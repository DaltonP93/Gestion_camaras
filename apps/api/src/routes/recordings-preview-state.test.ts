// Tests de la lógica pura del ciclo de vida del preview: el gate de "primer byte"
// (evita aceptar bytes tardíos tras timeout/kill/cierre → MP4 truncado), el mapeo
// de status HTTP del error, y la clasificación de cancelación vs fallo del NVR.
import { describe, it, expect } from 'vitest'
import { shouldAcceptFirstByte, errorStatusForCategory, isCancellation, isDrainRace } from './recordings-preview-state'

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
