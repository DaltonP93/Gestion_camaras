// Parsers de envelope y mapeo de códigos de error de Hik-Connect.

import { describe, it, expect } from 'vitest'
import { unwrapEnvelope, safeJsonParse, describeCode, requireString, optionalNumber } from './parse'
import { HikConnectError } from './errors'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e instanceof HikConnectError ? e.code : 'OTHER'
  }
}

describe('safeJsonParse', () => {
  it('parsea JSON válido', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 })
  })
  it('lanza PARSE_ERROR sin filtrar el cuerpo', () => {
    try {
      safeJsonParse('<html>not json super-secret-body</html>')
      throw new Error('debió lanzar')
    } catch (e) {
      expect((e as HikConnectError).code).toBe('PARSE_ERROR')
      expect((e as Error).message).not.toContain('super-secret-body')
    }
  })
})

describe('unwrapEnvelope', () => {
  it('devuelve data cuando code=200', () => {
    expect(unwrapEnvelope({ code: '200', msg: 'ok', data: { x: 1 } })).toEqual({ x: 1 })
  })
  it('code de error → API_ERROR con apiCode y glosa conocida', () => {
    try {
      unwrapEnvelope({ code: '20007', msg: 'offline' })
      throw new Error('debió lanzar')
    } catch (e) {
      const err = e as HikConnectError
      expect(err.code).toBe('API_ERROR')
      expect(err.apiCode).toBe('20007')
      expect(err.message).toContain('dispositivo')
    }
  })
  it('envelope no-objeto o sin code → PARSE_ERROR', () => {
    expect(code(() => unwrapEnvelope(null))).toBe('PARSE_ERROR')
    expect(code(() => unwrapEnvelope('cadena'))).toBe('PARSE_ERROR')
    expect(code(() => unwrapEnvelope({ msg: 'x' }))).toBe('PARSE_ERROR')
  })
})

describe('describeCode', () => {
  it('conoce códigos comunes', () => {
    expect(describeCode('200')).toBe('éxito')
    expect(describeCode('10018')).toContain('firma')
    expect(describeCode('99999')).toContain('desconocido')
  })
})

describe('requireString / optionalNumber', () => {
  it('requireString exige un string no vacío', () => {
    expect(requireString({ a: 'x' }, 'a')).toBe('x')
    expect(code(() => requireString({ a: '' }, 'a'))).toBe('PARSE_ERROR')
    expect(code(() => requireString({}, 'a'))).toBe('PARSE_ERROR')
  })
  it('optionalNumber acepta number y string numérico', () => {
    expect(optionalNumber({ a: 5 }, 'a')).toBe(5)
    expect(optionalNumber({ a: '7' }, 'a')).toBe(7)
    expect(optionalNumber({ a: 'x' }, 'a')).toBeNull()
    expect(optionalNumber({}, 'a')).toBeNull()
  })
})
