import { describe, it, expect, beforeEach } from 'vitest'
import { FakeRedis } from './redis-fake'
import {
  getMediaGrantManager, revokeUserMediaGrants, retryPendingUserRevokes,
  __pendingUserRevokeCount, __resetMediaGrantManagerForTest,
} from './grant-service'

function fakeServer(redis: FakeRedis) {
  return { log: { info: () => {}, warn: () => {} }, redis } as any
}
const scope = { userId: 'userX', cameraId: 'cam-1', streamPath: 'nvr_c_sub', transport: 'rtsps' as const, action: 'read' as const }

beforeEach(() => __resetMediaGrantManagerForTest())

describe('revokeUserMediaGrants (P0-3 · no se traga; fail-closed; retry)', () => {
  it('backend caído ⇒ pending, el grant no es aceptable; recuperación drena el pending', async () => {
    const redis = new FakeRedis()
    const server = fakeServer(redis)
    const mgr = getMediaGrantManager(server)
    await mgr.registerSource('nvr_c_sub')
    const r = await mgr.issue({ userId: 'userX', viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    if (!r.ok) throw new Error('issue')

    // Redis cae durante el logout/permiso:
    redis.down = true
    const status = await revokeUserMediaGrants(server, 'userX')
    expect(status).toBe('pending')                 // NO declara revocación completa
    expect(__pendingUserRevokeCount()).toBe(1)
    // El plano falla cerrado: el grant no valida mientras el backend está caído.
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).reason).toBe('BACKEND_UNAVAILABLE')

    // Redis se recupera y se drena el pending (epoch se incrementa).
    redis.down = false
    expect(await retryPendingUserRevokes(server)).toBe(1)
    expect(__pendingUserRevokeCount()).toBe(0)
    // Tras la revocación aplicada, el grant viejo ya no valida.
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).ok).toBe(false)
  })

  it('backend sano ⇒ applied de una', async () => {
    const redis = new FakeRedis()
    const server = fakeServer(redis)
    expect(await revokeUserMediaGrants(server, 'userY')).toBe('applied')
    expect(__pendingUserRevokeCount()).toBe(0)
  })
})
