// apps/api/src/services/media/revoke-outbox.int.test.ts
//
// C23·H2·P2 — INTEGRACIÓN: outbox durable de revocación + Redis REAL.
//
// Escenario clave (durabilidad ante reinicio durante caída de Redis):
//   Redis "caído" → logout (fila DURABLE en el outbox) → REINICIO COMPLETO del
//   proceso (se recrean los singletons del servicio desde cero, SIN ningún Set en
//   memoria) → Redis vuelve → drenaje → epoch incrementado → un grant anterior es
//   RECHAZADO (EPOCH_MISMATCH).
//
// También: fail-closed del relay mientras hay deuda pendiente, y drenaje
// CONCURRENTE sobre la MISMA cola in-memory (dos drenajes en el mismo proceso ⇒
// una sola aplicación por fila). OJO: esto NO es "multi-worker/cross-process" —
// son dos drenajes en un único event loop sobre un único objeto InMemory. La
// atomicidad multi-worker REAL (FOR UPDATE SKIP LOCKED entre transacciones/procesos
// distintos) se valida contra Postgres efímero real en `revoke-outbox.pg.int.test.ts`.
//
// La durabilidad ante reinicio se prueba con la impl EN MEMORIA de la interfaz
// durable, re-inyectada tras el "reinicio" (representa la persistencia de Postgres).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startEphemeralRedis, assertRedisRequiredOrSkip, type EphemeralRedis } from './redis-real-harness'
import { ik, type RedisGrantClient } from './grant-store'
import { InMemoryMediaRevokeOutbox } from './revoke-outbox'
import {
  getMediaGrantManager, revokeUserMediaGrants, retryPendingUserRevokes,
  setMediaRevokeOutboxForTest, __resetMediaGrantManagerForTest, __pendingUserRevokeCount,
} from './grant-service'

const HAVE_REDIS = assertRedisRequiredOrSkip()

/** Proxy sobre ioredis que puede simular una caída (toda op lanza) SIN perder los
 *  datos ya escritos en el Redis real subyacente (como un outage de red). */
class FailableRedis implements RedisGrantClient {
  down = false
  constructor(private readonly inner: RedisGrantClient) {}
  private g<T>(fn: () => Promise<T>): Promise<T> { if (this.down) return Promise.reject(new Error('redis down')); return fn() }
  get(k: string) { return this.g(() => this.inner.get(k)) }
  set(k: string, v: string, m: 'PX', ttl: number, nx?: 'NX') { return this.g(() => nx ? this.inner.set(k, v, m, ttl, nx) : this.inner.set(k, v, m, ttl)) }
  del(k: string) { return this.g(() => this.inner.del(k)) }
  sadd(k: string, m: string) { return this.g(() => this.inner.sadd(k, m)) }
  srem(k: string, m: string) { return this.g(() => this.inner.srem(k, m)) }
  smembers(k: string) { return this.g(() => this.inner.smembers(k)) }
  pexpire(k: string, ttl: number) { return this.g(() => this.inner.pexpire(k, ttl)) }
  incr(k: string) { return this.g(() => this.inner.incr(k)) }
  ping() { return this.g(() => this.inner.ping()) }
  eval(script: string, numKeys: number, ...args: (string | number)[]) { return this.g(() => this.inner.eval(script, numKeys, ...args)) }
}

const log = { info: () => {}, warn: () => {} }
const scope = { userId: 'victim', cameraId: 'cam-1', streamPath: 'nvr_c_sub', transport: 'rtsps' as const, action: 'read' as const }

describe.skipIf(!HAVE_REDIS)('revoke-outbox · durable + Redis REAL', () => {
  let env: EphemeralRedis
  beforeAll(async () => { env = await startEphemeralRedis() })
  afterAll(async () => { await env?.stop() })
  beforeEach(() => __resetMediaGrantManagerForTest())

  it('durabilidad ante reinicio durante caída de Redis ⇒ drenaje ⇒ EPOCH_MISMATCH', async () => {
    // Outbox DURABLE compartido (representa Postgres: sobrevive al "reinicio").
    const durable = new InMemoryMediaRevokeOutbox()
    setMediaRevokeOutboxForTest(durable)

    // Fase A · Redis sano: fuente + grant vivo del usuario.
    const proxyUp = new FailableRedis(env.client)
    const serverA: any = { log, redis: proxyUp }
    const mgrA = getMediaGrantManager(serverA)
    await mgrA.registerSource('nvr_c_sub')
    const r = await mgrA.issue({ userId: 'victim', viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    if (!r.ok) throw new Error('issue: ' + r.code)

    // Fase B · Redis CAÍDO durante el logout: la intención queda DURABLE (pending).
    proxyUp.down = true
    expect(await revokeUserMediaGrants(serverA, 'victim')).toBe('pending')
    expect(__pendingUserRevokeCount()).toBe(1)

    // REINICIO COMPLETO del proceso: se destruyen los singletons (NO hay Set en
    // memoria); sólo el outbox DURABLE persiste, así que lo re-inyectamos.
    __resetMediaGrantManagerForTest()
    setMediaRevokeOutboxForTest(durable)

    // Redis vuelve (proxy nuevo, sano, sobre el MISMO Redis real: el grant sigue ahí).
    const proxyDown2 = new FailableRedis(env.client)
    const serverB: any = { log, redis: proxyDown2 }

    // La deuda pendiente sobrevivió al reinicio.
    expect(__pendingUserRevokeCount()).toBe(1)

    // Aislamos la garantía por EPOCH (T9/P0-2): simulamos que el índice por-usuario
    // se perdió (escritura tardía / outage), borrándolo, de modo que el marcado
    // cosmético revokedAt NO alcance al grant. Sólo el bump de epoch puede
    // invalidarlo ⇒ el rechazo será EPOCH_MISMATCH, no REVOKED.
    await env.raw.del(ik('user', 'victim'))

    // Drenaje ⇒ epoch incrementado en Redis real.
    const drained = await retryPendingUserRevokes(serverB)
    expect(drained).toBe(1)
    expect(__pendingUserRevokeCount()).toBe(0)

    // El grant anterior (epoch 0) ya no valida: EPOCH_MISMATCH por el epoch bumpeado.
    const mgrB = getMediaGrantManager(serverB)
    const res = await mgrB.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('EPOCH_MISMATCH')
  })

  it('fail-closed del relay mientras hay deuda pendiente (REVOKE_PENDING), aun con Redis caído', async () => {
    const durable = new InMemoryMediaRevokeOutbox()
    setMediaRevokeOutboxForTest(durable)
    const proxy = new FailableRedis(env.client)
    const server: any = { log, redis: proxy }
    const mgr = getMediaGrantManager(server)
    await mgr.registerSource('nvr_c_sub')

    proxy.down = true
    expect(await revokeUserMediaGrants(server, 'victim')).toBe('pending')

    // issueSession y validateSession fallan CERRADO por la deuda (antes del store).
    const iss = await mgr.issueSession({ userId: 'victim', viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    expect(iss.ok).toBe(false)
    if (!iss.ok) expect(iss.code).toBe('REVOKE_PENDING')
    const vs = await mgr.validateSession({ grantId: 'whatever', secret: 'x' }, scope)
    expect(vs.reason).toBe('REVOKE_PENDING')

    // Un usuario SIN deuda no queda bloqueado por esta vía (aunque Redis caído dé otro deny).
    const other = await mgr.validateSession({ grantId: 'g', secret: 's' }, { ...scope, userId: 'inocente' })
    expect(other.reason).not.toBe('REVOKE_PENDING')
  })

  it('el CAMINO ACTIVO (issue/consume) también falla CERRADO con deuda; tras drenar ⇒ EPOCH_MISMATCH', async () => {
    // Las rutas reales usan manager.issue()/consume(), NO issueSession/validateSession.
    const durable = new InMemoryMediaRevokeOutbox()
    setMediaRevokeOutboxForTest(durable)

    // Fase A · Redis sano: fuente + grant vivo de la víctima.
    const proxy = new FailableRedis(env.client)
    const server: any = { log, redis: proxy }
    const mgr = getMediaGrantManager(server)
    await mgr.registerSource('nvr_c_sub')
    const r = await mgr.issue({ userId: 'victim', viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    if (!r.ok) throw new Error('issue inicial: ' + r.code)

    // Fase B · Redis CAÍDO en el logout: la deuda queda durable (no se bumpeó epoch).
    proxy.down = true
    expect(await revokeUserMediaGrants(server, 'victim')).toBe('pending')

    // Fase C · Redis VUELVE pero el drenaje AÚN NO corrió: issue() y consume() del
    // camino activo deben rechazar REVOKE_PENDING (antes de tocar el store).
    proxy.down = false
    const issAgain = await mgr.issue({ userId: 'victim', viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    expect(issAgain.ok).toBe(false)
    if (!issAgain.ok) expect(issAgain.code).toBe('REVOKE_PENDING')
    const cons = await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)
    expect(cons.ok).toBe(false)
    expect(cons.reason).toBe('REVOKE_PENDING')

    // Un usuario SIN deuda no queda bloqueado por issue().
    const innocent = await mgr.issue({ userId: 'inocente', viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    expect(innocent.ok).toBe(true)

    // Fase D · Drenaje ⇒ epoch bumpeado; se limpia la deuda.
    await env.raw.del(ik('user', 'victim')) // aislar la garantía por EPOCH (no por revokedAt)
    expect(await retryPendingUserRevokes(server)).toBe(1)
    expect(__pendingUserRevokeCount()).toBe(0)

    // El grant anterior (epoch 0) ya no consume: EPOCH_MISMATCH (no REVOKE_PENDING).
    const after = await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)
    expect(after.ok).toBe(false)
    expect(after.reason).toBe('EPOCH_MISMATCH')

    // Sin deuda pendiente, un nuevo issue de la víctima procede (la AUTORIZACIÓN/RBAC
    // vigente se aplica en la ruta, no en el manager).
    const fresh = await mgr.issue({ userId: 'victim', viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    expect(fresh.ok).toBe(true)
  })

  it('drenaje CONCURRENTE in-memory (mismo proceso): una sola aplicación por fila', async () => {
    // NB: NO es multi-worker/cross-process — son dos drenajes en el mismo event
    // loop sobre un único InMemoryMediaRevokeOutbox. La toma síncrona (claiming)
    // evita el doble proceso EN PROCESO; el equivalente entre procesos (SKIP
    // LOCKED) se valida en revoke-outbox.pg.int.test.ts contra Postgres real.
    const durable = new InMemoryMediaRevokeOutbox()
    await durable.enqueue('u1')
    await durable.enqueue('u2')
    let applies = 0
    const apply = async (): Promise<boolean> => { applies++; return true }
    // Dos drenajes a la vez sobre la MISMA cola in-memory.
    const [a, b] = await Promise.all([durable.drain(apply), durable.drain(apply)])
    expect(a + b).toBe(2)          // exactamente 2 filas aplicadas en total
    expect(applies).toBe(2)        // cada fila aplicada UNA vez (sin doble proceso)
    expect(await durable.pendingUserIds()).toEqual([])
  })

  it('apply fallido deja la fila pendiente (idempotente en el reintento)', async () => {
    const durable = new InMemoryMediaRevokeOutbox()
    await durable.enqueue('u1')
    expect(await durable.drain(async () => false)).toBe(0)     // Redis caído ⇒ no aplica
    expect(await durable.hasPending('u1')).toBe(true)
    expect(await durable.drain(async () => true)).toBe(1)      // reintento ⇒ aplica
    expect(await durable.hasPending('u1')).toBe(false)
  })
})
