// Integración (fastify.inject): un cambio de permisos CIERRA las conexiones WS
// vivas del usuario afectado (fuerza reconexión + re-auth con permisos nuevos),
// sin tocar las de otros usuarios.
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { userRoutes } from './users'
import { __resetMediaGrantManagerForTest } from '../services/media/grant-service'
import { FakeRedis } from '../services/media/redis-fake'
import { wsClients } from './websocket'

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

function makeFakeSocket() {
  const calls: Array<{ code?: number; reason?: string }> = []
  const ws: any = {
    readyState: 1,
    close(code?: number, reason?: string) { calls.push({ code, reason }) },
    _calls: calls,
  }
  return ws
}

function register(userId: string, ws: any) {
  if (!wsClients.has(userId)) wsClients.set(userId, new Set())
  wsClients.get(userId)!.add(ws)
}

beforeEach(() => {
  __resetMediaGrantManagerForTest()
  wsClients.clear()
})

describe('POST /api/users/:id/permissions cierra las conexiones WS del usuario (inject)', () => {
  it('cierra las conexiones de la víctima y no las de otros', async () => {
    const redis = new FakeRedis()
    const app = await buildApp(redis)

    const victimWs = makeFakeSocket()
    const otherWs = makeFakeSocket()
    register('victim', victimWs)
    register('bystander', otherWs)

    const res = await app.inject({ method: 'POST', url: '/api/users/victim/permissions', payload: [] })
    expect(res.statusCode).toBe(200)

    expect(victimWs._calls).toHaveLength(1)
    expect(victimWs._calls[0].code).toBe(4003)
    expect(otherWs._calls).toHaveLength(0)

    await app.close()
  })
})
