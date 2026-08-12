// Tests de FINALIZACIÓN FUERA DE ORDEN (revisión de #149 y #150).
//
// Los dos defectos son de ordenamiento, no de estado: una petición vieja que
// termina tarde no puede pisar el trabajo de una nueva. Se prueban con tickets
// y barreras controladas sobre el comportamiento real del módulo.
//
// NOTA: `apps/api/tsconfig.json` excluye `src/**/*.test.ts`, así que estos
// archivos NO pasan por el `tsc` productivo. Para no construir tickets ni
// sesiones a mano sin validación —un ticket mal formado ya se coló una vez— se
// usan los helpers tipados de más abajo, que delegan en la API real del módulo.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stopped: string[] = []
const removed: string[] = []
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
    aliveProcesses.add(path)
    return { once: () => {}, pid: 8001 }
  },
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => { stopped.push(p); aliveProcesses.delete(p); return true },
  getTranscodeStderr: () => '',
  getStreamDetails: async () => ({ sourceType: 'rtspSession', active: true }),
  getActiveTranscodesList: () => Array.from(aliveProcesses).map(p => ({ streamPath: p, alive: true, pid: 8001 })),
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const M = await import('./stream-manager')
const {
  startStream, stopStream, cleanupUserSessions, cleanupIdleSessions,
  touchSession, touchView, getActiveSessions, getTranscodeCounts,
  beginRequest, markViewClosed, isViewClosedAfter,
  __seedSessionForTest, __setViewHeartbeatForTest, __setMediaActivityForTest,
  __resetSessionsForTest, __resetClosedViewsForTest, __isPathPublishedForTest,
} = M

// ─── Helpers TIPADOS ─────────────────────────────────────────────────────────
// Nunca se arma un RequestTicket ni una sesión a mano: siempre por la API real
// o por el seam, con los campos completos.

type Ticket = ReturnType<typeof beginRequest>
const ticket = (): Ticket => beginRequest()

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)
const tick = () => new Promise(r => setImmediate(r))

interface SeedOpts {
  userId: string
  viewId: string
  cameraId: string
  streamType: 'sub' | 'main' | 'main_h264'
  streamPath: string
  ageSec?: number
  ownerSeq?: number
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

const hevc = (id: string) => ({
  id, active: true, online: true, channel: 1, name: id,
  mainCodec: 'hevc', subCodec: 'hevc', rtspSubOk: true, rtspMainOk: true,
  streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '10.0.0.1', rtspPort: 554 },
})
const h264 = (id: string) => ({ ...hevc(id), mainCodec: 'h264', subCodec: 'h264' })

function makeServer(camFactory = h264): any {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    prisma: { camera: { findUnique: async ({ where }: any) => camFactory(where.id) } },
  }
}

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  stopped.length = 0; removed.length = 0
  aliveProcesses.clear()
  publishGate = null; hlsReadyGate = null
})

// ─── P1 · watermark monotónico de cierre ─────────────────────────────────────

describe('P1 · el watermark de cierre nunca retrocede', () => {
  it('(1) close 3 termina antes que close 1; el watermark final sigue siendo 3', () => {
    const close1 = ticket()
    const start2 = ticket()
    const close3 = ticket()

    markViewClosed('u1', 'v1', close3)   // el más nuevo termina primero
    markViewClosed('u1', 'v1', close1)   // el viejo termina después

    // start 2 quedó por debajo de 3: sigue invalidado pese al cierre tardío.
    expect(isViewClosedAfter('u1', 'v1', start2)).toBe(true)
    expect(isViewClosedAfter('u1', 'v1', close3)).toBe(true)
  })

  it('(3) start 2 sigue bloqueado tras el orden close 3 → close 1', async () => {
    const close1 = ticket()
    const start2 = ticket()
    const close3 = ticket()

    markViewClosed('u1', 'v1', close3)
    markViewClosed('u1', 'v1', close1)

    const r = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start2)

    expect(r.error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
  })

  it('(4) start 4 sí es aceptado', async () => {
    const close1 = ticket()
    ticket()                              // start 2
    const close3 = ticket()
    markViewClosed('u1', 'v1', close3)
    markViewClosed('u1', 'v1', close1)

    const start4 = ticket()
    const r = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start4)

    expect(r.error).toBeUndefined()
    expect(getActiveSessions()).toHaveLength(1)
  })

  it('una secuencia IGUAL no degrada la marca', () => {
    const t = ticket()
    const later = ticket()
    markViewClosed('u1', 'v1', later)
    markViewClosed('u1', 'v1', later)     // repetida
    expect(isViewClosedAfter('u1', 'v1', t)).toBe(true)
    expect(isViewClosedAfter('u1', 'v1', later)).toBe(true)
  })

  it('(2) lo mismo para el cierre por cámara (markTargetClosed vía stopStream)', async () => {
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', ticket())

    const close1 = ticket()
    const start2 = ticket()
    const close3 = ticket()

    // El cierre nuevo se procesa primero…
    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', close3)
    // …y el viejo después: no puede bajar el watermark de esa cámara.
    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', close1)

    const r = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start2)
    expect(r.error?.code).toBe('VIEW_CLOSED')

    const nueva = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', ticket())
    expect(nueva.error).toBeUndefined()
  })
})

// ─── P1 · un cierre viejo no borra una sesión nueva ──────────────────────────

describe('P1 · la propiedad protege a la sesión más nueva', () => {
  it('(5) stop 1 retrasado NO elimina la sesión creada por start 2', async () => {
    const stop1  = ticket()               // el cierre entra primero…
    const start2 = ticket()               // …y el arranque después

    // start 2 completa antes que stop 1.
    const r = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start2)
    expect(r.error).toBeUndefined()
    expect(getActiveSessions()).toHaveLength(1)

    // stop 1 continúa ahora: su ticket es ANTERIOR a la propiedad actual.
    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', stop1)

    expect(getActiveSessions()).toHaveLength(1)
    expect(removed).toEqual([])
  })

  it('(6) cleanup view retrasado NO elimina la sesión creada por start 2', async () => {
    const close1 = ticket()
    const start2 = ticket()

    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start2)
    await cleanupUserSessions(makeServer(), 'u1', 'v1', close1)

    expect(getActiveSessions()).toHaveLength(1)
  })

  it('(7) una sesión creada por start 1 SÍ es eliminada por stop 2', async () => {
    const start1 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start1)

    const stop2 = ticket()
    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', stop2)

    expect(getActiveSessions()).toHaveLength(0)
  })

  it('(8) un heartbeat válido posterior preserva la sesión frente a stop 2', async () => {
    const start1 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start1)

    const stop2 = ticket()                // el cierre entra…
    const beat3 = ticket()                // …y el heartbeat llega después
    touchSession('u1', 'camA', 'sub', beat3, 'v1')

    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', stop2)

    expect(getActiveSessions()).toHaveLength(1)
  })

  it('(9) un heartbeat anterior al cierre no reafirma nada', async () => {
    const start1 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start1)

    const beat2 = ticket()                // heartbeat…
    const stop3 = ticket()                // …anterior al cierre
    markViewClosed('u1', 'v1', stop3)
    touchSession('u1', 'camA', 'sub', beat2, 'v1')   // descartado por el watermark

    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', stop3)

    expect(getActiveSessions()).toHaveLength(0)
  })

  it('(10) una sesión reemplazada (misma clave, nueva generación) no cae por un snapshot viejo', async () => {
    const start1 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start1)
    const gen1 = getActiveSessions()[0].generation

    // Cierre y reapertura: misma clave, generación nueva.
    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', ticket())
    const start3 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start3)
    const gen2 = getActiveSessions()[0].generation
    expect(gen2).not.toBe(gen1)

    // Un cierre con el ticket ORIGINAL no puede llevarse la fila nueva.
    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', start1)

    expect(getActiveSessions()).toHaveLength(1)
    expect(getActiveSessions()[0].generation).toBe(gen2)
  })

  it('(11) la sesión preservada conserva viewHeartbeat y viewCameras', async () => {
    const close1 = ticket()
    const start2 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start2)

    await cleanupUserSessions(makeServer(), 'u1', 'v1', close1)

    expect(getActiveSessions()).toHaveLength(1)
    // Si los índices se hubieran borrado, el barrido siguiente la mataría por
    // `view_heartbeat_missing`.
    __setViewHeartbeatForTest('u1', 'v1', new Date())
    expect(await cleanupIdleSessions(makeServer())).toBe(0)
    expect(getActiveSessions()).toHaveLength(1)
  })
})

// ─── Procesos compartidos y recursos ─────────────────────────────────────────

describe('procesos y paths con cierres fuera de orden', () => {
  it('(12) un FFmpeg compartido no termina si sobrevive un propietario posterior', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_main_h264', ownerSeq: 1 })
    const close2 = ticket()
    const start3 = ticket()
    seedSession({ userId: 'u2', viewId: 'v2', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_main_h264', ownerSeq: start3.seq })

    await cleanupUserSessions(makeServer(hevc), 'u1', 'v1', close2)

    expect(stopped).toEqual([])                    // sigue vivo para u2
    expect(getActiveSessions().map(s => s.userId)).toEqual(['u2'])
  })

  it('(13) el path no se retira si pertenece a una sesión posterior', async () => {
    const close1 = ticket()
    const start2 = ticket()
    await startStream(makeServer(), 'u2', 'camA', 'v2', 'sub', start2)
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camA', streamType: 'sub',
                  streamPath: 'p_camA_sub', ownerSeq: 0 })

    await cleanupUserSessions(makeServer(), 'u1', 'v1', close1)

    expect(removed).toEqual([])                    // u2 sigue mirando camA
    expect(getActiveSessions().map(s => s.userId)).toEqual(['u2'])
  })

  it('(14) al cerrar el último propietario elegible, el proceso termina una sola vez', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_main_h264', ownerSeq: 1 })
    seedSession({ userId: 'u2', viewId: 'v1', cameraId: 'camB', streamType: 'main_h264',
                  streamPath: 'p_camH_main_h264', ownerSeq: 1 })

    await cleanupUserSessions(makeServer(hevc), 'u1', 'v1', ticket())
    await cleanupUserSessions(makeServer(hevc), 'u2', 'v1', ticket())

    expect(stopped).toEqual(['p_camH_main_h264'])
  })

  it('(15) la limpieza por TTL no elimina una sesión reafirmada tras su snapshot', async () => {
    // Vencida por edad, pero reafirmada por una petición reciente.
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camA', streamType: 'sub',
                  streamPath: 'p_camA_sub', ageSec: 300, ownerSeq: 0 })
    const beat = ticket()
    __setViewHeartbeatForTest('u1', 'v1', new Date())
    touchSession('u1', 'camA', 'sub', beat, 'v1')   // heartbeat fresco y válido

    expect(await cleanupIdleSessions(makeServer())).toBe(0)
    expect(getActiveSessions()).toHaveLength(1)
  })
})

// ─── Invariantes previos ─────────────────────────────────────────────────────

describe('invariantes que deben seguir vigentes', () => {
  it('(16) dos pestañas del mismo usuario siguen aisladas', async () => {
    await startStream(makeServer(), 'u1', 'camA', 'tabA', 'sub', ticket())
    await startStream(makeServer(), 'u1', 'camA', 'tabB', 'sub', ticket())
    expect(getActiveSessions()).toHaveLength(2)

    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'exit_focus', 'tabA', ticket())

    const rest = getActiveSessions()
    expect(rest).toHaveLength(1)
    expect(rest[0].viewId).toBe('tabB')
  })

  it('(17) la capacidad sigue contando paths distintos, no viewers', () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_main_h264' })
    seedSession({ userId: 'u2', viewId: 'v2', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_main_h264' })
    expect(getActiveSessions()).toHaveLength(2)
    expect(getTranscodeCounts().active).toBe(1)
    expect(getTranscodeCounts().total).toBe(1)
  })

  it('(18) la regresión de 26 horas sigue siendo imposible', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camUTI', streamType: 'main_h264',
                  streamPath: 'p_ch09_main_h264', ageSec: 26 * 3600 })
    __setMediaActivityForTest('p_ch09_main_h264', Date.now())

    const first = await cleanupIdleSessions(makeServer(hevc))
    const second = await cleanupIdleSessions(makeServer(hevc))

    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_ch09_main_h264'])
  })

  it('touchView también reafirma la propiedad', async () => {
    const start1 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start1)

    const stop2 = ticket()
    const beat3 = ticket()
    touchView('u1', 'v1', beat3)

    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', stop2)
    expect(getActiveSessions()).toHaveLength(1)
  })

  it('ni el proceso vivo ni la actividad de medio reafirman propiedad', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_main_h264', ownerSeq: 1 })
    __setMediaActivityForTest('p_camH_main_h264', Date.now())
    expect(aliveProcesses.has('p_camH_main_h264')).toBe(true)

    const stop2 = ticket()
    await stopStream(makeServer(hevc), 'u1', 'camH', 'main_h264', 'exit_focus', 'v1', stop2)

    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_camH_main_h264'])
  })
})

// ─── Revisión de #151 ────────────────────────────────────────────────────────

describe('#151 · reutilización de sub/main reafirma propiedad', () => {
  it('stop 1 retrasado NO borra una sesión sub REUTILIZADA por start 2', async () => {
    // La rama de reutilización refrescaba el heartbeat pero no la propiedad, así
    // que la sesión quedaba con una secuencia vieja y el stop anterior la borraba.
    const start0 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start0)

    const stop1  = ticket()               // el cierre entra…
    const start2 = ticket()               // …y la REUTILIZACIÓN ocurre después
    const reuse = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start2)
    expect(reuse.error).toBeUndefined()

    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', stop1)

    expect(getActiveSessions()).toHaveLength(1)
  })

  it('lo mismo al reutilizar una sesión transcodificada', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camH', streamType: 'main_h264',
                  streamPath: 'p_camH_main_h264', ownerSeq: 0 })

    const stop1  = ticket()
    const start2 = ticket()
    await startStream(makeServer(hevc), 'u1', 'camH', 'v1', 'main_h264', start2)

    await stopStream(makeServer(hevc), 'u1', 'camH', 'main_h264', 'exit_focus', 'v1', stop1)

    expect(getActiveSessions()).toHaveLength(1)
    expect(stopped).toEqual([])
  })
})

describe('#151 · la limpieza sin viewId también marca el cierre', () => {
  it('un arranque viejo de la vista purgada no puede registrar después', async () => {
    // Sin la marca por vista, el arranque suspendido reanudaba y creaba una
    // sesión fantasma: no había watermark que lo cancelara.
    const startViejo = ticket()
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camA', streamType: 'sub',
                  streamPath: 'p_camA_sub', ageSec: 300, ownerSeq: 0 })

    const limpieza = ticket()
    await cleanupUserSessions(makeServer(), 'u1', undefined, limpieza)
    expect(getActiveSessions()).toHaveLength(0)

    // El arranque viejo reanuda ahora.
    const r = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', startViejo)

    expect(r.error?.code).toBe('VIEW_CLOSED')
    expect(getActiveSessions()).toHaveLength(0)
  })

  it('un arranque POSTERIOR a la limpieza sin viewId sí puede abrir', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camA', streamType: 'sub',
                  streamPath: 'p_camA_sub', ageSec: 300, ownerSeq: 0 })
    await cleanupUserSessions(makeServer(), 'u1', undefined, ticket())

    const r = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', ticket())
    expect(r.error).toBeUndefined()
  })
})

describe('#151 · un registro tardío no degrada una propiedad más nueva', () => {
  it('start 1 que termina después de start 3 no baja lastOwnerRequestSeq', async () => {
    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })

    // Orden de LLEGADA: start 1, close 2, start 3.
    // Orden de FINALIZACIÓN: start 3, start 1 (tardío), close 2 (tardío).
    //
    // Si el registro tardío de start 1 pisara la fila con ownerSeq=1, el cierre
    // 2 la encontraría elegible y borraría lo que start 3 reclamó.
    const start1 = ticket()
    const pendiente = startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start1)
    await tick()                          // start 1 espera en publishStream

    const close2 = ticket()               // LLEGA acá; se procesa al final

    publishGate = null
    const start3 = ticket()
    await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', start3)
    expect(getActiveSessions()).toHaveLength(1)
    expect(getActiveSessions()[0].lastOwnerRequestSeq).toBe(start3.seq)

    release()                             // start 1 reanuda y quiere registrar
    await pendiente

    // La propiedad sigue siendo la de start 3, no la de start 1.
    expect(getActiveSessions()[0].lastOwnerRequestSeq).toBe(start3.seq)

    // Y por eso el cierre intermedio no puede llevársela.
    await stopStream(makeServer(), 'u1', 'camA', 'sub', 'viewport_change', 'v1', close2)

    expect(getActiveSessions()).toHaveLength(1)
  })
})

describe('#151 · el path no se retira si aparece una sesión nueva durante la limpieza', () => {
  it('se relee el mapa vivo antes de cada removeStream', async () => {
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camA', streamType: 'sub',
                  streamPath: 'p_camA_sub', ownerSeq: 0 })
    seedSession({ userId: 'u1', viewId: 'v1', cameraId: 'camB', streamType: 'sub',
                  streamPath: 'p_camB_sub', ownerSeq: 0 })

    // Durante la consulta de camA se registra una sesión nueva para camB.
    let inyectado = false
    const server: any = {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      prisma: {
        camera: {
          findUnique: async ({ where }: any) => {
            if (!inyectado) {
              inyectado = true
              seedSession({ userId: 'u9', viewId: 'v9', cameraId: 'camB', streamType: 'sub',
                            streamPath: 'p_camB_sub', ownerSeq: 999 })
            }
            return h264(where.id)
          },
        },
      },
    }

    await cleanupUserSessions(server, 'u1', 'v1', ticket())

    // camB sobrevive con su sesión nueva y su path NO se retira.
    expect(removed).not.toContain('camB')
    expect(getActiveSessions().map(s => s.userId)).toEqual(['u9'])
  })
})

describe('#151b · el registro superado devuelve la sesión retenida', () => {
  it('responde con el path de la sesión que quedó, no con el propio', async () => {
    // Dos arranques concurrentes con la MISMA clave calculan paths distintos
    // porque el canal de la cámara cambió entre sus lecturas de la base.
    let release!: () => void
    publishGate = new Promise<void>(r => { release = r })

    let canal = 1
    const servidorMutante: any = {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      prisma: { camera: { findUnique: async ({ where }: any) => ({ ...h264(where.id), channel: canal }) } },
    }

    const start1 = ticket()
    const pendiente = startStream(servidorMutante, 'u1', 'camA', 'v1', 'sub', start1)
    await tick()

    // El arranque posterior reclama la clave con otro path.
    publishGate = null
    canal = 2
    const start2 = ticket()
    await startStream(servidorMutante, 'u1', 'camA', 'v1', 'sub', start2)
    const pathRetenido = getActiveSessions()[0].streamPath

    release()
    const r1 = await pendiente

    // start 1 responde con el path RETENIDO, no con el suyo.
    expect(r1.streamPath).toBe(pathRetenido)
    expect(r1.hlsUrl).toContain(pathRetenido)
    expect(getActiveSessions()).toHaveLength(1)
  })

  it('un registro NO superado sigue devolviendo su propio path', async () => {
    const r = await startStream(makeServer(), 'u1', 'camA', 'v1', 'sub', ticket())
    expect(r.error).toBeUndefined()
    expect(r.streamPath).toBe(getActiveSessions()[0].streamPath)
  })
})
