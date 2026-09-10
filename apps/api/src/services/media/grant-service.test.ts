import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { FakeRedis } from './redis-fake'
import {
  getMediaGrantManager, revokeUserMediaGrants, retryPendingUserRevokes,
  startRevokeRecovery, __pendingUserRevokeCount, __resetMediaGrantManagerForTest,
  setMediaKicker, kickConnectionsForGrants,
  revokeUserMediaGrantsAtomic, setMediaRevokeOutboxForTest, assertRevokeOutboxAvailable,
} from './grant-service'
import { InMemoryMediaRevokeOutbox, type MediaRevokeOutboxRepo } from './revoke-outbox'
import type { MediaMtxKicker } from './relay-kick'

function fakeServer(redis: FakeRedis) {
  return { log: { info: () => {}, warn: () => {} }, redis } as any
}
/** FakeRedis + emisor de eventos (como ioredis) para probar `redis.on('ready')`. */
function eventfulRedis(): { redis: FakeRedis; emit: (e: string) => void } {
  const redis = new FakeRedis()
  const ee = new EventEmitter()
  ;(redis as any).on = ee.on.bind(ee)
  ;(redis as any).off = ee.off.bind(ee)
  return { redis, emit: (e: string) => ee.emit(e) }
}
async function issueForUser(server: any, userId: string) {
  const mgr = getMediaGrantManager(server)
  await mgr.registerSource('nvr_c_sub')
  const r = await mgr.issue({ userId, viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
  if (!r.ok) throw new Error('issue')
  return r
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
    // El plano falla cerrado en el CAMINO ACTIVO: consume() ahora rechaza por la
    // DEUDA de revocación pendiente ANTES de tocar el backend (fail-closed más
    // preciso que el viejo BACKEND_UNAVAILABLE). El grant sigue sin ser aceptable.
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).reason).toBe('REVOKE_PENDING')

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

describe('assertRevokeOutboxAvailable · fail-closed de arranque', () => {
  it('RECHAZA un outbox en memoria sin inyección explícita (delegate ausente + runtime test)', () => {
    const server = { log: { info() {}, warn() {} }, redis: new FakeRedis() } as any // sin prisma.mediaRevokeOutbox
    expect(() => assertRevokeOutboxAvailable(server)).toThrow(/EN MEMORIA/)
  })

  it('ACEPTA InMemory cuando fue inyectado explícitamente por un test', () => {
    const server = { log: { info() {}, warn() {} }, redis: new FakeRedis() } as any
    setMediaRevokeOutboxForTest(new InMemoryMediaRevokeOutbox())
    expect(() => assertRevokeOutboxAvailable(server)).not.toThrow()
  })
})

describe('revokeUserMediaGrantsAtomic · robustez post-commit', () => {
  it('si el drenaje LANZA tras el commit, devuelve pending (no propaga ⇒ la ruta no responde 503)', async () => {
    const redis = new FakeRedis()
    // $transaction real-ish: ejecuta el callback (commit implícito al resolver).
    const prisma = { $transaction: async (fn: any) => fn({ mediaRevokeOutbox: { create: async () => ({}) } }) }
    const server = { log: { info() {}, warn() {} }, redis, prisma } as any
    // Outbox cuya intención se persiste OK (enqueueInTx) pero cuyo DRENAJE post-commit
    // lanza (simula un blip de backend justo después del commit atómico).
    const outbox: MediaRevokeOutboxRepo = {
      async enqueue() {}, async enqueueInTx() {}, async hasPending() { return false },
      async pendingUserIds() { return [] }, async pruneApplied() { return 0 },
      async drain() { throw new Error('blip post-commit') },
    }
    setMediaRevokeOutboxForTest(outbox)
    // No debe rechazar: la intención ya es durable ⇒ 'pending' (se drena en el barrido).
    await expect(revokeUserMediaGrantsAtomic(server, 'userX', async () => {})).resolves.toBe('pending')
  })
})

describe('B1 · startRevokeRecovery (recuperación cableada; drenaje post-reconexión)', () => {
  it('drena el outbox al emitir redis "ready" (reconexión) ⇒ el grant viejo ya no valida', async () => {
    const { redis, emit } = eventfulRedis()
    const server = fakeServer(redis)
    const r = await issueForUser(server, 'userX')

    // Outage durante el logout: la revocación queda pendiente (epoch NO incrementado).
    redis.down = true
    expect(await revokeUserMediaGrants(server, 'userX')).toBe('pending')
    expect(__pendingUserRevokeCount()).toBe(1)

    // Barrido "infinito": aislamos el disparador de reconexión.
    const rec = startRevokeRecovery(server, 1_000_000)
    redis.down = false
    emit('ready')                                   // ioredis reconecta
    await new Promise((res) => setTimeout(res, 20))  // drena en microtask

    expect(__pendingUserRevokeCount()).toBe(0)
    const mgr = getMediaGrantManager(server)
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).ok).toBe(false)
    rec.stop()
  })

  it('el barrido periódico drena aunque no llegue el evento "ready"', async () => {
    const redis = new FakeRedis()  // sin .on: sólo el barrido puede drenar
    const server = fakeServer(redis)
    await issueForUser(server, 'userX')
    redis.down = true
    expect(await revokeUserMediaGrants(server, 'userX')).toBe('pending')

    const rec = startRevokeRecovery(server, 1)  // se clampa a 1000ms (mínimo seguro)
    redis.down = false
    await new Promise((res) => setTimeout(res, 1200))

    expect(__pendingUserRevokeCount()).toBe(0)
    rec.stop()
  })

  it('sin pendientes es inerte: no drena nada (flags OFF / sin outage)', async () => {
    const { redis, emit } = eventfulRedis()
    const server = fakeServer(redis)
    const rec = startRevokeRecovery(server, 1_000_000)
    emit('ready')
    await new Promise((res) => setTimeout(res, 10))
    expect(__pendingUserRevokeCount()).toBe(0)
    rec.stop()
  })
})

describe('A1·F0 · revoke→kick (SOLO con la flag ON; OFF ⇒ no-op idéntico a hoy)', () => {
  function fakeKicker(): { kicker: MediaMtxKicker; kicked: string[] } {
    const kicked: string[] = []
    return { kicked, kicker: { async kick(id) { kicked.push(id) } } }
  }
  const prev = process.env.NATIVE_MEDIA_RELAY_ENABLED
  afterEach(() => { if (prev === undefined) delete process.env.NATIVE_MEDIA_RELAY_ENABLED; else process.env.NATIVE_MEDIA_RELAY_ENABLED = prev })

  it('flag ON: revocar por usuario expulsa SUS conexiones vivas', async () => {
    process.env.NATIVE_MEDIA_RELAY_ENABLED = 'true'
    const server = fakeServer(new FakeRedis())
    const mgr = getMediaGrantManager(server)
    const { kicker, kicked } = fakeKicker(); setMediaKicker(kicker)
    await mgr.bindConnection('conn-A1', 'g1', 'userX', 'nvr_c_sub', 60_000)
    await mgr.bindConnection('conn-A2', 'g2', 'userX', 'nvr_c_sub', 60_000)
    await mgr.bindConnection('conn-B', 'g3', 'userY', 'nvr_c_sub', 60_000)

    expect(await revokeUserMediaGrants(server, 'userX')).toBe('applied')
    expect(kicked.sort()).toEqual(['conn-A1', 'conn-A2'])  // userY intacto
  })

  it('flag OFF: revocar por usuario NO expulsa nada (no-op)', async () => {
    process.env.NATIVE_MEDIA_RELAY_ENABLED = 'false'
    const server = fakeServer(new FakeRedis())
    const mgr = getMediaGrantManager(server)
    const { kicker, kicked } = fakeKicker(); setMediaKicker(kicker)
    await mgr.bindConnection('conn-A1', 'g1', 'userX', 'nvr_c_sub', 60_000)

    expect(await revokeUserMediaGrants(server, 'userX')).toBe('applied')
    expect(kicked).toEqual([])
  })

  it('flag ON: kickConnectionsForGrants expulsa las conexiones de esos grants (vista/sesión)', async () => {
    process.env.NATIVE_MEDIA_RELAY_ENABLED = 'true'
    const server = fakeServer(new FakeRedis())
    const mgr = getMediaGrantManager(server)
    const { kicker, kicked } = fakeKicker(); setMediaKicker(kicker)
    await mgr.bindConnection('c1', 'gV1', 'u', 'p', 60_000)
    await mgr.bindConnection('c2', 'gV2', 'u', 'p', 60_000)
    await mgr.bindConnection('c3', 'gOTHER', 'u', 'p', 60_000)

    const n = await kickConnectionsForGrants(server, ['gV1', 'gV2'])
    expect(n).toBe(2)
    expect(kicked.sort()).toEqual(['c1', 'c2'])
  })

  it('flag OFF: kickConnectionsForGrants es no-op', async () => {
    process.env.NATIVE_MEDIA_RELAY_ENABLED = 'false'
    const server = fakeServer(new FakeRedis())
    const mgr = getMediaGrantManager(server)
    const { kicker, kicked } = fakeKicker(); setMediaKicker(kicker)
    await mgr.bindConnection('c1', 'gV1', 'u', 'p', 60_000)
    expect(await kickConnectionsForGrants(server, ['gV1'])).toBe(0)
    expect(kicked).toEqual([])
  })
})
