import { describe, expect, it } from 'vitest'
import { MemoryGrantStore, RedisGrantStore, validateAndClaimReducer, validateSessionReducer, type ClaimState, type SessionState, type ValidateAndClaimInput } from './grant-store'
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

// ─── A1 · F0 — grant de sesión (no destructivo) ──────────────────────
function sstate(over: Partial<SessionState> = {}): SessionState {
  return { grant: grant(), userEpoch: 0, currentInstance: 'mi-1', ...over }
}

describe('A1·F0 · validateSessionReducer (mismas verificaciones, sin claim ni REPLAYED)', () => {
  it('ok con todo válido (NO marca uso ⇒ sin campo claim)', () => {
    expect(validateSessionReducer(sstate(), claimInput())).toEqual({ result: { ok: true, grant: grant() } })
  })
  it('cada reject reason en el mismo orden que validateAndClaim', () => {
    expect(validateSessionReducer(sstate({ grant: null }), claimInput()).result.reason).toBe('NOT_FOUND')
    expect(validateSessionReducer(sstate({ grant: grant({ revokedAt: 5 }) }), claimInput()).result.reason).toBe('REVOKED')
    expect(validateSessionReducer(sstate(), claimInput({ nowMs: 9e15 })).result.reason).toBe('EXPIRED')
    expect(validateSessionReducer(sstate(), claimInput({ scope: { ...claimInput().scope, cameraId: 'z' } })).result.reason).toBe('SCOPE_MISMATCH')
    expect(validateSessionReducer(sstate({ userEpoch: 1 }), claimInput()).result.reason).toBe('EPOCH_MISMATCH')
    expect(validateSessionReducer(sstate({ currentInstance: null }), claimInput()).result.reason).toBe('INSTANCE_REQUIRED')
    expect(validateSessionReducer(sstate({ currentInstance: 'mi-2' }), claimInput()).result.reason).toBe('INSTANCE_MISMATCH')
    expect(validateSessionReducer(sstate(), claimInput({ presentedSecretHash: 'x' })).result.reason).toBe('SECRET_MISMATCH')
  })
  it('re-validación REPETIDA sigue OK; NUNCA devuelve REPLAYED', () => {
    // El reducer es puro: aunque "ya se usó", no hay estado alreadyClaimed que lo
    // marque; re-invocar N veces con el mismo grant vigente da siempre ok.
    for (let i = 0; i < 5; i++) {
      const r = validateSessionReducer(sstate(), claimInput())
      expect(r.result.ok).toBe(true)
      expect(r.result.reason).toBeUndefined()
    }
  })
})

describe.each([
  ['memoria', () => new MemoryGrantStore()],
  ['redis-fake', () => new RedisGrantStore(new FakeRedis())],
])('A1·F0 · store.validateSession (%s) — no consume', (_n, make) => {
  it('valida repetidamente sin marcar uso (jamás REPLAYED); mismo grant sigue válido', async () => {
    const s = make()
    await s.registerSource('nvr_c_sub', 60_000)
    const inst = await s.currentInstance('nvr_c_sub')
    await s.issueGrant(grant({ mediaInstanceId: inst!, secretHash: 'sh', kind: 'relay_session' }), { viewId: 'v' }, 30_000)
    for (let i = 0; i < 3; i++) {
      const r = await s.validateSession(claimInput({ presentedSecretHash: 'sh' }))
      expect(r.ok).toBe(true)
      expect(r.reason).toBeUndefined()
    }
    // A diferencia de validateAndClaim, no hay claim: validateAndClaim seguiría dando ok una vez más.
    expect((await s.validateSession(claimInput({ presentedSecretHash: 'sh' }))).ok).toBe(true)
  })
  it('rechaza secret/scope/epoch/instancia/expirado', async () => {
    const s = make()
    await s.registerSource('nvr_c_sub', 60_000)
    const inst = await s.currentInstance('nvr_c_sub')
    await s.issueGrant(grant({ mediaInstanceId: inst!, secretHash: 'sh' }), { viewId: 'v' }, 30_000)
    expect((await s.validateSession(claimInput({ presentedSecretHash: 'bad' }))).reason).toBe('SECRET_MISMATCH')
    expect((await s.validateSession(claimInput({ presentedSecretHash: 'sh', scope: { ...claimInput().scope, cameraId: 'other' } }))).reason).toBe('SCOPE_MISMATCH')
    await s.bumpUserEpoch('u')  // el grant se emitió con epoch 0
    expect((await s.validateSession(claimInput({ presentedSecretHash: 'sh' }))).reason).toBe('EPOCH_MISMATCH')
  })
})

describe('A1·F0 · store.validateSession — fail-closed (redis caído)', () => {
  it('backend caído ⇒ BACKEND_UNAVAILABLE (deny)', async () => {
    const redis = new FakeRedis(); const s = new RedisGrantStore(redis)
    redis.down = true
    expect((await s.validateSession(claimInput())).reason).toBe('BACKEND_UNAVAILABLE')
  })
})

describe.each([
  ['memoria', (clock: () => number) => new MemoryGrantStore(clock)],
  ['redis-fake', (_c: () => number) => new RedisGrantStore(new FakeRedis())],
])('A1·F0 · mapa conexión↔grant (%s) — bind/unbind/list/TTL', (_n, make) => {
  it('bind indexa por user y por grant; unbind lo quita de ambos', async () => {
    const s = make(() => Date.now())
    await s.bindConnection('conn-1', 'g1', 'userA', 'nvr_c_sub', 60_000)
    await s.bindConnection('conn-2', 'g1', 'userA', 'nvr_c_sub', 60_000)
    await s.bindConnection('conn-3', 'g2', 'userB', 'nvr_d_sub', 60_000)

    const byUserA = await s.listConnectionsForUser('userA')
    expect(byUserA.map(b => b.connectionId).sort()).toEqual(['conn-1', 'conn-2'])
    const byG1 = await s.listConnectionsForGrant('g1')
    expect(byG1.map(b => b.connectionId).sort()).toEqual(['conn-1', 'conn-2'])
    expect((await s.listConnectionsForUser('userB')).map(b => b.connectionId)).toEqual(['conn-3'])

    await s.unbindConnection('conn-1')
    expect((await s.listConnectionsForUser('userA')).map(b => b.connectionId)).toEqual(['conn-2'])
    expect((await s.listConnectionsForGrant('g1')).map(b => b.connectionId)).toEqual(['conn-2'])
  })
  it('los bindings guardan grantId/userId/streamPath (para el kick)', async () => {
    const s = make(() => Date.now())
    await s.bindConnection('conn-x', 'gX', 'uX', 'nvr_z_main', 60_000)
    const [b] = await s.listConnectionsForGrant('gX')
    expect(b).toEqual({ connectionId: 'conn-x', grantId: 'gX', userId: 'uX', streamPath: 'nvr_z_main' })
  })
})

describe('A1·F0 · binding TTL en memoria (reloj controlado)', () => {
  it('el binding expira tras su TTL', async () => {
    let now = 1000
    const s = new MemoryGrantStore(() => now)
    await s.bindConnection('conn-1', 'g1', 'userA', 'nvr_c_sub', 5_000)
    expect((await s.listConnectionsForUser('userA')).length).toBe(1)
    now += 5_001
    expect((await s.listConnectionsForUser('userA')).length).toBe(0)
    expect((await s.listConnectionsForGrant('g1')).length).toBe(0)
  })
})
