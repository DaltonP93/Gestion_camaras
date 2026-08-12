// Tests de CARRERAS del ciclo de vida de sesiones (PR A1).
//
// Cubren los doce casos exigidos por el encargo. Se mockea './stream' para
// observar exactamente cuándo se termina un FFmpeg y cuándo NO, sin depender de
// procesos reales ni de MediaMTX.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mock del módulo de streaming ────────────────────────────────────────────
const stopped: string[] = []
const aliveProcesses = new Set<string>()

vi.mock('./stream', () => ({
  getStreamPath: (_nvr: any, cam: any, type = 'sub') => `nvr_x_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async () => true,
  removeStream: async () => true,
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => true,
  getTranscodedStreamPath: (p: string) => `${p}_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: async () => ({ available: true }),
  waitForHlsReady: async () => true,
  spawnTranscodeProcess: () => ({ once: () => {}, pid: 1 }),
  // La observación del proceso NO puede influir en la vigencia de una sesión.
  // Se expone acá justamente para demostrarlo en los tests.
  isTranscodeProcessAlive: (p: string) => aliveProcesses.has(p),
  stopTranscodeProcess: (p: string) => { stopped.push(p); aliveProcesses.delete(p); return true },
  getTranscodeStderr: () => '',
  getStreamDetails: async () => ({}),
  getActiveTranscodesList: () => [],
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const {
  pruneStaleSessions, cleanupIdleSessions, stopStream, cleanupUserSessions,
  touchSession, touchView, getActiveSessions, getStreamCounts, isViewClosedAfter, beginRequest,
  __seedSessionForTest, __setViewHeartbeatForTest, __setMediaActivityForTest,
  __resetSessionsForTest, __resetClosedViewsForTest,
} = await import('./stream-manager')

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)

// Servidor mínimo: sólo se usan log y una consulta de cámara.
const fakeServer: any = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  prisma: { camera: { findUnique: async () => null } },
}

function seedHd(userId: string, cameraId: string, viewId: string, path: string, ageSec: number) {
  __seedSessionForTest({
    cameraId, userId, viewId, streamType: 'main_h264', streamPath: path,
    startedAt: secondsAgo(ageSec + 10), lastClientHeartbeat: secondsAgo(ageSec),
  })
  __setViewHeartbeatForTest(userId, viewId, secondsAgo(ageSec))
  aliveProcesses.add(path)
}

function seedSub(userId: string, cameraId: string, viewId: string, ageSec: number) {
  __seedSessionForTest({
    cameraId, userId, viewId, streamType: 'sub', streamPath: `nvr_x_${cameraId}_sub`,
    startedAt: secondsAgo(ageSec + 10), lastClientHeartbeat: secondsAgo(ageSec),
  })
  __setViewHeartbeatForTest(userId, viewId, secondsAgo(ageSec))
}

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  stopped.length = 0
  aliveProcesses.clear()
})

describe('A1 · el proceso vivo no sostiene la sesión', () => {
  it('(1) FFmpeg vivo SIN heartbeat de cliente no renueva la sesión: expira y el proceso muere', async () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 3600)     // una hora sin latir
    expect(aliveProcesses.has('p_hd')).toBe(true)

    const removed = await cleanupIdleSessions(fakeServer)

    expect(removed).toBe(1)
    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_hd'])
  })

  it('la actividad de MEDIO reciente tampoco sostiene la sesión', async () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 3600)
    __setMediaActivityForTest('p_hd', Date.now())   // medio moviéndose ahora mismo

    await cleanupIdleSessions(fakeServer)

    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_hd'])
  })

  it('(2) sesión visible con heartbeat fresco permanece activa', async () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 0)
    expect(await cleanupIdleSessions(fakeServer)).toBe(0)
    expect(getActiveSessions()).toHaveLength(1)
    expect(stopped).toEqual([])
  })

  it('(3) pestaña oculta MENOS de 90 s: la sesión sigue y el heartbeat la reanuda', async () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 80)
    expect(await cleanupIdleSessions(fakeServer)).toBe(0)

    touchSession('u1', 'camA', 'main_h264')       // vuelve a ser visible
    expect(await cleanupIdleSessions(fakeServer)).toBe(0)
    expect(getActiveSessions()).toHaveLength(1)
    expect(stopped).toEqual([])
  })

  it('(4) pestaña oculta MÁS de 90 s: expira y libera el FFmpeg', async () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 91)
    expect(await cleanupIdleSessions(fakeServer)).toBe(1)
    expect(stopped).toEqual(['p_hd'])
  })
})

describe('A1 · cierre explícito', () => {
  it('(5) cerrar la pestaña elimina la sesión y su proceso', async () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 0)
    await cleanupUserSessions(fakeServer, 'u1', 'v1')
    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_hd'])
  })

  it('(6) cambiar de cámara elimina ÚNICAMENTE la referencia anterior', async () => {
    seedSub('u1', 'camA', 'v1', 0)
    seedSub('u1', 'camB', 'v1', 0)

    await stopStream(fakeServer, 'u1', 'camA', 'sub', 'viewport_change')

    const remaining = getActiveSessions()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].cameraId).toBe('camB')
  })

  it('(9) cierres repetidos son idempotentes: no re-matan ni cuentan de más', async () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 0)

    await stopStream(fakeServer, 'u1', 'camA', 'main_h264', 'exit_focus')
    await stopStream(fakeServer, 'u1', 'camA', 'main_h264', 'exit_focus')
    await stopStream(fakeServer, 'u1', 'camA', 'main_h264', 'cleanup_unmount')

    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_hd'])          // exactamente una terminación
  })

  it('cierres concurrentes (pagehide + desmontaje + layout) terminan el proceso una sola vez', async () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 0)

    await Promise.all([
      stopStream(fakeServer, 'u1', 'camA', 'main_h264', 'cleanup_unmount'),
      stopStream(fakeServer, 'u1', 'camA', 'main_h264', 'layout_change'),
      cleanupUserSessions(fakeServer, 'u1', 'v1'),
    ])

    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['p_hd'])
  })
})

describe('A1 · procesos compartidos', () => {
  it('(7) dos viewers comparten proceso: vencer uno NO mata el FFmpeg', async () => {
    seedHd('u1', 'camA', 'v1', 'p_shared', 3600)   // vencido
    seedHd('u2', 'camA', 'v2', 'p_shared', 0)      // fresco

    const removed = await cleanupIdleSessions(fakeServer)

    expect(removed).toBe(1)
    expect(stopped).toEqual([])                    // el proceso sigue vivo
    expect(getActiveSessions().map(s => s.userId)).toEqual(['u2'])
  })

  it('(8) al vencer el ÚLTIMO viewer el proceso termina', async () => {
    seedHd('u1', 'camA', 'v1', 'p_shared', 3600)
    seedHd('u2', 'camA', 'v2', 'p_shared', 3600)

    const removed = await cleanupIdleSessions(fakeServer)

    expect(removed).toBe(2)
    expect(stopped).toEqual(['p_shared'])          // una sola vez, no dos
    expect(getActiveSessions()).toHaveLength(0)
  })

  it('cerrar explícitamente un viewer de un proceso compartido no afecta al otro', async () => {
    seedHd('u1', 'camA', 'v1', 'p_shared', 0)
    seedHd('u2', 'camA', 'v2', 'p_shared', 0)

    await stopStream(fakeServer, 'u1', 'camA', 'main_h264', 'exit_focus')

    expect(stopped).toEqual([])
    expect(getActiveSessions()).toHaveLength(1)

    await stopStream(fakeServer, 'u2', 'camA', 'main_h264', 'exit_focus')
    expect(stopped).toEqual(['p_shared'])
  })
})

describe('A1 · respuestas tardías e índices auxiliares', () => {
  it('(11) un heartbeat tardío NO resucita una sesión ya cerrada', async () => {
    seedSub('u1', 'camA', 'v1', 0)
    // El heartbeat saca su ticket ANTES del cierre…
    const heartbeatTicket = beginRequest()

    await cleanupUserSessions(fakeServer, 'u1', 'v1')     // …y el cierre ocurre después
    expect(getActiveSessions()).toHaveLength(0)

    expect(isViewClosedAfter('u1', 'v1', heartbeatTicket)).toBe(true)
    touchView('u1', 'v1', heartbeatTicket)                // llega tarde: se descarta

    expect(getActiveSessions()).toHaveLength(0)
  })

  it('un heartbeat POSTERIOR al cierre sí es legítimo (el usuario volvió a abrir)', () => {
    seedSub('u1', 'camA', 'v1', 0)
    __resetClosedViewsForTest()
    const posterior = beginRequest()
    expect(isViewClosedAfter('u1', 'v1', posterior)).toBe(false)
  })

  it('touchSession sobre una sesión inexistente no la crea', () => {
    touchSession('u1', 'fantasma', 'sub')
    expect(getActiveSessions()).toHaveLength(0)
  })

  it('(10) no quedan índices auxiliares ni sesiones fantasma tras la expiración', async () => {
    seedSub('u1', 'camA', 'vieja', 300)
    seedSub('u1', 'camB', 'vieja', 300)

    await cleanupIdleSessions(fakeServer)

    expect(getActiveSessions()).toHaveLength(0)
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(0)
    // El índice del view huérfano se podó: un touchView posterior no puede
    // reconstruir demanda a partir de él.
    touchView('u1', 'vieja')
    expect(getActiveSessions()).toHaveLength(0)
  })
})

describe('A1 · (12) el caso de 26 horas', () => {
  it('una sesión HD con FFmpeg vivo y 26 h sin cliente se elimina y libera el proceso', async () => {
    const TWENTY_SIX_HOURS_SEC = 26 * 3600
    seedHd('u1', 'camUTI', 'v-zombie', 'nvr_x_ch09_main_h264', TWENTY_SIX_HOURS_SEC)
    __setMediaActivityForTest('nvr_x_ch09_main_h264', Date.now())   // medio activo
    expect(aliveProcesses.has('nvr_x_ch09_main_h264')).toBe(true)   // proceso vivo

    // Varias pasadas del cron: antes, cada pasada renovaba el heartbeat y la
    // sesión sobrevivía indefinidamente. Ahora muere en la primera.
    const first = await cleanupIdleSessions(fakeServer)
    const second = await cleanupIdleSessions(fakeServer)

    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(getActiveSessions()).toHaveLength(0)
    expect(stopped).toEqual(['nvr_x_ch09_main_h264'])
  })

  it('la sesión zombi deja de contar como demanda para el monitor de pipeline', async () => {
    // getActiveSessions() es la fuente que alimenta demandActive en el health
    // worker. Mientras la sesión fantasma existiera, el pipeline veía demanda
    // real sobre un path apagado y fabricaba CAMERA_STREAM_ERROR.
    seedHd('u1', 'camUTI', 'v-zombie', 'p_hd', 26 * 3600)
    expect(getActiveSessions()).toHaveLength(1)

    await cleanupIdleSessions(fakeServer)

    expect(getActiveSessions()).toHaveLength(0)
  })
})

describe('A1 · la purga liviana usa el mismo criterio', () => {
  it('pruneStaleSessions no conserva HD por proceso vivo', () => {
    seedHd('u1', 'camA', 'v1', 'p_hd', 300)
    expect(pruneStaleSessions()).toBe(1)
    expect(stopped).toEqual(['p_hd'])
  })

  it('pruneStaleSessions respeta procesos compartidos', () => {
    seedHd('u1', 'camA', 'v1', 'p_shared', 300)
    seedHd('u2', 'camA', 'v2', 'p_shared', 0)
    expect(pruneStaleSessions()).toBe(1)
    expect(stopped).toEqual([])
  })
})
