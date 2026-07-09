// apps/api/src/services/session-store.ts
// Abstracción de almacenamiento de sesiones/tokens con TTL.
// Backend Redis (sobrevive reinicios, compartido entre workers) con
// fallback automático a memoria cuando Redis no está disponible.
//
// Nota de arquitectura: SOLO el estado serializable va aquí (tokens,
// metadatos). Las sesiones que sostienen un ChildProcess de FFmpeg son
// inherentemente locales al proceso y permanecen en Maps — con múltiples
// workers requieren sticky routing, no un store compartido.

export interface SessionStore<T> {
  get(key: string): Promise<T | null>
  set(key: string, value: T, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
}

export class MemorySessionStore<T> implements SessionStore<T> {
  private map = new Map<string, { value: T; expiresAt: number }>()

  constructor(sweepIntervalMs = 5 * 60 * 1000) {
    const t = setInterval(() => {
      const now = Date.now()
      for (const [k, e] of this.map.entries()) {
        if (now > e.expiresAt) this.map.delete(k)
      }
    }, sweepIntervalMs)
    if (typeof t.unref === 'function') t.unref()
  }

  async get(key: string): Promise<T | null> {
    const e = this.map.get(key)
    if (!e) return null
    if (Date.now() > e.expiresAt) { this.map.delete(key); return null }
    return e.value
  }

  async set(key: string, value: T, ttlMs: number): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

// Cliente mínimo compatible con ioredis (@fastify/redis)
interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, px: 'PX', ttl: number): Promise<unknown>
  del(key: string): Promise<unknown>
}

export class RedisSessionStore<T> implements SessionStore<T> {
  constructor(private redis: RedisLike, private prefix: string) {}

  async get(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(this.prefix + key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch {
      return null
    }
  }

  async set(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      await this.redis.set(this.prefix + key, JSON.stringify(value), 'PX', Math.max(1, ttlMs))
    } catch { /* Redis caído: el token simplemente no persiste */ }
  }

  async delete(key: string): Promise<void> {
    try { await this.redis.del(this.prefix + key) } catch { /* idem */ }
  }
}

export function createSessionStore<T>(
  redis: RedisLike | null | undefined,
  prefix: string,
): SessionStore<T> {
  return redis ? new RedisSessionStore<T>(redis, prefix) : new MemorySessionStore<T>()
}
