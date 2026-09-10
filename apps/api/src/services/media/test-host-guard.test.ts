// Guard de destino de test: loopback + señal EXPLÍCITA de instancia descartable.
// Fail-closed; los errores no filtran host/IP/credenciales.
import { describe, it, expect, afterEach } from 'vitest'
import { assertDisposableLocalHost, assertDestructiveTestAllowed } from './test-host-guard'
import { buildScopedUrl } from './pg-real-harness'

const ENV = 'TEST_DISPOSABLE_X'
afterEach(() => { delete process.env[ENV] })

describe('assertDisposableLocalHost', () => {
  it('acepta loopback (redis/postgres, ipv4/ipv6/localhost)', () => {
    for (const u of [
      'redis://localhost:6379', 'redis://127.0.0.1:6379', 'redis://[::1]:6379',
      'postgresql://ci:ci@localhost:5432/ci', 'postgresql://ci:ci@127.0.0.1:5432/ci', 'postgresql://ci:ci@[::1]:5432/ci',
    ]) expect(() => assertDisposableLocalHost(u, 'TEST'), u).not.toThrow()
  })

  it('RECHAZA destinos NO loopback antes de conectar', () => {
    for (const u of [
      'redis://10.0.0.9:6379', 'redis://redis.prod.internal:6379',
      'postgresql://u:p@db.example.com:5432/app', 'postgresql://u:p@192.168.1.10:5432/app',
      'postgresql://u:p@169.254.169.254:5432/app',
    ]) expect(() => assertDisposableLocalHost(u, 'TEST'), u).toThrow(/loopback/)
  })

  it('RECHAZA URL inválida', () => {
    expect(() => assertDisposableLocalHost('no-es-url', 'TEST')).toThrow(/inválida/)
    expect(() => assertDisposableLocalHost('', 'TEST')).toThrow(/inválida/)
  })

  it('el mensaje de error NO incluye el host ni credenciales', () => {
    try { assertDisposableLocalHost('postgresql://user:secretpass@db.example.com:5432/app', 'TEST'); throw new Error('debió lanzar') }
    catch (e) {
      const msg = (e as Error).message
      expect(msg).not.toContain('db.example.com')
      expect(msg).not.toContain('secretpass')
    }
  })
})

describe('assertDestructiveTestAllowed', () => {
  it('loopback SIN señal explícita ⇒ RECHAZA (loopback solo no autoriza destructivo)', () => {
    expect(() => assertDestructiveTestAllowed('redis://localhost:6379', 'REDIS_TEST_URL', ENV)).toThrow(/no autorizada|destructiva/i)
  })
  it('loopback CON señal explícita =1 ⇒ permitido', () => {
    process.env[ENV] = '1'
    expect(() => assertDestructiveTestAllowed('redis://127.0.0.1:6379', 'REDIS_TEST_URL', ENV)).not.toThrow()
  })
  it('no loopback ⇒ RECHAZA aunque la señal esté =1', () => {
    process.env[ENV] = '1'
    expect(() => assertDestructiveTestAllowed('redis://10.0.0.9:6379', 'REDIS_TEST_URL', ENV)).toThrow(/loopback/)
  })
})

describe('buildScopedUrl — REEMPLAZA el schema, no lo anexa', () => {
  it('sin schema previo ⇒ agrega ?schema=', () => {
    const out = buildScopedUrl('postgresql://ci:ci@localhost:5432/ci', 't_abc')
    expect(out).toContain('schema=t_abc')
    expect((out.match(/schema=/g) || []).length).toBe(1)
  })
  it('con schema previo ⇒ lo REEMPLAZA (un solo schema=)', () => {
    const out = buildScopedUrl('postgresql://ci:ci@localhost:5432/ci?schema=public&x=1', 't_abc')
    expect((out.match(/schema=/g) || []).length).toBe(1)
    expect(out).toContain('schema=t_abc')
    expect(out).not.toContain('schema=public')
    expect(out).toContain('x=1')
  })
})
