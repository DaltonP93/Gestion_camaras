// Tests de la lógica pura del ciclo de vida del preview: el gate de "primer byte"
// (evita aceptar bytes tardíos tras timeout/kill/cierre → MP4 truncado), el mapeo
// de status HTTP del error, y la clasificación de cancelación vs fallo del NVR.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shouldAcceptFirstByte, errorStatusForCategory, isCancellation, isDrainRace, resolveStreamTakeover } from './recordings-preview-state'
import { PreviewProcessRegistry, type ManagedProc } from '../services/recordings/preview-process-registry'

const base = { state: 'waiting_first_byte' as const, variantTimedOut: false, procExited: false, clientGone: false, responseEnded: false }

describe('shouldAcceptFirstByte', () => {
  it('acepta el primer byte cuando el intento sigue esperando y nada lo terminó', () => {
    expect(shouldAcceptFirstByte(base)).toBe(true)
  })

  it('RECHAZA un byte tardío tras timeout (caso del NVR que vacía datos en el cierre)', () => {
    expect(shouldAcceptFirstByte({ ...base, variantTimedOut: true })).toBe(false)
    expect(shouldAcceptFirstByte({ ...base, state: 'terminal' })).toBe(false)
  })

  it('rechaza si el proceso salió, el cliente se fue o la respuesta cerró', () => {
    expect(shouldAcceptFirstByte({ ...base, procExited: true })).toBe(false)
    expect(shouldAcceptFirstByte({ ...base, clientGone: true })).toBe(false)
    expect(shouldAcceptFirstByte({ ...base, responseEnded: true })).toBe(false)
  })

  it('rechaza si ya estaba en streaming (el primer byte se acepta una sola vez)', () => {
    expect(shouldAcceptFirstByte({ ...base, state: 'streaming' })).toBe(false)
  })
})

describe('errorStatusForCategory', () => {
  it('mapea las causas a status HTTP correctos', () => {
    expect(errorStatusForCategory('NVR_BANDWIDTH_OR_SESSION_LIMIT')).toBe(503)
    expect(errorStatusForCategory('NVR_OFFLINE_OR_TIMEOUT')).toBe(504)
    expect(errorStatusForCategory('FIRST_BYTE_TIMEOUT')).toBe(504)
    expect(errorStatusForCategory('AUTH_FAILED')).toBe(401)
    expect(errorStatusForCategory('UNKNOWN')).toBe(502)
  })
  it('mapea las categorías granulares por etapa', () => {
    expect(errorStatusForCategory('RTSP_OPEN_TIMEOUT')).toBe(504)
    expect(errorStatusForCategory('MUXER_NO_OUTPUT')).toBe(504)
    expect(errorStatusForCategory('OUTPUT_PIPE_DRAIN_RACE')).toBe(504)
    expect(errorStatusForCategory('ENCODE_FAILED')).toBe(500)
    expect(errorStatusForCategory('RTSP_AUTH_FAILED')).toBe(401)
  })
})

describe('isDrainRace / exit antes del último data de stdout (TASK 4)', () => {
  it('exit ocurre ANTES del último data: el byte tardío NO se acepta y es drain race', () => {
    // Secuencia real: watchdog no disparó, pero el proceso salió (procExited) y
    // RECIÉN DESPUÉS llega un chunk de stdout (buffer vaciado en el cierre).
    const gateAtByte = { ...base, procExited: true }
    const accepted = shouldAcceptFirstByte(gateAtByte)
    expect(accepted).toBe(false)                         // no se sirve MP4 truncado
    expect(isDrainRace({ variantTimedOut: false, procExited: true, sawStdoutByte: true, firstByteAccepted: accepted }))
      .toBe(true)                                        // FFmpeg SÍ produjo salida
  })

  it('timeout + byte tardío tras kill = drain race (no rechazo del NVR)', () => {
    const accepted = shouldAcceptFirstByte({ ...base, variantTimedOut: true })
    expect(accepted).toBe(false)
    expect(isDrainRace({ variantTimedOut: true, procExited: false, sawStdoutByte: true, firstByteAccepted: accepted }))
      .toBe(true)
  })

  it('NO es drain race si nunca hubo byte de stdout (MUXER_NO_OUTPUT real)', () => {
    expect(isDrainRace({ variantTimedOut: true, procExited: true, sawStdoutByte: false, firstByteAccepted: false }))
      .toBe(false)
  })

  it('NO es drain race si el primer byte se aceptó a tiempo (éxito normal)', () => {
    expect(isDrainRace({ variantTimedOut: false, procExited: false, sawStdoutByte: true, firstByteAccepted: true }))
      .toBe(false)
  })
})

describe('isCancellation', () => {
  it('es cancelación si el cliente se fue o la sesión ya no existe', () => {
    expect(isCancellation({ clientGone: true, sessionAlive: true })).toBe(true)
    expect(isCancellation({ clientGone: false, sessionAlive: false })).toBe(true)
  })
  it('NO es cancelación si el cliente sigue y la sesión vive (fallo real del NVR)', () => {
    expect(isCancellation({ clientGone: false, sessionAlive: true })).toBe(false)
  })
})

// REQUISITO 6: dos GET concurrentes al route. resolveStreamTakeover es EXACTAMENTE
// la función que ejecuta el handler — se prueba contra un PreviewProcessRegistry
// real con un ChildProcess simulado. spawn = registrar en el registro; sólo se
// permite tras un takeover que devuelve proceed:true.
function fakeProc(pid = Math.floor(Math.random() * 1e6)): ManagedProc & { kills: string[] } {
  return { pid, kills: [] as string[], kill(s?: NodeJS.Signals | number) { this.kills.push(String(s ?? 'SIGTERM')); return true } }
}

describe('resolveStreamTakeover — dos GET concurrentes al route (req 1, 2, 6)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sin procesos vivos → procede directo (primer GET, spawn permitido)', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    const d = await resolveStreamTakeover(reg, { reason: 'stream_takeover', deadlineMs: 600 })
    expect(d.proceed).toBe(true)
  })

  it('el anterior confirma exit real → el 2.º procede; nunca dos vivos', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    let spawnCount = 0
    const doSpawn = () => { spawnCount++; return reg.register(fakeProc(), 0) }
    const first = doSpawn()                       // GET #1 spawn

    // GET #2: takeover. El anterior confirma salida real durante la espera.
    const p = resolveStreamTakeover(reg, { reason: 'stream_takeover', deadlineMs: 600 })
    await vi.advanceTimersByTimeAsync(10)
    reg.markExited(first.attemptId); reg.unregister(first.attemptId)
    const d = await p
    expect(d.proceed).toBe(true)
    expect(reg.aliveCount()).toBe(0)
    if (d.proceed) doSpawn()                       // GET #2 spawn recién ahora
    expect(spawnCount).toBe(2)
    expect(reg.aliveCount()).toBe(1)               // exactamente uno vivo, sin solape
  })

  it('el anterior NO sale → 503 PREVIOUS_FFMPEG_NOT_REAPED y el 2.º NO spawnea', async () => {
    const reg = new PreviewProcessRegistry({ graceMs: 50 })
    let spawnCount = 0
    const doSpawn = () => { spawnCount++; return reg.register(fakeProc(), 0) }
    doSpawn()                                      // GET #1, nunca emite exit

    const p = resolveStreamTakeover(reg, { reason: 'stream_takeover', deadlineMs: 300 })
    await vi.advanceTimersByTimeAsync(400)         // vence deadline sin exit real
    const d = await p
    expect(d.proceed).toBe(false)
    if (!d.proceed) { expect(d.status).toBe(503); expect(d.code).toBe('PREVIOUS_FFMPEG_NOT_REAPED') }
    if (d.proceed) doSpawn()                        // no debe ocurrir
    expect(spawnCount).toBe(1)                      // el 2.º GET NO llamó spawn
    expect(reg.aliveCount()).toBe(1)               // nunca hubo dos procesos vivos
  })
})
