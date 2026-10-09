// Recuperación del cliente cuando el API rechaza un access emitido ANTES de ligar el
// access a su sesión (`sid`, revocación efectiva): el servidor responde 401 y el web
// renueva por cookie (/auth/refresh) SIN cerrar la sesión del usuario.
//
// Se ejercita el código REAL de src/lib/api.ts (interceptor + mutex de refresh) y de
// src/lib/websocket.ts (ticket del WS, que no pasa por axios) contra un servidor
// simulado con el contrato del API: access viejo ⇒ 401; refresh por cookie ⇒ 200 y
// cookie nueva. El contrato del lado del API lo prueba, con el server.ts real,
// apps/api/src/security-joint/revocation-effective.joint.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'

// Los toasts no forman parte de lo que se prueba (y en node no hay `document`).
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

const ORIGIN = 'https://vms.example.test'

/** "Navegador + servidor": la cookie de acceso y lo que responde cada ruta. */
const server = {
  access: 'legacy' as 'legacy' | 'fresh' | null,
  refreshWorks: true,
  calls: [] as string[],
}

function pathOf(url: string): string {
  return url.startsWith('http') ? new URL(url).pathname : url
}

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const url = pathOf(`${config.url?.startsWith('http') ? '' : (config.baseURL ?? '')}${config.url ?? ''}`)
  server.calls.push(`${(config.method ?? 'get').toUpperCase()} ${url}`)
  const respond = (status: number, data: unknown) => {
    const response = { status, statusText: '', headers: {}, config, data }
    if (status >= 200 && status < 300) return response
    throw new AxiosError(`HTTP ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response as any)
  }
  if (url === '/api/auth/refresh') {
    if (!server.refreshWorks) return respond(401, { message: 'Refresh token inválido o expirado' })
    server.access = 'fresh'
    return respond(200, { ok: true })
  }
  if (server.access !== 'fresh') return respond(401, { message: 'Token inválido o expirado' })
  return respond(200, { id: 'u1', role: 'OPERATOR' })
}

const fetchStub = vi.fn(async (input: string | URL) => {
  const url = pathOf(String(input))
  server.calls.push(`FETCH ${url}`)
  if (url === '/api/auth/ws-ticket' && server.access === 'fresh') {
    return new Response(JSON.stringify({ ticket: `wst_${'a'.repeat(64)}` }), { status: 200 })
  }
  return new Response(JSON.stringify({ message: 'Token inválido o expirado' }), { status: 401 })
})

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  send() { /* noop */ }
  close() { this.readyState = 3 }
}

const dispatchEvent = vi.fn()

beforeEach(() => {
  vi.resetModules()
  server.access = 'legacy'
  server.refreshWorks = true
  server.calls = []
  FakeWebSocket.instances = []
  dispatchEvent.mockClear()
  fetchStub.mockClear()
  vi.stubGlobal('window', { location: { origin: ORIGIN }, dispatchEvent })
  vi.stubGlobal('fetch', fetchStub)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  axios.defaults.adapter = adapter
})

afterEach(async () => {
  const ws = await import('./websocket')
  ws.disconnectWebSocket()
  vi.unstubAllGlobals()
})

describe('access previo al cambio (sin sid) ⇒ 401 ⇒ el web renueva y sigue', () => {
  it('interceptor de axios: /auth/me 401 ⇒ POST /auth/refresh ⇒ reintento 200; no dispara auth-expired', async () => {
    const { api } = await import('./api')
    api.defaults.adapter = adapter
    const res = await api.get('/auth/me')
    expect(res.status).toBe(200)
    expect(server.calls).toEqual(['GET /api/auth/me', 'POST /api/auth/refresh', 'GET /api/auth/me'])
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('ticket del WS (fetch, fuera de axios): 401 ⇒ refresh por cookie ⇒ nuevo ticket ⇒ abre el WS', async () => {
    const { connectWebSocket } = await import('./websocket')
    await connectWebSocket()
    expect(server.calls).toEqual(['FETCH /api/auth/ws-ticket', 'POST /api/auth/refresh', 'FETCH /api/auth/ws-ticket'])
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toBe(`wss://vms.example.test/ws/alerts?ticket=wst_${'a'.repeat(64)}`)
  })

  it('sin sesión renovable (refresh 401): no abre el WS ni reintenta en bucle', async () => {
    vi.useFakeTimers()
    try {
      server.refreshWorks = false
      const { connectWebSocket } = await import('./websocket')
      await connectWebSocket()
      expect(server.calls).toEqual(['FETCH /api/auth/ws-ticket', 'POST /api/auth/refresh'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchStub).toHaveBeenCalledTimes(1)
      expect(FakeWebSocket.instances).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('con el access ya vigente no hay refresh de más', async () => {
    server.access = 'fresh'
    const { connectWebSocket } = await import('./websocket')
    await connectWebSocket()
    expect(server.calls).toEqual(['FETCH /api/auth/ws-ticket'])
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
