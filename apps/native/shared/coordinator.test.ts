import { describe, expect, it } from 'vitest'
import { LivePlaybackCoordinator } from './coordinator'
import { LivePlaybackSession } from './session-controller'
import { MockAdapter, createDeferred } from './mock-adapter'
import type { GrantRequest, GrantOutcome, GrantTransport } from './grant-client'
import type { EphemeralMediaGrant } from './playback'

function grant(id: string, over: Partial<EphemeralMediaGrant> = {}): EphemeralMediaGrant {
  return { grantId: id, secret: `s-${id}`, transport: 'rtsps', streamPath: `nvr_${id}`, codec: 'hevc', expiresAt: 9e15, ...over }
}
const req = (cameraId: string): GrantRequest => ({ viewId: 'v1', cameraId, transport: 'rtsps', codec: 'hevc', device: 'win' })

// Transporte con requestGrant compuertable por cámara (para carreras controladas).
// Tolera resolve() ANTES o DESPUÉS de requestGrant (preset).
function gatedTransport() {
  const revoked: string[] = []
  const gates = new Map<string, { promise: Promise<GrantOutcome>; resolve: (o: GrantOutcome) => void }>()
  const preset = new Map<string, GrantOutcome>()
  let failNextRevoke = false
  const t: GrantTransport & { revoked: string[]; resolve: (c: string, o: GrantOutcome) => void; failNextRevoke: () => void } = {
    revoked,
    requestGrant(r: GrantRequest) {
      if (preset.has(r.cameraId)) { const o = preset.get(r.cameraId)!; preset.delete(r.cameraId); return Promise.resolve(o) }
      const d = createDeferred<GrantOutcome>(); gates.set(r.cameraId, d); return d.promise
    },
    async revokeGrant(id: string) { if (failNextRevoke) { failNextRevoke = false; throw new Error('revoke failed') } revoked.push(id) },
    resolve(cameraId, o) { const d = gates.get(cameraId); if (d) { gates.delete(cameraId); d.resolve(o) } else preset.set(cameraId, o) },
    failNextRevoke() { failNextRevoke = true },
  }
  return t
}

describe('LivePlaybackCoordinator', () => {
  it('P0-4 · A tardía después de B ⇒ A se revoca y B permanece', async () => {
    const t = gatedTransport()
    const adapter = new MockAdapter()
    const coord = new LivePlaybackCoordinator(t, new LivePlaybackSession(adapter))

    const pA = coord.open(req('cam-A'), {})   // rid 1, esperando grant A
    const pB = coord.open(req('cam-B'), {})   // rid 2, esperando grant B

    t.resolve('cam-B', { ok: true, grant: grant('gB') })  // B responde primero
    expect(await pB).toEqual({ published: true })

    t.resolve('cam-A', { ok: true, grant: grant('gA') })  // A responde tarde
    expect((await pA).reason).toBe('SUPERSEDED')

    expect(t.revoked).toContain('gA')     // el grant tardío A se revocó
    expect(coord.activeGrantId()).toBe('gB')
    // A NUNCA llegó al decoder: sólo se abrió B (si A abriera, dispondría a B).
    expect(adapter.calls.filter(c => c === 'open').length).toBe(1)
    expect(adapter.calls.filter(c => c === 'dispose').length).toBe(0)
  })

  it('P0-4 · open(A) → open(B) secuencial libera el handle A (dispose)', async () => {
    const t = gatedTransport()
    const adapter = new MockAdapter()
    const coord = new LivePlaybackCoordinator(t, new LivePlaybackSession(adapter))

    const pA = coord.open(req('cam-A'), {}); t.resolve('cam-A', { ok: true, grant: grant('gA') })
    expect(await pA).toEqual({ published: true })
    const pB = coord.open(req('cam-B'), {}); t.resolve('cam-B', { ok: true, grant: grant('gB') })
    expect(await pB).toEqual({ published: true })

    expect(adapter.calls.filter(c => c === 'dispose').length).toBeGreaterThanOrEqual(1) // A dispuesto
    expect(t.revoked).toContain('gA') // grant A revocado al cambiar
  })

  it('P0-4 · no abre el decoder con un grant vencido', async () => {
    const t = gatedTransport()
    const adapter = new MockAdapter()
    const coord = new LivePlaybackCoordinator(t, new LivePlaybackSession(adapter), () => 1_000_000)
    const p = coord.open(req('cam-A'), {})
    t.resolve('cam-A', { ok: true, grant: grant('gA', { expiresAt: 500_000 }) })  // ya vencido
    expect((await p).reason).toBe('GRANT_EXPIRED')
    expect(adapter.calls).not.toContain('open')
    expect(t.revoked).toContain('gA')
  })

  it('P0-4 · revocación fallida queda pendiente y se reintenta', async () => {
    const t = gatedTransport()
    const adapter = new MockAdapter()
    const coord = new LivePlaybackCoordinator(t, new LivePlaybackSession(adapter))
    const p = coord.open(req('cam-A'), {}); t.resolve('cam-A', { ok: true, grant: grant('gA') })
    await p
    t.failNextRevoke()          // el próximo revoke falla
    await coord.invalidate()    // intenta revocar gA → falla → pending
    expect(coord.pendingRevokes()).toBe(1)
    expect(await coord.retryPendingRevokes()).toBe(1)
    expect(coord.pendingRevokes()).toBe(0)
    expect(t.revoked).toContain('gA')
  })

  it('dispose es idempotente', async () => {
    const t = gatedTransport()
    const coord = new LivePlaybackCoordinator(t, new LivePlaybackSession(new MockAdapter()))
    const p = coord.open(req('cam-A'), {}); t.resolve('cam-A', { ok: true, grant: grant('gA') }); await p
    await coord.dispose()
    await coord.dispose() // no lanza
    expect(coord.activeGrantId()).toBeNull()
  })
})
