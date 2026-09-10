// P1 — auth_request del HLS por espectador. Prueba las funciones puras de parseo y
// el endpoint /internal/hls-auth con JWT real (cookie), @fastify/cookie y un prisma
// stub para userPermission (RBAC por cámara).
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyJwt from '@fastify/jwt'
import { hlsAuthRoutes, parseStreamName, streamNameFromUri } from './hlsAuth'

describe('parseStreamName', () => {
  it('deriva nvrId + canal de un path válido', () => {
    expect(parseStreamName('nvr_abc123_ch01_sub')).toEqual({ nvrId: 'abc123', channel: 1 })
    expect(parseStreamName('nvr_abc123_ch16_main')).toEqual({ nvrId: 'abc123', channel: 16 })
    expect(parseStreamName('nvr_abc123_ch07_main_h264')).toEqual({ nvrId: 'abc123', channel: 7 })
  })
  it('rechaza formatos inválidos', () => {
    for (const bad of ['', 'nvr_abc', 'foo_abc_ch01_sub', 'nvr_abc_chXX_sub', 'nvr__ch01_sub', 'nvr_abc_ch01']) {
      expect(parseStreamName(bad), bad).toBeNull()
    }
  })
})

describe('streamNameFromUri', () => {
  it('extrae el nombre del stream de la URI de HLS', () => {
    expect(streamNameFromUri('/hls/nvr_abc_ch01_sub/index.m3u8')).toBe('nvr_abc_ch01_sub')
    expect(streamNameFromUri('/hls/nvr_abc_ch01_sub/seg1.mp4?x=1')).toBe('nvr_abc_ch01_sub')
    expect(streamNameFromUri('nvr_abc_ch01_sub/index.m3u8')).toBe('nvr_abc_ch01_sub')
    expect(streamNameFromUri('/hls/')).toBeNull()
    expect(streamNameFromUri(undefined)).toBeNull()
  })
  it('rechaza path-traversal (`..`): no autorizar la 1a cámara si la URI evade a otra (P1)', () => {
    // Con `..` el primer segmento (nvr_X_ch01) autorizaría, pero MediaMTX serviría
    // nvr_X_ch02 tras normalizar ⇒ se rechaza de plano (defensa en profundidad).
    expect(streamNameFromUri('/hls/nvr_X_ch01_sub/../nvr_X_ch02_sub/index.m3u8')).toBeNull()
    expect(streamNameFromUri('/hls/../nvr_X_ch02_sub/index.m3u8')).toBeNull()
    expect(streamNameFromUri('/hls/./nvr_X_ch01_sub/index.m3u8')).toBeNull()
  })
})

// ── endpoint ──────────────────────────────────────────────────────────────
// prisma stub: userPermission.findFirst devuelve un match según el dataset.
function makePrisma(perms: Array<{ userId: string; nvrId?: string | null; cameraId?: string | null; channel?: number }>) {
  return {
    userPermission: {
      findFirst: async ({ where }: any) => {
        // NVR-scoped: { userId, canView:true, nvrId, cameraId:null }
        // camera-scoped: { userId, canView:true, camera: { nvrId, channel } }
        const match = perms.find((p) => {
          if (p.userId !== where.userId) return false
          if (where.cameraId === null) return p.nvrId === where.nvrId && (p.cameraId ?? null) === null && p.channel === undefined
          if (where.camera) return p.channel === where.camera.channel && p.nvrId === where.camera.nvrId && p.cameraId != null
          return false
        })
        return match ? { id: 'perm-1' } : null
      },
    },
  } as any
}

async function buildApp(prisma: any): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(fastifyCookie)
  await app.register(fastifyJwt, { secret: 'test_secret_at_least_32_chars_long_xxxxx', cookie: { cookieName: 'access_token', signed: false } })
  app.decorate('prisma', prisma)
  await app.register(hlsAuthRoutes)   // define su ruta exacta /internal/hls-auth
  await app.ready()
  return app
}

function tokenFor(app: FastifyInstance, sub: string, role: string): string {
  return app.jwt.sign({ sub, username: 'u', role })
}

const URI = '/hls/nvr_n1_ch03_sub/index.m3u8'

describe('GET /internal/hls-auth', () => {
  let app: FastifyInstance
  beforeEach(async () => { if (app) await app.close() })

  it('sin cookie ⇒ 401', async () => {
    app = await buildApp(makePrisma([]))
    const res = await app.inject({ method: 'GET', url: '/internal/hls-auth', headers: { 'x-original-uri': URI } })
    expect(res.statusCode).toBe(401)
  })

  it('ADMIN ⇒ 200 (ve todo, sin consultar permisos)', async () => {
    app = await buildApp(makePrisma([]))
    const res = await app.inject({
      method: 'GET', url: '/internal/hls-auth',
      cookies: { access_token: tokenFor(app, 'admin1', 'ADMIN') },
      headers: { 'x-original-uri': URI },
    })
    expect(res.statusCode).toBe(200)
  })

  it('OPERATOR con canView sobre la cámara ⇒ 200', async () => {
    app = await buildApp(makePrisma([{ userId: 'op1', nvrId: 'n1', cameraId: 'cam-x', channel: 3 }]))
    const res = await app.inject({
      method: 'GET', url: '/internal/hls-auth',
      cookies: { access_token: tokenFor(app, 'op1', 'OPERATOR') },
      headers: { 'x-original-uri': URI },
    })
    expect(res.statusCode).toBe(200)
  })

  it('OPERATOR sin permiso sobre esa cámara ⇒ 403', async () => {
    app = await buildApp(makePrisma([{ userId: 'op1', nvrId: 'n1', cameraId: 'cam-y', channel: 9 }]))
    const res = await app.inject({
      method: 'GET', url: '/internal/hls-auth',
      cookies: { access_token: tokenFor(app, 'op1', 'OPERATOR') },
      headers: { 'x-original-uri': URI },
    })
    expect(res.statusCode).toBe(403)
  })

  it('path inválido ⇒ 403 (aunque el JWT sea válido)', async () => {
    app = await buildApp(makePrisma([]))
    const res = await app.inject({
      method: 'GET', url: '/internal/hls-auth',
      cookies: { access_token: tokenFor(app, 'admin1', 'ADMIN') },
      headers: { 'x-original-uri': '/hls/no-es-un-stream/index.m3u8' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('P1: URI con path-traversal ⇒ 403 aunque el 1er segmento sea autorizable', async () => {
    // OPERATOR con canView SOLO en ch03; intenta evadir a otra cámara vía `..`.
    app = await buildApp(makePrisma([{ userId: 'op1', nvrId: 'n1', cameraId: 'cam-x', channel: 3 }]))
    const res = await app.inject({
      method: 'GET', url: '/internal/hls-auth',
      cookies: { access_token: tokenFor(app, 'op1', 'OPERATOR') },
      headers: { 'x-original-uri': '/hls/nvr_n1_ch03_sub/../nvr_n1_ch09_sub/index.m3u8' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('origen externo (IP pública) ⇒ 403 aunque haya cookie válida', async () => {
    app = await buildApp(makePrisma([]))
    const res = await app.inject({
      method: 'GET', url: '/internal/hls-auth', remoteAddress: '203.0.113.7',
      cookies: { access_token: tokenFor(app, 'admin1', 'ADMIN') },
      headers: { 'x-original-uri': URI },
    })
    expect(res.statusCode).toBe(403)
  })
})
