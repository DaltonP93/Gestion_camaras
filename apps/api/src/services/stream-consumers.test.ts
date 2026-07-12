// Tests del StreamConsumerRegistry (memoria + Redis simulado).
// Cubre acquire/renew/release/count/list/cleanupExpired, expiración por TTL,
// múltiples tipos de consumidor sobre un mismo path, y concurrencia.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MemoryStreamConsumerRegistry,
  RedisStreamConsumerRegistry,
  createStreamConsumerRegistry,
  type RedisConsumerClient,
} from './stream-consumer-registry'

// Fake ioredis en memoria: hash por key + sets.
function makeFakeRedis(): RedisConsumerClient & { hashes: Map<string, Map<string, string>>; sets: Map<string, Set<string>> } {
  const hashes = new Map<string, Map<string, string>>()
  const sets = new Map<string, Set<string>>()
  return {
    hashes, sets,
    async hset(key, field, value) { const h = hashes.get(key) ?? new Map(); h.set(field, value); hashes.set(key, h); return 1 },
    async hgetall(key) { return Object.fromEntries(hashes.get(key) ?? new Map()) },
    async hdel(key, ...fields) { const h = hashes.get(key); if (!h) return 0; let n = 0; for (const f of fields) { if (h.delete(f)) n++ } return n },
    async del(key) { hashes.delete(key); return 1 },
    async sadd(key, member) { const s = sets.get(key) ?? new Set(); s.add(member); sets.set(key, s); return 1 },
    async srem(key, member) { sets.get(key)?.delete(member); return 1 },
    async smembers(key) { return [...(sets.get(key) ?? new Set())] },
    async pexpire() { return 1 },
  }
}

// Corre la MISMA batería contra ambos backends.
const backends: Array<[string, () => { reg: any }]> = [
  ['memory', () => ({ reg: new MemoryStreamConsumerRegistry() })],
  ['redis',  () => ({ reg: new RedisStreamConsumerRegistry(makeFakeRedis()) })],
]

describe.each(backends)('StreamConsumerRegistry (%s)', (_name, make) => {
  let reg: any
  beforeEach(() => { vi.useRealTimers(); reg = make().reg })

  it('acquire registra un consumidor vigente', async () => {
    await reg.acquire('nvr_x_ch09_sub', 'analytics', 'a1', 60_000)
    expect(await reg.count('nvr_x_ch09_sub')).toBe(1)
    const list = await reg.list('nvr_x_ch09_sub')
    expect(list[0]).toMatchObject({ consumerType: 'analytics', consumerId: 'a1' })
  })

  it('un path admite varios tipos de consumidor a la vez', async () => {
    await reg.acquire('p', 'live', 'live:u1', 60_000)
    await reg.acquire('p', 'analytics', 'analytics:p', 60_000)
    await reg.acquire('p', 'recording', 'rec:1', 60_000)
    expect(await reg.count('p')).toBe(3)
    expect(await reg.count('p', 'analytics')).toBe(1)
    expect(await reg.count('p', 'live')).toBe(1)
  })

  it('release baja la cuenta; el path sin consumidores puede borrarse', async () => {
    await reg.acquire('p', 'live', 'l1', 60_000)
    await reg.acquire('p', 'analytics', 'a1', 60_000)
    await reg.release('p', 'l1')
    expect(await reg.count('p')).toBe(1)
    await reg.release('p', 'a1')
    expect(await reg.count('p')).toBe(0)
  })

  it('el lease expira por TTL', async () => {
    vi.useFakeTimers()
    await reg.acquire('p', 'analytics', 'a1', 1_000)
    expect(await reg.count('p')).toBe(1)
    vi.advanceTimersByTime(1_500)
    expect(await reg.count('p')).toBe(0)
    vi.useRealTimers()
  })

  it('renew extiende un lease vigente y falla en uno inexistente', async () => {
    vi.useFakeTimers()
    await reg.acquire('p', 'analytics', 'a1', 2_000)
    vi.advanceTimersByTime(1_500)
    expect(await reg.renew('p', 'a1', 2_000)).toBe(true)
    vi.advanceTimersByTime(1_500) // 3s desde acquire, pero renovado a los 1.5s
    expect(await reg.count('p')).toBe(1)
    expect(await reg.renew('p', 'noexiste', 1_000)).toBe(false)
    vi.useRealTimers()
  })

  it('acquire repetido preserva createdAt (renovación implícita)', async () => {
    const c1 = await reg.acquire('p', 'analytics', 'a1', 60_000)
    await new Promise(r => setTimeout(r, 5))
    const c2 = await reg.acquire('p', 'analytics', 'a1', 60_000)
    expect(c2.createdAt).toBe(c1.createdAt)
    expect(c2.expiresAt).toBeGreaterThanOrEqual(c1.expiresAt)
    expect(await reg.count('p')).toBe(1)
  })

  it('cleanupExpired remueve solo los vencidos', async () => {
    vi.useFakeTimers()
    await reg.acquire('p1', 'analytics', 'a1', 1_000)
    await reg.acquire('p2', 'live', 'l1', 60_000)
    vi.advanceTimersByTime(2_000)
    const removed = await reg.cleanupExpired()
    expect(removed).toBe(1)
    expect(await reg.count('p2')).toBe(1)
    vi.useRealTimers()
  })

  it('list global agrega consumidores de todos los paths', async () => {
    await reg.acquire('p1', 'analytics', 'a1', 60_000)
    await reg.acquire('p2', 'live', 'l1', 60_000)
    expect(await reg.count()).toBe(2)
    expect((await reg.list()).map((c: any) => c.streamPath).sort()).toEqual(['p1', 'p2'])
  })

  it('acquires concurrentes sobre distintos ids no se pisan', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => reg.acquire('p', 'live', `u${i}`, 60_000))
    )
    expect(await reg.count('p')).toBe(20)
  })
})

describe('createStreamConsumerRegistry', () => {
  it('elige Redis con cliente y memoria sin él', () => {
    expect(createStreamConsumerRegistry(makeFakeRedis())).toBeInstanceOf(RedisStreamConsumerRegistry)
    expect(createStreamConsumerRegistry(null)).toBeInstanceOf(MemoryStreamConsumerRegistry)
  })
})
