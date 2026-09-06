// apps/api/src/services/net/nvr-host-guard.test.ts
//
// Defensa SSRF del host de un NVR: LAN-only. Se PERMITEN IPs privadas RFC1918/CGNAT
// e IPv6 ULA; se BLOQUEAN metadatos cloud (169.254.169.254 y todo 169.254/16),
// loopback (127/8, ::1), no-especificada (0.0.0.0, ::), link-local IPv6 y hosts
// externos. IPs 100% ficticias (10.x / 192.168.x para LAN, 169.254.169.254 bloqueo).

import { describe, it, expect } from 'vitest'
import { assertSafeNvrHost, NvrHostError, isNvrHostError } from './nvr-host-guard'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return isNvrHostError(e) ? e.code : 'OTHER'
  }
}

describe('assertSafeNvrHost — LAN permitida (NVRs legítimos)', () => {
  it.each([
    '192.168.1.50',
    '192.168.100.10',
    '10.0.0.5',
    '10.20.30.40',
    '172.16.3.9',
    '172.31.9.9',
    '100.64.0.1',        // CGNAT
    'fd12::1',           // ULA IPv6
    '[fd00::abcd]',      // ULA IPv6 con brackets
    'nvr.local',         // mDNS LAN
    'grabador.lan',      // LAN
  ])('permite %s', (host) => {
    expect(() => assertSafeNvrHost(host)).not.toThrow()
  })
})

describe('assertSafeNvrHost — bloqueados (SSRF)', () => {
  it('bloquea el endpoint de metadatos cloud 169.254.169.254', () => {
    expect(code(() => assertSafeNvrHost('169.254.169.254'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea todo link-local 169.254.0.0/16', () => {
    expect(code(() => assertSafeNvrHost('169.254.10.10'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea hostname de metadatos GCP', () => {
    expect(code(() => assertSafeNvrHost('metadata.google.internal'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea loopback 127.0.0.1', () => {
    expect(code(() => assertSafeNvrHost('127.0.0.1'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea loopback en todo 127/8', () => {
    expect(code(() => assertSafeNvrHost('127.5.5.5'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea loopback IPv6 ::1', () => {
    expect(code(() => assertSafeNvrHost('::1'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea la dirección no especificada 0.0.0.0', () => {
    expect(code(() => assertSafeNvrHost('0.0.0.0'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea la no especificada IPv6 ::', () => {
    expect(code(() => assertSafeNvrHost('::'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea IPv6 link-local fe80::', () => {
    expect(code(() => assertSafeNvrHost('fe80::1'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea IP pública', () => {
    expect(code(() => assertSafeNvrHost('8.8.8.8'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea hostname externo arbitrario', () => {
    expect(code(() => assertSafeNvrHost('evil.example.com'))).toBe('SSRF_BLOCKED')
  })
  it('bloquea localhost', () => {
    expect(code(() => assertSafeNvrHost('localhost'))).toBe('SSRF_BLOCKED')
  })
  it('rechaza host vacío como INVALID_HOST', () => {
    expect(code(() => assertSafeNvrHost(''))).toBe('INVALID_HOST')
    expect(code(() => assertSafeNvrHost('   '))).toBe('INVALID_HOST')
  })
})

describe('assertSafeNvrHost — el error no filtra la IP', () => {
  it('el mensaje de NvrHostError nunca contiene el host', () => {
    try {
      assertSafeNvrHost('169.254.169.254')
      throw new Error('debió lanzar')
    } catch (e) {
      expect(e).toBeInstanceOf(NvrHostError)
      expect((e as NvrHostError).message).not.toContain('169.254.169.254')
    }
  })
})
