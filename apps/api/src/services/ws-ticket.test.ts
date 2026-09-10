import { describe, it, expect, beforeEach } from 'vitest'
import { issueWsTicket, consumeWsTicket, WS_TICKET_TTL_MS, type WsTicketRedis } from './ws-ticket'

// Fake Redis mínimo con soporte de PX/NX y getdel atómico.
function makeFakeRedis(): WsTicketRedis & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    async set(key, val, _mode, _ttlMs, _nx) {
      if (store.has(key)) return null // NX
      store.set(key, val)
      return 'OK'
    },
    async getdel(key) {
      const v = store.get(key) ?? null
      store.delete(key)
      return v
    },
    async get(key) { return store.get(key) ?? null },
    async del(key) { return store.delete(key) ? 1 : 0 },
  }
}

describe('ws-ticket', () => {
  let redis: ReturnType<typeof makeFakeRedis>
  beforeEach(() => { redis = makeFakeRedis() })

  it('emite un ticket con formato opaco (wst_ + 64 hex) y NO contiene el userId', async () => {
    const t = await issueWsTicket(redis, { userId: 'user-123', username: 'alice' })
    expect(t).toMatch(/^wst_[0-9a-f]{64}$/)
    expect(t).not.toContain('user-123')
    expect(t).not.toContain('alice')
  })

  it('canjea el ticket una sola vez (segundo canje ⇒ null)', async () => {
    const t = await issueWsTicket(redis, { userId: 'u1', username: 'bob' })
    const first = await consumeWsTicket(redis, t)
    expect(first).toEqual({ userId: 'u1', username: 'bob' })
    const second = await consumeWsTicket(redis, t)
    expect(second).toBeNull()
  })

  it('rechaza formato inválido SIN tocar Redis', async () => {
    let touched = false
    const spy: WsTicketRedis = {
      set: async () => { touched = true; return 'OK' },
      get: async () => { touched = true; return null },
      del: async () => { touched = true; return 0 },
      getdel: async () => { touched = true; return null },
    }
    for (const bad of ['', 'token', 'wst_zzz', 'wst_' + 'a'.repeat(63), '../../etc', 'wst_' + 'A'.repeat(64)]) {
      expect(await consumeWsTicket(spy, bad)).toBeNull()
    }
    expect(await consumeWsTicket(spy, 12345 as any)).toBeNull()
    expect(touched).toBe(false)
  })

  it('ticket inexistente/expirado ⇒ null', async () => {
    const fake = `wst_${'a'.repeat(64)}`
    expect(await consumeWsTicket(redis, fake)).toBeNull()
  })

  it('fail-closed: si Redis lanza, devuelve null (no autentica)', async () => {
    const throwing: WsTicketRedis = {
      set: async () => 'OK',
      get: async () => { throw new Error('down') },
      del: async () => 0,
      getdel: async () => { throw new Error('down') },
    }
    expect(await consumeWsTicket(throwing, `wst_${'b'.repeat(64)}`)).toBeNull()
  })

  it('JSON corrupto en el valor ⇒ null', async () => {
    const t = await issueWsTicket(redis, { userId: 'u', username: 'x' })
    redis.store.set('ws:ticket:' + t, '{no-json')
    expect(await consumeWsTicket(redis, t)).toBeNull()
  })

  it('usa el fallback get+del cuando no hay getdel (sigue siendo un solo uso)', async () => {
    const noGetdel: WsTicketRedis & { store: Map<string, string> } = { ...makeFakeRedis() }
    delete (noGetdel as any).getdel
    const t = await issueWsTicket(noGetdel, { userId: 'u9', username: 'z' })
    expect(await consumeWsTicket(noGetdel, t)).toEqual({ userId: 'u9', username: 'z' })
    expect(await consumeWsTicket(noGetdel, t)).toBeNull()
  })

  it('el TTL es corto (segundos), no minutos/horas', () => {
    expect(WS_TICKET_TTL_MS).toBeLessThanOrEqual(60_000)
  })
})
