import { describe, expect, it } from 'vitest'
import { MemoryGrantStore, RedisGrantStore } from './grant-store'
import { FakeRedis } from './redis-fake'
import {
  buildGrant, MediaGrantManager, decideGrantIssuance, sha256Hex, timingSafeEqualHex,
  type GrantClock, type GrantRandom, type MintGrantParams,
} from './media-grants'
import type { GrantScopeQuery, GrantAuditRecord } from './contracts'

function fakeClock(start = 1_000_000) {
  let t = start
  return { clock: { now: () => t } as GrantClock, advance: (ms: number) => { t += ms } }
}
function seqRandom(): GrantRandom { let n = 0; return { id: () => `mg_${++n}`, secret: () => `secret_${n}_${'a'.repeat(48)}` } }

function base(over: Partial<MintGrantParams> = {}): MintGrantParams {
  return { userId: 'user-A', viewId: 'view-1', cameraId: 'cam-1', streamPath: 'nvr_cam1_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000, ...over }
}
function scopeFor(p: MintGrantParams): GrantScopeQuery { return { userId: p.userId, cameraId: p.cameraId, streamPath: p.streamPath, transport: p.transport, action: 'read' } }

function mkManager(opts: { redis?: FakeRedis; clock?: GrantClock; audit?: (r: GrantAuditRecord) => void } = {}) {
  const store = opts.redis ? new RedisGrantStore(opts.redis) : new MemoryGrantStore()
  return new MediaGrantManager({ store, clock: opts.clock, random: seqRandom(), audit: opts.audit })
}
async function issueOk(mgr: MediaGrantManager, p: MintGrantParams) {
  await mgr.registerSource(p.streamPath)
  const r = await mgr.issue(p)
  if (!r.ok) throw new Error(`issue failed: ${r.code}`)
  return r.issued
}

describe('helpers', () => {
  it('sha256Hex + timingSafeEqualHex', () => {
    expect(sha256Hex('x')).toHaveLength(64)
    expect(timingSafeEqualHex('ab', 'ab')).toBe(true)
    expect(timingSafeEqualHex('ab', 'ac')).toBe(false)
  })
  it('buildGrant guarda sólo hash; sin URI; server fields', () => {
    const { issued, stored } = buildGrant({ ...base(), mediaInstanceId: 'mi-1', authorizationEpoch: 3 }, fakeClock().clock, seqRandom())
    expect(stored.secretHash).toBe(sha256Hex(issued.secret))
    expect(JSON.stringify(stored).toLowerCase()).not.toContain('rtsp://')
    expect(stored.authorizationEpoch).toBe(3)
    expect(stored.mediaInstanceId).toBe('mi-1')
  })
})

describe.each([['memoria', false], ['redis-fake', true]])('MediaGrantManager (%s)', (_n, useRedis) => {
  const mk = (o: any = {}) => mkManager({ redis: useRedis ? new FakeRedis() : undefined, ...o })

  it('P0-4 · issue se NIEGA sin fuente real (NO_MEDIA_INSTANCE)', async () => {
    const mgr = mk()
    const r = await mgr.issue(base())            // sin registerSource
    expect(r).toEqual({ ok: false, code: 'NO_MEDIA_INSTANCE' })
  })

  it('issue + consume una vez; segundo consumo REPLAYED', async () => {
    const mgr = mk()
    const p = base(); const issued = await issueOk(mgr, p)
    expect((await mgr.consume({ grantId: issued.grantId, secret: issued.secret }, scopeFor(p))).ok).toBe(true)
    expect((await mgr.consume({ grantId: issued.grantId, secret: issued.secret }, scopeFor(p))).reason).toBe('REPLAYED')
  })

  it('P0-1(A) · revoke completo ANTES del claim ⇒ REVOKED', async () => {
    const mgr = mk()
    const p = base(); const issued = await issueOk(mgr, p)
    expect(await mgr.revoke(issued.grantId, 'user-A')).toBe(true)
    expect((await mgr.consume({ grantId: issued.grantId, secret: issued.secret }, scopeFor(p))).reason).toBe('REVOKED')
  })

  it('P0-1(B) · vencimiento observado en el punto de linealización ⇒ EXPIRED', async () => {
    // C23·H2·P1: la expiración del lado Redis se juzga con el RELOJ DE REDIS dentro
    // del script (no con el Date.now() de Node). El fake toma su "reloj de Redis" del
    // clock inyectado, así que para el store Redis avanzamos ESE reloj; para memoria
    // sigue rigiendo el reloj lógico del manager (input.nowMs). En ambos, detener la
    // operación hasta pasado el TTL ⇒ EXPIRED en el punto de linealización.
    const fc = fakeClock()
    const store = useRedis ? new RedisGrantStore(new FakeRedis(fc.clock.now)) : new MemoryGrantStore()
    const mgr = new MediaGrantManager({ store, clock: fc.clock, random: seqRandom() })
    const p = base({ ttlMs: 5_000 })
    await mgr.registerSource(p.streamPath)
    const r = await mgr.issue(p); if (!r.ok) throw new Error('issue')
    fc.advance(5_001)
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scopeFor(p))).reason).toBe('EXPIRED')
  })

  it('P0-2/P0-5 · epoch avanzó (permiso/logout) ⇒ EPOCH_MISMATCH aunque el índice se escribiera tarde', async () => {
    const redis = useRedis ? new FakeRedis() : undefined
    const store = redis ? new RedisGrantStore(redis) : new MemoryGrantStore()
    const mgr = new MediaGrantManager({ store, random: seqRandom() })
    const p = base(); await mgr.registerSource(p.streamPath)
    const r = await mgr.issue(p); if (!r.ok) throw new Error('issue')
    await store.bumpUserEpoch('user-A')            // el epoch cambia tras leerlo en issue
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scopeFor(p))).reason).toBe('EPOCH_MISMATCH')
  })

  it('P0-1 · revokeAllForUser aplica (epoch) y el grant deja de validar', async () => {
    const mgr = mk()
    const p = base(); const issued = await issueOk(mgr, p)
    const out = await mgr.revokeAllForUser('user-A')
    expect(out.status).toBe('applied')
    expect((await mgr.consume({ grantId: issued.grantId, secret: issued.secret }, scopeFor(p))).ok).toBe(false)
  })

  it('P0-4 · recrear la fuente (rotar instancia) ⇒ INSTANCE_MISMATCH', async () => {
    const mgr = mk()
    const p = base(); const issued = await issueOk(mgr, p)
    await mgr.registerSource(p.streamPath)         // fuente recreada ⇒ nueva instancia
    expect((await mgr.consume({ grantId: issued.grantId, secret: issued.secret }, scopeFor(p))).reason).toBe('INSTANCE_MISMATCH')
  })

  it('cross-user: otro usuario no revoca; secreto alterado ⇒ SECRET_MISMATCH', async () => {
    const mgr = mk()
    const p = base(); const issued = await issueOk(mgr, p)
    expect(await mgr.revoke(issued.grantId, 'user-B')).toBe(false)
    expect((await mgr.consume({ grantId: issued.grantId, secret: 'bad' }, scopeFor(p))).reason).toBe('SECRET_MISMATCH')
  })

  it('auditoría sin secreto', async () => {
    const ev: GrantAuditRecord[] = []
    const mgr = mk({ audit: (r: GrantAuditRecord) => ev.push(r) })
    const p = base(); const issued = await issueOk(mgr, p)
    await mgr.consume({ grantId: issued.grantId, secret: issued.secret }, scopeFor(p))
    await mgr.revoke(issued.grantId, 'user-A')
    const kinds = ev.map(e => e.event)
    expect(kinds).toContain('grant_issued'); expect(kinds).toContain('grant_used'); expect(kinds).toContain('grant_revoked')
    expect(JSON.stringify(ev)).not.toContain(issued.secret)
  })
})

describe('cross-process (dos managers sobre el mismo Redis)', () => {
  it('T3 · dos procesos consumen el mismo grant ⇒ uno gana', async () => {
    const redis = new FakeRedis()
    const m1 = mkManager({ redis }); const m2 = mkManager({ redis })
    const p = base(); const issued = await issueOk(m1, p)
    const [a, b] = await Promise.all([
      m1.consume({ grantId: issued.grantId, secret: issued.secret }, scopeFor(p)),
      m2.consume({ grantId: issued.grantId, secret: issued.secret }, scopeFor(p)),
    ])
    expect([a, b].filter(r => r.ok).length).toBe(1)
  })
})

describe('decideGrantIssuance (readiness unificada)', () => {
  const ok = { playbackEnabled: true, relayReady: true, transport: 'rtsps' as const, hasCameraAccess: true }
  it('playback off ⇒ 404', () => { expect(decideGrantIssuance({ ...ok, playbackEnabled: false }).httpStatus).toBe(404) })
  it('relay no listo ⇒ 503', () => { expect(decideGrantIssuance({ ...ok, relayReady: false })).toMatchObject({ httpStatus: 503, code: 'NATIVE_RELAY_NOT_READY' }) })
  it('sin acceso ⇒ 403', () => { expect(decideGrantIssuance({ ...ok, hasCameraAccess: false }).httpStatus).toBe(403) })
  it('todo listo ⇒ 200', () => { expect(decideGrantIssuance(ok)).toMatchObject({ allow: true, httpStatus: 200 }) })
})
