// apps/api/src/services/media/redis-fake.ts
//
// Fake de Redis con semántica ATÓMICA equivalente para pruebas (C22.2). No es
// código de producción; en producción se usa ioredis real (@fastify/redis) y el
// script Lua real. Este fake implementa `eval` ejecutando el MISMO reducer puro
// dentro de una sola función async (atómica en el event loop de un solo hilo),
// de modo que dos EVAL concurrentes (dos "procesos" sobre el mismo Redis)
// serialicen y exactamente uno reclame el uso — igual que Lua en el servidor.
//
// La ruta Lua real NO se valida en vivo en este entorno (sin Redis): ver docs.

import { validateAndClaimReducer, type RedisGrantClient, type ValidateAndClaimInput } from './grant-store'
import type { StoredMediaGrant, MediaTransport, MediaAction } from './contracts'

export class FakeRedis implements RedisGrantClient {
  private kv = new Map<string, { v: string; exp: number | null }>()
  private sets = new Map<string, Set<string>>()
  /** Simula backend caído: toda operación lanza. */
  down = false

  private guard(): void { if (this.down) throw new Error('redis down') }
  private live(k: string): { v: string; exp: number | null } | null {
    const e = this.kv.get(k)
    if (!e) return null
    if (e.exp !== null && Date.now() > e.exp) { this.kv.delete(k); return null }
    return e
  }

  async ping(): Promise<unknown> { this.guard(); return 'PONG' }
  async get(k: string): Promise<string | null> { this.guard(); return this.live(k)?.v ?? null }
  async set(k: string, v: string, _m: 'PX', ttl: number, nx?: 'NX'): Promise<unknown> {
    this.guard()
    if (nx === 'NX' && this.live(k)) return null
    this.kv.set(k, { v, exp: ttl ? Date.now() + ttl : null })
    return 'OK'
  }
  async del(k: string): Promise<unknown> { this.guard(); this.kv.delete(k); return 1 }
  async sadd(k: string, m: string): Promise<unknown> { this.guard(); let s = this.sets.get(k); if (!s) { s = new Set(); this.sets.set(k, s) } s.add(m); return 1 }
  async srem(k: string, m: string): Promise<unknown> { this.guard(); this.sets.get(k)?.delete(m); return 1 }
  async smembers(k: string): Promise<string[]> { this.guard(); return [...(this.sets.get(k) ?? [])] }
  async pexpire(): Promise<unknown> { this.guard(); return 1 }
  async incr(k: string): Promise<number> { this.guard(); const e = this.live(k); const n = (e ? parseInt(e.v, 10) : 0) + 1; this.kv.set(k, { v: String(n), exp: null }); return n }

  // EVAL del script VALIDATE_AND_CLAIM (atómico: lee estado y marca el uso sin await).
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.guard()
    if (!script.includes('VALIDATE_AND_CLAIM')) throw new Error('unknown script')
    const keys = args.slice(0, numKeys).map(String)
    const argv = args.slice(numKeys).map(String)
    const [grantKey, epochKey, instKey, claimKey] = keys
    const [userId, cameraId, streamPath, transport, action, secretHash, nowStr, claimTtlStr] = argv
    const rawGrant = this.live(grantKey)?.v
    const grant = rawGrant ? (JSON.parse(rawGrant) as StoredMediaGrant) : null
    const userEpoch = parseInt(this.live(epochKey)?.v ?? '0', 10)
    const currentInstance = this.live(instKey)?.v ?? null
    const alreadyClaimed = !!this.live(claimKey)
    const input: ValidateAndClaimInput = {
      grantId: grantKey, presentedSecretHash: secretHash,
      scope: { userId, cameraId, streamPath, transport: transport as MediaTransport, action: action as MediaAction },
      nowMs: Number(nowStr),
    }
    const { result, claim } = validateAndClaimReducer({ grant, userEpoch, currentInstance, alreadyClaimed }, input)
    if (claim) this.kv.set(claimKey, { v: '1', exp: Date.now() + Number(claimTtlStr) })
    return JSON.stringify({ ok: result.ok, reason: result.reason })
  }
}
