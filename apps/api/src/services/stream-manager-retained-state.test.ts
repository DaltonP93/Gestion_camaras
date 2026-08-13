// A1.7 · dos defectos sobre el mismo eje: qué se borra y qué se conserva.
//
// P1 — `releaseUnownedStream` borraba `transcodeInFlight` en su PRIMERA línea,
// antes de saber si otra sesión, un waiter o un arranque válido conservaban el
// path. El proceso seguía vivo pero perdía su estado compartido, así que el
// arranque siguiente no lo adoptaba o levantaba un segundo FFmpeg.
//
// P2 — Después de publicar el path, varias salidas fallidas retornaban sin
// llamar a la liberación: quedaban el path pasivo en MediaMTX, `publishedPaths`,
// `transcodeSourceInfo`, `transcodeRestarts` y `lastMediaActivity` sin dueño.
//
// Todo con barreras y promesas controladas —sin temporizadores ni tiempos
// reales— y sobre el comportamiento observable, nunca sobre el texto del código.
//
// NOTA: `apps/api/tsconfig.json` excluye `src/**/*.test.ts`, así que este
// archivo no pasa por el `tsc` productivo; los tickets y las sesiones se
// construyen con helpers que delegan en la API real del módulo.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stopped: string[] = []
const removed: string[] = []
const removedPaths: string[] = []
const spawned: string[] = []
const aliveProcesses = new Set<string>()
let hlsReadyGate: Promise<void> | null = null
/** Resultado forzado de waitForHlsReady, para recorrer cada salida fallida. */
let hlsOutcome: 'ready' | 'exited' | 'timeout' = 'ready'
/** Si es true, `spawnTranscodeProcess` devuelve null (falla el arranque). */
let spawnReturnsNull = false
/** Si es true, `publishTranscodedStream` falla. */
let publishFails = false
/** Excepción lanzada por `waitForHlsReady` DESPUÉS de publicar y spawnear. */
let throwAfterPublish: Error | null = null
/** Publisher RTSP visible en MediaMTX cuando HLS no llegó a tiempo. */
let rtspPublisherActive = false

vi.mock('./stream', () => ({
  getStreamPath: (_n: any, cam: any, type = 'sub') => `p_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async () => true,
  removeStream: async (_n: any, cam: any) => { removed.push(cam.id); return true },
  removeTranscodedPath: async (p: string, stillUnowned?: () => boolean) => {
    if (stillUnowned && !stillUnowned()) return false
    removedPaths.push(p); return true
  },
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => !publishFails,
  getTranscodedStreamPath: (_n: any, cam: any) => `p_${cam.id}_ch${cam.channel}_main_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: () => ({ available: true, encoders: [] }),
  waitForHlsReady: async () => {
    if (hlsReadyGate) await hlsReadyGate
    if (throwAfterPublish) throw throwAfterPublish
    if (hlsOutcome === 'ready') {
      return { ready: true, lastStatus: 200, elapsedMs: 10, processExited: false, manifestVisible: true }
    }
    if (hlsOutcome === 'exited') {
      return { ready: false, lastStatus: 0, elapsedMs: 10, processExited: true, manifestVisible: false }
    }
    return { ready: false, lastStatus: 404, elapsedMs: 10, processExited: false, manifestVisible: false }
  },
  spawnTranscodeProcess: (_n: any, _c: any, path: string) => {
    if (spawnReturnsNull) return null
    spawned.push(path); aliveProcesses.add(path)
    return { once: () => {}, pid: 5000 + spawned.length }
  },
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => { stopped.push(p); aliveProcesses.delete(p); return true },
  getTranscodeStderr: () => 'stderr-de-prueba',
  getStreamDetails: async () => (
    rtspPublisherActive ? { sourceType: 'rtspSession', active: true } : { sourceType: 'none', active: false }
  ),
  getActiveTranscodesList: () => Array.from(aliveProcesses).map(p => ({ streamPath: p, alive: true, pid: 5001 })),
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const {
  startStream, getActiveSessions, getTranscodeCounts, beginRequest,
  __seedSessionForTest, __setViewHeartbeatForTest, __setMediaActivityForTest,
  __resetSessionsForTest, __resetClosedViewsForTest, __isPathPublishedForTest,
  __getTranscodeInFlightPathsForTest, __hasTranscodeSourceInfoForTest,
  __hasTranscodeRestartsForTest, __hasMediaActivityForTest,
  __getTranscodeInFlightForTest, __setTranscodeInFlightForTest,
  __addInFlightStartForTest, __addWaiterForTest, __markPathPublishedForTest,
  __releaseUnownedStreamForTest,
} = await import('./stream-manager')

type Ticket = ReturnType<typeof beginRequest>
const ticket = (): Ticket => beginRequest()
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)
const tick = () => new Promise(r => setImmediate(r))

const PATH = 'p_camH_ch1_main_h264'

const hevc = (id: string, channel = 1) => ({
  id, active: true, online: true, channel, name: id,
  mainCodec: 'hevc', subCodec: 'hevc', rtspSubOk: true, rtspMainOk: true,
  streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '10.0.0.1', rtspPort: 554 },
})

function makeServer(camFactory: (id: string, ch?: number) => any = hevc): any {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    prisma: { camera: { findUnique: async ({ where }: any) => camFactory(where.id) } },
  }
}

/** Siembra una sesión SIN marcar el proceso vivo (eso lo decide cada test). */
function seedSesion(o: { userId: string; viewId: string; cameraId: string; streamPath: string }): void {
  __seedSessionForTest({
    cameraId: o.cameraId, userId: o.userId, viewId: o.viewId,
    streamType: 'main_h264', streamPath: o.streamPath,
    startedAt: secondsAgo(10), lastClientHeartbeat: secondsAgo(0), lastOwnerRequestSeq: 1,
  })
  __setViewHeartbeatForTest(o.userId, o.viewId, secondsAgo(0))
}

/** Un arranque en vuelo ajeno, vivo y no cancelado. */
function seedArranqueEnVuelo(attemptId: string, userId = 'uX', viewId = 'vX'): void {
  __addInFlightStartForTest(PATH, attemptId, { userId, viewId, cameraId: 'camH', ticket: ticket() })
}

/** Deja el path como lo dejaría un arranque exitoso previo. */
function seedPathVivo(): void {
  aliveProcesses.add(PATH)
  __markPathPublishedForTest(PATH)
  __setMediaActivityForTest(PATH, Date.now())
}

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  stopped.length = 0; removed.length = 0; spawned.length = 0; removedPaths.length = 0
  aliveProcesses.clear()
  hlsReadyGate = null
  hlsOutcome = 'ready'
  spawnReturnsNull = false
  publishFails = false
  throwAfterPublish = null
  rtspPublisherActive = false
})

// ─── P1 · el estado de un path CONSERVADO no se borra ────────────────────────

describe('P1 · conservar el path es conservar también su estado', () => {
  it('(1) una sesión válida conserva el path y su transcodeInFlight', async () => {
    seedSesion({ userId: 'u9', viewId: 'v9', cameraId: 'camH', streamPath: PATH })
    seedPathVivo()
    __setTranscodeInFlightForTest(PATH, 'ready', 'intentoViejo')

    const kept = await __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'test', 'intentoViejo')

    expect(kept).toBe(true)
    // Lo que el defecto borraba:
    expect(__getTranscodeInFlightForTest(PATH)?.state).toBe('ready')
    // Y el resto del estado del path retenido tampoco se toca.
    expect(aliveProcesses.has(PATH)).toBe(true)
    expect(stopped).toEqual([])
    expect(__isPathPublishedForTest(PATH)).toBe(true)
    expect(__hasMediaActivityForTest(PATH)).toBe(true)
    expect(removedPaths).toEqual([])
  })

  it('(2) un waiter con proceso vivo conserva el estado adoptable', async () => {
    seedPathVivo()
    __setTranscodeInFlightForTest(PATH, 'starting', 'intentoViejo')
    __addWaiterForTest(PATH)

    const kept = await __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'test', 'intentoViejo')

    expect(kept).toBe(true)
    expect(__getTranscodeInFlightForTest(PATH)?.state).toBe('starting')
    expect(aliveProcesses.has(PATH)).toBe(true)
    expect(__isPathPublishedForTest(PATH)).toBe(true)
  })

  it('(3) otro startAttemptId válido no pierde su estado', async () => {
    seedPathVivo()
    __setTranscodeInFlightForTest(PATH, 'starting', 'intentoNuevo')
    seedArranqueEnVuelo('intentoNuevo')

    const kept = await __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'test', 'intentoViejo')

    expect(kept).toBe(true)
    const f = __getTranscodeInFlightForTest(PATH)
    expect(f?.state).toBe('starting')
    expect(f?.attemptId).toBe('intentoNuevo')   // no se lo pisó ni se lo borró
    expect(__isPathPublishedForTest(PATH)).toBe(true)
  })

  it('(4) sin ningún dueño, transcodeInFlight sí se elimina', async () => {
    seedPathVivo()
    __setTranscodeInFlightForTest(PATH, 'starting', 'intentoViejo')

    const kept = await __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'test', 'intentoViejo')

    expect(kept).toBe(false)
    expect(__getTranscodeInFlightForTest(PATH)).toBeUndefined()
    expect(stopped).toContain(PATH)
    expect(__isPathPublishedForTest(PATH)).toBe(false)
  })

  it('(4b) un estado que ya no describe al path se descarta aunque el path se conserve', async () => {
    // READY sin proceso: conservarlo anunciaría un FFmpeg que no existe.
    seedSesion({ userId: 'u9', viewId: 'v9', cameraId: 'camH', streamPath: PATH })
    __markPathPublishedForTest(PATH)
    __setTranscodeInFlightForTest(PATH, 'ready', 'intentoViejo')   // sin aliveProcesses

    const kept = await __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'test', 'intentoViejo')

    expect(kept).toBe(true)
    expect(__getTranscodeInFlightForTest(PATH)).toBeUndefined()
    // Pero el path sigue siendo de su dueño: no se despublica por debajo de él.
    expect(__isPathPublishedForTest(PATH)).toBe(true)
  })

  it('(9) un dueño que aparece durante la limpieza impide retirar su path', async () => {
    // La revalidación del borrado se ejecuta con el dueño ya registrado.
    seedPathVivo()
    __setTranscodeInFlightForTest(PATH, 'starting', 'intentoViejo')
    seedSesion({ userId: 'u9', viewId: 'v9', cameraId: 'camH', streamPath: PATH })

    const kept = await __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'test', 'intentoViejo')

    expect(kept).toBe(true)
    expect(removedPaths).toEqual([])
    expect(stopped).toEqual([])
  })

  it('(10)(13) la limpieza concurrente es idempotente y emite un solo DELETE', async () => {
    seedPathVivo()
    __setTranscodeInFlightForTest(PATH, 'starting', 'intentoViejo')

    const [a, b, c] = await Promise.all([
      __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'r1', 'intentoViejo'),
      __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'r2', 'intentoViejo'),
      __releaseUnownedStreamForTest(makeServer(), 'camH', PATH, 'r3', 'intentoViejo'),
    ])

    expect([a, b, c]).toEqual([false, false, false])
    expect(removedPaths.filter(p => p === PATH)).toHaveLength(1)
    expect(stopped.filter(p => p === PATH)).toHaveLength(1)
    expect(__getTranscodeInFlightForTest(PATH)).toBeUndefined()
  })
})

// ─── P2 · toda salida fallida posterior a publicar limpia ────────────────────

describe('P2 · las salidas fallidas después de publicar limpian todo', () => {
  /** Estado que NO debe sobrevivir a un arranque fallido sin dueño. */
  function esperarPathLimpio() {
    expect(__isPathPublishedForTest(PATH)).toBe(false)
    expect(__hasTranscodeSourceInfoForTest(PATH)).toBe(false)
    expect(__hasTranscodeRestartsForTest(PATH)).toBe(false)
    expect(__hasMediaActivityForTest(PATH)).toBe(false)
    expect(__getTranscodeInFlightPathsForTest()).not.toContain(PATH)
    expect(aliveProcesses.has(PATH)).toBe(false)
  }

  it('(5) spawnTranscodeProcess = null después de publicar retira el path', async () => {
    spawnReturnsNull = true

    const r = await startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(r.error?.code).toBe('TRANSCODE_PROCESS_EXITED')
    expect(removedPaths).toContain(PATH)
    esperarPathLimpio()
  })

  it('(6) FFmpeg muerto antes de HLS retira el path', async () => {
    hlsOutcome = 'exited'

    const r = await startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(r.error?.code).toBe('TRANSCODE_PROCESS_EXITED')
    expect(r.error?.details).toContain('stderr-de-prueba')   // el error original
    expect(removedPaths).toContain(PATH)
    esperarPathLimpio()
  })

  it('(7) timeout de HLS sin publisher activo retira el path', async () => {
    hlsOutcome = 'timeout'
    rtspPublisherActive = false

    const r = await startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(r.error?.code).toBe('TRANSCODE_NOT_READY')
    expect(removedPaths).toContain(PATH)
    esperarPathLimpio()
  })

  it('(8) una excepción posterior a publicar limpia y conserva el error original', async () => {
    throwAfterPublish = new Error('fallo-inesperado-del-medio')

    await expect(
      startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket()),
    ).rejects.toThrow('fallo-inesperado-del-medio')

    expect(removedPaths).toContain(PATH)
    esperarPathLimpio()
  })

  it('(12) también se limpian los reinicios y la actividad sembrados antes', async () => {
    __setMediaActivityForTest(PATH, Date.now())
    hlsOutcome = 'timeout'

    await startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())

    esperarPathLimpio()
  })

  it('(13) el fallo emite un solo DELETE del path exacto', async () => {
    hlsOutcome = 'timeout'

    await startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(removedPaths.filter(p => p === PATH)).toHaveLength(1)
  })

  it('(14) la capacidad vuelve al valor previo al intento fallido', async () => {
    const antes = getTranscodeCounts().total
    hlsOutcome = 'timeout'

    await startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(getTranscodeCounts().total).toBe(antes)
    expect(getActiveSessions()).toHaveLength(0)
  })

  it('(publicación fallida) no retira un path que nunca se publicó', async () => {
    publishFails = true

    const r = await startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(r.error?.code).toBe('MEDIA_SERVER_ERROR')
    expect(removedPaths).toEqual([])            // no se publicó: nada que retirar
    expect(__getTranscodeInFlightPathsForTest()).not.toContain(PATH)
    expect(getTranscodeCounts().total).toBe(0)
  })

  it('(11) un intento fallido no resuelve el single-flight de otro intento', async () => {
    // Otro arranque ya se adueñó del single-flight del path; el que falla no
    // puede marcarlo como fallido ni resolver su promesa.
    let abrir!: () => void
    hlsReadyGate = new Promise<void>(r => { abrir = r })
    hlsOutcome = 'timeout'

    const fallando = startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())
    for (let i = 0; i < 30; i++) await tick()   // publicó, spawneó y espera HLS

    // Un intento posterior toma el estado del path con SU identidad.
    __setTranscodeInFlightForTest(PATH, 'starting', 'intentoNuevo')
    seedArranqueEnVuelo('intentoNuevo')

    abrir()
    const r = await fallando

    expect(r.error?.code).toBe('TRANSCODE_NOT_READY')
    const f = __getTranscodeInFlightForTest(PATH)
    expect(f?.attemptId).toBe('intentoNuevo')   // no se lo pisó…
    expect(f?.state).toBe('starting')           // …ni se lo marcó como fallido
    // Y su path se conserva: hay un arranque válido detrás.
    expect(removedPaths).toEqual([])
    expect(__isPathPublishedForTest(PATH)).toBe(true)
  })
})

// ─── Invariantes previos ─────────────────────────────────────────────────────

describe('invariantes que siguen vigentes', () => {
  it('(15) dos pestañas del mismo usuario siguen aisladas', async () => {
    const h264 = (id: string, channel = 1) => ({ ...hevc(id, channel), mainCodec: 'h264', subCodec: 'h264' })

    await startStream(makeServer(h264), 'u1', 'camA', 'tabA', 'sub', ticket())
    await startStream(makeServer(h264), 'u1', 'camA', 'tabB', 'sub', ticket())

    const filas = getActiveSessions()
    expect(filas).toHaveLength(2)
    expect(filas.map(s => s.viewId).sort()).toEqual(['tabA', 'tabB'])
  })

  it('un arranque exitoso deja el path listo y con su identidad', async () => {
    const r = await startStream(makeServer(), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(r.error).toBeUndefined()
    expect(r.streamPath).toBe(PATH)
    expect(__getTranscodeInFlightForTest(PATH)?.state).toBe('ready')
    expect(__getTranscodeInFlightForTest(PATH)?.attemptId).toBeTruthy()
  })
})
