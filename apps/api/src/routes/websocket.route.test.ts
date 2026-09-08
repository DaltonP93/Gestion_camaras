// Integración del handler WS: autenticación por TICKET (no por JWT en la URL).
// Usa app.injectWS de @fastify/websocket (handshake real) con un Redis stub.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { wsHandler, wsClients } from './websocket'

// Redis stub con getdel atómico sobre un Map (un solo uso real).
function fakeRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    store,
    async getdel(key: string) { const v = store.get(key) ?? null; store.delete(key); return v },
    async get(key: string) { return store.get(key) ?? null },
    async del(key: string) { return store.delete(key) ? 1 : 0 },
    async set() { return 'OK' },
  }
}

async function build(redis: any): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('redis', redis)
  await app.register(websocket)
  await app.register(wsHandler)
  await app.ready()
  return app
}

const VALID = `wst_${'a'.repeat(64)}`
const KEY = 'ws:ticket:' + VALID

/** Espera el primer evento close y devuelve su código. */
function closeCode(ws: any): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code: number) => resolve(code)))
}

describe('WS /ws/alerts — auth por ticket', () => {
  let app: FastifyInstance
  beforeEach(() => { wsClients.clear() })
  afterEach(async () => { if (app) await app.close(); wsClients.clear() })

  it('sin ticket ⇒ cierra 4001 y no registra cliente', async () => {
    app = await build(fakeRedis())
    const ws = await app.injectWS('/alerts')
    const code = await closeCode(ws)
    expect(code).toBe(4001)
    expect(wsClients.size).toBe(0)
  })

  it('ticket inválido/inexistente ⇒ cierra 4001', async () => {
    app = await build(fakeRedis())
    const ws = await app.injectWS(`/alerts?ticket=${VALID}`)
    const code = await closeCode(ws)
    expect(code).toBe(4001)
    expect(wsClients.size).toBe(0)
  })

  it('ticket válido ⇒ conecta y registra el userId; el ticket queda consumido', async () => {
    const redis = fakeRedis({ [KEY]: JSON.stringify({ u: 'user-42', n: 'carla' }) })
    app = await build(redis)
    const ws = await app.injectWS(`/alerts?ticket=${VALID}`)
    // dar un tick para que el handler registre la conexión
    await new Promise((r) => setTimeout(r, 20))
    expect(wsClients.has('user-42')).toBe(true)
    expect(redis.store.has(KEY)).toBe(false) // consumido (un solo uso)
    ws.terminate?.() ?? ws.close()
  })

  it('el mismo ticket no sirve dos veces (segunda conexión ⇒ 4001)', async () => {
    const redis = fakeRedis({ [KEY]: JSON.stringify({ u: 'u1', n: 'x' }) })
    app = await build(redis)
    const ws1 = await app.injectWS(`/alerts?ticket=${VALID}`)
    await new Promise((r) => setTimeout(r, 20))
    expect(wsClients.has('u1')).toBe(true)

    const ws2 = await app.injectWS(`/alerts?ticket=${VALID}`)
    const code = await closeCode(ws2)
    expect(code).toBe(4001)
    ws1.terminate?.() ?? ws1.close()
  })
})
