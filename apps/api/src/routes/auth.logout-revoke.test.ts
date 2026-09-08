// Integración (fastify.inject) del logout ⇄ revocación de grants de medios (C23·H2·P1):
//
//   - ÉXITO: el cierre de sesión y la INTENCIÓN de revocar se confirman ATÓMICOS;
//     el grant vivo del usuario deja de validar (epoch bumpeado).
//   - FALLO del outbox: si el INSERT de la intención falla, la transacción hace
//     ROLLBACK; la ruta responde no-2xx y NUNCA declara "Sesión cerrada"; la sesión
//     NO se borra y el grant previo sigue igual (nada cambió).
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { authRoutes } from './auth'
import {
  getMediaGrantManager, setMediaRevokeOutboxForTest, __resetMediaGrantManagerForTest,
} from '../services/media/grant-service'
import type { MediaRevokeOutboxRepo, MediaRevokeOutboxTxClient } from '../services/media/revoke-outbox'
import { FakeRedis } from '../services/media/redis-fake'

interface Store { sessionsDeleted: number; outbox: string[] }
function makeFake() {
  const store: Store = { sessionsDeleted: 0, outbox: [] }
  let failOutbox = false
  const makeTx = () => {
    const local = { sessionsDeleted: 0, outbox: [] as string[] }
    const tx: any = {
      session: { deleteMany: async () => { local.sessionsDeleted++; return { count: 1 } } },
      mediaRevokeOutbox: { create: async ({ data }: any) => { if (failOutbox) throw new Error('outbox insert falló (simulado)'); local.outbox.push(data.userId); return {} } },
    }
    return { tx, local }
  }
  const prisma: any = {
    auditLog: { create: async () => ({}) },
    $transaction: async (fn: any) => {
      const { tx, local } = makeTx()
      const out = await fn(tx)                 // lanza ⇒ ROLLBACK (nada aplicado)
      store.sessionsDeleted += local.sessionsDeleted
      store.outbox.push(...local.outbox)
      return out
    },
  }
  return { prisma, store, setFail: (v: boolean) => { failOutbox = v } }
}

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
  app.decorate('authenticate', async (req: any) => { req.user = { sub: 'victim', username: 'v', role: 'OPERATOR' } })
  app.decorate('prisma', prisma)
  app.decorate('redis', redis as any)
  await app.register(authRoutes, { prefix: '/api/auth' })
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

describe('logout ⇄ revocación ATÓMICA (C23·H2·P1)', () => {
  it('éxito: el logout revoca (epoch) ⇒ el grant vivo deja de validar', async () => {
    const { prisma, store } = makeFake()
    const redis = new FakeRedis()
    setMediaRevokeOutboxForTest(new TxOutbox(store))
    const app = await buildApp(prisma, redis)
    const mgr = getMediaGrantManager(app)
    const r = await issueLiveGrant(app)

    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refreshToken: 'rt-abc' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().message).toBe('Sesión cerrada')
    expect(store.sessionsDeleted).toBe(1)               // la sesión se borró (commit)
    // El grant previo ya no valida (epoch bumpeado por el logout).
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).ok).toBe(false)
    await app.close()
  })

  it('fallo del outbox: ROLLBACK ⇒ 503, sin "Sesión cerrada", sesión NO borrada y epoch intacto', async () => {
    const { prisma, store, setFail } = makeFake()
    const redis = new FakeRedis()
    setMediaRevokeOutboxForTest(new TxOutbox(store))
    const app = await buildApp(prisma, redis)
    const mgr = getMediaGrantManager(app)
    const r = await issueLiveGrant(app)

    setFail(true)
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refreshToken: 'rt-abc' } })

    expect(res.statusCode).toBe(503)
    expect(res.json().message).not.toBe('Sesión cerrada')
    expect(store.sessionsDeleted).toBe(0)               // ROLLBACK: la sesión NO se borró
    expect(store.outbox).toEqual([])                    // ninguna intención a medias
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).ok).toBe(true)
    await app.close()
  })
})
