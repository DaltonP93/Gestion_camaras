// Builder del request de token y parser de la respuesta (con mapeo de errores).

import { describe, it, expect } from 'vitest'
import { buildTokenRequest, parseTokenResponse, formEncode, TOKEN_PATH } from './token'
import { HikConnectError } from './errors'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e instanceof HikConnectError ? e.code : 'OTHER'
  }
}

describe('buildTokenRequest', () => {
  it('produce POST form-urlencoded a TOKEN_PATH con appKey y appSecret', () => {
    const spec = buildTokenRequest({ appKey: 'AK123', secretKey: 'SK-super-secret' })
    expect(spec.method).toBe('POST')
    expect(spec.path).toBe(TOKEN_PATH)
    expect(spec.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(spec.body).toContain('appKey=AK123')
    expect(spec.body).toContain('appSecret=SK-super-secret')
  })

  it('exige credenciales', () => {
    expect(code(() => buildTokenRequest({ appKey: '', secretKey: 'x' }))).toBe('INVALID_ARG')
    expect(code(() => buildTokenRequest({ appKey: 'x', secretKey: '' }))).toBe('INVALID_ARG')
  })

  it('formEncode escapa caracteres reservados', () => {
    expect(formEncode({ a: 'x y', b: 'p&q' })).toBe('a=x%20y&b=p%26q')
  })
})

describe('parseTokenResponse', () => {
  it('parsea accessToken, areaDomain y expireTime', () => {
    const r = parseTokenResponse({
      code: '200',
      msg: 'ok',
      data: { accessToken: 'at.abc', areaDomain: 'https://isaeu.hik-connect.com', expireTime: 1893456000000 },
    })
    expect(r).toEqual({
      accessToken: 'at.abc',
      areaDomain: 'https://isaeu.hik-connect.com',
      expireTimeMs: 1893456000000,
    })
  })

  it('acepta expireTime como string y code numérico', () => {
    const r = parseTokenResponse({
      code: 200,
      msg: 'ok',
      data: { accessToken: 'at', areaDomain: 'https://x.ys7.com', expireTime: '1700000000000' },
    })
    expect(r.expireTimeMs).toBe(1700000000000)
  })

  it('expireTime ausente → null', () => {
    const r = parseTokenResponse({ code: '200', data: { accessToken: 'at', areaDomain: 'https://x.ys7.com' } })
    expect(r.expireTimeMs).toBeNull()
  })

  it('code de error → API_ERROR con apiCode', () => {
    try {
      parseTokenResponse({ code: '10018', msg: 'sign error', data: {} })
      throw new Error('debió lanzar')
    } catch (e) {
      expect(e).toBeInstanceOf(HikConnectError)
      expect((e as HikConnectError).code).toBe('API_ERROR')
      expect((e as HikConnectError).apiCode).toBe('10018')
    }
  })

  it('respuesta sin accessToken → PARSE_ERROR', () => {
    expect(code(() => parseTokenResponse({ code: '200', data: { areaDomain: 'https://x.ys7.com' } }))).toBe(
      'PARSE_ERROR',
    )
  })
})
