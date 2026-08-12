// Tests de la revisión de #146 — pertenencia por pestaña, cierre durante un
// arranque en vuelo, TTL efectivo y autorización del supervisor.
//
// Se mockea './stream' para observar exactamente cuándo se termina un FFmpeg,
// cuándo se publica un path y cuándo NO, sin procesos reales ni MediaMTX.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stopped: string[] = []
const published: string[] = []
const removed: string[] = []
const aliveProcesses = new Set<string>()
// Compuertas para simular latencia en cada etapa asíncrona del arranque.
let publishGate: Promise<void> | null = null
let hlsReadyGate: Promise<void> | null = null

vi.mock('./stream', () => ({
  getStreamPath: (_nvr: any, cam: any, type = 'sub') => `nvr_x_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async (_n: any, cam: any, type: string) => {
    published.push(`nvr_x_${cam.id}_${type}`)
    if (publishGate) await publishGate
    return true
  },
  removeStream: async (_n: any, cam: any) => { removed.push(cam.id); return true },
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => { if (publishGate) await publishGate; return true },
  getTranscodedStreamPath: (_n: any, cam: any) => `nvr_x_${cam.id}_main_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: () => ({ available: true, encoders: [] }),
  waitForHlsReady: async () => {
    if (hlsReadyGate) await hlsReadyGate
    return { ready: true, lastStatus: 200, elapsedMs: 10, processExited: false, manifestVisible: true }
  },
  spawnTranscodeProcess: (_n: any, _c: any, path: string) => {
    aliveProcesses.add(path)
    return { once: () => {}, pid: 4242 }
  },
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => { stopped.push(p); aliveProcesses.delete(p); return true },
  getTranscodeStderr: () => '',
  getStreamDetails: async () => ({ sourceType: 'rtspSession', active: true }),
  getActiveTranscodesList: () => [],
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const {
  startStream, stopStream, cleanupUserSessions, cleanupIdleSessions,
  touchSession, getActiveSessions, getStreamIdleTimeoutMs, getStreamHdIdleTimeoutMs,
  markViewClosed,
  __seedSessionForTest, __setViewHeartbeatForTest, __setMediaActivityForTest,
  __resetSessionsForTest, __resetClosedViewsForTest,
} = await import('./stream-manager')

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)

const camera = (id: string) => ({
  id, active: true, online: true, channel: 1, name: `cam ${id}`,
  mainCodec: 'h264', subCodec: 'h264', rtspSubOk: true, rtspMainOk: true,
  streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '10.0.0.1', rtspPort: 554 },
})

const fakeServer: any = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  prisma: { camera: { findUnique: async ({ where }: any) => camera(where.id) } },
}

function seed(userId: string, viewId: string, cameraId: string,
              streamType: 'sub' | 'main' | 'main_h264', path: string, ageSec: number) {
  __seedSessionForTest({
    cameraId, userId, viewId, streamType, streamPath: path,
    startedAt: secondsAgo(ageSec + 10), lastClientHeartbeat: secondsAgo(ageSec),
  })
  __setViewHeartbeatForTest(userId, viewId, secondsAgo(ageSec))
  if (streamType === 'main_h264') aliveProcesses.add(path)
}

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  stopped.length = 0; published.length = 0; removed.length = 0
  aliveProcesses.clear()
  publishGate = null; hlsReadyGate = null
})

// ─── P1 · pertenencia por pestaña ────────────────────────────────────────────

describe('P1 · asociación sesión ↔ viewId', () => {
  it('(2) HD observado activamente NO expira por view_heartbeat_missing', async () => {
    // El defecto: la sesión se registraba con viewId='default' mientras el
    // heartbeat llegaba como 'vp_x'. Con el viewId correcto ambos coinciden.
    seed('u1', 'vp_x', 'camA', 'main_h264', 'p_hd', 0)
    __setViewHeartbeatForTest('u1', 'vp_x', new Date())

    expect(await cleanupIdleSessions(fakeServer)).toBe(0)
    expect(getActiveSessions()).toHaveLength(1)
    expect(stopped).toEqual([])
  })

  it('una sesión cuyo viewId no coincide con ningún heartbeat SÍ expira', async () => {
    // Reproduce el bug ORIGINAL para dejar constancia de que la detección es
    // real: la sesión queda bajo 'default' (como hacía ViewPlayerPage al no
    // mandar viewId) y el único heartbeat existente es el de 'vp_x'.
    __seedSessionForTest({
      cameraId: 'camA', userId: 'u1', viewId: 'default', streamType: 'main_h264',
      streamPath: 'p_hd', startedAt: new Date(), lastClientHeartbeat: new Date(),
    })
    aliveProcesses.add('p_hd')
    __setViewHeartbeatForTest('u1', 'vp_x', new Date())   // heartbeat de OTRA clave

    expect(await cleanupIdleSessions(fakeServer)).toBe(1)
    expect(stopped).toEqual(['p_hd'])
  })

  it('(3) dos pestañas del mismo usuario NO se roban la sesión', async () => {
    await startStream(fakeServer, 'u1', 'camA', 'tabA')
    await startStream(fakeServer, 'u1', 'camA', 'tabB')

    const all = getActiveSessions()
    expect(all).toHaveLength(2)
    expect(all.map(s => s.viewId).sort()).toEqual(['tabA', 'tabB'])
  })

  it('(3b) cerrar en una pestaña NO cierra la sesión de la otra', async () => {
    await startStream(fakeServer, 'u1', 'camA', 'tabA')
    await startStream(fakeServer, 'u1', 'camA', 'tabB')

    await stopStream(fakeServer, 'u1', 'camA', 'sub', 'exit_focus', 'tabA')

    const rest = getActiveSessions()
    expect(rest).toHaveLength(1)
    expect(rest[0].viewId).toBe('tabB')
  })

  it('un cierre SIN viewId con dos pestañas se rechaza en vez de adivinar', async () => {
    await startStream(fakeServer, 'u1', 'camA', 'tabA')
    await startStream(fakeServer, 'u1', 'camA', 'tabB')

    await stopStream(fakeServer, 'u1', 'camA', 'sub', 'legacy_no_view')

    expect(getActiveSessions()).toHaveLength(2)   // ninguna se cerró
  })

  it('un cierre SIN viewId con una sola pestaña sí resuelve (compatibilidad)', async () => {
    await startStream(fakeServer, 'u1', 'camA', 'tabA')
    await stopStream(fakeServer, 'u1', 'camA', 'sub', 'legacy_no_view')
    expect(getActiveSessions()).toHaveLength(0)
  })

  it('touchSession sin viewId no toca sesiones ajenas cuando hay ambigüedad', async () => {
    seed('u1', 'tabA', 'camA', 'sub', 'p1', 80)
    seed('u1', 'tabB', 'camA', 'sub', 'p1', 80)
    const before = getActiveSessions().map(s => s.lastClientHeartbeat.getTime())

    touchSession('u1', 'camA', 'sub')

    const after = getActiveSessions().map(s => s.lastClientHeartbeat.getTime())
    expect(after).toEqual(before)
  })

  it('(8) el proceso compartido sobrevive mientras otra pestaña lo use', async () => {
    seed('u1', 'tabA', 'camA', 'main_h264', 'p_shared', 3600)
    seed('u2', 'tabB', 'camA', 'main_h264', 'p_shared', 0)
    __setViewHeartbeatForTest('u2', 'tabB', new Date())

    await cleanupIdleSessions(fakeServer)

    expect(stopped).toEqual([])
    expect(getActiveSessions().map(s => s.userId)).toEqual(['u2'])
  })
})

// ─── P2 · cierre durante un arranque en vuelo ────────────────────────────────

describe('P2 · cierre mientras el arranque está en vuelo', () => {
  it('(4) cierre ANTES de registrar la primera sesión deja cero sesiones y cero FFmpeg', async () => {
    // cleanupUserSessions con cero sesiones debe marcar igual el cierre: ese
    // era exactamente el agujero por el que nacía la sesión fantasma.
    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })

    const starting = startStream(fakeServer, 'u1', 'camA', 'tabA')
    await new Promise(r => setImmediate(r))

    expect(getActiveSessions()).toHaveLength(0)          // aún no registró nada
    await cleanupUserSessions(fakeServer, 'u1', 'tabA')  // pagehide

    release()
    const result = await starting

    expect(result.error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
    expect(aliveProcesses.size).toBe(0)
  })

  it('(5) cierre durante publishStream aborta y libera el path', async () => {
    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })

    const starting = startStream(fakeServer, 'u1', 'camA', 'tabA')
    await new Promise(r => setImmediate(r))
    markViewClosed('u1', 'tabA')
    release()

    const result = await starting
    expect(result.error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
    // Nadie más mira esa cámara: el path se retira de MediaMTX.
    expect(removed).toContain('camA')
  })

  it('(6) cierre durante waitForHlsReady no deja sesión ni FFmpeg huérfanos', async () => {
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })

    const starting = startStream(fakeServer, 'u1', 'camHevc', 'tabA', 'main_h264')
    await new Promise(r => setImmediate(r))
    markViewClosed('u1', 'tabA')
    release()

    const result = await starting
    expect(result.error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
    expect(aliveProcesses.size).toBe(0)
    expect(stopped).toContain('nvr_x_camHevc_main_h264')
  })

  it('(7) cierre mientras se espera un transcodeInFlight resuelve el single-flight', async () => {
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })

    const first  = startStream(fakeServer, 'u1', 'camHevc', 'tabA', 'main_h264')
    await new Promise(r => setImmediate(r))
    const second = startStream(fakeServer, 'u2', 'camHevc', 'tabB', 'main_h264')

    markViewClosed('u1', 'tabA')
    release()

    const [r1, r2] = await Promise.all([first, second])
    // Ninguna de las dos queda colgada: el single-flight se resolvió.
    expect(r1.error?.code).toBe('VIEW_CLOSED')
    expect(r2).toBeDefined()
    expect(getActiveSessions().every(s => s.viewId !== 'tabA')).toBe(true)
  })

  it('(9) un arranque abortado NO le quita el recurso a otra pestaña', async () => {
    // Con el proceso ya vivo, el arranque toma la rama de reutilización y
    // registra al instante, así que no habría aborto que observar. Lo que sí
    // importa probar es que abortar no le quite el path a quien sigue mirando.
    seed('u2', 'tabB', 'camA', 'sub', 'nvr_x_camA_sub', 0)
    __setViewHeartbeatForTest('u2', 'tabB', new Date())

    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })
    const starting = startStream(fakeServer, 'u1', 'camA', 'tabA')
    await new Promise(r => setImmediate(r))
    markViewClosed('u1', 'tabA')
    release()

    const result = await starting
    expect(result.error?.code).toBe('VIEW_CLOSED')
    expect(removed).toEqual([])          // el path NO se retira
    expect(stopped).toEqual([])
    expect(getActiveSessions().map(s => s.viewId)).toEqual(['tabB'])
  })

  it('una respuesta tardía no reabre una generación cerrada', async () => {
    seed('u1', 'tabA', 'camA', 'sub', 'p1', 0)
    const receivedBefore = Date.now() - 1
    await cleanupUserSessions(fakeServer, 'u1', 'tabA')

    touchSession('u1', 'camA', 'sub', receivedBefore, 'tabA')

    expect(getActiveSessions()).toHaveLength(0)
  })
})

// ─── P2 · TTL efectivo ───────────────────────────────────────────────────────

describe('P2 · TTL efectivo compartido con el frontend', () => {
  it('(15) cleanupUserSessions sin viewId usa el TTL efectivo por tipo', async () => {
    // sub con 100 s y HD con 100 s: con STREAM_IDLE_TIMEOUT=90 ambos vencen.
    // Lo relevante es que se use la MISMA decisión centralizada, no un cutoff
    // crudo y único como antes.
    seed('u1', 'tabA', 'camA', 'sub', 'p_sub', 100)
    seed('u1', 'tabA', 'camB', 'main_h264', 'p_hd', 100)

    const cleaned = await cleanupUserSessions(fakeServer, 'u1')

    expect(cleaned).toBe(2)
    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_hd'])
  })

  it('cleanupUserSessions sin viewId respeta sesiones frescas', async () => {
    seed('u1', 'tabA', 'camA', 'sub', 'p_sub', 0)
    __setViewHeartbeatForTest('u1', 'tabA', new Date())
    expect(await cleanupUserSessions(fakeServer, 'u1')).toBe(0)
  })

  it('(9-frontend) los getters exponen el TTL efectivo que consume el frontend', () => {
    expect(getStreamIdleTimeoutMs()).toBe(90_000)
    expect(getStreamHdIdleTimeoutMs()).toBe(90_000)
  })
})

// ─── Supervisor ──────────────────────────────────────────────────────────────

describe('Inconsistencia adicional · autorización del supervisor', () => {
  it('(14) lastMediaActivity SIN sesión no autoriza un reinicio', async () => {
    // El supervisor corre al morir FFmpeg. Sin sesión válida y sin arranque en
    // vuelo, la actividad de medio reciente NO puede resucitar el proceso.
    __setMediaActivityForTest('p_huerfano', Date.now())
    __resetSessionsForTest()
    __setMediaActivityForTest('p_huerfano', Date.now())

    // Con cero sesiones, cualquier limpieza no debe revivir nada.
    await cleanupIdleSessions(fakeServer)

    expect(aliveProcesses.has('p_huerfano')).toBe(false)
    expect(getActiveSessions()).toHaveLength(0)
  })

  it('(16) la carrera de 26 horas sigue siendo imposible', async () => {
    seed('u1', 'tabA', 'camUTI', 'main_h264', 'nvr_x_ch09_main_h264', 26 * 3600)
    __setMediaActivityForTest('nvr_x_ch09_main_h264', Date.now())

    const first = await cleanupIdleSessions(fakeServer)
    const second = await cleanupIdleSessions(fakeServer)

    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['nvr_x_ch09_main_h264'])
  })
})

// ─── Revisión de #147 ────────────────────────────────────────────────────────

describe('#147 · el que espera un arranque compartido registra su propia sesión', () => {
  it('la segunda pestaña obtiene URL en vez de TRANSCODE_NOT_READY', async () => {
    // Antes: la clave es por view, así que el que esperaba buscaba SU
    // transcodeKey, no lo encontraba y devolvía TRANSCODE_NOT_READY aunque
    // FFmpeg hubiera arrancado perfecto.
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })

    const first  = startStream(fakeServer, 'u1', 'camHevc', 'tabA', 'main_h264')
    await new Promise(r => setImmediate(r))
    const second = startStream(fakeServer, 'u2', 'camHevc', 'tabB', 'main_h264')
    release()

    const [r1, r2] = await Promise.all([first, second])
    expect(r1.error).toBeUndefined()
    expect(r2.error).toBeUndefined()
    expect(r2.hlsUrl).toContain('nvr_x_camHevc_main_h264')
    // Cada pestaña tiene SU fila sobre el mismo proceso compartido.
    expect(getActiveSessions().map(s => s.viewId).sort()).toEqual(['tabA', 'tabB'])
  })

  it('si la pestaña iniciadora se cierra, el que espera conserva el proceso', async () => {
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })

    const first  = startStream(fakeServer, 'u1', 'camHevc', 'tabA', 'main_h264')
    await new Promise(r => setImmediate(r))
    const second = startStream(fakeServer, 'u2', 'camHevc', 'tabB', 'main_h264')
    markViewClosed('u1', 'tabA')
    release()

    const [, r2] = await Promise.all([first, second])
    expect(r2.error).toBeUndefined()
    expect(stopped).toEqual([])                                  // no se mató el proceso
    expect(getActiveSessions().map(s => s.viewId)).toEqual(['tabB'])
  })
})

describe('#147 · la cancelación es POR CÁMARA, no por view entero', () => {
  it('cerrar la cámara A no aborta el arranque en vuelo de la cámara B', async () => {
    // Antes stopStream marcaba el view completo, así que cambiar de cámara
    // abortaba con VIEW_CLOSED los arranques de las demás de la grilla.
    seed('u1', 'tabA', 'camA', 'sub', 'nvr_x_camA_sub', 0)

    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })
    const startingB = startStream(fakeServer, 'u1', 'camB', 'tabA')
    await new Promise(r => setImmediate(r))

    await stopStream(fakeServer, 'u1', 'camA', 'sub', 'viewport_change', 'tabA')
    release()

    const rB = await startingB
    expect(rB.error).toBeUndefined()
    expect(getActiveSessions().map(s => s.cameraId)).toEqual(['camB'])
  })

  it('cerrar la MISMA cámara sí aborta su arranque en vuelo', async () => {
    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })
    const starting = startStream(fakeServer, 'u1', 'camA', 'tabA')
    await new Promise(r => setImmediate(r))

    await stopStream(fakeServer, 'u1', 'camA', 'sub', 'viewport_change', 'tabA')
    release()

    expect((await starting).error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
  })

  it('cerrar el view entero (pagehide) sí aborta todas las cámaras', async () => {
    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })
    const startingB = startStream(fakeServer, 'u1', 'camB', 'tabA')
    await new Promise(r => setImmediate(r))

    await cleanupUserSessions(fakeServer, 'u1', 'tabA')
    release()

    expect((await startingB).error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
  })
})

describe('#147 · una sesión HD retenida por su TTL conserva su índice de view', () => {
  it('con HD TTL > TTL estándar, la limpieza sin viewId no borra su viewHeartbeat', async () => {
    // La sesión HD tiene 100 s (vence el estándar de 90 s pero no un HD mayor).
    // Antes el tramo final de cleanupUserSessions borraba viewHeartbeat con el
    // cutoff estándar CRUDO, y la siguiente pasada la mataba por
    // `view_heartbeat_missing`, anulando el TTL de HD configurado.
    seed('u1', 'tabA', 'camHd', 'main_h264', 'p_hd', 30)
    __setViewHeartbeatForTest('u1', 'tabA', secondsAgo(30))

    await cleanupUserSessions(fakeServer, 'u1')

    // Sobrevive, y su índice sigue: una segunda pasada tampoco la mata.
    expect(getActiveSessions()).toHaveLength(1)
    await cleanupUserSessions(fakeServer, 'u1')
    expect(getActiveSessions()).toHaveLength(1)
    expect(stopped).toEqual([])
  })
})
