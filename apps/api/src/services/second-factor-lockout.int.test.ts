// C03 — contador por usuario del 2.º factor contra Redis REAL (script Lua real,
// keyPrefix propio, borrado sólo de ese prefijo). Sin red salvo loopback.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startEphemeralRedis, assertRedisRequiredOrSkip, type EphemeralRedis } from './media/redis-real-harness'
import { beginSecondFactorAttempt, clearSecondFactorFailures, secondFactorFailKey } from './second-factor-lockout'

const HAVE_REDIS = assertRedisRequiredOrSkip()
const SEC = { lockoutMaxAttempts: 5, lockoutDurationMinutes: 15 }
const LOCK_MS = 15 * 60_000

describe.skipIf(!HAVE_REDIS)('second-factor-lockout · Redis REAL', () => {
  let env: EphemeralRedis
  const locks: Array<{ userId: string; until: Date }> = []
  const deps = () => ({ redis: env.raw, lockAccount: async (userId: string, until: Date) => { locks.push({ userId, until }) } })

  beforeAll(async () => { env = await startEphemeralRedis() })
  afterAll(async () => { await env?.stop() })

  it('ráfaga paralela: el INCR reserva un número distinto por intento; sólo los K primeros verifican y el K-ésimo fallo bloquea', async () => {
    const user = { id: 'u-rafaga', lockedUntil: null }
    const attempts = await Promise.all(Array.from({ length: 20 }, () => beginSecondFactorAttempt(deps(), user, SEC)))
    const ok = attempts.filter((a) => a.ok)
    expect(ok.map((a) => (a.ok ? a.attempt : 0)).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5])
    expect(attempts.filter((a) => !a.ok)).toHaveLength(15)
    const results = await Promise.all(ok.map((a) => (a.ok ? a.fail() : null)))
    expect(results.filter((r) => r?.locked)).toHaveLength(1)
    expect(locks.filter((l) => l.userId === 'u-rafaga')).toHaveLength(1)
  })

  it('TTL = duración del bloqueo; se renueva con intentos que verifican y NO con los rechazados por agotamiento', async () => {
    const user = { id: 'u-ttl', lockedUntil: null }
    const key = secondFactorFailKey(user.id)
    const a1 = await beginSecondFactorAttempt(deps(), user, SEC)
    expect(a1.ok).toBe(true)
    const ttl1 = await env.raw.pttl(key)
    expect(ttl1).toBeGreaterThan(LOCK_MS - 5_000)
    expect(ttl1).toBeLessThanOrEqual(LOCK_MS)
    // Se acorta el TTL a mano para ver quién lo renueva.
    await env.raw.pexpire(key, 60_000)
    expect((await beginSecondFactorAttempt(deps(), user, SEC)).ok).toBe(true)
    expect(await env.raw.pttl(key)).toBeGreaterThan(LOCK_MS - 5_000)
    for (let i = 0; i < 3; i++) await beginSecondFactorAttempt(deps(), user, SEC)   // 3, 4, 5
    await env.raw.pexpire(key, 60_000)
    const rechazado = await beginSecondFactorAttempt(deps(), user, SEC)            // 6 > 5
    expect(rechazado.ok).toBe(false)
    expect(await env.raw.pttl(key), 'el rechazado no estira el contador').toBeLessThanOrEqual(60_000)
  })

  it('cuenta con lockedUntil vigente ⇒ rechazo sin tocar el contador; vencido ⇒ cuenta', async () => {
    const key = secondFactorFailKey('u-bloq')
    const r = await beginSecondFactorAttempt(deps(), { id: 'u-bloq', lockedUntil: new Date(Date.now() + 120_000) }, SEC)
    expect(r).toEqual({ ok: false, minutesLeft: 2 })
    expect(await env.raw.exists(key)).toBe(0)
    expect((await beginSecondFactorAttempt(deps(), { id: 'u-bloq', lockedUntil: new Date(Date.now() - 1) }, SEC)).ok).toBe(true)
  })

  it('acierto y desbloqueo del admin borran el contador; un fallo de Redis al borrar tras el acierto no rompe el login', async () => {
    const user = { id: 'u-ok', lockedUntil: null }
    const key = secondFactorFailKey(user.id)
    const a = await beginSecondFactorAttempt(deps(), user, SEC)
    if (!a.ok) throw new Error('debía reservar')
    await a.succeed()
    expect(await env.raw.exists(key)).toBe(0)

    await beginSecondFactorAttempt(deps(), user, SEC)
    await clearSecondFactorFailures(env.raw, user.id)
    expect(await env.raw.exists(key)).toBe(0)

    const errores: unknown[] = []
    const roto = { eval: env.raw.eval.bind(env.raw), del: async () => { throw new Error('redis caído') } }
    const b = await beginSecondFactorAttempt({ redis: roto, lockAccount: async () => undefined, onClearError: (e) => errores.push(e) }, user, SEC)
    if (!b.ok) throw new Error('debía reservar')
    await expect(b.succeed()).resolves.toBeUndefined()
    expect(errores).toHaveLength(1)
  })

  it('Redis caído al reservar ⇒ lanza (fail-closed: la ruta no verifica el código)', async () => {
    const caido = { eval: async () => { throw new Error('redis caído') }, del: async () => 0 }
    await expect(beginSecondFactorAttempt({ redis: caido, lockAccount: async () => undefined }, { id: 'u-caido', lockedUntil: null }, SEC)).rejects.toThrow('redis caído')
  })
})
