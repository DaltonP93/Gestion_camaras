// #171 — /api/dashboard/overview ENFORCE canViewDashboard (fastify.inject).
// Antes: abierto a cualquier autenticado. Ahora: 403 si el flag resuelto es false;
// ADMIN siempre pasa; default (sin override) sigue permitiendo.
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { dashboardRoutes } from './dashboard'

function prismaStub(featureRow: Record<string, unknown> | null) {
  return {
    userFeaturePermissions: { findUnique: async () => featureRow },
    camera: { count: async () => 0 },
    nVR: { count: async () => 0 },
    alert: { count: async () => 0, findMany: async () => [] },
  } as any
}

async function buildApp(user: { sub: string; role: string }, featureRow: Record<string, unknown> | null): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('prisma', prismaStub(featureRow))
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
  await app.ready()
  return app
}

describe('GET /api/dashboard/overview — enforcement de canViewDashboard', () => {
  it('no-ADMIN sin override ⇒ 200 (default true)', async () => {
    const app = await buildApp({ sub: 'u1', role: 'OPERATOR' }, null)
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/overview' })
    expect(res.statusCode).toBe(200)
    expect(res.json().cameras).toBeDefined()
    await app.close()
  })

  it('no-ADMIN con canViewDashboard=false ⇒ 403 (ya no evadible)', async () => {
    const app = await buildApp({ sub: 'u2', role: 'OPERATOR' }, { userId: 'u2', canViewDashboard: false })
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/overview' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('ADMIN con override false ⇒ 200 (ADMIN siempre puede)', async () => {
    const app = await buildApp({ sub: 'admin', role: 'ADMIN' }, { userId: 'admin', canViewDashboard: false })
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/overview' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
