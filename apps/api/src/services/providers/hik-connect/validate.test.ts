// Validación anti-SSRF del areaDomain: https obligatorio, host plausible de la
// nube, bloqueo de IPs privadas/públicas y metadatos cloud.

import { describe, it, expect } from 'vitest'
import { assertSafeAreaDomain } from './validate'
import { HikConnectError } from './errors'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e instanceof HikConnectError ? e.code : 'OTHER'
  }
}

describe('assertSafeAreaDomain — permitidos', () => {
  it.each([
    'https://open.hik-connect.com',
    'https://isaeu.hik-connect.com',
    'https://iusopen.ezvizlife.com',
    'https://open.ys7.com',
    'https://xyz.hicloudcam.com',
    'https://api.hikvision.com',
  ])('permite %s', (d) => {
    expect(() => assertSafeAreaDomain(d)).not.toThrow()
  })

  it('normaliza a origin (protocol//host)', () => {
    const u = assertSafeAreaDomain('https://open.hik-connect.com/algo/path')
    expect(`${u.protocol}//${u.host}`).toBe('https://open.hik-connect.com')
  })
})

describe('assertSafeAreaDomain — bloqueados', () => {
  it('rechaza http (no https)', () => {
    expect(code(() => assertSafeAreaDomain('http://open.hik-connect.com'))).toBe('INVALID_AREA_DOMAIN')
  })
  it('rechaza IP privada literal', () => {
    expect(code(() => assertSafeAreaDomain('https://192.168.1.10'))).toBe('INVALID_AREA_DOMAIN')
  })
  it('rechaza IP pública literal', () => {
    expect(code(() => assertSafeAreaDomain('https://8.8.8.8'))).toBe('INVALID_AREA_DOMAIN')
  })
  it('rechaza endpoint de metadatos cloud', () => {
    expect(code(() => assertSafeAreaDomain('https://169.254.169.254'))).toBe('INVALID_AREA_DOMAIN')
    expect(code(() => assertSafeAreaDomain('https://metadata.google.internal'))).toBe('INVALID_AREA_DOMAIN')
  })
  it('rechaza IPv6 literal', () => {
    expect(code(() => assertSafeAreaDomain('https://[fd00::1]'))).toBe('INVALID_AREA_DOMAIN')
  })
  it('rechaza host arbitrario no plausible', () => {
    expect(code(() => assertSafeAreaDomain('https://evil.example.com'))).toBe('INVALID_AREA_DOMAIN')
  })
  it('rechaza sufijo casi-parecido (no termina en el dominio real)', () => {
    expect(code(() => assertSafeAreaDomain('https://hik-connect.com.evil.net'))).toBe('INVALID_AREA_DOMAIN')
  })
  it('rechaza credenciales embebidas', () => {
    expect(code(() => assertSafeAreaDomain('https://u:p@open.hik-connect.com'))).toBe('INVALID_AREA_DOMAIN')
  })
  it('rechaza URL inválida', () => {
    expect(code(() => assertSafeAreaDomain('no-es-url'))).toBe('INVALID_AREA_DOMAIN')
  })
})

describe('assertSafeAreaDomain — política de sufijos', () => {
  it('allowedSuffixes permite un dominio regional extra', () => {
    expect(() =>
      assertSafeAreaDomain('https://open.mi-region.example', { allowedSuffixes: ['.mi-region.example'] }),
    ).not.toThrow()
  })
})
