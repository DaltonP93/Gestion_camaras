import { describe, it, expect } from 'vitest'
import {
  readBackendCode, parseStreamError, parseRetryAfterMs, describeLimit, isLimitCode,
} from './streamErrors'

describe('readBackendCode — body.code ?? body.error (P1)', () => {
  it('prefiere body.code (contrato nuevo)', () => {
    expect(readBackendCode({ code: 'TRANSCODE_LIMIT_REACHED', error: 'x' })).toBe('TRANSCODE_LIMIT_REACHED')
  })
  it('cae a body.error si no hay code (legado)', () => {
    expect(readBackendCode({ error: 'AUTH_FAILED' })).toBe('AUTH_FAILED')
  })
  it('403 sin cuerpo → NO_PERMISSION', () => {
    expect(readBackendCode({}, 403)).toBe('NO_PERMISSION')
  })
  it('sin nada → cadena vacía', () => {
    expect(readBackendCode({})).toBe('')
  })
})

describe('parseStreamError — un 429 nunca es "Error desconocido" (P1)', () => {
  it('TRANSCODE_LIMIT_REACHED con contadores → mensaje real, no UNKNOWN', () => {
    const r = parseStreamError(
      { code: 'TRANSCODE_LIMIT_REACHED', activeCount: 2, startingCount: 1, maxTranscodes: 2 },
      429,
    )
    expect(r.code).toBe('TRANSCODE_LIMIT_REACHED')
    expect(r.isLimit).toBe(true)
    expect(r.message).toContain('2/2')
    expect(r.message).toContain('1 iniciando')
    expect(r.code).not.toBe('UNKNOWN')
  })

  it('TRANSCODE_LIMIT_REACHED leído del campo equivocado (body.error) igual se resuelve', () => {
    // Regresión del bug: la ruta de foco leía body.error.
    const r = parseStreamError({ error: 'TRANSCODE_LIMIT_REACHED', message: 'máx 2' }, 429)
    expect(r.code).toBe('TRANSCODE_LIMIT_REACHED')
    expect(r.message).not.toBe('Error desconocido')
  })

  it('STREAM_LIMIT_REACHED con current/max', () => {
    const r = parseStreamError({ code: 'STREAM_LIMIT_REACHED', current: 32, max: 32 }, 429)
    expect(r.code).toBe('STREAM_LIMIT_REACHED')
    expect(r.message).toContain('32/32')
  })

  it('STREAM_LIMIT_GLOBAL mapea a STREAM_LIMIT_REACHED', () => {
    expect(parseStreamError({ code: 'STREAM_LIMIT_GLOBAL' }, 429).code).toBe('STREAM_LIMIT_REACHED')
  })

  it('cada código requerido está mapeado', () => {
    for (const c of [
      'TRANSCODE_LIMIT_REACHED', 'STREAM_LIMIT_REACHED', 'STREAM_LIMIT_GLOBAL',
      'TRANSCODE_NOT_READY', 'TRANSCODE_PROCESS_EXITED', 'CODEC_UNSUPPORTED_HEVC', 'MEDIA_SERVER_ERROR',
    ]) {
      expect(parseStreamError({ code: c }).code).not.toBe('UNKNOWN')
    }
  })

  it('código realmente desconocido → UNKNOWN con mensaje del backend', () => {
    const r = parseStreamError({ code: 'SOMETHING_NEW', message: 'detalle backend' })
    expect(r.code).toBe('UNKNOWN')
    expect(r.message).toBe('detalle backend')
  })
})

describe('parseRetryAfterMs', () => {
  it('segundos → ms', () => expect(parseRetryAfterMs('10')).toBe(10_000))
  it('acepta number', () => expect(parseRetryAfterMs(5)).toBe(5_000))
  it('inválido → fallback', () => expect(parseRetryAfterMs('abc', 3000)).toBe(3000))
  it('ausente → fallback', () => expect(parseRetryAfterMs(undefined, 3000)).toBe(3000))
})

describe('describeLimit / isLimitCode', () => {
  it('isLimitCode reconoce los tres límites', () => {
    expect(isLimitCode('TRANSCODE_LIMIT_REACHED')).toBe(true)
    expect(isLimitCode('STREAM_LIMIT_REACHED')).toBe(true)
    expect(isLimitCode('STREAM_LIMIT_GLOBAL')).toBe(true)
    expect(isLimitCode('AUTH_FAILED')).toBe(false)
  })
  it('transcode sin contadores cae al message', () => {
    expect(describeLimit('TRANSCODE_LIMIT_REACHED', { message: 'máx 2' })).toBe('máx 2')
  })
})
