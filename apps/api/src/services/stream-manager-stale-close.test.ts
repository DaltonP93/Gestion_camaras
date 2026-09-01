// A1 (post #160, 3ª vuelta) · el cierre por respuesta tardía, contra el
// `stopStream` REAL.
//
// LA CARRERA
//
//   1. A pide `main`; la cámara es HEVC y el backend crea `main_h264`.
//   2. B pide `main_h264` para la MISMA cámara y vista, y queda vigente.
//   3. B responde primero: la sesión efectiva pasa a ser suya.
//   4. A responde tarde y su descarte cierra `(u, v, cámara, main_h264)`.
//
// Esa cuádrupla es la de B. Y el DELETE de A saca su ticket al CERRARSE, o sea
// después del de B, así que ni el watermark ni `lastOwnerRequestSeq` lo frenan:
// borraba la sesión vigente y mataba su FFmpeg.
//
// Acá no hay backend falso: se ejecutan `startStream` y `stopStream` reales, con
// la capa de medios simulada igual que en el resto de las pruebas del módulo.
// Lo que se observa son los efectos verdaderos —sesiones en el mapa, procesos
// vivos, marcas de cierre— y no el retorno de una función auxiliar.
//
// NOTA: `apps/api/tsconfig.json` excluye `src/**/*.test.ts`, así que este
// archivo no pasa por el `tsc` productivo.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stopped: string[] = []
const spawned: string[] = []
/** Barrera dentro de publishStream: deja a un arranque pasado el punto de reuso. */
let publishGate: (() => Promise<void>) | null = null
const aliveProcesses = new Set<string>()

vi.mock('./stream', () => ({
  getStreamPath: (_n: any, cam: any, type = 'sub') => `p_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async () => { if (publishGate) await publishGate(); return true },
  removeStream: async () => true,
  removeTranscodedPath: async () => true,
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => true,
  getTranscodedStreamPath: (_n: any, cam: any) => `p_${cam.id}_ch${cam.channel}_main_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: () => ({ available: true, encoders: [] }),
  waitForHlsReady: async () => ({
    ready: true, lastStatus: 200, elapsedMs: 10, processExited: false, manifestVisible: true,
  }),
  spawnTranscodeProcess: (_n: any, _c: any, path: string) => {
    spawned.push(path); aliveProcesses.add(path)
    return { once: () => {}, pid: 9000 + spawned.length }
  },
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => { stopped.push(p); aliveProcesses.delete(p); return true },
  getTranscodeStderr: () => '',
  getStreamDetails: async () => ({ sourceType: 'rtspSession', active: true }),
  getActiveTranscodesList: () => Array.from(aliveProcesses).map(p => ({ streamPath: p, alive: true, pid: 9001 })),
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const {
  startStream, stopStream, reconcileView, touchView, touchSession,
  getActiveSessions, beginRequest, describeStartAttempt,
  __resetSessionsForTest, __resetClosedViewsForTest, __resetTombstonesForTest,
  STALE_RESPONSE_REASON,
} = await import('./stream-manager')

const hevc = (id: string, channel = 1) => ({
  id, active: true, online: true, channel, name: id,
  mainCodec: 'hevc', subCodec: 'h264', rtspSubOk: true, rtspMainOk: true,
  streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '10.0.0.1', rtspPort: 554 },
})
// Variantes de cámara para forzar cada redirección efectiva del sub.
const subH264       = (id: string, ch = 1) => ({ ...hevc(id, ch), mainCodec: 'h264', subCodec: 'h264' })   // sub queda sub
const subHevcMainOk = (id: string, ch = 1) => ({ ...hevc(id, ch), mainCodec: 'h264', subCodec: 'hevc' })   // sub → main
const bothHevc      = (id: string, ch = 1) => ({ ...hevc(id, ch), mainCodec: 'hevc', subCodec: 'hevc' })   // sub → main_h264

/** Barrera opcional dentro de la consulta de la cámara, para cruzar arranques. */
let dbGate: (() => Promise<void>) | null = null
/** Cámara que devuelve la DB en cada test; por defecto HEVC (main→main_h264). */
let camFactory: (id: string, channel?: number) => any = hevc

const server: any = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  prisma: {
    camera: {
      findUnique: async ({ where }: any) => {
        if (dbGate) await dbGate()
        return camFactory(where.id)
      },
    },
    // `startStream` actualiza marcas de salud en algunas ramas.
    $executeRaw: async () => 0,
  },
}

function diferida() {
  let resolver!: () => void
  const promise = new Promise<void>(r => { resolver = r })
  return { promise, resolver }
}

const U = 'u1', V = 'v1', CAM = 'camHevc'
const PATH_HD = 'p_camHevc_ch1_main_h264'

const sesiones = () => getActiveSessions().filter(s => s.cameraId === CAM)
const hd = () => sesiones().find(s => s.streamType === 'main_h264')
/** Arrendamientos vivos sobre la sesión HD. */
const leases = () => Array.from(hd()?.startAttemptIds ?? [])
const tick = () => new Promise(r => setImmediate(r))

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  __resetTombstonesForTest()
  stopped.length = 0; spawned.length = 0
  aliveProcesses.clear()
  dbGate = null
  publishGate = null
  camFactory = hevc
})

// ─── 1 · la carrera completa ─────────────────────────────────────────────────

describe('A pide main (redirigida a main_h264) y B pide main_h264', () => {
  it('el descarte de A suelta SÓLO su arrendamiento; la sesión y el FFmpeg de B siguen', async () => {
    const A = 'sa-A-1'
    const B = 'sa-B-2'

    // A: pide `main`; la cámara es HEVC ⇒ el backend crea `main_h264`.
    const rA = await startStream(server, U, CAM, V, 'main', beginRequest(), A)
    expect(rA.streamPath).toBe(PATH_HD)
    expect(leases()).toEqual([A])

    // B: pide `main_h264` sobre la misma ranura. NO desplaza a A: se suma.
    const rB = await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)
    expect(rB.streamPath).toBe(PATH_HD)
    expect(leases().sort()).toEqual([A, B])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)

    // A responde tarde y se descarta.
    const r = await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), A)

    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: A, remainingAttempts: 1 })
    expect(hd()).toBeDefined()
    expect(leases()).toEqual([B])
    expect(stopped).toEqual([])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  })

  it('el orden de LLEGADA invertido no cambia nada: B llega primero, A después', async () => {
    // ÉSTE es el caso que rompía la versión de dueño único. El usuario inicia A
    // y después B, pero B llega primero al servidor; A llega con un ticket
    // MAYOR y le arrebataba la propiedad a B. Con arrendamientos no hay nada
    // que arrebatar.
    const A = 'sa-A-logicamente-primero'
    const B = 'sa-B-logicamente-segundo'

    // Los tickets se sacan en el orden de LLEGADA: B primero.
    const ticketB = beginRequest()
    const ticketA = beginRequest()
    expect(ticketA.seq).toBeGreaterThan(ticketB.seq)

    await startStream(server, U, CAM, V, 'main_h264', ticketB, B)   // B llega antes
    await startStream(server, U, CAM, V, 'main', ticketA, A)        // A llega después

    expect(leases().sort()).toEqual([A, B].sort())

    // A —vieja para el navegador— se descarta y suelta lo suyo.
    const r = await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), A)

    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: A })
    expect(leases()).toEqual([B])
    expect(hd()).toBeDefined()
    expect(stopped).toEqual([])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  })

  it('cuando B también suelta, recién ahí cae la sesión y muere el proceso', async () => {
    const A = 'sa-A-1', B = 'sa-B-2'
    await startStream(server, U, CAM, V, 'main', beginRequest(), A)
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)

    const r1 = await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), A)
    expect(r1.outcome).toBe('attempt_released')
    expect(aliveProcesses.has(PATH_HD)).toBe(true)

    const r2 = await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), B)
    expect(r2).toMatchObject({ outcome: 'session_closed', attemptId: B })
    expect(hd()).toBeUndefined()
    expect(stopped).toEqual([PATH_HD])
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
  })

  it('sin la identidad, ese mismo cierre habría matado la sesión de B', async () => {
    // Contraste explícito: el cierre deliberado —el que no declara intento—
    // sigue cerrando la ranura entera, que es lo que se le pide. La diferencia
    // entre uno y otro es exactamente lo que aporta esta corrección.
    await startStream(server, U, CAM, V, 'main', beginRequest(), 'sa-A-1')
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B-2')

    const r = await stopStream(server, U, CAM, 'main_h264', 'nvr_change', V, beginRequest())

    expect(r.outcome).toBe('session_closed')
    expect(hd()).toBeUndefined()
    expect(stopped).toEqual([PATH_HD])
  })

  it('el cierre tardío del propio B sí cierra y mata su FFmpeg', async () => {
    const B = 'sa-B-2'
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)
    expect(aliveProcesses.has(PATH_HD)).toBe(true)

    const r = await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), B)

    expect(r).toMatchObject({ outcome: 'session_closed', attemptId: B, killedFfmpeg: true })
    expect(hd()).toBeUndefined()
    expect(stopped).toEqual([PATH_HD])
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
  })
})

// ─── P0-1 · un cierre conservador no puede consumir uno terminante ───────────
//
// `hls_fatal_error`/`grid_retry`/`quality_switch`/`restart_stream` borran la
// sesión pero CONSERVAN el FFmpeg (para reutilizarlo). Si nadie lo reutiliza, un
// cierre TERMINANTE posterior debe poder matarlo por LÁPIDA. Nunca una B que
// reutiliza el path.
describe('P0-1: escalada de cierre terminante tras uno conservador', () => {
  it.each([
    ['hls_fatal_error', 'page_change'],
    ['grid_retry', 'exit_focus'],
    ['quality_switch', 'exit_fullscreen'],
    ['restart_stream', 'nvr_change'],
  ])('conservador «%s» conserva el FFmpeg; terminante «%s» lo mata por lápida', async (conservador, terminante) => {
    const A = 'sa-A'
    await startStream(server, U, CAM, V, 'main', beginRequest(), A)   // main_h264, FFmpeg vivo
    expect(aliveProcesses.has(PATH_HD)).toBe(true)

    const c1 = await stopStream(server, U, CAM, 'main_h264', conservador, V, beginRequest(), A)
    expect(c1.outcome).toBe('session_closed')
    expect(c1.killedFfmpeg).toBeFalsy()             // conservó el proceso
    expect(hd()).toBeUndefined()                    // pero borró la sesión
    expect(aliveProcesses.has(PATH_HD)).toBe(true)  // FFmpeg HUÉRFANO

    const c2 = await stopStream(server, U, CAM, 'main_h264', terminante, V, beginRequest(), A)
    expect(c2).toMatchObject({ outcome: 'session_closed', killedFfmpeg: true })
    expect(aliveProcesses.has(PATH_HD)).toBe(false) // escalada: lo mató
  })

  it('el orden inverso (terminante primero) también termina el proceso, sin lápida', async () => {
    const A = 'sa-A'
    await startStream(server, U, CAM, V, 'main', beginRequest(), A)
    const c1 = await stopStream(server, U, CAM, 'main_h264', 'page_change', V, beginRequest(), A)
    expect(c1).toMatchObject({ outcome: 'session_closed', killedFfmpeg: true })
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
    // El conservador posterior ya no encuentra sesión ni proceso: no hace nada.
    const c2 = await stopStream(server, U, CAM, 'main_h264', 'hls_fatal_error', V, beginRequest(), A)
    expect(c2.outcome).toBe('ignored')
  })

  it('A conservador deja el FFmpeg; B lo reutiliza; un terminante de A NO mata a B', async () => {
    await startStream(server, U, CAM, V, 'main', beginRequest(), 'sa-A')
    await stopStream(server, U, CAM, 'main_h264', 'hls_fatal_error', V, beginRequest(), 'sa-A')
    expect(aliveProcesses.has(PATH_HD)).toBe(true)

    // B reutiliza el mismo path (adopta el FFmpeg vivo).
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B')
    expect(hd()).toBeDefined()
    expect(leases()).toEqual(['sa-B'])

    // Terminante de A: hay sesión B en la ranura → no escala; sa-A no es su lease.
    const c = await stopStream(server, U, CAM, 'main_h264', 'page_change', V, beginRequest(), 'sa-A')
    expect(c.outcome).toBe('ignored')
    expect(hd()).toBeDefined()
    expect(aliveProcesses.has(PATH_HD)).toBe(true)   // B y su FFmpeg intactos
  })

  it('un terminante confirmado por lápida, repetido, ya no encuentra proceso', async () => {
    await startStream(server, U, CAM, V, 'main', beginRequest(), 'sa-A')
    await stopStream(server, U, CAM, 'main_h264', 'hls_fatal_error', V, beginRequest(), 'sa-A')
    const c2 = await stopStream(server, U, CAM, 'main_h264', 'page_change', V, beginRequest(), 'sa-A')
    expect(c2.killedFfmpeg).toBe(true)
    // Repetir el terminante: la lápida ya se consumió, no hay nada que matar.
    const c3 = await stopStream(server, U, CAM, 'main_h264', 'page_change', V, beginRequest(), 'sa-A')
    expect(c3.outcome).toBe('ignored')
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
  })

  it('una identidad que NO coincide con la lápida no escala', async () => {
    await startStream(server, U, CAM, V, 'main', beginRequest(), 'sa-A')
    await stopStream(server, U, CAM, 'main_h264', 'hls_fatal_error', V, beginRequest(), 'sa-A')
    // Un terminante con OTRA identidad no mata el proceso de A.
    const c = await stopStream(server, U, CAM, 'main_h264', 'page_change', V, beginRequest(), 'sa-OTRA')
    expect(c.outcome).toBe('ignored')
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  })
})

// ─── 2 · el rechazo no deja rastro ───────────────────────────────────────────

describe('un cierre tardío rechazado no avanza la marca de cierre', () => {
  it('un arranque posterior no queda bloqueado', async () => {
    const A = 'sa-A-1', B = 'sa-B-2', C = 'sa-C-3'
    await startStream(server, U, CAM, V, 'main', beginRequest(), A)
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)

    // Cierre tardío de A: rechazado por identidad.
    await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), A)
    // B se cierra deliberadamente, como al salir de foco.
    await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, beginRequest())
    expect(hd()).toBeUndefined()

    // Y ahora un arranque NUEVO tiene que poder registrar su sesión. Si el
    // cierre rechazado hubiera avanzado el watermark, este arranque se
    // cancelaría solo (`view_closed_during_start`) y la cámara quedaría negra.
    const rC = await startStream(server, U, CAM, V, 'main_h264', beginRequest(), C)

    expect(rC.error).toBeUndefined()
    expect(leases()).toEqual([C])
  })

  it('no avanza la marca de cierre: un arranque EN VUELO no queda cancelado', async () => {
    // El watermark sólo frena peticiones ANTERIORES al cierre, así que para
    // verlo hace falta un arranque que ya esté viajando cuando llega el cierre
    // rechazado. Si el rechazo marcara igual, este arranque se cancelaría solo
    // (`view_closed_during_start`) y la cámara se quedaría negra.
    const A = 'sa-A-1', B = 'sa-B-2', C = 'sa-C-3'
    await startStream(server, U, CAM, V, 'main', beginRequest(), A)
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)
    // B se va por la puerta normal; queda la ranura libre.
    await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, beginRequest())

    // C arranca y queda esperando dentro de la consulta de la cámara.
    const puerta = diferida()
    dbGate = () => puerta.promise
    const arranqueC = startStream(server, U, CAM, V, 'main_h264', beginRequest(), C)
    await tick()

    // Con C en vuelo llega el cierre tardío de A: ranura vacía ⇒ rechazado.
    dbGate = null
    await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), A)

    puerta.resolver()
    const rC = await arranqueC

    expect(rC.error).toBeUndefined()
    expect(leases()).toEqual([C])
  })

  it('sin `expectedStartAttemptId` el cierre tardío no hace nada', async () => {
    const B = 'sa-B-2'
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)

    await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest())

    expect(leases()).toContain(B)
    expect(stopped).toEqual([])
  })

  it('un cierre tardío sobre una ranura vacía tampoco marca nada', async () => {
    const A = 'sa-A-1'
    await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), A)

    // El arranque que venía en camino no puede quedar cancelado por eso.
    const r = await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-Z-9')
    expect(r.error).toBeUndefined()
    expect(leases()).toEqual(['sa-Z-9'])
  })
})

// ─── 3 · reutilización ───────────────────────────────────────────────────────

describe('reutilizar una sesión SUMA un arrendamiento, no reemplaza', () => {
  it('B reutiliza la de A y las dos quedan como espectadoras', async () => {
    const A = 'sa-A-1', B = 'sa-B-2'
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), A)
    // B pide lo mismo: no se crea otra, se reutiliza la existente.
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)

    expect(leases().sort()).toEqual([A, B])

    // El descarte de A suelta lo suyo y deja viva la de B.
    const r = await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), A)
    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: A })
    expect(leases()).toEqual([B])
    expect(stopped).toEqual([])
  })

  it('también en `sub`: dos arranques de grilla dejan dos arrendamientos', async () => {
    // La reutilización de `sub`/`main` es un camino distinto del de
    // `main_h264`, con su propio registro. Los dos tienen que sumar.
    const A = 'sa-A-1', B = 'sa-B-2'
    await startStream(server, U, CAM, V, 'sub', beginRequest(), A)
    await startStream(server, U, CAM, V, 'sub', beginRequest(), B)

    const sub = sesiones().find(x => x.streamType === 'sub')!
    expect(Array.from(sub.startAttemptIds).sort()).toEqual([A, B])

    const r = await stopStream(server, U, CAM, 'sub', STALE_RESPONSE_REASON, V, beginRequest(), A)
    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: A, remainingAttempts: 1 })
    expect(sesiones().find(x => x.streamType === 'sub')).toBeDefined()
  })

  it('un arranque que llega tarde y NO pisa la fila igual deja su arrendamiento', async () => {
    // `registerSessionMonotonic` conserva la sesión de una petición POSTERIOR y
    // descarta la fila del arranque viejo. Pero ese arranque viejo también es un
    // espectador: si no se suma su arrendamiento, su descarte no encontraría
    // nada que soltar y su sesión viviría hasta el TTL.
    const A = 'sa-A-vieja', B = 'sa-B-nueva'
    const tA = beginRequest()          // A saca su ticket primero…
    const tB = beginRequest()          // …y B después

    // La barrera va en `publishStream`: así A ya pasó el punto de reutilización
    // —todavía no había sesión— y llega a registrar cuando la de B ya existe,
    // que es la rama "se conserva la más nueva".
    const puerta = diferida()
    publishGate = () => puerta.promise
    const arranqueA = startStream(server, U, CAM, V, 'sub', tA, A)   // A queda esperando
    await tick()

    publishGate = null
    await startStream(server, U, CAM, V, 'sub', tB, B)               // B completa primero
    puerta.resolver()
    await arranqueA                                                   // A registra tarde

    const sub = sesiones().find(x => x.streamType === 'sub')!
    expect(sub.lastOwnerRequestSeq).toBeGreaterThanOrEqual(tB.seq)
    expect(Array.from(sub.startAttemptIds).sort()).toEqual([A, B].sort())

    // Y el descarte de A suelta lo suyo sin tocar a B.
    const r = await stopStream(server, U, CAM, 'sub', STALE_RESPONSE_REASON, V, beginRequest(), A)
    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: A })
    expect(Array.from(sesiones().find(x => x.streamType === 'sub')!.startAttemptIds)).toEqual([B])
  })

  it('reutilizar NO borra el arrendamiento anterior aunque llegue con ticket mayor', async () => {
    // El ticket ordena llegadas, no intenciones del navegador. Usarlo para
    // decidir la propiedad era el defecto.
    const A = 'sa-A-1', B = 'sa-B-2'
    const tB = beginRequest(); const tA = beginRequest()
    await startStream(server, U, CAM, V, 'main_h264', tB, B)
    await startStream(server, U, CAM, V, 'main_h264', tA, A)

    expect(tA.seq).toBeGreaterThan(tB.seq)
    expect(leases().sort()).toEqual([A, B])
  })
})

// ─── 4 · sub y main_h264 conviven ────────────────────────────────────────────

describe('sub de grilla y main_h264 de foco a la vez', () => {
  it('el cierre tardío del HD no toca el sub', async () => {
    const S = 'sa-S-1', H = 'sa-H-2'
    await startStream(server, U, CAM, V, 'sub', beginRequest(), S)
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), H)
    expect(sesiones().map(s => s.streamType).sort()).toEqual(['main_h264', 'sub'])

    const r = await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), H)

    expect(r.outcome).toBe('session_closed')
    expect(sesiones().map(s => s.streamType)).toEqual(['sub'])
    expect(Array.from(sesiones()[0].startAttemptIds)).toEqual([S])
  })

  it('el cierre tardío del sub no toca el HD', async () => {
    const S = 'sa-S-1', H = 'sa-H-2'
    await startStream(server, U, CAM, V, 'sub', beginRequest(), S)
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), H)

    await stopStream(server, U, CAM, 'sub', STALE_RESPONSE_REASON, V, beginRequest(), S)

    expect(sesiones().map(s => s.streamType)).toEqual(['main_h264'])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  })
})

// ─── 5 · los tres orígenes del frontend ──────────────────────────────────────

describe('los tres orígenes de start-stream llevan su propio intento', () => {
  it.each([
    ['grilla',   'sub' as const,        'sa-grid-1'],
    ['foco/HD',  'main' as const,       'sa-focus-1'],
    ['calidad',  'main_h264' as const,  'sa-quality-1'],
  ])('%s: la sesión creada queda a nombre de su intento', async (_origen, tipo, intento) => {
    await startStream(server, U, CAM, V, tipo, beginRequest(), intento)

    // `main` se redirige a `main_h264` (cámara HEVC): el arrendamiento viaja igual.
    const creada = sesiones()[0]
    expect(creada).toBeDefined()
    expect(Array.from(creada.startAttemptIds)).toEqual([intento])

    // Y sólo ese intento puede cerrarla por respuesta tardía.
    await stopStream(server, U, CAM, creada.streamType, STALE_RESPONSE_REASON, V, beginRequest(), 'sa-otro-9')
    expect(sesiones()).toHaveLength(1)

    await stopStream(server, U, CAM, creada.streamType, STALE_RESPONSE_REASON, V, beginRequest(), intento)
    expect(sesiones()).toHaveLength(0)
  })
})

// ─── 6 · el estado que se le devuelve al cliente ─────────────────────────────

describe('describeStartAttempt refleja el mapa de sesiones, no el cuerpo enviado', () => {
  it('registrado, con la cuenta de arrendamientos', async () => {
    const A = 'sa-A-1', B = 'sa-B-2'
    await startStream(server, U, CAM, V, 'main', beginRequest(), A)
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)

    expect(describeStartAttempt({
      userId: U, viewId: V, cameraId: CAM, streamType: 'main_h264', attemptId: A,
    })).toEqual({ registered: true, owners: 2 })
  })

  it('un intento que el servidor NO registró se informa como tal', async () => {
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B-2')

    // Devolver el eco del cuerpo diría `sa-Z-9` y el cliente se creería dueño.
    expect(describeStartAttempt({
      userId: U, viewId: V, cameraId: CAM, streamType: 'main_h264', attemptId: 'sa-Z-9',
    })).toEqual({ registered: false, owners: 1 })
  })

  it('sin sesión en la ranura: ni registrado ni dueños', () => {
    expect(describeStartAttempt({
      userId: U, viewId: V, cameraId: CAM, streamType: 'main_h264', attemptId: 'sa-A-1',
    })).toEqual({ registered: false, owners: 0 })
  })

  it('un arranque sin intento declarado nunca figura como registrado', async () => {
    await startStream(server, U, CAM, V, 'main_h264', beginRequest())

    expect(describeStartAttempt({
      userId: U, viewId: V, cameraId: CAM, streamType: 'main_h264', attemptId: undefined,
    })).toEqual({ registered: false, owners: 0 })
  })

  it('tras soltar su arrendamiento, deja de figurar', async () => {
    const A = 'sa-A-1', B = 'sa-B-2'
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), A)
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)
    await stopStream(server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, beginRequest(), A)

    expect(describeStartAttempt({
      userId: U, viewId: V, cameraId: CAM, streamType: 'main_h264', attemptId: A,
    })).toEqual({ registered: false, owners: 1 })
  })
})

// ─── 7 · el heartbeat no puede retener el último arrendamiento ───────────────
//
// LA FUGA
//
//   existe `sub` de grilla y `main_h264` con un único arrendamiento A;
//   el DELETE stale de A entra y saca el ticket T;
//   se demora antes de llegar a `stopStream` (autenticación, cola…);
//   un `reconcileView` posterior llega con T+1 y TOCA el `main_h264`;
//   `reaffirmOwnership` sube `lastOwnerRequestSeq` a T+1;
//   al reanudarse el DELETE, el veredicto dice `close_session`, pero la
//   protección por ticket contestaba `reaffirmed_by_newer_request`.
//
// Resultado: `ignored`. A seguía arrendando, la sesión viva y el FFmpeg
// corriendo sin nadie mirándolo, hasta el TTL.
//
// Un heartbeat de grilla NO es una intención lógica nueva sobre el HD.

describe('un heartbeat posterior no bloquea el cierre del último arrendamiento', () => {
  it('la secuencia completa termina en session_closed y sin FFmpeg', async () => {
    const S = 'sa-sub-1', A = 'sa-hd-2'

    // 1 y 2 · sub de grilla y main_h264 con un único arrendamiento.
    await startStream(server, U, CAM, V, 'sub', beginRequest(), S)
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), A)
    expect(leases()).toEqual([A])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)

    // 3 · el DELETE stale saca su ticket y queda demorado.
    const ticketDelete = beginRequest()

    // 4 · el heartbeat llega DESPUÉS y toca la sesión HD.
    const ticketHeartbeat = beginRequest()
    expect(ticketHeartbeat.seq).toBeGreaterThan(ticketDelete.seq)
    const marcaAntes = hd()!.lastOwnerRequestSeq
    const latidoAntes = hd()!.lastClientHeartbeat.getTime()
    await reconcileView(server, U, V, [CAM], [], ticketHeartbeat)
    // El heartbeat renueva el TTL del HD…
    expect(hd()!.lastClientHeartbeat.getTime()).toBeGreaterThanOrEqual(latidoAntes)
    // …pero NO eleva la marca de propiedad: no es una intención sobre el HD.
    expect(hd()!.lastOwnerRequestSeq).toBe(marcaAntes)

    // 5 · recién ahora corre el cierre, con el ticket que había reservado.
    const r = await stopStream(
      server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, ticketDelete, A,
    )

    // 6 · el arrendamiento se soltó, la sesión cayó y el proceso murió.
    expect(r).toMatchObject({ outcome: 'session_closed', attemptId: A })
    expect(hd()).toBeUndefined()
    expect(leases()).toEqual([])
    expect(stopped).toEqual([PATH_HD])
    expect(aliveProcesses.has(PATH_HD)).toBe(false)

    // Y el `sub` de la grilla —que el heartbeat sí sostiene— sigue en pie.
    expect(sesiones().map(x => x.streamType)).toEqual(['sub'])
  })

  it('varios heartbeats seguidos tampoco lo retienen', async () => {
    const A = 'sa-hd-2'
    await startStream(server, U, CAM, V, 'sub', beginRequest(), 'sa-sub-1')
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), A)
    const ticketDelete = beginRequest()

    for (let i = 0; i < 3; i++) await reconcileView(server, U, V, [CAM], [], beginRequest())

    const r = await stopStream(
      server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, ticketDelete, A,
    )

    expect(r.outcome).toBe('session_closed')
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
  })

  it('pero un ARRANQUE posterior sí lo retiene: suelta A y conserva la sesión', async () => {
    // La protección que sí debe seguir en pie. Un arranque nuevo es una
    // intención lógica nueva, y se distingue porque SUMA su arrendamiento.
    const A = 'sa-hd-2', B = 'sa-hd-3'
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), A)
    const ticketDelete = beginRequest()
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), B)

    const r = await stopStream(
      server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, ticketDelete, A,
    )

    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: A, remainingAttempts: 1 })
    expect(leases()).toEqual([B])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  })

  it('y una sesión REABIERTA tampoco se cierra por un arrendamiento viejo', async () => {
    // Otra generación en la misma ranura: eso sí es algo genuinamente nuevo.
    const A = 'sa-hd-2', C = 'sa-hd-9'
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), A)
    const ticketDelete = beginRequest()
    // La sesión se cierra deliberadamente y se vuelve a abrir con otro intento.
    await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, beginRequest())
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), C)
    const generacionNueva = hd()!.generation

    const r = await stopStream(
      server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, ticketDelete, A,
    )

    expect(r.outcome).toBe('ignored')
    expect(hd()!.generation).toBe(generacionNueva)
    expect(leases()).toEqual([C])
  })

  it('el cierre deliberado conserva su protección por ticket', async () => {
    // Sin arrendamiento declarado se sigue usando `resolveDeletable`: un
    // arranque posterior debe impedir que un cierre viejo borre la fila nueva.
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-A-1')
    const ticketViejo = beginRequest()
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B-2')

    const r = await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, ticketViejo)

    expect(r).toMatchObject({ outcome: 'ignored', reason: 'reaffirmed_by_newer_request' })
    expect(hd()).toBeDefined()
  })
})

// ─── 8 · el heartbeat tampoco bloquea un cierre DELIBERADO de HD ─────────────
//
// LA FUGA (quinta revisión)
//
//   existe `sub` de grilla y `main_h264` de foco;
//   el usuario sale de foco y el DELETE `exit_focus` saca el ticket T;
//   un `reconcileView` posterior llega con T+1 y toca el HD co-locado;
//   `reaffirmOwnership` convertía ese keepalive pasivo en "propiedad nueva";
//   el cierre llegaba y `resolveDeletable` contestaba
//   `reaffirmed_by_newer_request` ⇒ `ignored`.
//
// La sesión HD y su FFmpeg sobrevivían a la salida de foco por culpa de un
// heartbeat de la GRILLA, que no dice nada sobre el HD.

describe('un heartbeat de grilla no bloquea el cierre deliberado del HD', () => {
  const conSubYHd = async () => {
    await startStream(server, U, CAM, V, 'sub', beginRequest(), 'sa-sub-1')
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-hd-2')
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  }

  it.each(['exit_focus', 'switch_to_sub'])('«%s» cierra el HD y deja el sub vivo', async (razon) => {
    await conSubYHd()

    // El cierre reserva su ticket…
    const ticketCierre = beginRequest()
    // …y el heartbeat de grilla llega DESPUÉS y toca el HD co-locado.
    await reconcileView(server, U, V, [CAM], [], beginRequest())

    const r = await stopStream(server, U, CAM, 'main_h264', razon, V, ticketCierre)

    expect(r.outcome).toBe('session_closed')
    expect(hd()).toBeUndefined()
    expect(stopped).toEqual([PATH_HD])
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
    // El `sub` de la grilla —de lo que el heartbeat sí habla— sigue en pie.
    expect(sesiones().map(x => x.streamType)).toEqual(['sub'])
  })

  it('varios heartbeats seguidos tampoco lo bloquean', async () => {
    await conSubYHd()
    const ticketCierre = beginRequest()
    for (let i = 0; i < 3; i++) await reconcileView(server, U, V, [CAM], [], beginRequest())

    expect((await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, ticketCierre)).outcome)
      .toBe('session_closed')
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
  })

  it('`touchView` tampoco: el HD renueva TTL pero no propiedad', async () => {
    await conSubYHd()
    const ticketCierre = beginRequest()
    const marca = hd()!.lastOwnerRequestSeq

    touchView(U, V, beginRequest())

    expect(hd()!.lastOwnerRequestSeq).toBe(marca)
    expect((await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, ticketCierre)).outcome)
      .toBe('session_closed')
  })

  it('`touchSession` sobre el HD tampoco', async () => {
    await conSubYHd()
    const ticketCierre = beginRequest()
    const marca = hd()!.lastOwnerRequestSeq

    touchSession(U, CAM, 'main_h264', beginRequest(), V)

    expect(hd()!.lastOwnerRequestSeq).toBe(marca)
    expect((await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, ticketCierre)).outcome)
      .toBe('session_closed')
  })

  it('pero un ARRANQUE real posterior SÍ protege la sesión nueva', async () => {
    // La garantía que no se puede debilitar: un cierre viejo no puede matar lo
    // que un arranque posterior acaba de establecer.
    await conSubYHd()
    const ticketCierre = beginRequest()
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-hd-B')

    const r = await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, ticketCierre)

    expect(r).toMatchObject({ outcome: 'ignored', reason: 'reaffirmed_by_newer_request' })
    expect(hd()).toBeDefined()
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
    expect(leases()).toContain('sa-hd-B')
  })

  it('el `sub` visible conserva su reafirmación: su heartbeat sí es propiedad', async () => {
    await startStream(server, U, CAM, V, 'sub', beginRequest(), 'sa-sub-1')
    const ticketCierre = beginRequest()
    await reconcileView(server, U, V, [CAM], [], beginRequest())

    // Un cierre anterior al heartbeat NO puede borrar el sub que la grilla
    // sigue usando: ése es el comportamiento que se mantiene.
    const r = await stopStream(server, U, CAM, 'sub', 'viewport_change', V, ticketCierre)

    expect(r).toMatchObject({ outcome: 'ignored', reason: 'reaffirmed_by_newer_request' })
    expect(sesiones().map(x => x.streamType)).toEqual(['sub'])
  })
})

// ─── 9 · un cierre ignorado no deja watermark ────────────────────────────────

describe('la marca de cierre se estampa sólo cuando el cierre surte efecto', () => {
  it('un cierre deliberado `ignored` no cancela un arranque anterior en vuelo', async () => {
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-A-1')

    // Un arranque reserva su ticket AHORA y corre más tarde (autenticación,
    // cola…): es el que quedaría cancelado si el cierre estampara la marca.
    const ticketArranqueViejo = beginRequest()
    const ticketCierre = beginRequest()
    // Un arranque posterior hace que el cierre sea `ignored`.
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B-2')

    const r = await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, ticketCierre)
    expect(r.outcome).toBe('ignored')

    // El arranque viejo llega y debe poder reclamar su arrendamiento.
    const rc = await startStream(server, U, CAM, V, 'main_h264', ticketArranqueViejo, 'sa-C-3')

    expect(rc.error).toBeUndefined()
    expect(leases()).toContain('sa-C-3')
  })

  it('un cierre stale `ignored` tampoco', async () => {
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-A-1')
    const ticketArranqueViejo = beginRequest()
    const ticketCierre = beginRequest()

    // Intento no registrado ⇒ `ignored`.
    const r = await stopStream(
      server, U, CAM, 'main_h264', STALE_RESPONSE_REASON, V, ticketCierre, 'sa-Z-9',
    )
    expect(r.outcome).toBe('ignored')

    const rc = await startStream(server, U, CAM, V, 'main_h264', ticketArranqueViejo, 'sa-C-3')
    expect(rc.error).toBeUndefined()
    expect(leases()).toContain('sa-C-3')
  })

  it('un cierre que SÍ cierra sigue cancelando el arranque anterior en vuelo', async () => {
    // La garantía que no se puede perder: la marca existe para que un arranque
    // que venía en camino no registre una sesión que el usuario ya cerró.
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-A-1')
    const ticketArranqueViejo = beginRequest()
    const ticketCierre = beginRequest()

    expect((await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, ticketCierre)).outcome)
      .toBe('session_closed')

    const rc = await startStream(server, U, CAM, V, 'main_h264', ticketArranqueViejo, 'sa-C-3')

    expect(rc.error?.code).toBe('VIEW_CLOSED')
    expect(hd()).toBeUndefined()
  })
})

// ─── 10 · cierre deliberado con identidad: la guarda no es sólo para stale ────
//
// Séptima revisión: un retry de `exit_focus`/`switch_to_sub` del intento A no
// puede cerrar una sesión B abierta después sobre la misma cámara/tipo. La
// guarda de identidad corre ANTES de `markTargetClosed`, del borrado y del kill,
// también para los cierres deliberados.

describe('cierre deliberado con `expectedStartAttemptId`', () => {
  it('exit_focus de A no toca la sesión B que ocupó la ranura después', async () => {
    // B es la única sesión viva de la ranura HD.
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B')
    expect(leases()).toEqual(['sa-B'])

    const r = await stopStream(
      server, U, CAM, 'main_h264', 'exit_focus', V, beginRequest(), 'sa-A',
    )

    expect(r).toMatchObject({ outcome: 'ignored', reason: 'attempt_not_registered' })
    expect(hd()).toBeDefined()
    expect(leases()).toEqual(['sa-B'])
    expect(stopped).toEqual([])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  })

  it('el rechazo no avanza el watermark: un arranque en vuelo no queda cancelado', async () => {
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B')
    // Un arranque reserva su ticket AHORA y correrá más tarde.
    const ticketArranque = beginRequest()

    // Cierre deliberado con identidad que NO coincide → ignored, sin watermark.
    // (No se cierra nada real en el medio: aislamos el efecto del rechazo.)
    const r = await stopStream(server, U, CAM, 'main_h264', 'exit_focus', V, beginRequest(), 'sa-A')
    expect(r.outcome).toBe('ignored')

    // El arranque en vuelo llega tarde y debe registrar su lease: si el rechazo
    // hubiera movido el watermark, se cancelaría solo (`view_closed_during_start`).
    const rc = await startStream(server, U, CAM, V, 'main_h264', ticketArranque, 'sa-C')
    expect(rc.error).toBeUndefined()
    expect(leases().sort()).toEqual(['sa-B', 'sa-C'])
  })

  it('re-entrada: {A,B}, exit_focus de A suelta sólo A; B y su FFmpeg siguen', async () => {
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-A')
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B')
    expect(leases().sort()).toEqual(['sa-A', 'sa-B'])

    const r = await stopStream(
      server, U, CAM, 'main_h264', 'exit_focus', V, beginRequest(), 'sa-A',
    )

    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: 'sa-A', remainingAttempts: 1 })
    expect(leases()).toEqual(['sa-B'])
    expect(stopped).toEqual([])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  })

  it('con un único lease A, exit_focus de A cierra la sesión y mata el FFmpeg', async () => {
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-A')

    const r = await stopStream(
      server, U, CAM, 'main_h264', 'exit_focus', V, beginRequest(), 'sa-A',
    )

    expect(r).toMatchObject({ outcome: 'session_closed', attemptId: 'sa-A', killedFfmpeg: true })
    expect(hd()).toBeUndefined()
    expect(stopped).toEqual([PATH_HD])
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
  })

  it('switch_to_sub con identidad se comporta igual: sólo suelta el suyo', async () => {
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-A')
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B')

    const r = await stopStream(
      server, U, CAM, 'main_h264', 'switch_to_sub', V, beginRequest(), 'sa-A',
    )

    expect(r.outcome).toBe('attempt_released')
    expect(leases()).toEqual(['sa-B'])
    expect(aliveProcesses.has(PATH_HD)).toBe(true)
  })

  it('un cierre deliberado SIN identidad sigue cerrando la ranura entera', async () => {
    // La transición/desmontaje a granel no rastrea intentos: full_close.
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-A')
    await startStream(server, U, CAM, V, 'main_h264', beginRequest(), 'sa-B')

    const r = await stopStream(server, U, CAM, 'main_h264', 'nvr_change', V, beginRequest())

    expect(r.outcome).toBe('session_closed')
    expect(hd()).toBeUndefined()
    expect(aliveProcesses.has(PATH_HD)).toBe(false)
  })
})

// ─── 11 · sesiones nacidas de reconcile: identidad real, no sintética ─────────
//
// Regresión del correctivo 7: reconcile creaba sesiones sin intento de cliente,
// el frontend las anotaba con un `hb:<cameraId>` que el backend nunca registró,
// y su cierre respondía `attempt_not_registered` —tomado por confirmación—,
// dejando la sesión y su FFmpeg vivos. Ahora reconcile acuña una identidad
// DURABLE (`srv-*`), la devuelve, y el cierre real la usa.

describe('reconcileView acuña identidad de servidor y el cierre real la honra', () => {
  const RC = 'camReconcile'

  it('sub plano: crea sesión con id `srv-*`, y stopStream con ese id la cierra', async () => {
    camFactory = subH264
    const r = await reconcileView(server, U, V, [RC], [], beginRequest())

    const id = r.streams[RC].startAttemptId
    expect(id).toBeTruthy()
    expect(id!.startsWith('srv-')).toBe(true)

    const sub = getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'sub')
    expect(sub).toBeDefined()
    expect(Array.from(sub!.startAttemptIds)).toEqual([id])

    // El cierre desde el camino real de LiveView, con la identidad devuelta.
    const res = await stopStream(server, U, RC, 'sub', 'viewport_change', V, beginRequest(), id!)
    expect(res).toMatchObject({ outcome: 'session_closed', attemptId: id })
    expect(getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'sub')).toBeUndefined()
  })

  it('redirección sub → main: identidad `srv-*` y cierre efectivo del `main`', async () => {
    camFactory = subHevcMainOk
    const r = await reconcileView(server, U, V, [RC], [], beginRequest())

    const id = r.streams[RC].startAttemptId!
    const main = getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'main')
    expect(main).toBeDefined()
    expect(Array.from(main!.startAttemptIds)).toEqual([id])

    const res = await stopStream(server, U, RC, 'main', 'viewport_change', V, beginRequest(), id)
    expect(res).toMatchObject({ outcome: 'session_closed', attemptId: id })
    expect(getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'main')).toBeUndefined()
  })

  it('redirección sub → main_h264: cierre efectivo y FFmpeg terminado', async () => {
    camFactory = bothHevc
    const r = await reconcileView(server, U, V, [RC], [], beginRequest())

    const id = r.streams[RC].startAttemptId!
    const rc = getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'main_h264')
    expect(rc).toBeDefined()
    const path = rc!.streamPath
    expect(aliveProcesses.has(path)).toBe(true)

    const res = await stopStream(server, U, RC, 'main_h264', 'exit_focus', V, beginRequest(), id)
    expect(res).toMatchObject({ outcome: 'session_closed', attemptId: id, killedFfmpeg: true })
    expect(aliveProcesses.has(path)).toBe(false)
  })

  it('un `hb:*` sintético NO puede cerrar la sesión de reconcile', async () => {
    camFactory = subH264
    await reconcileView(server, U, V, [RC], [], beginRequest())

    // Exactamente lo que hacía el frontend viejo.
    const res = await stopStream(server, U, RC, 'sub', 'viewport_change', V, beginRequest(), `hb:${RC}`)

    expect(res).toMatchObject({ outcome: 'ignored', reason: 'attempt_not_registered' })
    // La sesión sigue viva: `attempt_not_registered` NO es "no existe".
    expect(getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'sub')).toBeDefined()
  })

  it('un id no registrado contra la sesión de reconcile no la toca (señal no confirmatoria)', async () => {
    camFactory = subH264
    const r = await reconcileView(server, U, V, [RC], [], beginRequest())
    const real = r.streams[RC].startAttemptId!

    const res = await stopStream(server, U, RC, 'sub', 'viewport_change', V, beginRequest(), 'srv-inexistente')
    expect(res).toMatchObject({ outcome: 'ignored', reason: 'attempt_not_registered' })

    // Y la identidad real sigue cerrándola.
    const ok = await stopStream(server, U, RC, 'sub', 'viewport_change', V, beginRequest(), real)
    expect(ok.outcome).toBe('session_closed')
  })

  it('reconcile + B posterior en la misma ranura: el cierre viejo no cierra B', async () => {
    camFactory = subH264
    const r = await reconcileView(server, U, V, [RC], [], beginRequest())
    const srv = r.streams[RC].startAttemptId!

    // B: un arranque de cliente reutiliza la MISMA sesión sub y suma su lease.
    await startStream(server, U, RC, V, 'sub', beginRequest(), 'sa-B')
    const sub = () => getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'sub')
    expect(Array.from(sub()!.startAttemptIds).sort()).toEqual(['sa-B', srv].sort())

    // El cierre viejo (identidad de reconcile) suelta SÓLO srv; B sobrevive.
    const res = await stopStream(server, U, RC, 'sub', 'viewport_change', V, beginRequest(), srv)
    expect(res).toMatchObject({ outcome: 'attempt_released', attemptId: srv })
    expect(Array.from(sub()!.startAttemptIds)).toEqual(['sa-B'])
  })

  it('reconcile es idempotente: el mismo id en heartbeats sucesivos, sin acumular leases', async () => {
    camFactory = subH264
    const r1 = await reconcileView(server, U, V, [RC], [], beginRequest())
    const r2 = await reconcileView(server, U, V, [RC], [], beginRequest())

    expect(r2.streams[RC].startAttemptId).toBe(r1.streams[RC].startAttemptId)
    const sub = getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'sub')
    expect(sub!.startAttemptIds.size).toBe(1)
  })

  // ─── P0: el heartbeat debe recuperar TODOS los leases ─────────────────────
  // srv-A de reconcile + sa-B de un start cuya respuesta HTTP se perdió. Antes
  // `ensureServerOwnerId` devolvía sólo el PRIMERO (srv-A); sa-B quedaba vivo sin
  // que el cliente conociera su identidad. Ahora `startAttemptIds` trae ambos.
  it.each([
    ['sub (h264)', subH264, 'sub'],
    ['sub→main', subHevcMainOk, 'main'],
    ['sub→main_h264', bothHevc, 'main_h264'],
  ] as const)('%s: heartbeat recupera srv-A + sa-B; cerrar ambos elimina la sesión', async (_t, factory, tipoEfectivo) => {
    camFactory = factory
    const r1 = await reconcileView(server, U, V, [RC], [], beginRequest())
    const srvA = r1.streams[RC].startAttemptId!
    expect(r1.streams[RC].startAttemptIds).toEqual([srvA])

    // B reutiliza la misma ranura efectiva; su respuesta HTTP se "pierde" (el
    // cliente no la registra), pero el backend tiene su lease.
    await startStream(server, U, RC, V, 'sub', beginRequest(), 'sa-B')
    const ses = () => getActiveSessions().find(s => s.cameraId === RC && s.streamType === tipoEfectivo)
    expect(Array.from(ses()!.startAttemptIds).sort()).toEqual([srvA, 'sa-B'].sort())

    // El heartbeat siguiente devuelve AMBAS identidades.
    const r2 = await reconcileView(server, U, V, [RC], [], beginRequest())
    expect((r2.streams[RC].startAttemptIds ?? []).sort()).toEqual([srvA, 'sa-B'].sort())

    // La transición del cliente cierra AMBAS por identidad: recién con la última
    // cae la sesión (y su FFmpeg, si es main_h264).
    const c1 = await stopStream(server, U, RC, tipoEfectivo, 'viewport_change', V, beginRequest(), srvA)
    expect(c1.outcome).toBe('attempt_released')
    expect(ses()).toBeDefined()
    const c2 = await stopStream(server, U, RC, tipoEfectivo, 'viewport_change', V, beginRequest(), 'sa-B')
    expect(c2).toMatchObject({ outcome: 'session_closed', attemptId: 'sa-B' })
    expect(ses()).toBeUndefined()
  })

  it('P0: una sesión de OTRO viewId permanece intacta al recuperar/cerrar leases', async () => {
    camFactory = subH264
    const r1 = await reconcileView(server, U, V, [RC], [], beginRequest())
    const srvA = r1.streams[RC].startAttemptId!
    // Otra pestaña (viewId distinto) abre la misma cámara.
    await startStream(server, U, RC, 'v-otra', 'sub', beginRequest(), 'sa-otra')
    const otra = () => getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'sub' && s.viewId === 'v-otra')
    expect(otra()).toBeDefined()

    // Cerrar todos los leases de V no toca la sesión de v-otra.
    await stopStream(server, U, RC, 'sub', 'viewport_change', V, beginRequest(), srvA)
    expect(otra()).toBeDefined()
    expect(Array.from(otra()!.startAttemptIds)).toEqual(['sa-otra'])
  })

  it('P0 (mutación): devolver sólo el primer lease deja sa-B sin cerrar', async () => {
    // Contraste explícito: si el heartbeat devolviera sólo `startAttemptId`
    // (singular), el cliente cerraría srv-A y sa-B quedaría vivo.
    camFactory = subH264
    const r1 = await reconcileView(server, U, V, [RC], [], beginRequest())
    const srvA = r1.streams[RC].startAttemptId!
    await startStream(server, U, RC, V, 'sub', beginRequest(), 'sa-B')

    // Cerrar sólo el singular (comportamiento viejo) NO elimina la sesión.
    await stopStream(server, U, RC, 'sub', 'viewport_change', V, beginRequest(), srvA)
    const sub = getActiveSessions().find(s => s.cameraId === RC && s.streamType === 'sub')
    expect(sub).toBeDefined()
    expect(Array.from(sub!.startAttemptIds)).toEqual(['sa-B'])
  })
})

// ─── main NO transcodificado (cámara H.264): la misma carrera, sin FFmpeg ─────
//
// El correctivo 9 pide repetir el caso A/B con `main` NO redirigido. En una
// cámara H.264 pura, `main` NO se transcodifica: no hay proceso FFmpeg, pero la
// ranura `(u, v, cámara, main)` es la misma para A y B, así que el cierre «bare»
// del fullscreen de `ViewPlayerPage` —llegando tarde— borraba la sesión de B
// igual que en el caso transcodificado. Con identidad, suelta sólo A.
describe('A y B piden main sobre una cámara H.264 (sin transcodificación)', () => {
  const CAM_H264 = 'camH264'
  const PATH_MAIN = 'p_camH264_main'
  const mainSes = () =>
    getActiveSessions().find(s => s.cameraId === CAM_H264 && s.streamType === 'main')
  const mainLeases = () => Array.from(mainSes()?.startAttemptIds ?? [])

  beforeEach(() => { camFactory = subH264 })   // mainCodec h264 ⇒ main queda main

  it('el descarte tardío de A suelta SÓLO su arrendamiento; la sesión de B sigue', async () => {
    const A = 'sa-A-1', B = 'sa-B-2'

    const rA = await startStream(server, U, CAM_H264, V, 'main', beginRequest(), A)
    expect(rA.streamPath).toBe(PATH_MAIN)
    expect(mainLeases()).toEqual([A])

    const rB = await startStream(server, U, CAM_H264, V, 'main', beginRequest(), B)
    expect(rB.streamPath).toBe(PATH_MAIN)          // misma ranura: se suma, no reemplaza
    expect(mainLeases().sort()).toEqual([A, B].sort())

    // A responde tarde y su descarte de fullscreen llega con SU identidad.
    const r = await stopStream(server, U, CAM_H264, 'main', STALE_RESPONSE_REASON, V, beginRequest(), A)

    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: A, remainingAttempts: 1 })
    expect(mainSes()).toBeDefined()
    expect(mainLeases()).toEqual([B])
    // No hay FFmpeg que matar en main puro, pero tampoco se toca ningún proceso.
    expect(stopped).toEqual([])
  })

  it('sin la identidad, ese mismo cierre habría cerrado la sesión de B', async () => {
    await startStream(server, U, CAM_H264, V, 'main', beginRequest(), 'sa-A-1')
    await startStream(server, U, CAM_H264, V, 'main', beginRequest(), 'sa-B-2')

    // Un cierre deliberado SIN `expectedStartAttemptId` cierra la ranura entera.
    const r = await stopStream(server, U, CAM_H264, 'main', 'exit_fullscreen', V, beginRequest())

    expect(r.outcome).toBe('session_closed')
    expect(mainSes()).toBeUndefined()
  })

  it('cuando B también suelta, recién ahí cae la sesión', async () => {
    const A = 'sa-A-1', B = 'sa-B-2'
    await startStream(server, U, CAM_H264, V, 'main', beginRequest(), A)
    await startStream(server, U, CAM_H264, V, 'main', beginRequest(), B)

    const r1 = await stopStream(server, U, CAM_H264, 'main', STALE_RESPONSE_REASON, V, beginRequest(), A)
    expect(r1.outcome).toBe('attempt_released')
    expect(mainSes()).toBeDefined()

    const r2 = await stopStream(server, U, CAM_H264, 'main', STALE_RESPONSE_REASON, V, beginRequest(), B)
    expect(r2).toMatchObject({ outcome: 'session_closed', attemptId: B })
    expect(mainSes()).toBeUndefined()
  })

  it('un cierre tardío sin identidad sobre la ranura no hace nada', async () => {
    const A = 'sa-A-1', B = 'sa-B-2'
    await startStream(server, U, CAM_H264, V, 'main', beginRequest(), A)
    await startStream(server, U, CAM_H264, V, 'main', beginRequest(), B)

    // `stale_response` SIN intento declarado: el backend no puede saber cuál
    // soltar y no toca nada. Las dos siguen vivas.
    const r = await stopStream(server, U, CAM_H264, 'main', STALE_RESPONSE_REASON, V, beginRequest())
    expect(r.outcome).toBe('ignored')
    expect(mainLeases().sort()).toEqual([A, B].sort())
  })
})
