import { describe, expect, it } from 'vitest'
import { MediaGrantClient, type GrantTransport, type GrantOutcome, type GrantRequest } from './grant-client'
import type { EphemeralMediaGrant } from './playback'

function grant(id: string): EphemeralMediaGrant {
  return { grantId: id, secret: `sec-${id}`, transport: 'rtsps', streamPath: `nvr_${id}_sub`, codec: 'hevc', expiresAt: 9e15 }
}

class FakeTransport implements GrantTransport {
  readonly requested: GrantRequest[] = []
  readonly revoked: string[] = []
  nextOutcome: (req: GrantRequest) => GrantOutcome = (req) => ({ ok: true, grant: grant(req.cameraId) })
  async requestGrant(req: GrantRequest): Promise<GrantOutcome> { this.requested.push(req); return this.nextOutcome(req) }
  async revokeGrant(grantId: string): Promise<void> { this.revoked.push(grantId) }
}

const req = (cameraId: string): GrantRequest => ({ viewId: 'v1', cameraId, transport: 'rtsps', codec: 'hevc', device: 'windows' })

describe('MediaGrantClient', () => {
  it('adquiere y marca activo', async () => {
    const t = new FakeTransport()
    const c = new MediaGrantClient(t)
    const r = await c.acquire(req('cam-1'))
    expect(r.ok).toBe(true)
    expect(c.hasActive()).toBe(true)
    expect(c.activeGrantId()).toBe('cam-1')
  })

  it('release revoca y olvida (idempotente)', async () => {
    const t = new FakeTransport()
    const c = new MediaGrantClient(t)
    await c.acquire(req('cam-1'))
    await c.release()
    expect(t.revoked).toEqual(['cam-1'])
    expect(c.hasActive()).toBe(false)
    await c.release() // no vuelve a revocar
    expect(t.revoked).toEqual(['cam-1'])
  })

  it('cambiar de cámara revoca el grant anterior ANTES de adquirir el nuevo', async () => {
    const t = new FakeTransport()
    const c = new MediaGrantClient(t)
    await c.acquire(req('cam-1'))
    await c.acquire(req('cam-2'))
    expect(t.revoked).toEqual(['cam-1'])       // el viejo se revocó
    expect(c.activeGrantId()).toBe('cam-2')
    expect(t.requested.map(r => r.cameraId)).toEqual(['cam-1', 'cam-2'])
  })

  it('P0-4 · revoke fallido queda pendiente y retryPending lo completa', async () => {
    const t = new FakeTransport()
    let fail = true
    t.revokeGrant = async (id: string) => { if (fail) { fail = false; throw new Error('revoke failed') } t.revoked.push(id) }
    const c = new MediaGrantClient(t)
    await c.acquire(req('cam-1'))
    await c.release()                       // falla ⇒ pendiente, no se olvida
    expect(c.pendingRevokes()).toBe(1)
    expect(await c.retryPending()).toBe(1)  // reintento exitoso
    expect(c.pendingRevokes()).toBe(0)
    expect(t.revoked).toContain('cam-1')
  })

  it('error de emisión ⇒ sin grant activo', async () => {
    const t = new FakeTransport()
    t.nextOutcome = () => ({ ok: false, status: 409, code: 'SECURE_RELAY_NOT_IMPLEMENTED' })
    const c = new MediaGrantClient(t)
    const r = await c.acquire(req('cam-1'))
    expect(r.ok).toBe(false)
    expect(c.hasActive()).toBe(false)
  })
})
