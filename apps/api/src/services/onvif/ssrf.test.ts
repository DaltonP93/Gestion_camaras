// apps/api/src/services/onvif/ssrf.test.ts
//
// Validación SSRF de deviceUrl: LAN-only, bloqueo de metadatos cloud y esquemas.

import { describe, it, expect } from 'vitest'
import { assertSafeDeviceUrl } from './ssrf'
import { OnvifError } from './errors'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e instanceof OnvifError ? e.code : 'OTHER'
  }
}

describe('assertSafeDeviceUrl — permitidos (LAN)', () => {
  it.each([
    'http://192.168.1.50/onvif/device_service',
    'http://10.0.0.5:80/onvif',
    'http://172.16.3.9/onvif',
    'http://172.31.9.9/onvif',
    'https://127.0.0.1:8080/onvif',
    'http://100.64.0.1/onvif', // CGNAT
    'http://localhost:4000/onvif',
    'http://camara.local/onvif',
    'http://nvr.lan/onvif',
    'http://[fd12::1]/onvif', // ULA IPv6
    'http://[::1]/onvif', // loopback IPv6
  ])('permite %s', (url) => {
    expect(() => assertSafeDeviceUrl(url)).not.toThrow()
  })
})

describe('assertSafeDeviceUrl — bloqueados', () => {
  it('bloquea el endpoint de metadatos cloud 169.254.169.254', () => {
    expect(code(() => assertSafeDeviceUrl('http://169.254.169.254/latest/meta-data/'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea hostname de metadatos GCP', () => {
    expect(code(() => assertSafeDeviceUrl('http://metadata.google.internal/'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea todo link-local 169.254.0.0/16', () => {
    expect(code(() => assertSafeDeviceUrl('http://169.254.10.10/'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea IP pública', () => {
    expect(code(() => assertSafeDeviceUrl('http://8.8.8.8/onvif'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea hostname externo arbitrario', () => {
    expect(code(() => assertSafeDeviceUrl('http://evil.example.com/onvif'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea IPv6 link-local', () => {
    expect(code(() => assertSafeDeviceUrl('http://[fe80::1]/onvif'))).toBe('SSRF_BLOCKED')
  })
  it('rechaza esquema no http(s)', () => {
    expect(code(() => assertSafeDeviceUrl('file:///etc/passwd'))).toBe('INVALID_URL')
    expect(code(() => assertSafeDeviceUrl('gopher://192.168.1.1/'))).toBe('INVALID_URL')
  })
  it('rechaza URL inválida', () => {
    expect(code(() => assertSafeDeviceUrl('no-es-url'))).toBe('INVALID_URL')
  })
})

describe('assertSafeDeviceUrl — política', () => {
  it('allowPublic permite una IP pública', () => {
    expect(() => assertSafeDeviceUrl('http://8.8.8.8/onvif', { allowPublic: true })).not.toThrow()
  })
  it('allowPublic NO puede desbloquear los metadatos cloud', () => {
    expect(code(() => assertSafeDeviceUrl('http://169.254.169.254/', { allowPublic: true }))).toBe('SSRF_BLOCKED')
  })
  it('allowedHosts permite un hostname explícito', () => {
    expect(() => assertSafeDeviceUrl('http://cam.example.com/onvif', { allowedHosts: ['cam.example.com'] })).not.toThrow()
  })
})
