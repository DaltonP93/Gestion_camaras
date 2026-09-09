import { describe, it, expect, beforeEach, vi } from 'vitest'
import { wsClients, closeUserConnections } from '../routes/websocket'
import { revokeUserWs, startWsRevokeSubscriber, WS_REVOKE_CHANNEL } from './ws-revoke-bus'

// Socket falso con la interfaz mínima que usa closeUserConnections.
function fakeSocket() {
  return { readyState: 1, closed: null as null | { code: number; reason: string }, send() {}, close(code: number, reason: string) { this.closed = { code, reason } } }
}
function seed(userId: string, n = 2) {
  const socks = Array.from({ length: n }, fakeSocket)
  wsClients.set(userId, new Set(socks as any))
  return socks
}

beforeEach(() => wsClients.clear())

describe('closeUserConnections', () => {
  it('cierra todos los sockets del usuario (code 4003) y borra la entrada', () => {
    const socks = seed('u1', 3)
    const n = closeUserConnections('u1')
    expect(n).toBe(3)
    expect(socks.every((s) => s.closed?.code === 4003)).toBe(true)
    expect(wsClients.has('u1')).toBe(false)
  })
  it('usuario sin conexiones ⇒ 0, no lanza', () => {
    expect(closeUserConnections('nadie')).toBe(0)
  })
  it('no afecta a otros usuarios', () => {
    seed('u1'); const other = seed('u2')
    closeUserConnections('u1')
    expect(wsClients.has('u2')).toBe(true)
    expect(other.every((s) => s.closed === null)).toBe(true)
  })
})

describe('revokeUserWs', () => {
  it('cierra localmente Y publica el userId en Redis', async () => {
    const socks = seed('u1', 2)
    const publish = vi.fn().mockResolvedValue(1)
    const server: any = { redis: { publish }, log: { warn: vi.fn() } }
    const n = await revokeUserWs(server, 'u1')
    expect(n).toBe(2)
    expect(socks.every((s) => s.closed?.code === 4003)).toBe(true)
    expect(publish).toHaveBeenCalledWith(WS_REVOKE_CHANNEL, 'u1')
  })
  it('si el publish falla, igual cerró local y NO lanza', async () => {
    seed('u1', 1)
    const server: any = { redis: { publish: vi.fn().mockRejectedValue(new Error('down')) }, log: { warn: vi.fn() } }
    await expect(revokeUserWs(server, 'u1')).resolves.toBe(1)
    expect(server.log.warn).toHaveBeenCalled()
  })
  it('sin redis: cierra local, no lanza', async () => {
    seed('u1', 1)
    const server: any = { log: { warn: vi.fn() } }
    await expect(revokeUserWs(server, 'u1')).resolves.toBe(1)
  })
})

describe('startWsRevokeSubscriber', () => {
  it('sin redis ⇒ null (cierre sólo local) y avisa', () => {
    const server: any = { log: { warn: vi.fn() }, addHook: vi.fn() }
    expect(startWsRevokeSubscriber(server)).toBeNull()
    expect(server.log.warn).toHaveBeenCalled()
  })

  it('al recibir un userId por el canal, cierra sus WS en este proceso', () => {
    let onMessage: ((ch: string, msg: string) => void) | null = null
    const sub = {
      on: (ev: string, cb: any) => { if (ev === 'message') onMessage = cb },
      subscribe: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue(undefined),
    }
    const server: any = { redis: { duplicate: () => sub }, log: { warn: vi.fn(), info: vi.fn() }, addHook: vi.fn() }
    const ret = startWsRevokeSubscriber(server)
    expect(ret).toBe(sub)
    expect(sub.subscribe).toHaveBeenCalledWith(WS_REVOKE_CHANNEL)
    expect(server.addHook).toHaveBeenCalledWith('onClose', expect.any(Function))

    const socks = seed('u9', 2)
    onMessage!(WS_REVOKE_CHANNEL, 'u9')
    expect(socks.every((s) => s.closed?.code === 4003)).toBe(true)
    expect(wsClients.has('u9')).toBe(false)

    // Mensaje en otro canal ⇒ ignorado.
    const other = seed('u10', 1)
    onMessage!('otro-canal', 'u10')
    expect(other[0].closed).toBeNull()
  })
})
