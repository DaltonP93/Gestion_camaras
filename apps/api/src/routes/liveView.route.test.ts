// Coherencia + RBAC de negociación vía fastify.inject (C22.2, P0-3/P0-5).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeRedis } from '../services/media/redis-fake'

let liveViewRoutes: any
let reset: () => void
let getMgr: any

// Cámara HEVC completa (con NVR y canal): la derivación compartida deriva el
// streamPath exacto para comprobar la readiness por PATH (mediaInstanceId).
const CAM_HEVC = { id: 'cam-1', channel: 9, mainCodec: 'HEVC', subCodec: 'H264', nvr: { id: 'nvr1' } }
const STREAM_MAIN = `nvr_${CAM_HEVC.nvr.id}_ch${String(CAM_HEVC.channel).padStart(2, '0')}_main`

beforeAll(async () => {
  process.env.NATIVE_PLAYBACK_ENABLED = 'true'
  process.env.NATIVE_MEDIA_RELAY_ENABLED = 'true'
  process.env.MEDIA_RELAY_SECRET = 'relaysecret'
  liveViewRoutes = (await import('./liveView')).liveViewRoutes
  const svc = await import('../services/media/grant-service')
  reset = svc.__resetMediaGrantManagerForTest
  getMgr = svc.getMediaGrantManager
})
beforeEach(() => reset())

async function build(opts: { user: any; perm?: any; redis: FakeRedis; camera?: any }): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = opts.user })
  app.decorate('authorize', () => async (req: any) => { req.user = opts.user })
  app.decorate('prisma', {
    userPermission: { findFirst: async () => opts.perm ?? null },
    camera: { findUnique: async () => (opts.camera === undefined ? CAM_HEVC : opts.camera) },
  } as any)
  app.decorate('redis', opts.redis as any)
  await app.register(liveViewRoutes, { prefix: '/api/live-view' })
  await app.ready()
  return app
}

const nativePayload = { runtime: 'android', codecs: ['h264', 'hevc'], hardwareDecodedCodecs: ['h264', 'hevc'], transports: ['rtsps'], maxHardwareDecoders: 4, cameraId: 'cam-1', viewId: 'v1' }

describe('POST /client-capabilities (inject)', () => {
  it('P0-3 · admin HEVC + relay listo + fuente registrada ⇒ native_hevc y nativeDirect.available=true', async () => {
    const app = await build({ user: { sub: 'admin1', role: 'ADMIN' }, redis: new FakeRedis() })
    await getMgr(app).registerSource(STREAM_MAIN)
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(body.decision.decision).toBe('native_hevc')
    expect(body.nativeDirect.available).toBe(true)
    expect(body.browserFallback).toBeTruthy()
    await app.close()
  })

  it('P3 · misma cámara SIN fuente vigente ⇒ NO native (fallback) con motivo NO_MEDIA_INSTANCE', async () => {
    // La emisión respondería NO_MEDIA_INSTANCE; la negociación NO puede ofrecer nativo.
    const app = await build({ user: { sub: 'admin1', role: 'ADMIN' }, redis: new FakeRedis() })
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(body.decision.decision).not.toBe('native_hevc')
    expect(body.decision.decision).not.toBe('native_h264')
    expect(body.decision.nativeBlockedReason).toBe('NO_MEDIA_INSTANCE')
    expect(body.nativeDirect.available).toBe(false)
    await app.close()
  })

  it('P3 · readiness por path: registrar la fuente FLIPEA la decisión a nativa', async () => {
    const app = await build({ user: { sub: 'admin1', role: 'ADMIN' }, redis: new FakeRedis() })
    const before = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(before.decision.decision).not.toBe('native_hevc')
    await getMgr(app).registerSource(STREAM_MAIN)
    const after = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(after.decision.decision).toBe('native_hevc')
    await app.close()
  })

  it('P0-3 · nunca combina nativeDirect=false con decisión nativa', async () => {
    const app = await build({ user: { sub: 'admin1', role: 'ADMIN' }, redis: new FakeRedis() })
    await getMgr(app).registerSource(STREAM_MAIN)
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    const isNative = body.decision.decision === 'native_hevc' || body.decision.decision === 'native_h264'
    expect(body.nativeDirect.available).toBe(isNative)
    await app.close()
  })

  it('T8 · operador sin canHighQuality ⇒ NO native (coincide con la emisión)', async () => {
    const app = await build({ user: { sub: 'op1', role: 'OPERADOR' }, perm: { canView: true, canHighQuality: false }, redis: new FakeRedis() })
    await getMgr(app).registerSource(STREAM_MAIN)
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(body.decision.decision).not.toBe('native_hevc')
    expect(body.decision.nativeBlockedReason).toBe('HD_PERMISSION_MISSING')
    expect(body.nativeDirect.available).toBe(false)
    await app.close()
  })

  it('T7 · Redis caído ⇒ readiness no lista ⇒ NO native (motivo RELAY_BACKEND_NOT_READY)', async () => {
    const redis = new FakeRedis(); redis.down = true
    const app = await build({ user: { sub: 'admin1', role: 'ADMIN' }, redis })
    const body = (await app.inject({ method: 'POST', url: '/api/live-view/client-capabilities', payload: nativePayload })).json()
    expect(body.decision.decision).not.toBe('native_hevc')
    expect(body.nativeDirect.available).toBe(false)
    // El bloqueo es por READINESS (evaluada ANTES que la instancia por path): si la
    // readiness ignorara la salud del backend, el motivo cambiaría ⇒ este assert
    // mantiene CAZADA la mutación M8 (backendHealthy forzado a true).
    expect(body.decision.nativeBlockedReason).toBe('RELAY_BACKEND_NOT_READY')
    await app.close()
  })
})
