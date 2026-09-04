// A1 · F0 — pruebas de RUTA del auth-hook de MediaMTX vía fastify.inject.
// Controlador real + FakeRedis (cross-process atómico). SIN red ni MediaMTX vivo.
// Env fijado antes del import (la ruta lee las flags en import-time).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FakeRedis } from '../services/media/redis-fake'

let mediamtxAuthRoutes: any
let getMgr: any
let reset: () => void

const RELAY_SECRET = 'relaysecret'
const STREAM = 'nvr_nvr1_ch09_main'
const relayHdr = { 'x-media-relay-secret': RELAY_SECRET }

async function buildApp(redis: FakeRedis): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('redis', redis as any)
  reset()
  await app.register(mediamtxAuthRoutes, { prefix: '/internal/mediamtx' })
  await app.ready()
  return app
}

/** Emite un grant de SESIÓN de relay listo para validar (fuente registrada). */
async function seedSession(app: FastifyInstance, over: { userId?: string; cameraId?: string; streamPath?: string } = {}) {
  const mgr = getMgr(app)
  const streamPath = over.streamPath ?? STREAM
  await mgr.registerSource(streamPath)
  const r = await mgr.issueSession({
    userId: over.userId ?? 'userA', viewId: 'v1', cameraId: over.cameraId ?? 'cam-1',
    streamPath, effectiveType: 'main', codec: 'hevc', transport: 'rtsps', device: 'win', ttlMs: 30_000,
  })
  if (!r.ok) throw new Error('seed issueSession failed: ' + r.code)
  return r.issued as { grantId: string; secret: string }
}

const post = (app: FastifyInstance, payload: any, headers: any = relayHdr, remoteAddress = '127.0.0.1') =>
  app.inject({ method: 'POST', url: '/internal/mediamtx/auth', headers, payload, remoteAddress })

beforeAll(async () => {
  process.env.NATIVE_MEDIA_RELAY_ENABLED = 'true'
  process.env.MEDIA_RELAY_SECRET = RELAY_SECRET
  mediamtxAuthRoutes = (await import('./mediamtxAuth')).mediamtxAuthRoutes
  const svc = await import('../services/media/grant-service')
  getMgr = svc.getMediaGrantManager
  reset = svc.__resetMediaGrantManagerForTest
})
beforeEach(() => reset())

describe('POST /internal/mediamtx/auth — allow', () => {
  it('grant de sesión válido + read ⇒ 200 y registra el binding conexión↔grant', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'read', path: STREAM, id: 'reader-1', protocol: 'rtsp' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    const conns = await getMgr(app).listConnectionsForGrant(g.grantId)
    expect(conns.map((b: any) => b.connectionId)).toEqual(['reader-1'])
    await app.close()
  })

  it('re-validación repetida de la MISMA conexión ⇒ sigue 200 (no se consume)', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    const body = { user: g.grantId, password: g.secret, action: 'read', path: STREAM, id: 'reader-1' }
    expect((await post(app, body)).statusCode).toBe(200)
    expect((await post(app, body)).statusCode).toBe(200)
    expect((await post(app, body)).statusCode).toBe(200)
    await app.close()
  })

  it('secreto del grant por query (no password) ⇒ 200', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    const res = await post(app, { action: 'read', path: STREAM, id: 'reader-q', query: `grant=${g.grantId}&secret=${g.secret}` })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('POST /internal/mediamtx/auth — deny (fail-closed)', () => {
  it('flag OFF ⇒ ruta NO registrada ⇒ 404 (idéntico a hoy)', async () => {
    const app = Fastify()
    await app.ready()
    expect((await app.inject({ method: 'POST', url: '/internal/mediamtx/auth', payload: {} })).statusCode).toBe(404)
    await app.close()
  })

  it('flag OFF en el handler (defensa en profundidad) ⇒ 404', async () => {
    vi.resetModules()
    const prev = process.env.NATIVE_MEDIA_RELAY_ENABLED
    process.env.NATIVE_MEDIA_RELAY_ENABLED = 'false'
    const mod = await import('./mediamtxAuth')
    const app = Fastify()
    app.decorate('redis', new FakeRedis() as any)
    await app.register(mod.mediamtxAuthRoutes, { prefix: '/internal/mediamtx' })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/internal/mediamtx/auth', headers: relayHdr, payload: { user: 'g', password: 's', action: 'read', path: STREAM } })
    expect(res.statusCode).toBe(404)
    await app.close()
    process.env.NATIVE_MEDIA_RELAY_ENABLED = prev
    vi.resetModules()
    // re-cargar el módulo con la flag ON para el resto de la suite
    mediamtxAuthRoutes = (await import('./mediamtxAuth')).mediamtxAuthRoutes
    const svc = await import('../services/media/grant-service')
    getMgr = svc.getMediaGrantManager; reset = svc.__resetMediaGrantManagerForTest
  })

  it('MEDIA_RELAY_SECRET incorrecto ⇒ 401', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'read', path: STREAM }, { 'x-media-relay-secret': 'wrong' })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('RELAY_SECRET_INVALID')
    await app.close()
  })

  it('origen no interno ⇒ 403 ORIGIN_NOT_ALLOWED', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'read', path: STREAM }, relayHdr, '8.8.8.8')
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('ORIGIN_NOT_ALLOWED')
    await app.close()
  })

  it('publish ⇒ 403 ACTION_NOT_ALLOWED', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'publish', path: STREAM })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('ACTION_NOT_ALLOWED')
    await app.close()
  })

  it('credenciales de grant ausentes ⇒ 401', async () => {
    const app = await buildApp(new FakeRedis())
    await seedSession(app)
    const res = await post(app, { action: 'read', path: STREAM })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('GRANT_CREDENTIALS_MISSING')
    await app.close()
  })

  it('grant inexistente ⇒ 403 NOT_FOUND', async () => {
    const app = await buildApp(new FakeRedis())
    const res = await post(app, { user: 'mg_nope', password: 'x', action: 'read', path: STREAM })
    expect(res.statusCode).toBe(403)
    expect(res.json().reason).toBe('NOT_FOUND')
    await app.close()
  })

  it('secreto del grant equivocado ⇒ 403 SECRET_MISMATCH', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    const res = await post(app, { user: g.grantId, password: 'deadbeef', action: 'read', path: STREAM })
    expect(res.statusCode).toBe(403)
    expect(res.json().reason).toBe('SECRET_MISMATCH')
    await app.close()
  })

  it('path distinto al del grant ⇒ 403 SCOPE_MISMATCH', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'read', path: 'nvr_nvr1_ch01_sub' })
    expect(res.statusCode).toBe(403)
    expect(res.json().reason).toBe('SCOPE_MISMATCH')
    await app.close()
  })

  it('epoch bump (logout/permiso) ⇒ 403 EPOCH_MISMATCH', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    await getMgr(app).revokeAllForUser('userA')  // incrementa epoch (y marca revocado)
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'read', path: STREAM })
    expect(res.statusCode).toBe(403)
    // revokeAllForUser marca revokedAt además del epoch ⇒ REVOKED gana (chequeo previo).
    expect(['REVOKED', 'EPOCH_MISMATCH']).toContain(res.json().reason)
    await app.close()
  })

  it('grant revocado ⇒ 403 REVOKED', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    await getMgr(app).revoke(g.grantId, 'userA')
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'read', path: STREAM })
    expect(res.statusCode).toBe(403)
    expect(res.json().reason).toBe('REVOKED')
    await app.close()
  })

  it('instancia retirada (fuente recreada/ausente) ⇒ 403 INSTANCE_REQUIRED', async () => {
    const app = await buildApp(new FakeRedis())
    const g = await seedSession(app)
    await getMgr(app).retireSource(STREAM)
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'read', path: STREAM })
    expect(res.statusCode).toBe(403)
    expect(res.json().reason).toBe('INSTANCE_REQUIRED')
    await app.close()
  })

  it('backend no atómico (memoria, sin Redis) ⇒ 503 RELAY_BACKEND_NOT_ATOMIC', async () => {
    const app = Fastify()
    // sin decorate('redis') ⇒ MemoryGrantStore (crossProcessAtomic=false)
    reset()
    await app.register(mediamtxAuthRoutes, { prefix: '/internal/mediamtx' })
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/internal/mediamtx/auth', headers: relayHdr, payload: { user: 'g', password: 's', action: 'read', path: STREAM } })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('RELAY_BACKEND_NOT_ATOMIC')
    await app.close()
  })

  it('backend caído a mitad ⇒ 403 fail-closed (no abre por error)', async () => {
    const redis = new FakeRedis()
    const app = await buildApp(redis)
    const g = await seedSession(app)
    redis.down = true
    const res = await post(app, { user: g.grantId, password: g.secret, action: 'read', path: STREAM })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
