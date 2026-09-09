// ws-ticket re-verifica LIVENESS (P2 auditoría): tras desactivar al usuario o
// revocarle las sesiones, el ticket de WS NO debe emitirse aunque el access JWT
// siga vigente (así el 4003 no se puede re-abrir por reconexión).
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import { authRoutes } from './auth'

function makePrisma(opts: { active: boolean; hasSession: boolean }) {
  return {
    user: { findUnique: async () => ({ active: opts.active }) },
    session: { findFirst: async () => (opts.hasSession ? { id: 's1' } : null) },
    auditLog: { create: async () => ({}) },
  } as any
}
// redis mínimo para issueWsTicket (SET ... NX ⇒ 'OK').
const redis = { set: async () => 'OK' } as any

async function build(prisma: any): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(fastifyCookie)
  app.decorate('authenticate', async (req: any) => { req.user = { sub: 'u1', username: 'alice', role: 'OPERATOR' } })
  app.decorate('prisma', prisma)
  app.decorate('redis', redis)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xx'
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.ready()
  return app
}

describe('POST /api/auth/ws-ticket — liveness', () => {
  let app: FastifyInstance
  beforeEach(async () => { if (app) await app.close() })

  it('usuario activo con sesión viva ⇒ 200 + ticket', async () => {
    app = await build(makePrisma({ active: true, hasSession: true }))
    const res = await app.inject({ method: 'POST', url: '/api/auth/ws-ticket' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ticket).toMatch(/^wst_[0-9a-f]{64}$/)
  })

  it('usuario DESACTIVADO ⇒ 403 (no emite ticket)', async () => {
    app = await build(makePrisma({ active: false, hasSession: true }))
    const res = await app.inject({ method: 'POST', url: '/api/auth/ws-ticket' })
    expect(res.statusCode).toBe(403)
    expect(res.json().ticket).toBeUndefined()
  })

  it('sin sesión viva (revocadas) ⇒ 401 (no emite ticket)', async () => {
    app = await build(makePrisma({ active: true, hasSession: false }))
    const res = await app.inject({ method: 'POST', url: '/api/auth/ws-ticket' })
    expect(res.statusCode).toBe(401)
    expect(res.json().ticket).toBeUndefined()
  })
})
