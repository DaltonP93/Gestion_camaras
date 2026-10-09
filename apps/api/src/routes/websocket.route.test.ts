// Integración del handler WS: autenticación por TICKET (no por JWT en la URL).
// Usa app.injectWS de @fastify/websocket (handshake real) con un Redis stub.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { wsHandler, wsClients, revalidateWsConnections } from './websocket'
import { revokeSessionWs, startWsRevokeSubscriber, WS_REVOKE_SESSION_CHANNEL } from '../services/ws-revoke-bus'

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

// Prisma stub del ACTOR VIGENTE: sesiones vivas por usuario activo. `down` simula
// la base caída. Responde a la consulta de loadCurrentActor (users + EXISTS sessions).
function fakePrisma(live: Record<string, string[]> = {}, opts: { down?: boolean } = {}) {
  return {
    live,
    opts,
    user: {
      findFirst: async ({ where }: any) => {
        if (opts.down) throw Object.assign(new Error('base caída'), { code: 'P1001' })
        const sids = live[where?.id] ?? []
        return where?.active === true && sids.includes(where?.sessions?.some?.id) ? { role: 'OPERATOR', username: 'x' } : null
      },
    },
  }
}

async function build(redis: any, prisma: any = fakePrisma({ 'user-42': ['sess-42'], u1: ['sess-1'] })): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('redis', redis)
  app.decorate('prisma', prisma)
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
    const redis = fakeRedis({ [KEY]: JSON.stringify({ u: 'user-42', n: 'carla', s: 'sess-42' }) })
    app = await build(redis)
    const ws = await app.injectWS(`/alerts?ticket=${VALID}`)
    // dar un tick para que el handler registre la conexión
    await new Promise((r) => setTimeout(r, 20))
    expect(wsClients.has('user-42')).toBe(true)
    expect(redis.store.has(KEY)).toBe(false) // consumido (un solo uso)
    ws.terminate?.() ?? ws.close()
  })

  it('el mismo ticket no sirve dos veces (segunda conexión ⇒ 4001)', async () => {
    const redis = fakeRedis({ [KEY]: JSON.stringify({ u: 'u1', n: 'x', s: 'sess-1' }) })
    app = await build(redis)
    const ws1 = await app.injectWS(`/alerts?ticket=${VALID}`)
    await new Promise((r) => setTimeout(r, 20))
    expect(wsClients.has('u1')).toBe(true)

    const ws2 = await app.injectWS(`/alerts?ticket=${VALID}`)
    const code = await closeCode(ws2)
    expect(code).toBe(4001)
    ws1.terminate?.() ?? ws1.close()
  })
  // ── Actor vigente al canjear y en cada ping (CHW-07) ──────────────────────
  it('ticket SIN sesión (emitido antes de ligar el WS a la sesión) ⇒ 4001', async () => {
    app = await build(fakeRedis({ [KEY]: JSON.stringify({ u: 'user-42', n: 'carla' }) }))
    const ws = await app.injectWS(`/alerts?ticket=${VALID}`)
    expect(await closeCode(ws)).toBe(4001)
    expect(wsClients.size).toBe(0)
  })

  it('usuario desactivado o sesión cerrada después de emitir el ticket ⇒ 4003 y no se registra', async () => {
    app = await build(fakeRedis({ [KEY]: JSON.stringify({ u: 'user-42', n: 'carla', s: 'sess-cerrada' }) }))
    const ws = await app.injectWS(`/alerts?ticket=${VALID}`)
    expect(await closeCode(ws)).toBe(4003)
    expect(wsClients.size).toBe(0)
  })

  it('base caída al canjear ⇒ 1011 (el cliente reintenta) y no se registra', async () => {
    app = await build(fakeRedis({ [KEY]: JSON.stringify({ u: 'user-42', n: 'carla', s: 'sess-42' }) }), fakePrisma({}, { down: true }))
    const ws = await app.injectWS(`/alerts?ticket=${VALID}`)
    expect(await closeCode(ws)).toBe(1011)
    expect(wsClients.size).toBe(0)
  })

  it('el PING real (cada 30 s) revalida la conexión: cerrar su sesión ⇒ 4003 en el siguiente ping, sin llamar a ningún helper', async () => {
    // Sólo se simula setInterval (el ping); el resto de los temporizadores son reales.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const prisma = fakePrisma({ 'user-42': ['sess-42'] })
      app = await build(fakeRedis({ [KEY]: JSON.stringify({ u: 'user-42', n: 'carla', s: 'sess-42' }) }), prisma)
      const ws = await app.injectWS(`/alerts?ticket=${VALID}`)
      await new Promise((r) => setTimeout(r, 20))
      expect(wsClients.get('user-42')?.size).toBe(1)
      prisma.live['user-42'] = []                    // se cerró la sesión (p. ej. desde otro dispositivo)
      const closed = closeCode(ws)
      vi.advanceTimersByTime(29_000)
      await new Promise((r) => setTimeout(r, 20))
      expect(wsClients.get('user-42')?.size, 'antes del ping sigue abierta').toBe(1)
      vi.advanceTimersByTime(1_000)                  // ping ⇒ revalidación
      expect(await closed).toBe(4003)
      expect(wsClients.has('user-42')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('revalidación (ping): cierra con 4003 sólo la conexión cuya sesión se cerró; con la base caída no cierra', async () => {
    const prisma = fakePrisma({ 'user-42': ['sess-42'] })
    const k2 = 'ws:ticket:' + `wst_${'b'.repeat(64)}`
    app = await build(fakeRedis({
      [KEY]: JSON.stringify({ u: 'user-42', n: 'carla', s: 'sess-42' }),
      [k2]: JSON.stringify({ u: 'user-42', n: 'carla', s: 'sess-43' }),
    }), prisma)
    prisma.live['user-42'] = ['sess-42', 'sess-43']
    const ws1 = await app.injectWS(`/alerts?ticket=${VALID}`)
    const ws2 = await app.injectWS(`/alerts?ticket=wst_${'b'.repeat(64)}`)
    await new Promise((r) => setTimeout(r, 20))
    expect(wsClients.get('user-42')?.size).toBe(2)
    prisma.opts.down = true
    expect(await revalidateWsConnections(prisma)).toBe(0)
    prisma.opts.down = false
    prisma.live['user-42'] = ['sess-42']          // se cerró la sesión 43
    const closed2 = closeCode(ws2)
    expect(await revalidateWsConnections(prisma)).toBe(1)
    expect(await closed2).toBe(4003)
    await new Promise((r) => setTimeout(r, 20))
    expect(wsClients.get('user-42')?.size).toBe(1)
    ws1.terminate?.() ?? ws1.close()
  })
  it('revocación por SESIÓN (logout de un dispositivo): cierra sólo las conexiones de ese sid, en este proceso y en los demás (bus)', async () => {
    const k2 = 'ws:ticket:' + `wst_${'b'.repeat(64)}`
    app = await build(fakeRedis({
      [KEY]: JSON.stringify({ u: 'user-42', n: 'carla', s: 'sess-42' }),
      [k2]: JSON.stringify({ u: 'user-42', n: 'carla', s: 'sess-43' }),
    }), fakePrisma({ 'user-42': ['sess-42', 'sess-43'] }))
    const ws1 = await app.injectWS(`/alerts?ticket=${VALID}`)
    const ws2 = await app.injectWS(`/alerts?ticket=wst_${'b'.repeat(64)}`)
    await new Promise((r) => setTimeout(r, 20))
    expect(wsClients.get('user-42')?.size).toBe(2)

    // Proceso que atiende el logout: cierre local inmediato + publicación {u, s}.
    const publish = vi.fn().mockResolvedValue(1)
    const closed2 = closeCode(ws2)
    expect(await revokeSessionWs({ redis: { publish }, log: { warn: vi.fn() } } as any, 'user-42', 'sess-43')).toBe(1)
    expect(await closed2).toBe(4003)
    expect(publish).toHaveBeenCalledWith(WS_REVOKE_SESSION_CHANNEL, JSON.stringify({ u: 'user-42', s: 'sess-43' }))
    expect(wsClients.get('user-42')?.size, 'la otra sesión sigue conectada').toBe(1)

    // Otro proceso: el suscriptor cierra sólo la sesión indicada; ignora basura.
    let onMessage: ((ch: string, msg: string) => void) | null = null
    const sub = { on: (ev: string, cb: any) => { if (ev === 'message') onMessage = cb }, subscribe: vi.fn().mockResolvedValue(1), quit: vi.fn() }
    startWsRevokeSubscriber({ redis: { duplicate: () => sub }, log: { warn: vi.fn(), info: vi.fn() }, addHook: vi.fn() } as any)
    expect(sub.subscribe).toHaveBeenCalledWith(WS_REVOKE_SESSION_CHANNEL)
    onMessage!(WS_REVOKE_SESSION_CHANNEL, JSON.stringify({ u: 'user-42', s: 'otra-sesion' }))
    onMessage!(WS_REVOKE_SESSION_CHANNEL, 'no-es-json')
    await new Promise((r) => setTimeout(r, 20))
    expect(wsClients.get('user-42')?.size).toBe(1)
    const closed1 = closeCode(ws1)
    onMessage!(WS_REVOKE_SESSION_CHANNEL, JSON.stringify({ u: 'user-42', s: 'sess-42' }))
    expect(await closed1).toBe(4003)
    expect(wsClients.has('user-42')).toBe(false)
  })
})
