// Tests de la revisión de #152 (P1 abierto en el hilo r3770229771).
//
// Escenario: un arranque transcodificado GANA el registro con su path local
// (así que `registerTranscodeSession` no limpia nada) y, entre ese registro y
// la finalización, un arranque posterior del MISMO dueño reemplaza la fila con
// OTRO path. La finalización detecta el cambio ("finalize_repointed") y debe
// liberar el path local antes de responder; si no, el FFmpeg, la publicación en
// MediaMTX, el single-flight, la info de origen, los reinicios y la actividad
// del path descartado quedan huérfanos ocupando cupo sin dueño.
//
// Todo se prueba con barreras y promesas controladas —nada de temporizadores ni
// tiempos reales— y sobre el comportamiento observable del módulo, nunca sobre
// el texto del código.
//
// NOTA: `apps/api/tsconfig.json` excluye `src/**/*.test.ts`, así que este
// archivo no pasa por el `tsc` productivo. Por eso los tickets y las sesiones se
// construyen con helpers que delegan en la API real del módulo.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stopped: string[] = []
const removed: string[] = []
const spawned: string[] = []
const aliveProcesses = new Set<string>()
let hlsReadyGate: Promise<void> | null = null

vi.mock('./stream', () => ({
  getStreamPath: (_n: any, cam: any, type = 'sub') => `p_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async () => true,
  removeStream: async (_n: any, cam: any) => { removed.push(cam.id); return true },
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => true,
  // El path depende del CANAL: cambiarlo entre dos lecturas de la base es lo
  // que hace que dos arranques de la misma clave deriven paths distintos.
  getTranscodedStreamPath: (_n: any, cam: any) => `p_${cam.id}_ch${cam.channel}_main_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: () => ({ available: true, encoders: [] }),
  waitForHlsReady: async () => {
    if (hlsReadyGate) await hlsReadyGate
    return { ready: true, lastStatus: 200, elapsedMs: 10, processExited: false, manifestVisible: true }
  },
  spawnTranscodeProcess: (_n: any, _c: any, path: string) => {
    spawned.push(path); aliveProcesses.add(path)
    return { once: () => {}, pid: 6000 + spawned.length }
  },
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => { stopped.push(p); aliveProcesses.delete(p); return true },
  getTranscodeStderr: () => '',
  getStreamDetails: async () => ({ sourceType: 'rtspSession', active: true }),
  getActiveTranscodesList: () => Array.from(aliveProcesses).map(p => ({ streamPath: p, alive: true, pid: 6001 })),
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const {
  startStream, getActiveSessions, getTranscodeCounts, beginRequest,
  __seedSessionForTest, __setViewHeartbeatForTest, __setMediaActivityForTest,
  __resetSessionsForTest, __resetClosedViewsForTest, __isPathPublishedForTest,
  __getTranscodeInFlightPathsForTest, __hasTranscodeSourceInfoForTest,
  __hasTranscodeRestartsForTest, __hasMediaActivityForTest,
} = await import('./stream-manager')

type Ticket = ReturnType<typeof beginRequest>
const ticket = (): Ticket => beginRequest()
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)
const tick = () => new Promise(r => setImmediate(r))

const PATH_A = 'p_camH_ch1_main_h264'   // path del arranque VIEJO (canal 1)
const PATH_B = 'p_camH_ch2_main_h264'   // path del arranque NUEVO (canal 2)

const hevc = (id: string, channel = 1) => ({
  id, active: true, online: true, channel, name: id,
  mainCodec: 'hevc', subCodec: 'hevc', rtspSubOk: true, rtspMainOk: true,
  streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '10.0.0.1', rtspPort: 554 },
})

/** Servidor cuyo canal —y por lo tanto el path derivado— es mutable. */
function makeServerCanal(getCanal: () => number): any {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    prisma: { camera: { findUnique: async ({ where }: any) => hevc(where.id, getCanal()) } },
  }
}

/**
 * Siembra una sesión SIN marcar el proceso como vivo: si se marcara, el
 * arranque tomaría la rama de "reutilizar FFmpeg vivo" y nunca llegaría a la
 * compuerta HLS que estas pruebas necesitan.
 */
function seedSesionSinProceso(o: {
  userId: string; viewId: string; cameraId: string; streamPath: string; ownerSeq?: number
}): void {
  __seedSessionForTest({
    cameraId: o.cameraId, userId: o.userId, viewId: o.viewId,
    streamType: 'main_h264', streamPath: o.streamPath,
    startedAt: secondsAgo(10), lastClientHeartbeat: secondsAgo(0),
    lastOwnerRequestSeq: o.ownerSeq ?? 1,
  })
  __setViewHeartbeatForTest(o.userId, o.viewId, secondsAgo(0))
}

/** Cede turnos —sin relojes— hasta que haya `n` procesos spawneados. */
async function esperarSpawn(n: number): Promise<void> {
  for (let i = 0; i < 100 && spawned.length < n; i++) await tick()
  expect(spawned.length).toBeGreaterThanOrEqual(n)
}

/**
 * Reproduce el repunte POSTERIOR AL REGISTRO.
 *
 * Los dos arranques quedan detenidos en LA MISMA compuerta HLS, así que al
 * abrirla sus continuaciones se encolan en orden: el viejo registra primero
 * —gana la clave con su path local, sin limpieza— y el nuevo, con ticket mayor,
 * la reemplaza antes de que el viejo llegue a finalizar. Ese es exactamente el
 * hueco que el P1 dejaba sin limpiar.
 */
async function repunteTrasRegistro(extras?: {
  antesDelSegundo?: () => Promise<void> | void
  /** Se ejecuta con los dos arranques ya detenidos, antes de abrir la compuerta. */
  antesDeAbrir?: () => Promise<void> | void
}) {
  let abrir!: () => void
  hlsReadyGate = new Promise<void>(r => { abrir = r })

  let canal = 1
  const server = makeServerCanal(() => canal)

  const tViejo = ticket()
  const viejo = startStream(server, 'u1', 'camH', 'v1', 'main_h264', tViejo)
  await esperarSpawn(1)                    // el viejo ya publicó, spawneó y espera

  await extras?.antesDelSegundo?.()

  canal = 2                                // la base ahora devuelve otro canal
  const tNuevo = ticket()
  const nuevo = startStream(server, 'u1', 'camH', 'v1', 'main_h264', tNuevo)
  await esperarSpawn(2)                    // el nuevo espera en la MISMA compuerta

  await extras?.antesDeAbrir?.()

  abrir()
  const [rViejo, rNuevo] = await Promise.all([viejo, nuevo])
  return { rViejo, rNuevo, tNuevo }
}

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  stopped.length = 0; removed.length = 0; spawned.length = 0
  aliveProcesses.clear()
  hlsReadyGate = null
})

// ─── El escenario ocurre de verdad ───────────────────────────────────────────

describe('el repunte posterior al registro se reproduce', () => {
  it('(1) los dos arranques derivan paths distintos y la clave queda con el nuevo', async () => {
    await repunteTrasRegistro()

    expect(spawned).toEqual([PATH_A, PATH_B])
    const filas = getActiveSessions()
    expect(filas).toHaveLength(1)
    expect(filas[0].streamPath).toBe(PATH_B)
  })

  it('(2) la propiedad de la fila es la del ticket MÁS NUEVO', async () => {
    const { tNuevo } = await repunteTrasRegistro()
    expect(getActiveSessions()[0].lastOwnerRequestSeq).toBe(tNuevo.seq)
  })
})

// ─── El path local descartado se libera por completo ─────────────────────────

describe('el path local descartado no queda huérfano', () => {
  it('(3) su FFmpeg se termina', async () => {
    await repunteTrasRegistro()
    expect(stopped).toContain(PATH_A)
    expect(aliveProcesses.has(PATH_A)).toBe(false)
  })

  it('(4) se despublica de MediaMTX', async () => {
    await repunteTrasRegistro()
    expect(__isPathPublishedForTest(PATH_A)).toBe(false)
  })

  it('(5) no queda su single-flight colgado ni marcado como listo', async () => {
    await repunteTrasRegistro()
    expect(__getTranscodeInFlightPathsForTest()).not.toContain(PATH_A)
  })

  it('(6) se borra la info de origen, así el supervisor no puede resucitarlo', async () => {
    await repunteTrasRegistro()
    expect(__hasTranscodeSourceInfoForTest(PATH_A)).toBe(false)
    expect(__hasTranscodeRestartsForTest(PATH_A)).toBe(false)
  })

  it('(7) se borra su actividad de medio', async () => {
    // Se siembra actividad previa (la que dejaría un heartbeat anterior sobre
    // ese path): sin sembrarla la aserción no distinguiría nada.
    __setMediaActivityForTest(PATH_A, Date.now())

    await repunteTrasRegistro()

    expect(__hasMediaActivityForTest(PATH_A)).toBe(false)
  })

  it('(8) el cupo vuelve a contar un solo proceso', async () => {
    await repunteTrasRegistro()
    const counts = getTranscodeCounts()
    expect(counts.total).toBe(1)
    expect(Array.from(counts.occupiedPaths)).toEqual([PATH_B])
  })
})

// ─── El path retenido no se toca ─────────────────────────────────────────────

describe('la liberación no daña al path retenido', () => {
  it('(9) el retenido sigue vivo, publicado, listo y con actividad', async () => {
    await repunteTrasRegistro()

    expect(aliveProcesses.has(PATH_B)).toBe(true)
    expect(stopped).not.toContain(PATH_B)
    expect(__isPathPublishedForTest(PATH_B)).toBe(true)
    expect(__getTranscodeInFlightPathsForTest()).toContain(PATH_B)
    expect(__hasMediaActivityForTest(PATH_B)).toBe(true)
    // La cámara conserva una sesión: no se retira el path de la cámara entera.
    expect(removed).toEqual([])
  })

  it('(10) las dos respuestas apuntan al path retenido, no al descartado', async () => {
    const { rViejo, rNuevo } = await repunteTrasRegistro()

    for (const r of [rViejo, rNuevo]) {
      expect(r.error).toBeUndefined()
      expect(r.streamPath).toBe(PATH_B)
      expect(r.hlsUrl).toContain(PATH_B)
      expect(r.webrtcUrl).toContain(PATH_B)
      expect(r.hlsUrl).not.toContain(PATH_A)
    }
  })
})

// ─── No se retira lo que sí tiene otro dueño ─────────────────────────────────

describe('la liberación respeta a los dueños válidos del path local', () => {
  it('(11) otra sesión registrada sobre el path local lo conserva', async () => {
    seedSesionSinProceso({ userId: 'u9', viewId: 'v9', cameraId: 'camH', streamPath: PATH_A })

    await repunteTrasRegistro()

    expect(stopped).not.toContain(PATH_A)
    expect(aliveProcesses.has(PATH_A)).toBe(true)
    expect(__isPathPublishedForTest(PATH_A)).toBe(true)
    // Y el repunte igual respondió con el path retenido de SU clave.
    expect(getActiveSessions().find(s => s.userId === 'u1')!.streamPath).toBe(PATH_B)
  })

  it('(12) un waiter sobre el path local lo conserva y termina adoptándolo', async () => {
    let esperando!: Promise<any>

    const { rViejo } = await repunteTrasRegistro({
      antesDelSegundo: async () => {
        // Otra pestaña pide la MISMA cámara mientras el canal sigue siendo 1:
        // deriva PATH_A y queda esperando el single-flight del viejo.
        esperando = startStream(
          makeServerCanal(() => 1), 'u2', 'camH', 'v2', 'main_h264', ticket(),
        )
        await tick()
      },
    })

    const rWaiter = await esperando

    expect(rViejo.streamPath).toBe(PATH_B)          // el iniciador fue repuntado
    expect(stopped).not.toContain(PATH_A)           // pero su path se conservó
    expect(aliveProcesses.has(PATH_A)).toBe(true)
    // El waiter no recibe un fallo por un proceso que sigue vivo: lo adopta.
    expect(rWaiter.error).toBeUndefined()
    expect(rWaiter.streamPath).toBe(PATH_A)
    expect(getActiveSessions().find(s => s.userId === 'u2')!.streamPath).toBe(PATH_A)
  })
})

// ─── Conservado no es lo mismo que listo (revisión de #153) ──────────────────

describe('el single-flight local distingue "tiene dueño" de "está listo"', () => {
  /** Igual que el caso 12, pero FFmpeg muere tras superar `waitForHlsReady`. */
  async function waiterConProcesoMuerto() {
    let esperando!: Promise<any>

    const { rViejo } = await repunteTrasRegistro({
      antesDelSegundo: async () => {
        esperando = startStream(
          makeServerCanal(() => 1), 'u2', 'camH', 'v2', 'main_h264', ticket(),
        )
        await tick()
      },
      // El proceso local cae DESPUÉS de que la compuerta ya lo dio por listo y
      // ANTES de que la finalización resuelva el single-flight.
      antesDeAbrir: () => { aliveProcesses.delete(PATH_A) },
    })

    return { rViejo, rWaiter: await esperando }
  }

  it('(13) un waiter no recibe éxito sobre un path conservado pero con FFmpeg muerto', async () => {
    const { rViejo, rWaiter } = await waiterConProcesoMuerto()

    expect(rViejo.streamPath).toBe(PATH_B)              // el iniciador, repuntado
    expect(rWaiter.error?.code).toBe('TRANSCODE_NOT_READY')
    expect(rWaiter.streamPath).toBe('')
    expect(rWaiter.hlsUrl).toBe('')
  })

  it('(14) y no se registra ninguna sesión sobre ese path muerto', async () => {
    await waiterConProcesoMuerto()

    const filas = getActiveSessions()
    expect(filas).toHaveLength(1)
    expect(filas[0].streamPath).toBe(PATH_B)
    expect(filas.some(s => s.streamPath === PATH_A)).toBe(false)
  })

  it('(15) el path muerto se libera del todo: un waiter que va a fallar no lo conserva', async () => {
    // Un waiter sólo es dueño de algo que existe. Si el proceso murió, va a
    // recibir un fallo y retirarse, y nadie volvería a ejecutar la liberación:
    // conservarlo dejaría la publicación y el estado huérfanos para siempre.
    __setMediaActivityForTest(PATH_A, Date.now())

    await waiterConProcesoMuerto()

    expect(__isPathPublishedForTest(PATH_A)).toBe(false)
    expect(__hasTranscodeSourceInfoForTest(PATH_A)).toBe(false)
    expect(__hasTranscodeRestartsForTest(PATH_A)).toBe(false)
    expect(__hasMediaActivityForTest(PATH_A)).toBe(false)
    expect(__getTranscodeInFlightPathsForTest()).not.toContain(PATH_A)
    expect(getTranscodeCounts().total).toBe(1)
  })

  it('(16) una SESIÓN registrada sobre un path muerto sí lo conserva', async () => {
    // El otro tipo de dueño no se limpia por debajo: la fila existe y es la
    // purga por heartbeat la que decide su suerte, no una carrera de arranques.
    seedSesionSinProceso({ userId: 'u9', viewId: 'v9', cameraId: 'camH', streamPath: PATH_A })

    await repunteTrasRegistro({
      antesDeAbrir: () => { aliveProcesses.delete(PATH_A) },
    })

    expect(__isPathPublishedForTest(PATH_A)).toBe(true)
    expect(getActiveSessions().some(s => s.streamPath === PATH_A)).toBe(true)
  })
})
