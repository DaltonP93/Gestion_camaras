// Envíos de correo disparados por usuarios bajo aislamiento de staging:
//  - POST /api/alerts/settings/test-email ⇒ 409 sin crear transporte SMTP;
//  - POST /api/auth/forgot-password ⇒ misma respuesta genérica (sin enumeración),
//    el token se genera igual, pero no se crea transporte SMTP.
import { describe, it, expect, vi, afterEach } from 'vitest'
import Fastify from 'fastify'

const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail: vi.fn(async () => ({})) })))
vi.mock('nodemailer', () => ({ default: { createTransport }, createTransport }))

import alertSettingsRoutes from './alertSettings'
import { authRoutes } from './auth'

const saved = process.env.STAGING_ISOLATION
afterEach(() => {
  if (saved === undefined) delete process.env.STAGING_ISOLATION
  else process.env.STAGING_ISOLATION = saved
  createTransport.mockClear()
})

const SMTP = {
  id: 'singleton', emailEnabled: true, smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecure: false,
  smtpUser: 'u', smtpPassword: 'p', smtpFromEmail: 'a@example.test', smtpFromName: 'VC', recipientEmails: 'ops@example.test',
}

async function buildAlertSettings() {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = { sub: 'adm', role: 'ADMIN' } })
  app.decorate('authorize', () => async (req: any) => { req.user = { sub: 'adm', role: 'ADMIN' } })
  app.decorate('prisma', { alertSettings: { findUnique: vi.fn(async () => SMTP) } } as any)
  await app.register(alertSettingsRoutes, { prefix: '/api/alerts' })
  await app.ready()
  return app
}

describe('POST /api/alerts/settings/test-email', () => {
  it('STAGING_ISOLATION=true ⇒ 409 OUTBOUND_DISABLED sin crear transporte SMTP', async () => {
    process.env.STAGING_ISOLATION = 'true'
    const app = await buildAlertSettings()
    const res = await app.inject({ method: 'POST', url: '/api/alerts/settings/test-email', payload: { testEmail: 'x@example.test' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('OUTBOUND_DISABLED')
    expect(createTransport).not.toHaveBeenCalled()
    await app.close()
  })

  it('contraste: sin aislamiento crea el transporte', async () => {
    const app = await buildAlertSettings()
    const res = await app.inject({ method: 'POST', url: '/api/alerts/settings/test-email', payload: { testEmail: 'x@example.test' } })
    expect(res.statusCode).toBe(200)
    expect(createTransport).toHaveBeenCalledTimes(1)
    await app.close()
  })
})

async function buildAuth() {
  const app = Fastify()
  const update = vi.fn(async () => ({}))
  app.decorate('authenticate', async () => {})
  app.decorate('authorize', () => async () => {})
  app.decorate('requireStepUp', async () => {})
  app.decorate('redis', {} as any)
  app.decorate('prisma', {
    user: {
      findFirst: vi.fn(async () => ({ id: 'u1', email: 'x@example.test', active: true, passwordResetExpiry: null })),
      update,
    },
    alertSettings: { findUnique: vi.fn(async () => SMTP) },
    appearanceSettings: { findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  } as any)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.ready()
  return { app, update }
}

describe('POST /api/auth/forgot-password', () => {
  it('STAGING_ISOLATION=true ⇒ respuesta genérica, token generado, sin transporte SMTP', async () => {
    process.env.STAGING_ISOLATION = 'true'
    const { app, update } = await buildAuth()
    const res = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'x@example.test' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().message).toBe('Si el correo existe, se enviaron instrucciones.')
    expect(update).toHaveBeenCalledTimes(1)
    expect(createTransport).not.toHaveBeenCalled()
    await app.close()
  })

  it('contraste: sin aislamiento crea el transporte', async () => {
    const { app } = await buildAuth()
    const res = await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'x@example.test' } })
    expect(res.statusCode).toBe(200)
    expect(createTransport).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
