// Regresión de seguridad — sólo un ACCESS token sirve como credencial de petición.
//
// El servidor firma con la misma clave cinco tipos de JWT:
//   access    {sub, username, role}                       → credencial normal
//   refresh   {sub, username, role, jti, rememberMe} (7d) → sólo /auth/refresh
//   2fa       {sub, step:'2fa'}           (5 min, tras la contraseña, ANTES del 2.º factor)
//   enroll    {sub, step:'mfa-enroll'}    (15 min)
//   step-up   {sub, step:'elevated'}      (5 min, header x-step-up-token)
// `authenticate` sólo verificaba firma y vencimiento: los tokens intermedios (sin
// `role`) pasaban, y como las rutas de grabaciones sólo excluyen role==='OPERATOR' y
// filtran role==='AUDITOR', un token sin rol veía las grabaciones de TODAS las
// cámaras (con sólo la contraseña, o un OPERATOR con su propio step-up). El refresh
// servía como access token por 7 días sin poder revocarse.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const SECRET = 'test-secret-access-token-only-0123456789abcdef0123456789'
let saved: string | undefined
beforeAll(() => { saved = process.env.JWT_SECRET; process.env.JWT_SECRET = SECRET })
afterAll(() => { if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved })

const decrypt = vi.hoisted(() => vi.fn(() => ''))
vi.mock('../services/credentials', async (orig) => ({ ...(await orig() as object), decryptNvrPassword: decrypt }))

async function build(): Promise<FastifyInstance> {
  const { authPlugin } = await import('./auth')
  const { recordingRoutes } = await import('../routes/recordings')
  const app = Fastify()
  app.decorate('prisma', {
    camera: { findUnique: async () => ({ id: 'cam-x', channel: 3, nvr: { id: 'n', password: 'enc', ipAddress: '192.0.2.1', rtspPort: 554, username: 'u' } }) },
    userPermission: { findFirst: async () => null, findMany: async () => [] },
    auditLog: { create: async () => ({}) },
  } as any)
  await app.register(authPlugin)
  app.get('/who', { preHandler: [app.authenticate] }, async (req) => req.user)
  app.get('/admin', { preHandler: [app.authorize(['ADMIN'])] }, async () => ({ ok: true }))
  app.get('/sensible', { preHandler: [app.authenticate, app.requireStepUp] }, async () => ({ ok: true }))
  app.get('/verify-explicito', async (req) => app.jwt.verify((req.query as any).t))
  await app.register(recordingRoutes, { prefix: '/api/recordings' })
  await app.ready()
  return app
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

describe('sólo access tokens como credencial de petición', () => {
  let app: FastifyInstance
  let tokens: Record<string, string>
  beforeAll(async () => {
    app = await build()
    tokens = {
      access: app.jwt.sign({ sub: 'u1', username: 'op', role: 'OPERATOR' }),
      admin: app.jwt.sign({ sub: 'a1', username: 'adm', role: 'ADMIN' }),
      refresh: (app.jwt as any).sign({ sub: 'u1', username: 'op', role: 'OPERATOR', jti: 'j1', rememberMe: true }, { expiresIn: '7d' }),
      refreshAdmin: (app.jwt as any).sign({ sub: 'a1', username: 'adm', role: 'ADMIN', jti: 'j2', rememberMe: false }, { expiresIn: '7d' }),
      twoFa: (app.jwt as any).sign({ sub: 'u1', step: '2fa' }, { expiresIn: '5m' }),
      enroll: (app.jwt as any).sign({ sub: 'u1', step: 'mfa-enroll' }, { expiresIn: '15m' }),
      stepUp: (app.jwt as any).sign({ sub: 'u1', step: 'elevated' }, { expiresIn: '5m' }),
      badRole: app.jwt.sign({ sub: 'u1', username: 'x', role: 'ROOT' as any }),
      stepWithRole: (app.jwt as any).sign({ sub: 'u1', username: 'op', role: 'ADMIN', step: 'elevated' }),
    }
  })
  afterAll(async () => { await app.close() })

  it('el access token sigue funcionando (header y cookie)', async () => {
    const h = await app.inject({ method: 'GET', url: '/who', headers: bearer(tokens.access) })
    expect(h.statusCode).toBe(200)
    expect(h.json()).toMatchObject({ sub: 'u1', role: 'OPERATOR' })
    const c = await app.inject({ method: 'GET', url: '/who', cookies: { access_token: tokens.access } })
    expect(c.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/admin', headers: bearer(tokens.admin) })).statusCode).toBe(200)
  })

  for (const kind of ['twoFa', 'enroll', 'stepUp', 'refresh', 'badRole', 'stepWithRole'] as const) {
    it(`token ${kind} ⇒ 401 en authenticate y authorize (header y cookie)`, async () => {
      expect((await app.inject({ method: 'GET', url: '/who', headers: bearer(tokens[kind]) })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: '/who', cookies: { access_token: tokens[kind] } })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: '/admin', headers: bearer(tokens[kind]) })).statusCode).toBe(401)
    })
  }

  it('el refresh de un ADMIN tampoco abre rutas de ADMIN', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin', headers: bearer(tokens.refreshAdmin) })).statusCode).toBe(401)
  })

  it('impacto real: un token sin rol (2fa / step-up) ya no ve grabaciones de cualquier cámara', async () => {
    for (const kind of ['twoFa', 'stepUp', 'enroll'] as const) {
      const res = await app.inject({ method: 'GET', url: '/api/recordings/search?cameraId=cam-x&startTime=2026-01-01T00:00:00Z&endTime=2026-01-01T01:00:00Z', headers: bearer(tokens[kind]) })
      expect(res.statusCode, kind).toBe(401)
    }
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('los flujos explícitos siguen aceptando sus tokens (2.º factor, enrolamiento, step-up)', async () => {
    // /auth/2fa/verify y /auth/mfa/enroll/* verifican el token del body con server.jwt.verify.
    const v = await app.inject({ method: 'GET', url: `/verify-explicito?t=${tokens.twoFa}` })
    expect(v.json()).toMatchObject({ sub: 'u1', step: '2fa' })
    // requireStepUp lee el step-up del header x-step-up-token junto a un access token.
    const ok = await app.inject({ method: 'GET', url: '/sensible', headers: { ...bearer(tokens.access), 'x-step-up-token': tokens.stepUp } })
    expect(ok.statusCode).toBe(200)
    const sinStepUp = await app.inject({ method: 'GET', url: '/sensible', headers: bearer(tokens.access) })
    expect(sinStepUp.statusCode).toBe(403)
  })
})

describe('isAccessTokenClaims', () => {
  it('acepta sólo {sub, role válido} sin step ni jti', async () => {
    const { isAccessTokenClaims } = await import('./auth')
    expect(isAccessTokenClaims({ sub: 'u', username: 'x', role: 'AUDITOR', iat: 1, exp: 2 })).toBe(true)
    for (const bad of [
      null, undefined, 'x', 1, {},
      { sub: '', role: 'ADMIN' }, { sub: 'u' }, { sub: 'u', role: 'admin' }, { sub: 'u', role: 1 },
      { sub: 'u', role: 'ADMIN', step: 'elevated' }, { sub: 'u', role: 'ADMIN', step: null },
      { sub: 'u', role: 'ADMIN', jti: 'j' }, { sub: 1, role: 'ADMIN' },
    ]) expect(isAccessTokenClaims(bad), JSON.stringify(bad)).toBe(false)
  })
})
