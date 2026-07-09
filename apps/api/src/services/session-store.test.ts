// Tests del SessionStore (memoria + Redis simulado)
import { describe, it, expect, vi } from 'vitest'
import { MemorySessionStore, RedisSessionStore, createSessionStore } from './session-store'

describe('MemorySessionStore', () => {
  it('guarda y recupera valores', async () => {
    const store = new MemorySessionStore<{ a: number }>()
    await store.set('k1', { a: 1 }, 60_000)
    expect(await store.get('k1')).toEqual({ a: 1 })
  })

  it('expira valores por TTL', async () => {
    vi.useFakeTimers()
    const store = new MemorySessionStore<string>()
    await store.set('k', 'v', 1_000)
    vi.advanceTimersByTime(1_500)
    expect(await store.get('k')).toBeNull()
    vi.useRealTimers()
  })

  it('delete elimina la clave', async () => {
    const store = new MemorySessionStore<string>()
    await store.set('k', 'v', 60_000)
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
  })
})

describe('RedisSessionStore', () => {
  const makeFakeRedis = () => {
    const data = new Map<string, string>()
    return {
      data,
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string, _px: 'PX', _ttl: number) => { data.set(k, v) },
      del: async (k: string) => { data.delete(k) },
    }
  }

  it('serializa JSON con prefijo de namespace', async () => {
    const redis = makeFakeRedis()
    const store = new RedisSessionStore<{ token: string }>(redis, 'vc:test:')
    await store.set('abc', { token: 'abc' }, 60_000)
    expect(redis.data.has('vc:test:abc')).toBe(true)
    expect(await store.get('abc')).toEqual({ token: 'abc' })
    await store.delete('abc')
    expect(await store.get('abc')).toBeNull()
  })

  it('tolera errores de Redis sin lanzar (get devuelve null)', async () => {
    const broken = {
      get: async () => { throw new Error('redis down') },
      set: async () => { throw new Error('redis down') },
      del: async () => { throw new Error('redis down') },
    }
    const store = new RedisSessionStore<string>(broken as any, 'p:')
    await expect(store.set('k', 'v', 1000)).resolves.toBeUndefined()
    await expect(store.get('k')).resolves.toBeNull()
    await expect(store.delete('k')).resolves.toBeUndefined()
  })
})

describe('createSessionStore', () => {
  it('elige Redis cuando hay cliente y memoria cuando no', () => {
    const fake = { get: async () => null, set: async () => {}, del: async () => {} }
    expect(createSessionStore(fake as any, 'p:')).toBeInstanceOf(RedisSessionStore)
    expect(createSessionStore(null, 'p:')).toBeInstanceOf(MemorySessionStore)
  })
})
