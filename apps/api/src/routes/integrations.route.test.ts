// Pruebas de RUTA del estado de integraciones vía fastify.inject. Verifican que
// la ruta reporta las flags correctamente (ON/OFF), que requiere autenticación,
// y que NO filtra ninguna otra variable de entorno.
import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { integrationsRoutes } from './integrations'

const savedOnvif = process.env.ONVIF_ENABLED
const savedHik = process.env.HIK_CONNECT_ENABLED

afterEach(() => {
  if (savedOnvif === undefined) delete process.env.ONVIF_ENABLED
  else process.env.ONVIF_ENABLED = savedOnvif
  if (savedHik === undefined) delete process.env.HIK_CONNECT_ENABLED
  else process.env.HIK_CONNECT_ENABLED = savedHik
})

async function build(opts: { authOk?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify()
  // authenticate stub: 401 si authOk === false, si no deja pasar.
  app.decorate('authenticate', async (_req: any, reply: any) => {
    if (opts.authOk === false) return reply.status(401).send({ message: 'no auth' })
  })
  await app.register(integrationsRoutes, { prefix: '/api/integrations' })
  await app.ready()
  return app
}

describe('GET /api/integrations/status', () => {
  it('reporta ambas flags en OFF (default)', async () => {
    delete process.env.ONVIF_ENABLED
    delete process.env.HIK_CONNECT_ENABLED
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/integrations/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ onvif: { enabled: false }, hikConnect: { enabled: false } })
    await app.close()
  })

  it('reporta las flags en ON cuando ONVIF_ENABLED/HIK_CONNECT_ENABLED=true', async () => {
    process.env.ONVIF_ENABLED = 'true'
    process.env.HIK_CONNECT_ENABLED = 'true'
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/integrations/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ onvif: { enabled: true }, hikConnect: { enabled: true } })
    await app.close()
  })

  it('sólo expone los campos onvif/hikConnect (no filtra otras env)', async () => {
    process.env.ONVIF_ENABLED = 'true'
    delete process.env.HIK_CONNECT_ENABLED
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/integrations/status' })
    expect(Object.keys(res.json()).sort()).toEqual(['hikConnect', 'onvif'])
    expect(res.json()).toEqual({ onvif: { enabled: true }, hikConnect: { enabled: false } })
    await app.close()
  })

  it('requiere autenticación (401 sin token)', async () => {
    const app = await build({ authOk: false })
    const res = await app.inject({ method: 'GET', url: '/api/integrations/status' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
