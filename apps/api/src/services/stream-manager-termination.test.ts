// Tests de la revisión final de #151 (defectos que llegaron a `main`).
//
// Dos comportamientos: la decisión de terminar FFmpeg no puede sobrevivir a un
// `await`, y toda rama transcodificada debe responder con el path de la sesión
// REALMENTE retenida. Se prueban con barreras y promesas controladas.
//
// NOTA: `apps/api/tsconfig.json` excluye `src/**/*.test.ts`, así que este
// archivo no pasa por el `tsc` productivo. Por eso los tickets y las sesiones
// se construyen con helpers que delegan en la API real.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stopped: string[] = []
const removed: string[] = []
const spawned: string[] = []
const aliveProcesses = new Set<string>()
let publishGate: Promise<void> | null = null
let hlsReadyGate: Promise<void> | null = null
/** Fuerza el resultado de waitForHlsReady para recorrer cada rama. */
let hlsOutcome: 'ready' | 'manifest_only' | 'rtsp_only' = 'ready'

vi.mock('./stream', () => ({
  getStreamPath: (_n: any, cam: any, type = 'sub') => `p_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async () => { if (publishGate) await publishGate; return true },
  removeStream: async (_n: any, cam: any) => { removed.push(cam.id); return true },
  removeTranscodedPath: async () => true,
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => { if (publishGate) await publishGate; return true },
  getTranscodedStreamPath: (_n: any, cam: any) => `p_${cam.id}_ch${cam.channel}_main_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: () => ({ available: true, encoders: [] }),
  waitForHlsReady: async () => {
    if (hlsReadyGate) await hlsReadyGate
    if (hlsOutcome === 'ready') {
      return { ready: true, lastStatus: 200, elapsedMs: 10, processExited: false, manifestVisible: true }
    }
    // No listo: el llamador cae en las ramas "parcialmente listo".
    return {
      ready: false, lastStatus: 200, elapsedMs: 10, processExited: false,
      manifestVisible: hlsOutcome === 'manifest_only',
    }
  },
  spawnTranscodeProcess: (_n: any, _c: any, path: string) => {
    spawned.push(path); aliveProcesses.add(path)
    return { once: () => {}, pid: 9000 + spawned.length }
  },
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => { stopped.push(p); aliveProcesses.delete(p); return true },
  getTranscodeStderr: () => '',
  // Publisher RTSP activo: usado por la rama "HLS lento".
  getStreamDetails: async () => ({ sourceType: 'rtspSession', active: true }),
  getActiveTranscodesList: () => Array.from(aliveProcesses).map(p => ({ streamPath: p, alive: true, pid: 9001 })),
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const {
  startStream, stopStream, cleanupUserSessions, cleanupIdleSessions,
  getActiveSessions, getTranscodeCounts, beginRequest,
  __seedSessionForTest, __setViewHeartbeatForTest, __setMediaActivityForTest,
  __resetSessionsForTest, __resetClosedViewsForTest, __isPathPublishedForTest,
  __getTranscodeInFlightPathsForTest, __hasTranscodeSourceInfoForTest,
} = await import('./stream-manager')

type Ticket = ReturnType<typeof beginRequest>
const ticket = (): Ticket => beginRequest()
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)
const tick = () => new Promise(r => setImmediate(r))

interface SeedOpts {
  userId: string; viewId: string; cameraId: string
  streamType: 'sub' | 'main' | 'main_h264'; streamPath: string
  ageSec?: number; ownerSeq?: number
}
function seedSession(o: SeedOpts): void {
  __seedSessionForTest({
    cameraId: o.cameraId, userId: o.userId, viewId: o.viewId,
    streamType: o.streamType, streamPath: o.streamPath,
    startedAt: secondsAgo((o.ageSec ?? 0) + 10),
    lastClientHeartbeat: secondsAgo(o.ageSec ?? 0),
    lastOwnerRequestSeq: o.ownerSeq ?? 0,
  })
  __setViewHeartbeatForTest(o.userId, o.viewId, secondsAgo(o.ageSec ?? 0))
  if (o.streamType === 'main_h264') aliveProcesses.add(o.streamPath)
}

const hevc = (id: string, channel = 1) => ({
  id, active: true, online: true, channel, name: id,
  mainCodec: 'hevc', subCodec: 'hevc', rtspSubOk: true, rtspMainOk: true,
  streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '10.0.0.1', rtspPort: 554 },
})
const h264 = (id: string, channel = 1) => ({ ...hevc(id, channel), mainCodec: 'h264', subCodec: 'h264' })

function makeServer(camFactory: (id: string) => any = h264, dbGate: (() => Promise<void>) | null = null): any {
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

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  stopped.length = 0; removed.length = 0; spawned.length = 0
  aliveProcesses.clear()
  publishGate = null; hlsReadyGate = null
  hlsOutcome = 'ready'
})

// ─── P1 · la terminación se decide después del último await ──────────────────

describe('P1 · la decisión de terminar se recalcula tras los await', () => {
  it('(1) una sesión registrada durante findUnique impide matar su FFmpeg', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_hd', ownerSeq: 0 })

    // Durante la consulta de la cámara se registra un propietario NUEVO.
    let inyectado = false
    const server = makeServer(h264, async () => {
      if (inyectado) return
      inyectado = true
      seedSession({ userId: 'u9', viewId: 'v9', cameraId: 'camH', streamType: 'main_h264',
                    streamPath: 'p_camH_hd', ownerSeq: 999 })
    })

    await cleanupUserSessions(server, 'u1', 'v1', ticket())

    expect(stopped).toEqual([])                       // FFmpeg intacto
    expect(removed).not.toContain('camH')             // path intacto
    expect(getActiveSessions().map(s => s.userId)).toEqual(['u9'])
    expect(getTranscodeCounts().total).toBe(1)        // capacidad sigue ocupada
  })

  it('(2) sin propietario nuevo, el FFmpeg termina exactamente una vez', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_hd', ownerSeq: 0 })

    await cleanupUserSessions(makeServer(), 'u1', 'v1', ticket())

    expect(stopped).toEqual(['p_camH_hd'])
    expect(getTranscodeCounts().total).toBe(0)
  })

  it('(3) una sesión omitida por resolveDeletable no alimenta la terminación', async () => {
    const cierre = ticket()
    // Propiedad POSTERIOR al cierre: resolveDeletable la omite.
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_hd', ownerSeq: cierre.seq + 5 })

    await cleanupUserSessions(makeServer(), 'u1', 'v1', cierre)

    expect(getActiveSessions()).toHaveLength(1)
    expect(stopped).toEqual([])
  })

  it('(4) con dos procesos candidatos sólo muere el que queda sin propietario', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camA', streamType: 'main_h264',
                  streamPath: 'p_A_hd', ownerSeq: 0 })
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camB', streamType: 'main_h264',
                  streamPath: 'p_B_hd', ownerSeq: 0 })

    let inyectado = false
    const server = makeServer(h264, async () => {
      if (inyectado) return
      inyectado = true
      seedSession({ userId: 'u9', viewId: 'v9', cameraId: 'camB', streamType: 'main_h264',
                    streamPath: 'p_B_hd', ownerSeq: 999 })
    })

    await cleanupUserSessions(server, 'u1', 'v1', ticket())

    expect(stopped).toEqual(['p_A_hd'])
    expect(aliveProcesses.has('p_B_hd')).toBe(true)
  })

  it('(5) el propietario nuevo puede llegar durante CUALQUIER consulta, no sólo la primera', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camA', streamType: 'main_h264',
                  streamPath: 'p_A_hd', ownerSeq: 0 })
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camB', streamType: 'main_h264',
                  streamPath: 'p_B_hd', ownerSeq: 0 })

    // Se inyecta en la SEGUNDA consulta.
    let n = 0
    const server = makeServer(h264, async () => {
      n++
      if (n !== 2) return
      seedSession({ userId: 'u9', viewId: 'v9', cameraId: 'camA', streamType: 'main_h264',
                    streamPath: 'p_A_hd', ownerSeq: 999 })
    })

    await cleanupUserSessions(server, 'u1', 'v1', ticket())

    expect(stopped).toEqual(['p_B_hd'])
    expect(aliveProcesses.has('p_A_hd')).toBe(true)
  })
})

// ─── P2 · toda rama responde con la sesión retenida ──────────────────────────

/**
 * Prepara la carrera: un arranque transcodificado queda esperando y, mientras,
 * otro del MISMO dueño reclama la clave con OTRO path (el canal cambió entre
 * ambas lecturas de la base). El primero debe responder con el path retenido.
 */
async function carreraDePathDistinto(outcome: typeof hlsOutcome) {
  hlsOutcome = outcome
  let release!: () => void
  hlsReadyGate = new Promise<void>(r => { release = r })

  let canal = 1
  const server: any = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    prisma: { camera: { findUnique: async ({ where }: any) => hevc(where.id, canal) } },
  }

  const viejo = startStream(server, 'u1', 'camH', 'v1', 'main_h264', ticket())
  await tick()

  // El arranque posterior reclama la clave con otro path.
  hlsReadyGate = null
  canal = 2
  await startStream(server, 'u1', 'camH', 'v1', 'main_h264', ticket())
  const pathRetenido = getActiveSessions()[0].streamPath

  release()
  const r = await viejo
  return { r, pathRetenido }
}

describe('P2 · las ramas transcodificadas usan la sesión retenida', () => {
  it('(6)(7) el registro superado responde con el streamPath, HLS y WebRTC retenidos', async () => {
    const { r, pathRetenido } = await carreraDePathDistinto('ready')

    expect(r.streamPath).toBe(pathRetenido)
    expect(r.hlsUrl).toContain(pathRetenido)
    expect(r.webrtcUrl).toContain(pathRetenido)
  })

  it('(10) la rama manifestVisible usa la sesión retenida', async () => {
    const { r, pathRetenido } = await carreraDePathDistinto('manifest_only')
    expect(r.streamPath).toBe(pathRetenido)
    expect(r.hlsUrl).toContain(pathRetenido)
  })

  it('(11) la rama de publisher RTSP con HLS lento usa la sesión retenida', async () => {
    const { r, pathRetenido } = await carreraDePathDistinto('rtsp_only')
    expect(r.streamPath).toBe(pathRetenido)
    expect(r.hlsUrl).toContain(pathRetenido)
  })

  it('(12) el camino totalmente ready sin carrera devuelve su propio path', async () => {
    const r = await startStream(makeServer(hevc), 'u1', 'camH', 'v1', 'main_h264', ticket())
    expect(r.error).toBeUndefined()
    expect(r.streamPath).toBe(getActiveSessions()[0].streamPath)
    expect(r.hlsUrl).toContain(r.streamPath)
  })

  it('(9) la reutilización de FFmpeg vivo usa la sesión retenida', async () => {
    // Proceso vivo sin sesión: la rama de reutilización registra y responde.
    aliveProcesses.add('p_camH_ch1_main_h264')
    const r = await startStream(makeServer(hevc), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(r.error).toBeUndefined()
    expect(r.streamPath).toBe(getActiveSessions()[0].streamPath)
    expect(spawned).toEqual([])                       // no se volvió a spawnear
  })

  it('(8) el waiter que adopta un transcode compartido usa la sesión retenida', async () => {
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })

    const primero = startStream(makeServer(hevc), 'u1', 'camH', 'v1', 'main_h264', ticket())
    await tick()
    const waiter = startStream(makeServer(hevc), 'u2', 'camH', 'v2', 'main_h264', ticket())
    release()

    const [r1, r2] = await Promise.all([primero, waiter])
    expect(r1.error).toBeUndefined()
    expect(r2.error).toBeUndefined()
    const suya = getActiveSessions().find(s => s.userId === 'u2')!
    expect(r2.streamPath).toBe(suya.streamPath)
    expect(r2.hlsUrl).toContain(suya.streamPath)
  })
})

// ─── Limpieza del path descartado ────────────────────────────────────────────

describe('limpieza del transcode descartado', () => {
  it('(13)(14)(17) el intento descartado no se cuenta a sí mismo y limpia todo su estado', async () => {
    const { pathRetenido } = await carreraDePathDistinto('ready')
    const descartado = 'p_camH_ch1_main_h264'
    expect(pathRetenido).not.toBe(descartado)

    // El FFmpeg descartado se terminó y no quedó estado colgado.
    expect(stopped).toContain(descartado)
    expect(aliveProcesses.has(descartado)).toBe(false)
    expect(__isPathPublishedForTest(descartado)).toBe(false)
    expect(__getTranscodeInFlightPathsForTest()).not.toContain(descartado)
    expect(__hasTranscodeSourceInfoForTest(descartado)).toBe(false)
  })

  it('(15) un waiter real sobre el path local impide retirarlo', async () => {
    // Dos peticiones esperan el MISMO path; la carrera no descarta nada.
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })
    const a = startStream(makeServer(hevc), 'u1', 'camH', 'v1', 'main_h264', ticket())
    await tick()
    const b = startStream(makeServer(hevc), 'u2', 'camH', 'v2', 'main_h264', ticket())
    release()
    await Promise.all([a, b])

    expect(stopped).toEqual([])
    expect(removed).toEqual([])
  })

  it('(16) otra sesión real sobre el path local impide retirarlo', async () => {
    seedSession({ userId: 'u9', viewId: 'v9', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_ch1_main_h264', ownerSeq: 1 })
    const r = await startStream(makeServer(hevc), 'u1', 'camH', 'v1', 'main_h264', ticket())

    expect(r.error).toBeUndefined()
    expect(stopped).toEqual([])
    expect(removed).toEqual([])
  })

  it('(18) la capacidad cuenta sólo los paths supervivientes', async () => {
    const { pathRetenido } = await carreraDePathDistinto('ready')
    const counts = getTranscodeCounts()
    expect(counts.total).toBe(1)
    expect(getActiveSessions().every(s => s.streamPath === pathRetenido)).toBe(true)
  })
})

// ─── Invariantes previos ─────────────────────────────────────────────────────

describe('invariantes que siguen vigentes', () => {
  it('(19) dos pestañas del mismo usuario siguen aisladas', async () => {
    await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', ticket())
    await startStream(makeServer(), 'u1', 'camA', 'tabB', 'sub', ticket())
    expect(getActiveSessions()).toHaveLength(2)

    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'exit_focus', 'tabA', ticket())
    const rest = getActiveSessions()
    expect(rest).toHaveLength(1)
    expect(rest[0].viewId).toBe('tabB')
  })

  it('(20) la regresión de 26 horas sigue siendo imposible', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camUTI', streamType: 'main_h264',
                  streamPath: 'p_ch09_hd', ageSec: 26 * 3600 })
    __setMediaActivityForTest('p_ch09_hd', Date.now())

    const first = await cleanupIdleSessions(makeServer(hevc))
    const second = await cleanupIdleSessions(makeServer(hevc))

    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_ch09_hd'])
  })
})

// ─── Revisión de #152 ────────────────────────────────────────────────────────

describe('#152 · la finalización relee la sesión retenida', () => {
  it('un reemplazo encolado durante el await del registro no deja responder con el path viejo', async () => {
    // `registerTranscodeSession` es async: su await cede el turno aunque no
    // haya limpieza. Otro arranque ya encolado puede reemplazar la fila entre
    // el registro y la finalización.
    hlsOutcome = 'ready'
    let release!: () => void
    hlsReadyGate = new Promise<void>(r => { release = r })

    let canal = 1
    const server: any = {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      prisma: { camera: { findUnique: async ({ where }: any) => hevc(where.id, canal) } },
    }

    const viejo = startStream(server, 'u1', 'camH', 'v1', 'main_h264', ticket())
    await tick()

    // Encolado: se registra con otro path mientras el primero está por finalizar.
    hlsReadyGate = null
    canal = 2
    await startStream(server, 'u1', 'camH', 'v1', 'main_h264', ticket())
    const retenido = getActiveSessions()[0].streamPath

    release()
    const r = await viejo

    // Responde con el path RELEÍDO del mapa, no con el que capturó al registrar.
    expect(r.streamPath).toBe(retenido)
    expect(r.hlsUrl).toContain(retenido)
    // Y el descartado no quedó marcado como listo.
    expect(__getTranscodeInFlightPathsForTest()).not.toContain('p_camH_ch1_main_h264')
  })

  // Lo que NO se prueba acá: la rama `finalize_aborted` —la fila desaparece
  // entre el registro y la finalización— no es alcanzable de forma
  // determinista desde afuera, porque entre esos dos puntos no hay ningún
  // `await` propio: sólo puede colarse una microtarea YA encolada, que es
  // justamente el caso del test de arriba. Prefiero dejarlo dicho antes que
  // escribir un test que aparente cubrirla sin hacerlo.

})
