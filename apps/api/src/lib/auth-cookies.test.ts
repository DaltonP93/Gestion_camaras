import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import {
  setAuthCookies, clearAuthCookies, ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_COOKIE_PATH,
} from './auth-cookies'

async function buildApp() {
  const app = Fastify()
  await app.register(fastifyCookie)
  app.post('/set', async (_req, reply) => {
    const persist = (_req.query as any).persist === '1'
    setAuthCookies(reply, { accessToken: 'AT', refreshToken: 'RT', persist, refreshMaxAgeMs: 7 * 24 * 3600_000 })
    return reply.send({ ok: true })
  })
  app.post('/clear', async (_req, reply) => { clearAuthCookies(reply); return reply.send({ ok: true }) })
  await app.ready()
  return app
}

const prevSecure = process.env.COOKIE_SECURE
afterEach(() => { if (prevSecure === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = prevSecure })

describe('setAuthCookies', () => {
  it('access_token: HttpOnly, SameSite=Strict, Path=/, cookie de sesión (sin Max-Age)', async () => {
    process.env.COOKIE_SECURE = 'true'
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/set?persist=1' })
    const at = res.cookies.find((c: any) => c.name === ACCESS_COOKIE)!
    expect(at.value).toBe('AT')
    expect(at.httpOnly).toBe(true)
    expect(String(at.sameSite).toLowerCase()).toBe('strict')
    expect(at.path).toBe('/')
    expect(at.secure).toBe(true)
    expect(at.maxAge).toBeUndefined()   // sesión: se borra al cerrar el navegador
    await app.close()
  })

  it('refresh_token: Path=/api/auth y Max-Age SÓLO si persist (recordarme)', async () => {
    process.env.COOKIE_SECURE = 'true'
    const app = await buildApp()

    const persisted = await app.inject({ method: 'POST', url: '/set?persist=1' })
    const rtP = persisted.cookies.find((c: any) => c.name === REFRESH_COOKIE)!
    expect(rtP.path).toBe(REFRESH_COOKIE_PATH)
    expect(rtP.httpOnly).toBe(true)
    expect(String(rtP.sameSite).toLowerCase()).toBe('strict')
    expect(rtP.maxAge).toBeGreaterThan(0)

    const session = await app.inject({ method: 'POST', url: '/set?persist=0' })
    const rtS = session.cookies.find((c: any) => c.name === REFRESH_COOKIE)!
    expect(rtS.maxAge).toBeUndefined()   // sin recordarme ⇒ cookie de sesión
    await app.close()
  })

  it('COOKIE_SECURE=false ⇒ Secure desactivado (staging HTTP)', async () => {
    process.env.COOKIE_SECURE = 'false'
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/set?persist=1' })
    const at = res.cookies.find((c: any) => c.name === ACCESS_COOKIE)!
    expect(at.secure).toBeFalsy()
    await app.close()
  })
})

describe('clearAuthCookies', () => {
  it('expira ambas cookies (Max-Age/Expires en el pasado) con sus paths', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/clear' })
    const at = res.cookies.find((c: any) => c.name === ACCESS_COOKIE)!
    const rt = res.cookies.find((c: any) => c.name === REFRESH_COOKIE)!
    // clearCookie fija expiración en epoch/pasado y valor vacío.
    expect(at.path).toBe('/')
    expect(rt.path).toBe(REFRESH_COOKIE_PATH)
    expect(at.value).toBe('')
    expect(rt.value).toBe('')
  })
})
