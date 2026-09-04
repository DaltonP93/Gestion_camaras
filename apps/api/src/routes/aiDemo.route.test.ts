// Pruebas de RUTA de la demo de IA vía fastify.inject (C22.1, P0-5). Verifican
// aislamiento (ADMIN-only), filtro por cámara y flag OFF ⇒ inexistente.
import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

let aiDemoRoutes: any

function appWith(): FastifyInstance {
  const app = Fastify()
  // authorize stub: fija req.user desde un header y 403 si el rol no está permitido.
  app.decorate('authorize', (roles: string[]) => async (req: any, reply: any) => {
    const role = (req.headers['x-test-role'] as string) || 'ADMIN'
    req.user = { sub: 'u1', role }
    if (!roles.includes(role)) return reply.status(403).send({ code: 'Forbidden' })
  })
  return app
}

beforeAll(async () => {
  process.env.AI_EVENTS_ENABLED = 'true'
  aiDemoRoutes = (await import('./aiDemo')).aiDemoRoutes
})

async function build(): Promise<FastifyInstance> {
  const app = appWith()
  await app.register(aiDemoRoutes, { prefix: '/api/ai' })
  await app.ready()
  return app
}

const ev = (cameraId: string) => ({ cameraId, type: 'person', className: 'person', confidence: 0.9 })

describe('rutas demo de IA (inject)', () => {
  it('ADMIN puede publicar y leer eventos demo (source=demo)', async () => {
    const app = await build()
    const post = await app.inject({ method: 'POST', url: '/api/ai/demo/event', headers: { 'x-test-role': 'ADMIN' }, payload: ev('cam-1') })
    expect(post.statusCode).toBe(200)
    expect(post.json().event.source).toBe('demo')
    const get = await app.inject({ method: 'GET', url: '/api/ai/demo/recent', headers: { 'x-test-role': 'ADMIN' } })
    expect(get.statusCode).toBe(200)
    expect(get.json().events.length).toBe(1)
    await app.close()
  })

  it('P0-5 · un NO-admin no puede leer eventos demo (403)', async () => {
    const app = await build()
    await app.inject({ method: 'POST', url: '/api/ai/demo/event', headers: { 'x-test-role': 'ADMIN' }, payload: ev('cam-1') })
    const get = await app.inject({ method: 'GET', url: '/api/ai/demo/recent', headers: { 'x-test-role': 'OPERADOR' } })
    expect(get.statusCode).toBe(403)
    await app.close()
  })

  it('GET filtra por cameraId', async () => {
    const app = await build()
    await app.inject({ method: 'POST', url: '/api/ai/demo/event', headers: { 'x-test-role': 'ADMIN' }, payload: ev('cam-1') })
    await app.inject({ method: 'POST', url: '/api/ai/demo/event', headers: { 'x-test-role': 'ADMIN' }, payload: ev('cam-2') })
    const get = await app.inject({ method: 'GET', url: '/api/ai/demo/recent?cameraId=cam-2', headers: { 'x-test-role': 'ADMIN' } })
    const events = get.json().events
    expect(events.length).toBe(1)
    expect(events[0].cameraId).toBe('cam-2')
    await app.close()
  })

  it('flag OFF ⇒ ruta inexistente (404)', async () => {
    const app = appWith()
    await app.ready() // sin registrar la ruta
    const res = await app.inject({ method: 'GET', url: '/api/ai/demo/recent', headers: { 'x-test-role': 'ADMIN' } })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
