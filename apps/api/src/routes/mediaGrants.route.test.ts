// Pruebas de RUTA vía fastify.inject (C22.2): controlador real + FakeRedis
// (semántica atómica) + readiness/RBAC unificados. Env fijado antes del import.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeRedis } from '../services/media/redis-fake'

let mediaGrantsRoutes: any
let getMgr: any
let reset: () => void

const CAM_HEVC = { id: 'cam-1', channel: 9, mainCodec: 'HEVC', subCodec: 'H264', nvr: { id: 'nvr1' } }
const CAM_H264 = { id: 'cam-2', channel: 3, mainCodec: 'H264', subCodec: 'H264', nvr: { id: 'nvr1' } }
const path = (cam: any, type: 'sub' | 'main') => `nvr_${cam.nvr.id}_ch${String(cam.channel).padStart(2, '0')}_${type}`

async function buildApp(opts: { user: any; camera?: any; perm?: any; redis: FakeRedis }): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = opts.user })
  app.decorate('prisma', {
    camera: { findUnique: async () => opts.camera ?? null },
    userPermission: { findFirst: async () => opts.perm ?? null },
  } as any)
  app.decorate('redis', opts.redis as any)
  reset()
  await app.register(mediaGrantsRoutes, { prefix: '/api/live-view' })
  await app.ready()
  return app
}

beforeAll(async () => {
  process.env.NATIVE_PLAYBACK_ENABLED = 'true'
  process.env.NATIVE_MEDIA_RELAY_ENABLED = 'true'
  process.env.MEDIA_RELAY_SECRET = 'relaysecret'
  mediaGrantsRoutes = (await import('./mediaGrants')).mediaGrantsRoutes
  const svc = await import('../services/media/grant-service')
  getMgr = svc.getMediaGrantManager
  reset = svc.__resetMediaGrantManagerForTest
})
beforeEach(() => reset())

describe('POST /media-grant (inject)', () => {
  it('T15/happy · admin + HEVC + fuente registrada ⇒ 200 main/hevc server-derivado', async () => {
    const redis = new FakeRedis()
    const app = await buildApp({ user: { sub: 'admin1', role: 'ADMIN' }, camera: CAM_HEVC, redis })
    await getMgr(app).registerSource(path(CAM_HEVC, 'main'))
    const res = await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: { viewId: 'v1', cameraId: 'cam-1', transport: 'rtsps', device: 'win', codec: 'h264' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.codec).toBe('hevc'); expect(body.streamPath).toMatch(/_main$/)
    await app.close()
  })

  it('P0-4 · sin fuente registrada ⇒ 409 NO_MEDIA_INSTANCE', async () => {
    const redis = new FakeRedis()
    const app = await buildApp({ user: { sub: 'admin1', role: 'ADMIN' }, camera: CAM_HEVC, redis })
    const res = await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: { viewId: 'v1', cameraId: 'cam-1', transport: 'rtsps', device: 'win' } })
    expect(res.statusCode).toBe(409); expect(res.json().code).toBe('NO_MEDIA_INSTANCE')
    await app.close()
  })

  it('T8 · operador sin canHighQuality + HEVC (main) ⇒ 403', async () => {
    const redis = new FakeRedis()
    const app = await buildApp({ user: { sub: 'op1', role: 'OPERADOR' }, camera: CAM_HEVC, perm: { canView: true, canHighQuality: false }, redis })
    await getMgr(app).registerSource(path(CAM_HEVC, 'main'))
    const res = await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: { viewId: 'v1', cameraId: 'cam-1', transport: 'rtsps', device: 'win' } })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('operador canView + H.264 (sub) ⇒ 200 sub', async () => {
    const redis = new FakeRedis()
    const app = await buildApp({ user: { sub: 'op1', role: 'OPERADOR' }, camera: CAM_H264, perm: { canView: true, canHighQuality: false }, redis })
    await getMgr(app).registerSource(path(CAM_H264, 'sub'))
    const res = await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: { viewId: 'v1', cameraId: 'cam-2', transport: 'rtsps', device: 'win' } })
    expect(res.statusCode).toBe(200); expect(res.json().streamPath).toMatch(/_sub$/)
    await app.close()
  })

  it('T7 · Redis caído ⇒ readiness no lista ⇒ 503 NATIVE_RELAY_NOT_READY', async () => {
    const redis = new FakeRedis()
    const app = await buildApp({ user: { sub: 'admin1', role: 'ADMIN' }, camera: CAM_HEVC, redis })
    redis.down = true
    const res = await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: { viewId: 'v1', cameraId: 'cam-1', transport: 'rtsps', device: 'win' } })
    expect(res.statusCode).toBe(503); expect(res.json().code).toBe('NATIVE_RELAY_NOT_READY')
    await app.close()
  })

  it('cross-user: B no revoca el grant de A; A sí', async () => {
    const redis = new FakeRedis()
    const app = await buildApp({ user: { sub: 'userA', role: 'ADMIN' }, camera: CAM_HEVC, redis })
    await getMgr(app).registerSource(path(CAM_HEVC, 'main'))
    const issued = (await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: { viewId: 'v1', cameraId: 'cam-1', transport: 'rtsps', device: 'win' } })).json()
    await app.close()
    const appB = await buildApp({ user: { sub: 'userB', role: 'ADMIN' }, camera: CAM_HEVC, redis })
    expect((await appB.inject({ method: 'DELETE', url: `/api/live-view/media-grant/${issued.grantId}` })).json().revoked).toBe(false)
    await appB.close()
    const appA = await buildApp({ user: { sub: 'userA', role: 'ADMIN' }, camera: CAM_HEVC, redis })
    expect((await appA.inject({ method: 'DELETE', url: `/api/live-view/media-grant/${issued.grantId}` })).json().revoked).toBe(true)
    await appA.close()
  })
})

describe('validate + flags OFF', () => {
  it('secreto de relay inválido ⇒ 401', async () => {
    const redis = new FakeRedis()
    const app = await buildApp({ user: { sub: 'x', role: 'ADMIN' }, camera: CAM_HEVC, redis })
    const res = await app.inject({ method: 'POST', url: '/api/live-view/internal/media-grant/validate', headers: { 'x-media-relay-secret': 'wrong' }, payload: { grantId: 'g', secret: 's', streamPath: 'p', transport: 'rtsps' } })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
  it('T15 · ruta no registrada ⇒ 404', async () => {
    const app = Fastify()
    app.decorate('authenticate', async (req: any) => { req.user = { sub: 'a', role: 'ADMIN' } })
    await app.ready()
    expect((await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: {} })).statusCode).toBe(404)
    await app.close()
  })
})

describe('N2d · sesión única por usuario (inject)', () => {
  beforeAll(() => { process.env.SINGLE_ACTIVE_MEDIA_SESSION = 'true' })
  afterAll(() => { delete process.env.SINGLE_ACTIVE_MEDIA_SESSION })

  it('una sesión nueva revoca los grants de la sesión previa; la nueva sobrevive', async () => {
    const redis = new FakeRedis()
    const app = await buildApp({ user: { sub: 'userA', role: 'ADMIN' }, camera: CAM_HEVC, redis })
    await getMgr(app).registerSource(path(CAM_HEVC, 'main'))
    const relayHdr = { 'x-media-relay-secret': 'relaysecret' }

    const g1 = (await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: { viewId: 'v1', cameraId: 'cam-1', transport: 'rtsps', device: 'dispA', sessionId: 's1' } })).json()
    const g2 = (await app.inject({ method: 'POST', url: '/api/live-view/media-grant', payload: { viewId: 'v1', cameraId: 'cam-1', transport: 'rtsps', device: 'dispB', sessionId: 's2' } })).json()

    // g1 (sesión previa s1) quedó REVOCADO por la nueva sesión s2.
    const v1 = await app.inject({ method: 'POST', url: '/api/live-view/internal/media-grant/validate', headers: relayHdr, payload: { grantId: g1.grantId, secret: g1.secret, streamPath: g1.streamPath, transport: 'rtsps' } })
    expect(v1.statusCode).toBe(403); expect(v1.json().reason).toBe('REVOKED')

    // g2 (sesión nueva) sigue válido — el epoch por usuario NO se tocó.
    const v2 = await app.inject({ method: 'POST', url: '/api/live-view/internal/media-grant/validate', headers: relayHdr, payload: { grantId: g2.grantId, secret: g2.secret, streamPath: g2.streamPath, transport: 'rtsps' } })
    expect(v2.statusCode).toBe(200); expect(v2.json().ok).toBe(true)
    await app.close()
  })
})
