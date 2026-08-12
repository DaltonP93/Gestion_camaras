// Tests de la TERCERA revisión de #147 (defectos que llegaron a `main`).
//
// Los tres son carreras, así que se prueban con barreras y promesas
// controladas sobre el comportamiento REAL del módulo — nada de aserciones
// sobre el texto del código.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stopped: string[] = []
const removed: string[] = []
const spawned: string[] = []
const aliveProcesses = new Set<string>()
let publishGate: Promise<void> | null = null
let hlsReadyGate: Promise<void> | null = null

vi.mock('./stream', () => ({
  getStreamPath: (_n: any, cam: any, type = 'sub') => `p_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async () => { if (publishGate) await publishGate; return true },
  removeStream: async (_n: any, cam: any) => { removed.push(cam.id); return true },
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => { if (publishGate) await publishGate; return true },
  getTranscodedStreamPath: (_n: any, cam: any) => `p_${cam.id}_main_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: () => ({ available: true, encoders: [] }),
  waitForHlsReady: async () => {
    if (hlsReadyGate) await hlsReadyGate
    return { ready: true, lastStatus: 200, elapsedMs: 10, processExited: false, manifestVisible: true }
  },
  spawnTranscodeProcess: (_n: any, _c: any, path: string) => {
    spawned.push(path); aliveProcesses.add(path)
    return { once: () => {}, pid: 7000 + spawned.length }
  },
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => { stopped.push(p); aliveProcesses.delete(p); return true },
  getTranscodeStderr: () => '',
  getStreamDetails: async () => ({ sourceType: 'rtspSession', active: true }),
  getActiveTranscodesList: () => Array.from(aliveProcesses).map(p => ({ streamPath: p, alive: true, pid: 7001 })),
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const {
  startStream, stopStream, cleanupUserSessions, cleanupIdleSessions,
  getActiveSessions, getTranscodeCounts, getTranscodeSlots, markViewClosed, beginRequest,
  __seedSessionForTest, __setViewHeartbeatForTest, __setMediaActivityForTest,
  __resetSessionsForTest, __resetClosedViewsForTest,
} = await import('./stream-manager')

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)
const tick = () => new Promise(r => setImmediate(r))

/** Cámara HEVC → el backend redirige a main_h264 (transcodificación). */
const hevc = (id: string) => ({
  id, active: true, online: true, channel: 1, name: id,
  mainCodec: 'hevc', subCodec: 'hevc', rtspSubOk: true, rtspMainOk: true,
  streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '10.0.0.1', rtspPort: 554 },
})
const h264 = (id: string) => ({ ...hevc(id), mainCodec: 'h264', subCodec: 'h264' })

/** Servidor con una compuerta opcional en la consulta de cámara. */
function makeServer(camFactory = h264, dbGate: (() => Promise<void>) | null = null): any {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    prisma: {
      camera: {
        findUnique: async ({ where }: any) => {
          if (dbGate) await dbGate()
          return camFactory(where.id)
        },
      },
    },
  }
}

function seedHd(userId: string, viewId: string, cameraId: string, path: string, ageSec = 0) {
  __seedSessionForTest({
    cameraId, userId, viewId, streamType: 'main_h264', streamPath: path,
    startedAt: secondsAgo(ageSec + 10), lastClientHeartbeat: secondsAgo(ageSec),
  })
  __setViewHeartbeatForTest(userId, viewId, secondsAgo(ageSec))
  aliveProcesses.add(path)
}

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  stopped.length = 0; removed.length = 0; spawned.length = 0
  aliveProcesses.clear()
  publishGate = null; hlsReadyGate = null
})

// ─── P1-1 · antigüedad capturada al ENTRAR la petición ───────────────────────

describe('P1-1 · el cierre se compara contra la llegada de la petición', () => {
  it('(1)(2) cierre mientras el permiso está pendiente: cero sesiones, cero FFmpeg, cero path', async () => {
    // T1 entra la petición · T2 el permiso queda pendiente · T3 pagehide cierra
    // el view · T4 se resuelve el permiso. La petición es ANTERIOR al cierre.
    let releaseDb!: () => void
    const dbPending = new Promise<void>(r => { releaseDb = r })
    const server = makeServer(h264, () => dbPending)

    const ticket = beginRequest()               // T1: lo saca el handler
    const starting = startStream(server, 'u1', 'camA', 'tabA', 'sub', ticket)
    await tick()                                 // T2

    markViewClosed('u1', 'tabA')                 // T3
    releaseDb()                                  // T4
    const result = await starting

    expect(result.error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
    expect(aliveProcesses.size).toBe(0)
    expect(removed).toEqual([])                  // nunca llegó a publicar el path
  })

  it('demuestra el defecto: con el timestamp tomado DESPUÉS del permiso, la petición vieja pasaría', async () => {
    // Mismo escenario, pero midiendo desde después del cierre — que es lo que
    // hacía el default `Date.now()` interno. La sesión se registra: por eso el
    // handler debe capturar la hora en su primera línea síncrona.
    markViewClosed('u1', 'tabA')
    await tick()
    const tardio = beginRequest()                // ticket posterior al cierre

    const result = await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', tardio)

    expect(result.error).toBeUndefined()
    expect(getActiveSessions()).toHaveLength(1)
  })

  it('(3) una petición realmente POSTERIOR al cierre sí puede iniciar una generación nueva', async () => {
    await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', beginRequest())
    await cleanupUserSessions(makeServer(), 'u1', 'tabA')
    expect(getActiveSessions()).toHaveLength(0)

    await tick()
    const nueva = await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', beginRequest())

    expect(nueva.error).toBeUndefined()
    expect(getActiveSessions()).toHaveLength(1)
  })

  it('el cierre de OTRA cámara no invalida esta petición', async () => {
    const ticket = beginRequest()
    let releaseDb!: () => void
    const dbPending = new Promise<void>(r => { releaseDb = r })

    const starting = startStream(makeServer(h264, () => dbPending), 'u1', 'camB', 'tabA', 'sub', ticket)
    await tick()
    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'tabA')
    releaseDb()

    expect((await starting).error).toBeUndefined()
  })
})

// ─── P1-2 · identidad única por intento ──────────────────────────────────────

describe('P1-2 · cada intento en vuelo tiene identidad propia', () => {
  it('(4)(5)(6) el finally del intento viejo no borra ni desprotege al reemplazo', async () => {
    // Dos intentos del MISMO dueño (usuario, pestaña, cámara, tipo): comparten
    // clave de sesión, así que antes la segunda pisaba a la primera y el
    // `finally` de la primera borraba a la segunda.
    let releaseA!: () => void
    publishGate = new Promise<void>(r => { releaseA = r })

    const tA = beginRequest()
    const a = startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', tA)
    await tick()

    markViewClosed('u1', 'tabA')                 // A queda cancelada
    await tick()

    const tB = beginRequest()                    // B llega DESPUÉS del cierre
    const b = startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', tB)
    releaseA()

    const [ra, rb] = await Promise.all([a, b])

    expect(ra.error?.code).toBe('VIEW_CLOSED')   // A se cancela
    expect(rb.error).toBeUndefined()             // B sobrevive
    expect(getActiveSessions()).toHaveLength(1)
    // A no puede retirar el path que B está usando.
    expect(removed).toEqual([])
  })

  it('(7)(8) cancelados TODOS los intentos de un sub/main, el path se retira UNA vez', async () => {
    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })

    const a = startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', beginRequest())
    const b = startStream(makeServer(), 'u2', 'camA', 'tabB', 'sub', beginRequest())
    await tick()
    markViewClosed('u1', 'tabA')
    markViewClosed('u2', 'tabB')
    release()

    await Promise.all([a, b])

    expect(getActiveSessions()).toHaveLength(0)
    expect(removed.filter(c => c === 'camA')).toHaveLength(1)   // exactamente una
  })

  it('(9) la misma garantía en main_h264: A cancelada no derriba el proceso de B', async () => {
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })

    const a = startStream(makeServer(hevc), 'u1', 'camH', 'tabA', 'main_h264', beginRequest())
    await tick()
    const b = startStream(makeServer(hevc), 'u2', 'camH', 'tabB', 'main_h264', beginRequest())
    markViewClosed('u1', 'tabA')
    release()

    const [ra, rb] = await Promise.all([a, b])

    expect(ra.error?.code).toBe('VIEW_CLOSED')
    expect(rb.error).toBeUndefined()
    expect(stopped).toEqual([])                  // el proceso sigue vivo para B
    expect(getActiveSessions().map(s => s.viewId)).toEqual(['tabB'])
  })

  it('retirar un intento es idempotente: repetirlo no afecta a otros', async () => {
    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })

    const a = startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', beginRequest())
    const b = startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', beginRequest())
    release()
    await Promise.all([a, b])

    // Dos intentos del mismo dueño convergen en UNA sola sesión.
    expect(getActiveSessions()).toHaveLength(1)
  })
})

// ─── P1-3 · la capacidad cuenta procesos, no espectadores ────────────────────

describe('P1-3 · capacidad por streamPath', () => {
  it('(10) dos viewers del mismo path: dos sesiones, UN cupo activo', () => {
    seedHd('u1', 'tabA', 'camH', 'p_camH_main_h264')
    seedHd('u2', 'tabB', 'camH', 'p_camH_main_h264')

    expect(getActiveSessions()).toHaveLength(2)
    const counts = getTranscodeCounts()
    expect(counts.active).toBe(1)
    expect(counts.total).toBe(1)
  })

  it('dos cámaras con paths distintos ocupan dos cupos', () => {
    seedHd('u1', 'tabA', 'camA', 'p_camA_main_h264')
    seedHd('u1', 'tabA', 'camB', 'p_camB_main_h264')
    expect(getTranscodeCounts().total).toBe(2)
  })

  it('(11) con máximo 2: dos viewers de A más la cámara B están permitidos', async () => {
    seedHd('u1', 'tabA', 'camA', 'p_camA_main_h264')
    seedHd('u2', 'tabB', 'camA', 'p_camA_main_h264')   // comparten proceso
    expect(getTranscodeCounts().total).toBe(1)

    const r = await startStream(makeServer(hevc), 'u1', 'camB', 'tabA', 'main_h264', beginRequest())

    expect(r.error).toBeUndefined()
    expect(getTranscodeCounts().total).toBe(2)
  })

  it('(12) con A y B activas, una tercera cámara recibe TRANSCODE_LIMIT_REACHED', async () => {
    seedHd('u1', 'tabA', 'camA', 'p_camA_main_h264')
    seedHd('u1', 'tabA', 'camB', 'p_camB_main_h264')
    expect(getTranscodeCounts().total).toBe(2)

    const r = await startStream(makeServer(hevc), 'u1', 'camC', 'tabA', 'main_h264', beginRequest())

    expect(r.error?.code).toBe('TRANSCODE_LIMIT_REACHED')
  })

  it('reutilizar un path que ya ocupa cupo se permite con el máximo alcanzado', async () => {
    seedHd('u1', 'tabA', 'camA', 'p_camA_main_h264')
    seedHd('u1', 'tabA', 'camB', 'p_camB_main_h264')
    expect(getTranscodeCounts().total).toBe(2)      // máximo alcanzado

    // Otra pestaña pide la MISMA cámara A: comparte proceso, no consume cupo.
    const r = await startStream(makeServer(hevc), 'u2', 'camA', 'tabB', 'main_h264', beginRequest())

    expect(r.error).toBeUndefined()
    expect(getTranscodeCounts().total).toBe(2)
  })

  it('(13) un path activo Y iniciando cuenta una sola vez en total', async () => {
    seedHd('u1', 'tabA', 'camH', 'p_camH_main_h264')
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })

    // Se fuerza un arranque del MISMO path desde otra pestaña.
    aliveProcesses.delete('p_camH_main_h264')       // el proceso murió: re-arranca
    const starting = startStream(makeServer(hevc), 'u2', 'camH', 'tabB', 'main_h264', beginRequest())
    await tick()

    const during = getTranscodeCounts()
    expect(during.total).toBe(1)                    // activo + iniciando = mismo path

    release()
    await starting
    expect(getTranscodeCounts().total).toBe(1)
  })

  it('(14) getTranscodeSlots devuelve UN slot por proceso, con sus propietarios', () => {
    seedHd('u1', 'tabA', 'camH', 'p_camH_main_h264')
    seedHd('u2', 'tabB', 'camH', 'p_camH_main_h264')
    seedHd('u1', 'tabA', 'camB', 'p_camB_main_h264')

    const diag = getTranscodeSlots()

    expect(diag.slots).toHaveLength(2)              // dos procesos, no tres sesiones
    expect(diag.activeProcessCount).toBe(2)
    const compartido = diag.slots.find(s => s.streamPath === 'p_camH_main_h264')!
    expect(compartido.viewerCount).toBe(2)
    expect(compartido.viewers.map(v => v.viewId).sort()).toEqual(['tabA', 'tabB'])
    // El diagnóstico no se contradice: tantos slots como procesos.
    expect(diag.slots.length).toBe(diag.activeProcessCount)
  })

  it('el diagnóstico no expone tokens ni credenciales', () => {
    seedHd('u1', 'tabA', 'camH', 'p_camH_main_h264')
    const json = JSON.stringify(getTranscodeSlots())
    expect(json).not.toMatch(/rtsp:\/\/[^[]/)
    expect(json).not.toContain('password')
    expect(json).not.toContain('Bearer')
  })

  it('(15) al cerrar uno de dos viewers, el proceso y el cupo continúan', async () => {
    seedHd('u1', 'tabA', 'camH', 'p_camH_main_h264')
    seedHd('u2', 'tabB', 'camH', 'p_camH_main_h264')

    await stopStream(makeServer(hevc), 'u1', 'camH', 'main_h264', 'exit_focus', 'tabA')

    expect(stopped).toEqual([])
    expect(getTranscodeCounts().total).toBe(1)
    expect(getActiveSessions()).toHaveLength(1)
  })

  it('(16) al cerrar el ÚLTIMO viewer, el proceso y el cupo se liberan', async () => {
    seedHd('u1', 'tabA', 'camH', 'p_camH_main_h264')
    seedHd('u2', 'tabB', 'camH', 'p_camH_main_h264')

    await stopStream(makeServer(hevc), 'u1', 'camH', 'main_h264', 'exit_focus', 'tabA')
    await stopStream(makeServer(hevc), 'u2', 'camH', 'main_h264', 'exit_focus', 'tabB')

    expect(stopped).toEqual(['p_camH_main_h264'])
    expect(getTranscodeCounts().total).toBe(0)
    expect(getActiveSessions()).toHaveLength(0)
  })
})

// ─── Invariantes que no deben romperse ───────────────────────────────────────

describe('invariantes previos que siguen vigentes', () => {
  it('(17) lastMediaActivity sin sesión no cuenta como demanda', async () => {
    __setMediaActivityForTest('p_huerfano', Date.now())
    await cleanupIdleSessions(makeServer())
    expect(getActiveSessions()).toHaveLength(0)
    expect(aliveProcesses.has('p_huerfano')).toBe(false)
  })

  it('(18) la sesión de 26 horas sigue siendo imposible', async () => {
    seedHd('u1', 'tabA', 'camUTI', 'p_ch09_main_h264', 26 * 3600)
    __setMediaActivityForTest('p_ch09_main_h264', Date.now())

    const first = await cleanupIdleSessions(makeServer())
    const second = await cleanupIdleSessions(makeServer())

    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_ch09_main_h264'])
  })
})

// ─── Revisión de #148 ────────────────────────────────────────────────────────

describe('#148 · el ticket se estampa ANTES de la autenticación', () => {
  it('una petición vieja que se reanuda tras un cierre NO se toma por reapertura', async () => {
    // La carrera real: `server.authenticate` es un preHandler que hace
    // `await request.jwtVerify()`. Si el ticket se sacara en la primera línea
    // del HANDLER —después de ese await— este sería el orden:
    //
    //   T1 entra start-stream (vieja) y empieza a autenticarse
    //   T2 entra el cierre, termina SU autenticación y marca el view
    //   T3 la vieja termina de autenticarse y recién ahí saca su ticket
    //      → secuencia MAYOR que la del cierre → parecería una reapertura
    //
    // Con el ticket estampado en `onRequest` la vieja tiene secuencia MENOR.
    const ticketVieja = beginRequest()      // T1: onRequest de la petición vieja

    // T2: el cierre llega después y se completa antes.
    markViewClosed('u1', 'tabA')

    // T3: la vieja recién ahora llega al handler y arranca.
    const result = await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', ticketVieja)

    expect(result.error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
    expect(removed).toEqual([])
  })

  it('el orden lo decide la secuencia, no el momento en que se usa el ticket', async () => {
    const primera = beginRequest()
    const segunda = beginRequest()
    markViewClosed('u1', 'tabA')            // sella con la secuencia vigente
    const tercera = beginRequest()          // posterior al cierre

    // Las dos anteriores al cierre quedan invalidadas…
    expect((await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', primera)).error?.code)
      .toBe('VIEW_CLOSED')
    expect((await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', segunda)).error?.code)
      .toBe('VIEW_CLOSED')
    // …y la posterior sí puede abrir.
    expect((await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', tercera)).error)
      .toBeUndefined()
    expect(getActiveSessions()).toHaveLength(1)
  })
})
