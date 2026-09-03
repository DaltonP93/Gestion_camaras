// Validación estricta del path ISAPI (anti-SSRF/inyección) + builder del proxy.

import { describe, it, expect } from 'vitest'
import { assertSafeIsapiPath, buildIsapiProxyRequest, ISAPI_PROXY_PATH } from './isapi'
import { HikConnectError } from './errors'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e instanceof HikConnectError ? e.code : 'OTHER'
  }
}

describe('assertSafeIsapiPath — válidos', () => {
  it.each([
    '/ISAPI/System/deviceInfo',
    '/ISAPI/Streaming/channels/101',
    '/ISAPI/ContentMgmt/record/tracks',
    '/ISAPI/Image/channels/1/color',
    '/ISAPI/System/time?format=ISO8601',
    '/ISAPI/System/Video/inputs/channels/1/overlays',
  ])('acepta %s', (p) => {
    expect(assertSafeIsapiPath(p)).toBe(p)
  })
})

describe('assertSafeIsapiPath — rechazados', () => {
  it('vacío', () => {
    expect(code(() => assertSafeIsapiPath(''))).toBe('INVALID_ISAPI_PATH')
  })
  it('traversal ..', () => {
    expect(code(() => assertSafeIsapiPath('/ISAPI/../etc/passwd'))).toBe('INVALID_ISAPI_PATH')
  })
  it('doble barra //', () => {
    expect(code(() => assertSafeIsapiPath('/ISAPI//System'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('//evil.com/ISAPI/x'))).toBe('INVALID_ISAPI_PATH')
  })
  it('no empieza en /ISAPI/', () => {
    expect(code(() => assertSafeIsapiPath('/other/System'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('ISAPI/System'))).toBe('INVALID_ISAPI_PATH')
  })
  it('scheme/host embebido', () => {
    expect(code(() => assertSafeIsapiPath('http://evil.com/ISAPI/x'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('/ISAPI/x@evil.com'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('/ISAPI/host:8080/x'))).toBe('INVALID_ISAPI_PATH')
  })
  it('CRLF / caracteres de control', () => {
    expect(code(() => assertSafeIsapiPath('/ISAPI/System\r\nHost: evil'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('/ISAPI/System\ninfo'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('/ISAPI/System\tinfo'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('/ISAPI/System\x00info'))).toBe('INVALID_ISAPI_PATH')
  })
  it('espacios y backslash', () => {
    expect(code(() => assertSafeIsapiPath('/ISAPI/System info'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('/ISAPI/System\\info'))).toBe('INVALID_ISAPI_PATH')
  })
  it('excede longitud máxima', () => {
    expect(code(() => assertSafeIsapiPath('/ISAPI/' + 'a'.repeat(2000)))).toBe('INVALID_ISAPI_PATH')
  })
  it('más de un ? o querystring inseguro', () => {
    expect(code(() => assertSafeIsapiPath('/ISAPI/x?a=1?b=2'))).toBe('INVALID_ISAPI_PATH')
    expect(code(() => assertSafeIsapiPath('/ISAPI/x?a=<script>'))).toBe('INVALID_ISAPI_PATH')
  })
})

describe('buildIsapiProxyRequest', () => {
  it('compone el request: path fijo del proxy, headers con token/serial/path ISAPI', () => {
    const spec = buildIsapiProxyRequest({
      accessToken: 'at.SECRET',
      deviceSerial: 'DS12345',
      method: 'GET',
      isapiPath: '/ISAPI/System/deviceInfo',
    })
    expect(spec.method).toBe('POST')
    expect(spec.path).toBe(ISAPI_PROXY_PATH)
    expect(spec.headers['EZO-DeviceSerial']).toBe('DS12345')
    expect(spec.headers['EZO-ISAPI-Method']).toBe('GET')
    expect(spec.headers['EZO-ISAPI-Path']).toBe('/ISAPI/System/deviceInfo')
  })

  it('propaga el error de path inseguro', () => {
    expect(
      code(() =>
        buildIsapiProxyRequest({ accessToken: 'at', deviceSerial: 'DS', method: 'GET', isapiPath: '/ISAPI/../x' }),
      ),
    ).toBe('INVALID_ISAPI_PATH')
  })

  it('rechaza método no permitido', () => {
    expect(
      code(() =>
        buildIsapiProxyRequest({
          accessToken: 'at',
          deviceSerial: 'DS',
          // @ts-expect-error método inválido a propósito
          method: 'TRACE',
          isapiPath: '/ISAPI/System/deviceInfo',
        }),
      ),
    ).toBe('INVALID_ARG')
  })

  it('exige accessToken y deviceSerial', () => {
    expect(
      code(() => buildIsapiProxyRequest({ accessToken: '', deviceSerial: 'DS', method: 'GET', isapiPath: '/ISAPI/x' })),
    ).toBe('INVALID_ARG')
    expect(
      code(() => buildIsapiProxyRequest({ accessToken: 'at', deviceSerial: '', method: 'GET', isapiPath: '/ISAPI/x' })),
    ).toBe('INVALID_ARG')
  })
})
