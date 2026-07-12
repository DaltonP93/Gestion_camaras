// apps/api/src/services/stream-consumer-registry.ts
//
// StreamConsumerRegistry — refcount profesional de consumidores de un path de
// MediaMTX. Reemplaza al Map+TTL en memoria que solo conocía "analytics".
//
// Un "path" de MediaMTX (p.ej. nvr_<id>_ch09_sub) puede tener varios
// consumidores simultáneos de distinto tipo:
//   - live       → un viewer de Vista en vivo
//   - analytics  → el worker de analítica leyendo el restream
//   - recording  → un preview/exportación de Grabaciones sobre ese path
//   - diagnostic → una herramienta de diagnóstico futura
//
// Regla de oro: un path NO debe eliminarse de MediaMTX mientras tenga al menos
// un consumidor vigente. Cada consumidor tiene un lease con TTL que debe
// renovarse (heartbeat); si no se renueva, expira y deja de contar.
//
// Backend: Redis (estado compartido que sobrevive reinicios del API y sirve con
// múltiples workers) con fallback a memoria para desarrollo. NUNCA se guardan
// credenciales ni URLs RTSP — solo streamPath, tipo, id y timestamps.

export type ConsumerType = 'live' | 'analytics' | 'recording' | 'diagnostic'

export interface StreamConsumer {
  streamPath: string
  consumerType: ConsumerType
  consumerId: string
  createdAt: number    // epoch ms
  lastHeartbeat: number // epoch ms
  expiresAt: number    // epoch ms
}

export interface StreamConsumerRegistry {
  /** Registra (o refresca) un consumidor sobre un path con un TTL. */
  acquire(streamPath: string, type: ConsumerType, consumerId: string, ttlMs: number): Promise<StreamConsumer>
  /** Renueva el lease de un consumidor existente. Devuelve false si no existía. */
  renew(streamPath: string, consumerId: string, ttlMs: number): Promise<boolean>
  /** Libera explícitamente un consumidor. */
  release(streamPath: string, consumerId: string): Promise<void>
  /** Cantidad de consumidores vigentes (de un path, o global si se omite). */
  count(streamPath?: string, type?: ConsumerType): Promise<number>
  /** Lista consumidores vigentes (de un path, o global si se omite). */
  list(streamPath?: string): Promise<StreamConsumer[]>
  /** Poda perezosa de leases vencidos; devuelve cuántos removió. */
  cleanupExpired(): Promise<number>
}

// Logger opcional inyectable (se usa server.log en producción). Sin él, console.
type Logger = { info: (msg: string) => void }
let logger: Logger = { info: (m) => console.info(m) }
export function setStreamConsumerLogger(l: Logger): void { logger = l }

function isLive(c: StreamConsumer, now: number): boolean {
  return c.expiresAt > now
}

// ─── Backend en memoria ─────────────────────────────────────────────
export class MemoryStreamConsumerRegistry implements StreamConsumerRegistry {
  private paths = new Map<string, Map<string, StreamConsumer>>()

  async acquire(streamPath: string, type: ConsumerType, consumerId: string, ttlMs: number): Promise<StreamConsumer> {
    const now = Date.now()
    let byId = this.paths.get(streamPath)
    if (!byId) { byId = new Map(); this.paths.set(streamPath, byId) }
    const existing = byId.get(consumerId)
    const consumer: StreamConsumer = {
      streamPath, consumerType: type, consumerId,
      createdAt: existing?.createdAt ?? now,
      lastHeartbeat: now,
      expiresAt: now + ttlMs,
    }
    byId.set(consumerId, consumer)
    logger.info(`consumer_acquired path=${streamPath} type=${type} id=${consumerId} ttlMs=${ttlMs}`)
    return consumer
  }

  async renew(streamPath: string, consumerId: string, ttlMs: number): Promise<boolean> {
    const c = this.paths.get(streamPath)?.get(consumerId)
    if (!c || !isLive(c, Date.now())) return false
    const now = Date.now()
    c.lastHeartbeat = now
    c.expiresAt = now + ttlMs
    logger.info(`consumer_renewed path=${streamPath} id=${consumerId} ttlMs=${ttlMs}`)
    return true
  }

  async release(streamPath: string, consumerId: string): Promise<void> {
    const byId = this.paths.get(streamPath)
    if (byId?.delete(consumerId)) {
      logger.info(`consumer_released path=${streamPath} id=${consumerId}`)
    }
    if (byId && byId.size === 0) this.paths.delete(streamPath)
  }

  async count(streamPath?: string, type?: ConsumerType): Promise<number> {
    return (await this.list(streamPath)).filter(c => !type || c.consumerType === type).length
  }

  async list(streamPath?: string): Promise<StreamConsumer[]> {
    const now = Date.now()
    const out: StreamConsumer[] = []
    const iterate = (byId: Map<string, StreamConsumer>, path: string) => {
      for (const [id, c] of [...byId.entries()]) {
        if (isLive(c, now)) out.push(c)
        else byId.delete(id) // poda perezosa
      }
      if (byId.size === 0) this.paths.delete(path)
    }
    if (streamPath) {
      const byId = this.paths.get(streamPath)
      if (byId) iterate(byId, streamPath)
    } else {
      for (const [path, byId] of [...this.paths.entries()]) iterate(byId, path)
    }
    return out
  }

  async cleanupExpired(): Promise<number> {
    const before = [...this.paths.values()].reduce((n, m) => n + m.size, 0)
    await this.list() // poda perezosa global
    const after = [...this.paths.values()].reduce((n, m) => n + m.size, 0)
    return before - after
  }
}

// ─── Backend Redis ──────────────────────────────────────────────────
// Cliente mínimo compatible con ioredis (@fastify/redis).
export interface RedisConsumerClient {
  hset(key: string, field: string, value: string): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  del(key: string): Promise<unknown>
  sadd(key: string, member: string): Promise<unknown>
  srem(key: string, member: string): Promise<unknown>
  smembers(key: string): Promise<string[]>
  pexpire(key: string, ttlMs: number): Promise<unknown>
}

const PATHS_SET = 'vc:consumers:paths'
const hashKey = (streamPath: string) => `vc:consumers:${streamPath}`
// La expiración fina la maneja expiresAt en el JSON; el pexpire del hash es solo
// un colchón de seguridad para que Redis no acumule hashes olvidados.
const HASH_SAFETY_TTL_MS = 24 * 60 * 60 * 1000

export class RedisStreamConsumerRegistry implements StreamConsumerRegistry {
  constructor(private redis: RedisConsumerClient) {}

  async acquire(streamPath: string, type: ConsumerType, consumerId: string, ttlMs: number): Promise<StreamConsumer> {
    const now = Date.now()
    // preservar createdAt si ya existía
    let createdAt = now
    try {
      const raw = (await this.redis.hgetall(hashKey(streamPath))) || {}
      const prev = raw[consumerId] ? (JSON.parse(raw[consumerId]) as StreamConsumer) : null
      if (prev) createdAt = prev.createdAt
    } catch { /* red degradada: seguimos con createdAt=now */ }
    const consumer: StreamConsumer = {
      streamPath, consumerType: type, consumerId,
      createdAt, lastHeartbeat: now, expiresAt: now + ttlMs,
    }
    try {
      await this.redis.hset(hashKey(streamPath), consumerId, JSON.stringify(consumer))
      await this.redis.sadd(PATHS_SET, streamPath)
      await this.redis.pexpire(hashKey(streamPath), HASH_SAFETY_TTL_MS)
    } catch { /* si Redis cae, el path simplemente no queda registrado */ }
    logger.info(`consumer_acquired path=${streamPath} type=${type} id=${consumerId} ttlMs=${ttlMs}`)
    return consumer
  }

  async renew(streamPath: string, consumerId: string, ttlMs: number): Promise<boolean> {
    try {
      const raw = (await this.redis.hgetall(hashKey(streamPath))) || {}
      const prev = raw[consumerId] ? (JSON.parse(raw[consumerId]) as StreamConsumer) : null
      if (!prev || prev.expiresAt <= Date.now()) return false
      const now = Date.now()
      const updated: StreamConsumer = { ...prev, lastHeartbeat: now, expiresAt: now + ttlMs }
      await this.redis.hset(hashKey(streamPath), consumerId, JSON.stringify(updated))
      await this.redis.pexpire(hashKey(streamPath), HASH_SAFETY_TTL_MS)
      logger.info(`consumer_renewed path=${streamPath} id=${consumerId} ttlMs=${ttlMs}`)
      return true
    } catch { return false }
  }

  async release(streamPath: string, consumerId: string): Promise<void> {
    try {
      await this.redis.hdel(hashKey(streamPath), consumerId)
      logger.info(`consumer_released path=${streamPath} id=${consumerId}`)
      const raw = (await this.redis.hgetall(hashKey(streamPath))) || {}
      if (Object.keys(raw).length === 0) {
        await this.redis.del(hashKey(streamPath))
        await this.redis.srem(PATHS_SET, streamPath)
      }
    } catch { /* red degradada */ }
  }

  async count(streamPath?: string, type?: ConsumerType): Promise<number> {
    return (await this.list(streamPath)).filter(c => !type || c.consumerType === type).length
  }

  async list(streamPath?: string): Promise<StreamConsumer[]> {
    const now = Date.now()
    const readPath = async (path: string): Promise<StreamConsumer[]> => {
      let raw: Record<string, string> = {}
      try { raw = (await this.redis.hgetall(hashKey(path))) || {} } catch { return [] }
      const live: StreamConsumer[] = []
      const expired: string[] = []
      for (const [id, val] of Object.entries(raw)) {
        try {
          const c = JSON.parse(val) as StreamConsumer
          if (c.expiresAt > now) live.push(c)
          else expired.push(id)
        } catch { expired.push(id) }
      }
      if (expired.length) {
        try {
          await this.redis.hdel(hashKey(path), ...expired)
          if (live.length === 0) { await this.redis.del(hashKey(path)); await this.redis.srem(PATHS_SET, path) }
        } catch { /* ignore */ }
      }
      return live
    }
    if (streamPath) return readPath(streamPath)
    let paths: string[] = []
    try { paths = await this.redis.smembers(PATHS_SET) } catch { return [] }
    const all = await Promise.all(paths.map(readPath))
    return all.flat()
  }

  async cleanupExpired(): Promise<number> {
    let paths: string[] = []
    try { paths = await this.redis.smembers(PATHS_SET) } catch { return 0 }
    let removed = 0
    for (const path of paths) {
      let raw: Record<string, string> = {}
      try { raw = (await this.redis.hgetall(hashKey(path))) || {} } catch { continue }
      const now = Date.now()
      const expired = Object.entries(raw)
        .filter(([, v]) => { try { return (JSON.parse(v) as StreamConsumer).expiresAt <= now } catch { return true } })
        .map(([id]) => id)
      if (expired.length) {
        try {
          await this.redis.hdel(hashKey(path), ...expired)
          removed += expired.length
          const rest = (await this.redis.hgetall(hashKey(path))) || {}
          if (Object.keys(rest).length === 0) { await this.redis.del(hashKey(path)); await this.redis.srem(PATHS_SET, path) }
        } catch { /* ignore */ }
      }
    }
    return removed
  }
}

// ─── Singleton configurable ─────────────────────────────────────────
let singleton: StreamConsumerRegistry = new MemoryStreamConsumerRegistry()

/** Promociona el registry a Redis (llamar al arrancar el API con server.redis). */
export function configureStreamConsumerRegistry(redis: RedisConsumerClient | null | undefined): void {
  singleton = redis ? new RedisStreamConsumerRegistry(redis) : new MemoryStreamConsumerRegistry()
}

export function getStreamConsumerRegistry(): StreamConsumerRegistry {
  return singleton
}

export function createStreamConsumerRegistry(redis: RedisConsumerClient | null | undefined): StreamConsumerRegistry {
  return redis ? new RedisStreamConsumerRegistry(redis) : new MemoryStreamConsumerRegistry()
}
