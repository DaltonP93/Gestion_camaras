// C19 · La "conservación del FFmpeg para reutilización" deja de ser una
// condición aislada y pasa a ser un ESTADO DE CICLO DE VIDA explícito y
// rastreado (una RETENCIÓN) con GENERACIÓN de proceso.
//
// Estos tests ejercen el camino REAL —`startStream`, `stopStream`,
// `cleanupUserSessions`, el finalizador de retenciones— no guardas de AST. Cada
// uno demuestra un invariante de los cuatro defectos P0:
//
//   P0-2  un cierre DÉBIL confirmado conserva el FFmpeg y devuelve un token de
//         retención; un cierre FUERTE posterior con ese token lo MATA.
//   P0-3  una retención de la generación A NUNCA mata a una B —sesión, waiter,
//         arranque en vuelo, o una instancia nueva sobre el mismo path—.
//   P0-4  `cleanupUserSessions(viewId)` finaliza las retenciones de esa vista
//         aunque no queden sesiones; el barrido recoge las vencidas; el tope se
//         respeta finalizando, nunca borrando en silencio.
//
// Mismo molde de mock que `stream-manager-retained-state.test.ts`: sin
// temporizadores reales, sobre comportamiento observable. `apps/api/tsconfig`
// excluye `*.test.ts`, así que este archivo no pasa por el tsc productivo.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stopped: string[] = []
const removedPaths: string[] = []
const spawned: string[] = []
const aliveProcesses = new Set<string>()
let stopSucceeds = true

vi.mock('./stream', () => ({
  getStreamPath: (_n: any, cam: any, type = 'sub') => `p_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async () => true,
  removeStream: async () => true,
  removeTranscodedPath: async (p: string, stillUnowned?: () => boolean) => {
    if (stillUnowned && !stillUnowned()) return false
    removedPaths.push(p); return true
  },
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => true,
  getTranscodedStreamPath: (_n: any, cam: any) => `p_${cam.id}_ch${cam.channel}_main_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: () => ({ available: true, encoders: [] }),
  waitForHlsReady: async () => ({ ready: true, lastStatus: 200, elapsedMs: 10, processExited: false, manifestVisible: true }),
  spawnTranscodeProcess: (_n: any, _c: any, path: string) => {
    spawned.push(path); aliveProcesses.add(path)
    return { once: () => {}, pid: 5000 + spawned.length }
  },
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => {
    stopped.push(p)
    if (!stopSucceeds) return false
    aliveProcesses.delete(p)
    return true
  },
  getTranscodeStderr: () => 'stderr',
  getStreamDetails: async () => ({ sourceType: 'none', active: false }),
  getActiveTranscodesList: () => Array.from(aliveProcesses).map(p => ({ streamPath: p, alive: true, pid: 5001 })),
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[OCULTO]@host/path',
}))

const {
  startStream, stopStream, cleanupUserSessions, cleanupIdleSessions,
  getActiveSessions, getTranscodeCounts, getTranscodeSlots, beginRequest,
  __resetSessionsForTest, __resetClosedViewsForTest, __resetTombstonesForTest,
  __getRetentionsForTest, __getProcessInstanceForTest, __setProcessInstanceForTest,
  __ageRetentionForTest, __addInFlightStartForTest, __setViewHeartbeatForTest,
} = await import('./stream-manager')

type Ticket = ReturnType<typeof beginRequest>
const ticket = (): Ticket => beginRequest()

// Un path main_h264 concreto que produce el mock (cam `camH`, canal 1).
const PATH = 'p_camH_ch1_main_h264'

const hevc = (id: string, channel = 1) => ({
  id, active: true, online: true, channel, name: id,
  mainCodec: 'hevc', subCodec: 'hevc', rtspSubOk: true, rtspMainOk: true,
  streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '10.0.0.1', rtspPort: 554 },
})

function makeServer(): any {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    prisma: { camera: { findUnique: async ({ where }: any) => hevc(where.id) } },
  }
}

let attemptSeq = 0
/** Arranca un HD real con un arrendamiento de cliente y lo devuelve. */
async function arrancarHD(userId: string, viewId: string): Promise<string> {
  const attemptId = `cli-${++attemptSeq}`
  const r = await startStream(makeServer(), userId, 'camH', viewId, 'main_h264', ticket(), attemptId)
  expect(r.error).toBeUndefined()
  expect(r.streamPath).toBe(PATH)
  expect(aliveProcesses.has(PATH)).toBe(true)
  return attemptId
}

/** Cierre DÉBIL (conserva FFmpeg): devuelve el token de retención acuñado. */
async function cerrarDebil(userId: string, viewId: string, attemptId: string): Promise<string | undefined> {
  const res = await stopStream(makeServer(), userId, 'camH', 'main_h264', 'hls_fatal_error', viewId, ticket(), attemptId)
  return res.retentionToken
}

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  __resetTombstonesForTest()
  stopped.length = 0; removedPaths.length = 0; spawned.length = 0
  aliveProcesses.clear()
  stopSucceeds = true
  delete process.env.STREAM_MAX_RETENTIONS
  delete process.env.STREAM_RETENTION_TTL_MS
})

// ─── P0-2 · débil conserva y devuelve token; fuerte con token mata ───────────

describe('C19 P0-2 · conservación explícita y escalada terminante', () => {
  it('(2a) un cierre débil confirmado conserva el FFmpeg y crea una retención', async () => {
    const a = await arrancarHD('u1', 'v1')
    const token = await cerrarDebil('u1', 'v1', a)

    // La sesión se fue, pero el proceso sigue vivo y hay UNA retención que lo
    // rastrea, con su generación de instancia.
    expect(getActiveSessions()).toHaveLength(0)
    expect(aliveProcesses.has(PATH)).toBe(true)
    expect(token).toBeTruthy()
    const rets = __getRetentionsForTest()
    expect(rets).toHaveLength(1)
    expect(rets[0].streamPath).toBe(PATH)
    expect(rets[0].processInstanceId).toBe(__getProcessInstanceForTest(PATH))
    expect(rets[0].attemptIds).toContain(a)
  })

  it('(2b·escenario 1) débil 500 → fuerte con token reenviado MATA el proceso A', async () => {
    const a = await arrancarHD('u1', 'v1')
    const token = await cerrarDebil('u1', 'v1', a)
    expect(token).toBeTruthy()

    // El cierre FUERTE llega sin sesión (el débil ya la borró), pero con el
    // token de la retención: escala y mata el huérfano.
    const strong = await stopStream(makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'v1', ticket(), a, token)

    expect(strong.outcome).toBe('session_closed')
    expect(strong.killedFfmpeg).toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(false)
    expect(stopped).toContain(PATH)
    expect(__getRetentionsForTest()).toHaveLength(0)
    expect(__getProcessInstanceForTest(PATH)).toBeUndefined()
  })

  it('(2c) un fuerte sin token igual escala la retención por identidad', async () => {
    const a = await arrancarHD('u1', 'v1')
    await cerrarDebil('u1', 'v1', a)

    // Sin token: se resuelve por vista+cámara+tipo+attempt.
    const strong = await stopStream(makeServer(), 'u1', 'camH', 'main_h264', 'viewport_change', 'v1', ticket(), a)

    expect(strong.killedFfmpeg).toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(false)
    expect(__getRetentionsForTest()).toHaveLength(0)
  })

  it('(2d) no confirma ni pierde la retención si la instancia no pudo terminarse', async () => {
    const a = await arrancarHD('u1', 'v1')
    const token = await cerrarDebil('u1', 'v1', a)
    stopSucceeds = false

    const first = await stopStream(
      makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'v1', ticket(), a, token,
    )

    expect(first.outcome).toBe('ignored')
    expect(first.reason).toBe('retention_pending')
    expect(first.killedFfmpeg).not.toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(true)
    expect(__getRetentionsForTest()).toHaveLength(1)

    stopSucceeds = true
    const retry = await stopStream(
      makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'v1', ticket(), a, token,
    )
    expect(retry.killedFfmpeg).toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(false)
    expect(__getRetentionsForTest()).toHaveLength(0)
  })

  it('(2e) un cierre fuerte directo cuyo kill falla pasa a retención pendiente y reintenta', async () => {
    const a = await arrancarHD('u1', 'v1')
    stopSucceeds = false

    const first = await stopStream(
      makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'v1', ticket(), a,
    )
    expect(first).toMatchObject({
      outcome: 'ignored', reason: 'retention_pending', attemptId: a,
      killedFfmpeg: false,
    })
    expect(first.retentionToken).toMatch(/^ret-[0-9a-f-]{36}$/)
    expect(getActiveSessions()).toHaveLength(0)
    expect(aliveProcesses.has(PATH)).toBe(true)
    expect(__getRetentionsForTest()).toHaveLength(1)

    stopSucceeds = true
    const retry = await stopStream(
      makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'v1', ticket(), a,
      first.retentionToken,
    )
    expect(retry.killedFfmpeg).toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(false)
  })
})

describe('C19 · el token de retención está ligado a su propietario exacto', () => {
  it('un usuario/vista/intento ajeno no puede finalizar una retención aunque conozca el token', async () => {
    const a = await arrancarHD('u1', 'vA')
    const token = await cerrarDebil('u1', 'vA', a)

    const ataque = await stopStream(
      makeServer(), 'u2', 'camH', 'main_h264', 'page_change', 'vX', ticket(), 'otro-attempt', token,
    )

    expect(ataque.killedFfmpeg).not.toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(true)
    expect(__getRetentionsForTest()).toHaveLength(1)

    const legitimo = await stopStream(
      makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'vA', ticket(), a, token,
    )
    expect(legitimo.killedFfmpeg).toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(false)
  })
})

// ─── P0-3 · una retención de A NUNCA mata a una B ────────────────────────────

describe('C19 P0-3 · la lápida de A no mata a una B viva', () => {
  it('(3) A retenida + B registrada sobre el mismo path → escalar A ADOPTA, no mata', async () => {
    const a = await arrancarHD('u1', 'vA')
    const token = await cerrarDebil('u1', 'vA', a)
    expect(__getRetentionsForTest()).toHaveLength(1)

    // B (otra pestaña) arranca el HD: reutiliza el proceso vivo (misma
    // generación) y queda como dueña del path.
    await arrancarHD('u1', 'vB')
    expect(spawned.filter(p => p === PATH)).toHaveLength(1)   // no respawneó
    const bSessions = getActiveSessions().filter(s => s.viewId === 'vB')
    expect(bSessions).toHaveLength(1)

    // Ahora se escala la retención de A: hay dueño (B) → ADOPTED, no se mata.
    const strong = await stopStream(makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'vA', ticket(), a, token)

    expect(strong.outcome).toBe('ignored')
    expect(strong.reason).toBe('retention_adopted')
    expect(strong.killedFfmpeg).not.toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(true)          // B intacta
    expect(getActiveSessions().some(s => s.viewId === 'vB')).toBe(true)
    expect(__getRetentionsForTest()).toHaveLength(0)     // A resuelta
  })

  it('(4) A retenida + B en vuelo difiere el kill; sólo el registro de B confirma ADOPCIÓN', async () => {
    const a = await arrancarHD('u1', 'vA')
    const token = await cerrarDebil('u1', 'vA', a)

    // B tiene un arranque en vuelo sobre el mismo path (aún sin sesión).
    __addInFlightStartForTest(PATH, 'bAttempt', { userId: 'u1', viewId: 'vB', cameraId: 'camH', ticket: ticket() })

    const strong = await stopStream(makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'vA', ticket(), a, token)

    expect(strong.reason).toBe('retention_pending')
    expect(aliveProcesses.has(PATH)).toBe(true)          // el en-vuelo de B lo salvó
    expect(__getProcessInstanceForTest(PATH)).toBeTruthy()
    expect(__getRetentionsForTest()).toHaveLength(1)     // aún no se presume adopción

    // Y B efectivamente puede registrar su sesión sobre ese proceso.
    const b = await startStream(makeServer(), 'u1', 'camH', 'vB', 'main_h264', ticket())
    expect(b.error).toBeUndefined()
    expect(getActiveSessions().some(s => s.viewId === 'vB')).toBe(true)
    expect(__getRetentionsForTest()).toHaveLength(0)

    // Retry idempotente de A recibe la confirmación explícita de que B adoptó
    // esa misma generación; no toca el proceso de B.
    const confirmed = await stopStream(
      makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'vA', ticket(), a, token,
    )
    expect(confirmed).toMatchObject({
      outcome: 'ignored', reason: 'retention_adopted', attemptId: a,
      killedFfmpeg: false,
    })
    expect(aliveProcesses.has(PATH)).toBe(true)
  })

  it('(5) A muere + nace OTRA instancia en el mismo path → la lápida de A es GONE, no mata la nueva', async () => {
    const a = await arrancarHD('u1', 'vA')
    const token = await cerrarDebil('u1', 'vA', a)
    const genA = __getProcessInstanceForTest(PATH)

    // El proceso de A muere y el supervisor levanta OTRA instancia (nueva
    // generación) sobre el mismo path.
    aliveProcesses.add(PATH)                       // proceso vivo…
    const genB = __setProcessInstanceForTest(PATH) // …pero es una generación NUEVA
    expect(genB).not.toBe(genA)

    const strong = await stopStream(makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'vA', ticket(), a, token)

    // La generación vigente ya no es la de A: la lápida no toca a la nueva.
    expect(strong.outcome).toBe('ignored')
    expect(strong.reason).toBe('retention_gone')
    expect(strong.killedFfmpeg).not.toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(true)
    expect(__getProcessInstanceForTest(PATH)).toBe(genB)  // intacta
    expect(stopped).not.toContain(PATH)
  })
})

// ─── P0-4 · cleanup / barrido / tope recogen las retenciones ─────────────────

describe('C19 P0-4 · cleanup y expiración finalizan las retenciones', () => {
  it('(6) cleanupUserSessions(viewId) con CERO sesiones pero una retención mata el huérfano', async () => {
    const a = await arrancarHD('u1', 'vA')
    await cerrarDebil('u1', 'vA', a)
    expect(getActiveSessions()).toHaveLength(0)   // sin sesiones…
    expect(aliveProcesses.has(PATH)).toBe(true)   // …pero el FFmpeg sigue

    const removed = await cleanupUserSessions(makeServer(), 'u1', 'vA', ticket())

    expect(removed).toBe(0)                        // no había sesiones que quitar
    expect(aliveProcesses.has(PATH)).toBe(false)  // el huérfano murió igual
    expect(__getRetentionsForTest()).toHaveLength(0)
  })

  it('(6b) cleanup conserva la retención si el kill falla y un retry posterior la finaliza', async () => {
    const a = await arrancarHD('u1', 'vA')
    const token = await cerrarDebil('u1', 'vA', a)
    stopSucceeds = false

    await cleanupUserSessions(makeServer(), 'u1', 'vA', ticket())

    expect(aliveProcesses.has(PATH)).toBe(true)
    expect(__getRetentionsForTest()).toHaveLength(1)

    stopSucceeds = true
    const retry = await stopStream(
      makeServer(), 'u1', 'camH', 'main_h264', 'page_change', 'vA', ticket(), a, token,
    )
    expect(retry.killedFfmpeg).toBe(true)
    expect(aliveProcesses.has(PATH)).toBe(false)
  })

  it('(7) cleanupUserSessions(vA) con una B dueña del path RESUELVE A sin matar a B', async () => {
    const a = await arrancarHD('u1', 'vA')
    await cerrarDebil('u1', 'vA', a)
    await arrancarHD('u1', 'vB')                   // B reutiliza el proceso vivo

    await cleanupUserSessions(makeServer(), 'u1', 'vA', ticket())

    expect(aliveProcesses.has(PATH)).toBe(true)    // B intacta
    expect(getActiveSessions().some(s => s.viewId === 'vB')).toBe(true)
    expect(__getRetentionsForTest().filter(r => r.viewId === 'vA')).toHaveLength(0)
  })

  it('(8a) una retención VENCIDA se finaliza en el barrido idle (no se borra en silencio)', async () => {
    const a = await arrancarHD('u1', 'vA')
    const token = await cerrarDebil('u1', 'vA', a)
    expect(token).toBeTruthy()

    // Envejecerla más allá del TTL y correr el barrido idle.
    __ageRetentionForTest(token!, 60_000)
    await cleanupIdleSessions(makeServer())

    expect(aliveProcesses.has(PATH)).toBe(false)   // finalizada de verdad
    expect(__getRetentionsForTest()).toHaveLength(0)
    expect(stopped).toContain(PATH)
  })

  it('(8b) al llegar al TOPE, la retención más vieja se FINALIZA (mata su huérfano), no se descarta', async () => {
    process.env.STREAM_MAX_RETENTIONS = '1'

    // Retención 1 (cámara camH). Huérfana y viva.
    const a = await arrancarHD('u1', 'vA')
    await cerrarDebil('u1', 'vA', a)
    expect(__getRetentionsForTest()).toHaveLength(1)
    expect(aliveProcesses.has(PATH)).toBe(true)

    // Segunda retención sobre OTRO path: al toparse el límite, la primera se
    // finaliza (mata su proceso), no se pierde en silencio. Reusar el mismo
    // path sería una adopción explícita y resolvería la primera antes del cap.
    const a2 = `cli-${++attemptSeq}`
    const second = await startStream(
      makeServer(), 'u2', 'camJ', 'vC', 'main_h264', ticket(), a2,
    )
    expect(second.error).toBeUndefined()
    await stopStream(
      makeServer(), 'u2', 'camJ', 'main_h264', 'hls_fatal_error', 'vC', ticket(), a2,
    )

    // El tope es 1: sólo puede quedar una retención, y la desalojada se finalizó
    // por el camino seguro (su huérfano fue terminado), nunca borrada a secas.
    expect(__getRetentionsForTest().length).toBeLessThanOrEqual(1)
    expect(stopped).toContain(PATH)
    // No queda una retención fantasma apuntando al proceso que el finalizador
    // del tope acaba de matar.
    expect(__getRetentionsForTest().every(r => aliveProcesses.has(r.streamPath))).toBe(true)
  })
})

// ─── Coherencia con diagnóstico / cupos ──────────────────────────────────────

describe('C19 · las retenciones cuentan para diagnóstico y cupo', () => {
  it('una retención viva aparece en getTranscodeCounts.retained y ocupa cupo', async () => {
    const a = await arrancarHD('u1', 'vA')
    const antes = getTranscodeCounts()
    await cerrarDebil('u1', 'vA', a)
    const despues = getTranscodeCounts()

    expect((despues as any).retained).toBeGreaterThanOrEqual(1)
    // El path retenido sigue contando como ocupado (no liberó cupo al conservarse).
    expect(despues.total).toBeGreaterThanOrEqual(antes.total)
  })

  it('un proceso retenido sin sesión aparece como slot diagnóstico sin exponer el token', async () => {
    const a = await arrancarHD('u1', 'vA')
    await cerrarDebil('u1', 'vA', a)

    const diag = getTranscodeSlots()
    expect(diag.retainedCount).toBe(1)
    expect(diag.slots).toHaveLength(1)
    expect(diag.slots[0]).toMatchObject({
      cameraId: 'camH', userId: 'u1', viewId: 'vA', streamPath: PATH,
      processAlive: true, retained: true, viewerCount: 0,
    })
    expect(JSON.stringify(diag)).not.toContain('ret-')
  })
})
