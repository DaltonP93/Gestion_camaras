// Integración (fastify.inject) del cambio de permisos ⇄ revocación de grants:
//
//   - ÉXITO: el cambio de permisos y la INTENCIÓN de revocar se confirman ATÓMICOS;
//     el grant vivo del usuario deja de validar (epoch bumpeado). (C22.2, P0-1/P0-2)
//   - FALLO del outbox (C23·H2·P1): si el INSERT de la intención de revocar falla,
//     la transacción hace ROLLBACK: la mutación de permisos NO se confirma, la ruta
//     responde no-2xx y NUNCA declara "Permisos actualizados"; el grant previo sigue
//     igual (nada cambió). Cubre POST y PUT /permissions.
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { userRoutes } from './users'
import {
  getMediaGrantManager, setMediaRevokeOutboxForTest, __resetMediaGrantManagerForTest,
} from '../services/media/grant-service'
import type { MediaRevokeOutboxRepo, MediaRevokeOutboxTxClient } from '../services/media/revoke-outbox'
import { FakeRedis } from '../services/media/redis-fake'

// ── Doble de prisma con TRANSACCIÓN interactiva y staging/rollback ──────────────
// `$transaction(fn)` corre `fn(tx)`; las escrituras del `tx` van a un buffer LOCAL
// que sólo se vuelca al store COMMITEADO si `fn` resuelve. Si `fn` lanza (p.ej. el
// INSERT del outbox falla) el buffer se descarta ⇒ ROLLBACK real y observable.
interface Store { perms: number; permsDeleted: number; outbox: string[] }
function makeFake() {
  const store: Store = { perms: 0, permsDeleted: 0, outbox: [] }
  let failOutbox = false
  const makeTx = () => {
    const local = { perms: store.perms, permsDeleted: 0, outbox: [] as string[] }
    const tx: any = {
      session: { deleteMany: async () => ({ count: 1 }) },
      userPermission: {
        deleteMany: async () => { local.permsDeleted++; local.perms = 0; return { count: 0 } },
        createMany: async ({ data }: any) => { local.perms += data.length; return { count: data.length } },
        upsert: async () => { local.perms++; return {} },
      },
      userFeaturePermissions: { upsert: async () => ({}) },
      mediaRevokeOutbox: { create: async ({ data }: any) => { if (failOutbox) throw new Error('outbox insert falló (simulado)'); local.outbox.push(data.userId); return {} } },
    }
    return { tx, local }
  }
  const prisma: any = {
    user: { findUnique: async () => ({ id: 'victim' }) },
    camera: { findMany: async () => [] },
    auditLog: { create: async () => ({}) },
    $transaction: async (fn: any) => {
      const { tx, local } = makeTx()
      const out = await fn(tx)                 // lanza ⇒ no se aplica NADA (rollback)
      store.perms = local.perms
      store.permsDeleted += local.permsDeleted
      store.outbox.push(...local.outbox)
      return out
    },
  }
  return { prisma, store, setFail: (v: boolean) => { failOutbox = v } }
}

// Outbox inyectado: la intención se persiste DENTRO de la tx del caller (create),
// y `hasPending`/`drain` operan sobre lo COMMITEADO en el store del doble.
class TxOutbox implements MediaRevokeOutboxRepo {
  constructor(private store: Store) {}
  async enqueue(userId: string): Promise<void> { this.store.outbox.push(userId) }
  async enqueueInTx(tx: MediaRevokeOutboxTxClient, userId: string): Promise<void> { await tx.mediaRevokeOutbox.create({ data: { userId } }) }
  async hasPending(userId: string): Promise<boolean> { return this.store.outbox.includes(userId) }
  async pendingUserIds(): Promise<string[]> { return [...new Set(this.store.outbox)] }
  async drain(apply: (u: string) => Promise<boolean>): Promise<number> {
    let n = 0
    for (const u of [...new Set(this.store.outbox)]) if (await apply(u)) { this.store.outbox = this.store.outbox.filter((x) => x !== u); n++ }
    return n
  }
}

async function buildApp(prisma: any, redis: FakeRedis): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authorize', () => async (req: any) => { req.user = { sub: 'admin1', role: 'ADMIN' } })
  app.decorate('authenticate', async (req: any) => { req.user = { sub: 'admin1', role: 'ADMIN' } })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', prisma)
  app.decorate('redis', redis as any)
  await app.register(userRoutes, { prefix: '/api/users' })
  await app.ready()
  return app
}

const scope = { userId: 'victim', cameraId: 'cam-1', streamPath: 'nvr_cam1_sub', transport: 'rtsps' as const, action: 'read' as const }

async function issueLiveGrant(app: FastifyInstance) {
  const mgr = getMediaGrantManager(app)
  await mgr.registerSource('nvr_cam1_sub')
  const r = await mgr.issue({ userId: 'victim', viewId: 'v', cameraId: 'cam-1', streamPath: 'nvr_cam1_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
  if (!r.ok) throw new Error('issue: ' + r.code)
  return r
}

beforeEach(() => __resetMediaGrantManagerForTest())

describe('permisos ⇄ revocación ATÓMICA (C23·H2·P1)', () => {
  it('POST éxito: cambio de permisos revoca (epoch) ⇒ el grant vivo deja de validar', async () => {
    const { prisma, store } = makeFake()
    const redis = new FakeRedis()
    setMediaRevokeOutboxForTest(new TxOutbox(store))
    const app = await buildApp(prisma, redis)
    const mgr = getMediaGrantManager(app)
    const r = await issueLiveGrant(app)
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).ok).toBe(true)

    const r2 = await mgr.issue({ userId: 'victim', viewId: 'v2', cameraId: 'cam-1', streamPath: 'nvr_cam1_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    if (!r2.ok) throw new Error('issue2')

    const res = await app.inject({ method: 'POST', url: '/api/users/victim/permissions', payload: [] })
    expect(res.statusCode).toBe(200)
    // El grant nuevo ya no valida (epoch incrementado por el cambio de permisos).
    expect((await mgr.consume({ grantId: r2.issued.grantId, secret: r2.issued.secret }, scope)).ok).toBe(false)
    await app.close()
  })

  it('POST fallo del outbox: ROLLBACK ⇒ 503, sin declarar éxito, permisos sin cambios y epoch intacto', async () => {
    const { prisma, store, setFail } = makeFake()
    const redis = new FakeRedis()
    setMediaRevokeOutboxForTest(new TxOutbox(store))
    const app = await buildApp(prisma, redis)
    const mgr = getMediaGrantManager(app)
    const r = await issueLiveGrant(app)

    setFail(true)  // el INSERT de la intención de revocar fallará DENTRO de la tx
    const res = await app.inject({ method: 'POST', url: '/api/users/victim/permissions', payload: [{ nvrId: 'nvr-1' }] })

    expect(res.statusCode).toBe(503)                       // no-2xx
    expect(res.json().message).not.toBe('Permisos actualizados')  // nunca declara éxito
    expect(store.perms).toBe(0)                            // mutación NO comprometida (rollback)
    expect(store.outbox).toEqual([])                       // ninguna intención a medias
    // Nada cambió ⇒ el grant previo sigue validando (no se bumpeó epoch).
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).ok).toBe(true)
    await app.close()
  })

  it('PUT fallo del outbox: ROLLBACK ⇒ 503 y epoch intacto (mismo contrato atómico)', async () => {
    const { prisma, store, setFail } = makeFake()
    const redis = new FakeRedis()
    setMediaRevokeOutboxForTest(new TxOutbox(store))
    const app = await buildApp(prisma, redis)
    const mgr = getMediaGrantManager(app)
    const r = await issueLiveGrant(app)

    setFail(true)
    const res = await app.inject({ method: 'PUT', url: '/api/users/victim/permissions', payload: { nvrPermissions: [{ nvrId: 'nvr-1' }] } })

    expect(res.statusCode).toBe(503)
    expect(res.json().message).not.toBe('Permisos actualizados')
    expect(store.perms).toBe(0)
    expect(store.outbox).toEqual([])
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).ok).toBe(true)
    await app.close()
  })
})
