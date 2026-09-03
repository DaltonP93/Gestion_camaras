// Integración (fastify.inject): un cambio de permisos REVOCA (epoch) los grants
// del usuario afectado — el grant viejo deja de validar (C22.2, P0-1/P0-2).
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { userRoutes } from './users'
import { getMediaGrantManager, __resetMediaGrantManagerForTest } from '../services/media/grant-service'
import { FakeRedis } from '../services/media/redis-fake'

async function buildApp(redis: FakeRedis): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authorize', () => async (req: any) => { req.user = { sub: 'admin1', role: 'ADMIN' } })
  app.decorate('authenticate', async (req: any) => { req.user = { sub: 'admin1', role: 'ADMIN' } })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', {
    userPermission: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    auditLog: { create: async () => ({}) },
  } as any)
  app.decorate('redis', redis as any)
  await app.register(userRoutes, { prefix: '/api/users' })
  await app.ready()
  return app
}

const scope = { userId: 'victim', cameraId: 'cam-1', streamPath: 'nvr_cam1_sub', transport: 'rtsps' as const, action: 'read' as const }

beforeEach(() => __resetMediaGrantManagerForTest())

describe('POST /api/users/:id/permissions revoca (epoch) los grants (inject)', () => {
  it('tras cambiar permisos, el grant vivo del usuario deja de validar', async () => {
    const redis = new FakeRedis()
    const app = await buildApp(redis)
    const mgr = getMediaGrantManager(app)
    await mgr.registerSource('nvr_cam1_sub')
    const r = await mgr.issue({ userId: 'victim', viewId: 'v1', cameraId: 'cam-1', streamPath: 'nvr_cam1_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    if (!r.ok) throw new Error('issue')
    expect((await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)).ok).toBe(true)

    // Re-emitir uno nuevo (el anterior se consumió) para probar la revocación por cambio de permisos.
    const r2 = await mgr.issue({ userId: 'victim', viewId: 'v2', cameraId: 'cam-1', streamPath: 'nvr_cam1_sub', effectiveType: 'sub', codec: 'h264', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    if (!r2.ok) throw new Error('issue2')

    const res = await app.inject({ method: 'POST', url: '/api/users/victim/permissions', payload: [] })
    expect(res.statusCode).toBe(200)

    // El grant nuevo ya no valida (epoch incrementado por el cambio de permisos).
    expect((await mgr.consume({ grantId: r2.issued.grantId, secret: r2.issued.secret }, scope)).ok).toBe(false)
    await app.close()
  })
})
