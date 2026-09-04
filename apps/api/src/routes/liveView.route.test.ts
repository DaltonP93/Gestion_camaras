// Coherencia + RBAC de negociación vía fastify.inject (C22.2, P0-3/P0-5).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeRedis } from '../services/media/redis-fake'

let liveViewRoutes: any
let reset: () => void

beforeAll(async () => {
  process.env.NATIVE_PLAYBACK_ENABLED = 'true'
  process.env.NATIVE_MEDIA_RELAY_ENABLED = 'true'
  process.env.MEDIA_RELAY_SECRET = 'relaysecret'
  liveViewRoutes = (await import('./liveView')).liveViewRoutes
  reset = (await import('../services/media/grant-service')).__resetMediaGrantManagerForTest
})
beforeEach(() => reset())

async function build(opts: { user: any; perm?: any; redis: FakeRedis }): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = opts.user })
  app.decorate('authorize', () => async (req: any) => { req.user = opts.user })
  app.decorate('prisma', {
    userPermission: { findFirst: async () => opts.perm ?? null },
    camera: { findUnique: async () => ({ mainCodec: 'HEVC' }) },
  } as any)
  app.decorate('redis', opts.redis as any)
  await app.register(liveViewRoutes, { prefix: '/api/live-view' })
  await app.ready()
  return app
}

const nativePayload = { runtime: 'android', codecs: ['h264', 'hevc'], hardwareDecodedCodecs: ['h264', 'hevc'], transports: ['rtsps'], maxHardwareDecoders: 4, cameraId: 'cam-1', viewId: 'v1' }

describe('POST /client-capabilities (inject)', () => {
  it('P0-3 · admin HEVC + relay listo ⇒ native_hevc y nativeDirect.available=true (coherente)', async () => {
    const app = await build({ user: { sub: 'admin1', role: 'ADMIN' }, redis: new FakeRedis() })
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(body.decision.decision).toBe('native_hevc')
    expect(body.nativeDirect.available).toBe(true)
    expect(body.browserFallback).toBeTruthy()
    await app.close()
  })

  it('P0-3 · nunca combina nativeDirect=false con decisión nativa', async () => {
    const app = await build({ user: { sub: 'admin1', role: 'ADMIN' }, redis: new FakeRedis() })
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    const isNative = body.decision.decision === 'native_hevc' || body.decision.decision === 'native_h264'
    expect(body.nativeDirect.available).toBe(isNative)
    await app.close()
  })

  it('T8 · operador sin canHighQuality ⇒ NO native (coincide con la emisión)', async () => {
    const app = await build({ user: { sub: 'op1', role: 'OPERADOR' }, perm: { canView: true, canHighQuality: false }, redis: new FakeRedis() })
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(body.decision.decision).not.toBe('native_hevc')
    expect(body.nativeDirect.available).toBe(false)
    await app.close()
  })

  it('T7 · Redis caído ⇒ readiness no lista ⇒ NO native', async () => {
    const redis = new FakeRedis(); redis.down = true
    const app = await build({ user: { sub: 'admin1', role: 'ADMIN' }, redis })
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(body.decision.decision).not.toBe('native_hevc')
    expect(body.nativeDirect.available).toBe(false)
    await app.close()
  })
})
