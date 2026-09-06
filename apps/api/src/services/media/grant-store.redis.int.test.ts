// apps/api/src/services/media/grant-store.redis.int.test.ts
//
// C23·H2·P1 — INTEGRACIÓN con Redis REAL (redis-server efímero). Valida lo que el
// fake NO puede: (a) la expiración se juzga con el RELOJ DE REDIS dentro del EVAL
// (no con un Date.now() de Node) y (b) la atomicidad/linealizabilidad real de EVAL
// (uso único cross-process). Cierra el redis-server al terminar.
//
// MUTACIÓN cubierta: si LUA_VALIDATE_AND_CLAIM confiara en un `now` de Node en vez
// de redis.call('TIME'), el caso EXPIRED-por-reloj-de-Redis dejaría de detectarse.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RedisGrantStore, type ValidateAndClaimInput } from './grant-store'
import { startEphemeralRedis, assertRedisRequiredOrSkip, type EphemeralRedis } from './redis-real-harness'
import type { StoredMediaGrant } from './contracts'

const HAVE_REDIS = assertRedisRequiredOrSkip()

function grant(over: Partial<StoredMediaGrant> = {}): StoredMediaGrant {
  return {
    grantId: 'g1', secretHash: 'sh', userId: 'u', viewId: 'v', cameraId: 'c',
    streamPath: 'nvr_c_sub', codec: 'hevc', transport: 'rtsps', action: 'read',
    effectiveType: 'sub', device: 'd', mediaInstanceId: 'mi-1', authorizationEpoch: 0,
    // expiresAt/issuedAt los REESCRIBE ISSUE_GRANT con el reloj de Redis; el valor
    // que se pone aquí es intencionalmente absurdo para probar que se ignora.
    issuedAt: 0, expiresAt: 1, revokedAt: null, ...over,
  }
}
function claimInput(over: Partial<ValidateAndClaimInput> = {}): ValidateAndClaimInput {
  return { grantId: 'g1', presentedSecretHash: 'sh', scope: { userId: 'u', cameraId: 'c', streamPath: 'nvr_c_sub', transport: 'rtsps', action: 'read' }, nowMs: 0, ...over }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!HAVE_REDIS)('GrantStore · Redis REAL (redis-server efímero)', () => {
  let env: EphemeralRedis
  let store: RedisGrantStore
  beforeAll(async () => { env = await startEphemeralRedis(); store = new RedisGrantStore(env.client) })
  afterAll(async () => { await env?.stop() })

  it('emisión fija expiresAt con RELOJ DE REDIS (ignora el expiresAt=1 de Node)', async () => {
    await store.registerSource('nvr_c_sub', 60_000)
    const inst = await store.currentInstance('nvr_c_sub')
    await store.issueGrant(grant({ mediaInstanceId: inst!, expiresAt: 1, issuedAt: 0 }), { viewId: 'v' }, 30_000)
    const stored = await store.getGrant('g1')
    expect(stored).not.toBeNull()
    // El expiresAt guardado es Redis-time (~ahora + 30s), NO el 1 que trajo el JSON.
    expect(stored!.expiresAt).toBeGreaterThan(Date.now())
    expect(stored!.expiresAt - stored!.issuedAt).toBe(30_000)
  })

  it('happy: grant vigente ⇒ OK; segundo consumo ⇒ REPLAYED (uso único atómico real)', async () => {
    await store.registerSource('nvr_c_sub', 60_000)
    const inst = await store.currentInstance('nvr_c_sub')
    await store.issueGrant(grant({ grantId: 'gok', mediaInstanceId: inst!, secretHash: 'shok' }), { viewId: 'v' }, 30_000)
    const r1 = await store.validateAndClaim(claimInput({ grantId: 'gok', presentedSecretHash: 'shok' }))
    expect(r1.ok).toBe(true)
    const r2 = await store.validateAndClaim(claimInput({ grantId: 'gok', presentedSecretHash: 'shok' }))
    expect(r2.reason).toBe('REPLAYED')
  })

  it('EXPIRED por el reloj de Redis cuando la operación se DETIENE antes del EVAL', async () => {
    await store.registerSource('nvr_c_sub', 60_000)
    const inst = await store.currentInstance('nvr_c_sub')
    // TTL lógico muy corto (250ms) pero la clave sobrevive por la gracia (10s) ⇒ el
    // grant sigue presente al validar, así que el rechazo es EXPIRED (no NOT_FOUND).
    await store.issueGrant(grant({ grantId: 'gexp', mediaInstanceId: inst!, secretHash: 'shx' }), { viewId: 'v' }, 250)
    await sleep(500)  // "operación detenida": el reloj de Redis avanza más allá del TTL
    const r = await store.validateAndClaim(claimInput({ grantId: 'gexp', presentedSecretHash: 'shx' }))
    expect(r.reason).toBe('EXPIRED')
    // validateSession (no destructiva) coincide en el veredicto por reloj de Redis.
    const rs = await store.validateSession(claimInput({ grantId: 'gexp', presentedSecretHash: 'shx' }))
    expect(rs.reason).toBe('EXPIRED')
  })

  it('T3 · dos RedisGrantStore sobre el MISMO redis ⇒ exactamente uno reclama', async () => {
    const a = new RedisGrantStore(env.client)
    const b = new RedisGrantStore(env.client)
    await a.registerSource('nvr_cx_sub', 60_000)
    const inst = await a.currentInstance('nvr_cx_sub')
    await a.issueGrant(grant({ grantId: 'grace', mediaInstanceId: inst!, secretHash: 'shr', streamPath: 'nvr_cx_sub' }), { viewId: 'v' }, 30_000)
    const scoped = claimInput({ grantId: 'grace', presentedSecretHash: 'shr', scope: { userId: 'u', cameraId: 'c', streamPath: 'nvr_cx_sub', transport: 'rtsps', action: 'read' } })
    const [r1, r2] = await Promise.all([a.validateAndClaim(scoped), b.validateAndClaim(scoped)])
    expect([r1, r2].filter((r) => r.ok).length).toBe(1)
    expect([r1, r2].filter((r) => r.reason === 'REPLAYED').length).toBe(1)
  })

  it('EPOCH_MISMATCH real: bump del epoch invalida un grant emitido antes', async () => {
    await store.registerSource('nvr_ep_sub', 60_000)
    const inst = await store.currentInstance('nvr_ep_sub')
    await store.issueGrant(grant({ grantId: 'gep', mediaInstanceId: inst!, secretHash: 'she', userId: 'uep', streamPath: 'nvr_ep_sub' }), { viewId: 'v' }, 30_000)
    await store.bumpUserEpoch('uep')  // logout/permiso tras la emisión
    const r = await store.validateAndClaim(claimInput({ grantId: 'gep', presentedSecretHash: 'she', scope: { userId: 'uep', cameraId: 'c', streamPath: 'nvr_ep_sub', transport: 'rtsps', action: 'read' } }))
    expect(r.reason).toBe('EPOCH_MISMATCH')
  })
})
