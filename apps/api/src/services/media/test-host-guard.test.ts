// Guard de destino de test: sólo loopback (descartable local/CI). Fail-closed.
import { describe, it, expect } from 'vitest'
import { assertDisposableLocalHost } from './test-host-guard'

describe('assertDisposableLocalHost', () => {
  it('acepta loopback (redis y postgres, ipv4/ipv6/localhost)', () => {
    for (const u of [
      'redis://localhost:6379',
      'redis://127.0.0.1:6379',
      'redis://[::1]:6379',
      'postgresql://ci:ci@localhost:5432/ci',
      'postgresql://ci:ci@127.0.0.1:5432/ci',
      'postgresql://ci:ci@[::1]:5432/ci',
    ]) {
      expect(() => assertDisposableLocalHost(u, 'TEST'), u).not.toThrow()
    }
  })

  it('RECHAZA (fail-closed) destinos NO locales antes de conectar', () => {
    for (const u of [
      'redis://10.0.0.9:6379',            // LAN privada, pero NO loopback
      'redis://redis.prod.internal:6379', // hostname remoto
      'postgresql://u:p@db.example.com:5432/app',
      'postgresql://u:p@192.168.1.10:5432/app',
      'postgresql://u:p@169.254.169.254:5432/app', // metadata
    ]) {
      expect(() => assertDisposableLocalHost(u, 'TEST'), u).toThrow(/NO local/)
    }
  })

  it('RECHAZA URL inválida', () => {
    expect(() => assertDisposableLocalHost('no-es-url', 'TEST')).toThrow(/inválida/)
    expect(() => assertDisposableLocalHost('', 'TEST')).toThrow(/inválida/)
  })
})
