import { describe, expect, it } from 'vitest'
import { MemoryGrantStore, RedisGrantStore, validateAndClaimReducer, type ClaimState, type ValidateAndClaimInput } from './grant-store'
import { FakeRedis } from './redis-fake'
import type { StoredMediaGrant } from './contracts'

function grant(over: Partial<StoredMediaGrant> = {}): StoredMediaGrant {
  return {
    grantId: 'g1', secretHash: 'h', userId: 'u', viewId: 'v', cameraId: 'c',
    streamPath: 'nvr_c_sub', codec: 'hevc', transport: 'rtsps', action: 'read',
    effectiveType: 'sub', device: 'd', mediaInstanceId: 'mi-1', authorizationEpoch: 0,
    issuedAt: 0, expiresAt: 9e15, revokedAt: null, ...over,
  }
}
function claimInput(over: Partial<ValidateAndClaimInput> = {}): ValidateAndClaimInput {
  return { grantId: 'g1', presentedSecretHash: 'h', scope: { userId: 'u', cameraId: 'c', streamPath: 'nvr_c_sub', transport: 'rtsps', action: 'read' }, nowMs: 1000, ...over }
}
function state(over: Partial<ClaimState> = {}): ClaimState {
  return { grant: grant(), userEpoch: 0, currentInstance: 'mi-1', alreadyClaimed: false, ...over }
}

describe('validateAndClaimReducer (transición pura)', () => {
  it('ok con todo válido', () => { expect(validateAndClaimReducer(state(), claimInput())).toEqual({ result: { ok: true, grant: grant() }, claim: true }) })
  it('NOT_FOUND', () => { expect(validateAndClaimReducer(state({ grant: null }), claimInput()).result.reason).toBe('NOT_FOUND') })
  it('REVOKED antes que epoch/instancia', () => { expect(validateAndClaimReducer(state({ grant: grant({ revokedAt: 5 }) }), claimInput()).result.reason).toBe('REVOKED') })
  it('EXPIRED por nowMs vigente', () => { expect(validateAndClaimReducer(state(), claimInput({ nowMs: 9e15 })).result.reason).toBe('EXPIRED') })
  it('EPOCH_MISMATCH si el epoch avanzó', () => { expect(validateAndClaimReducer(state({ userEpoch: 1 }), claimInput()).result.reason).toBe('EPOCH_MISMATCH') })
  it('INSTANCE_REQUIRED / INSTANCE_MISMATCH', () => {
    expect(validateAndClaimReducer(state({ currentInstance: null }), claimInput()).result.reason).toBe('INSTANCE_REQUIRED')
    expect(validateAndClaimReducer(state({ currentInstance: 'mi-2' }), claimInput()).result.reason).toBe('INSTANCE_MISMATCH')
  })
  it('SECRET_MISMATCH / SCOPE_MISMATCH / REPLAYED', () => {
    expect(validateAndClaimReducer(state(), claimInput({ presentedSecretHash: 'x' })).result.reason).toBe('SECRET_MISMATCH')
    expect(validateAndClaimReducer(state(), claimInput({ scope: { ...claimInput().scope, cameraId: 'z' } })).result.reason).toBe('SCOPE_MISMATCH')
    expect(validateAndClaimReducer(state({ alreadyClaimed: true }), claimInput()).result.reason).toBe('REPLAYED')
  })
})

describe.each([
  ['memoria', () => new MemoryGrantStore()],
  ['redis-fake', () => new RedisGrantStore(new FakeRedis())],
])('GrantStore (%s)', (_n, make) => {
  it('issue + validateAndClaim (uso único)', async () => {
    const s = make()
    await s.registerSource('nvr_c_sub', 60_000)
    const inst = await s.currentInstance('nvr_c_sub')
    await s.issueGrant(grant({ mediaInstanceId: inst!, secretHash: 'sh' }), { viewId: 'v' }, 30_000)
    const r1 = await s.validateAndClaim(claimInput({ presentedSecretHash: 'sh' }))
    expect(r1.ok).toBe(true)
    const r2 = await s.validateAndClaim(claimInput({ presentedSecretHash: 'sh' }))
    expect(r2.reason).toBe('REPLAYED')
  })
  it('issue NO existe sin fuente (currentInstance null)', async () => {
    const s = make()
    expect(await s.currentInstance('nvr_x_sub')).toBeNull()
  })
  it('epoch: get/bump; instancia: register rota', async () => {
    const s = make()
    expect(await s.getUserEpoch('u')).toBe(0)
    expect(await s.bumpUserEpoch('u')).toBe(1)
    const a = await s.registerSource('p', 60_000)
    const b = await s.registerSource('p', 60_000)
    expect(b).not.toBe(a)
  })
})

describe('B2 · issueGrant atómico (EVAL agrupa grant + índices)', () => {
  it('escribe grant e índices user/view/session en la misma operación', async () => {
    const redis = new FakeRedis()
    const s = new RedisGrantStore(redis)
    await s.registerSource('nvr_c_sub', 60_000)
    const inst = await s.currentInstance('nvr_c_sub')
    await s.issueGrant(grant({ mediaInstanceId: inst!, secretHash: 'sh' }), { viewId: 'view-1', sessionId: 'sess-1' }, 30_000)
    // El grant y TODOS sus índices quedan presentes (no hay grant sin índice).
    expect(await s.getGrant('g1')).not.toBeNull()
    expect(await s.listIndex('user', 'u')).toContain('g1')
    expect(await s.listIndex('view', 'view-1')).toContain('g1')
    expect(await s.listIndex('session', 'sess-1')).toContain('g1')
  })

  it('sin sessionId no crea el índice de sesión', async () => {
    const redis = new FakeRedis()
    const s = new RedisGrantStore(redis)
    await s.registerSource('nvr_c_sub', 60_000)
    const inst = await s.currentInstance('nvr_c_sub')
    await s.issueGrant(grant({ mediaInstanceId: inst!, secretHash: 'sh' }), { viewId: 'view-1' }, 30_000)
    expect(await s.listIndex('view', 'view-1')).toContain('g1')
    expect(await s.listIndex('session', '_')).toEqual([])
  })

  it('backend caído durante el issue ⇒ lanza (nada a medias)', async () => {
    const redis = new FakeRedis()
    const s = new RedisGrantStore(redis)
    redis.down = true
    await expect(s.issueGrant(grant({ secretHash: 'sh' }), { viewId: 'v' }, 30_000)).rejects.toThrow()
    // El outbox de Redis quedó intacto: ni grant ni índice.
    redis.down = false
    expect(await s.getGrant('g1')).toBeNull()
    expect(await s.listIndex('user', 'u')).toEqual([])
  })
})

describe('cross-process (dos RedisGrantStore sobre el mismo Redis)', () => {
  it('T3 · validateAndClaim concurrente ⇒ exactamente uno gana', async () => {
    const redis = new FakeRedis()
    const a = new RedisGrantStore(redis); const b = new RedisGrantStore(redis)
    await a.registerSource('nvr_c_sub', 60_000)
    const inst = await a.currentInstance('nvr_c_sub')
    await a.issueGrant(grant({ mediaInstanceId: inst!, secretHash: 'sh' }), { viewId: 'v' }, 30_000)
    const [r1, r2] = await Promise.all([
      a.validateAndClaim(claimInput({ presentedSecretHash: 'sh' })),
      b.validateAndClaim(claimInput({ presentedSecretHash: 'sh' })),
    ])
    expect([r1, r2].filter(r => r.ok).length).toBe(1)
  })
  it('backend caído ⇒ BACKEND_UNAVAILABLE (fail-closed)', async () => {
    const redis = new FakeRedis(); const s = new RedisGrantStore(redis)
    redis.down = true
    expect((await s.validateAndClaim(claimInput())).reason).toBe('BACKEND_UNAVAILABLE')
    await expect(s.bumpUserEpoch('u')).rejects.toThrow()
    expect(await s.healthy()).toBe(false)
  })
})
