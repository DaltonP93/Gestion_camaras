// Tests del cierre de sesiones con keepalive (PR A1).
//
// Lo que importa verificar: que se use DELETE con keepalive, que el token vaya
// en el encabezado Authorization (y no en la URL), y que un fallo jamás lance
// —romper el desmontaje de un componente o un handler de `pagehide` sería peor
// que perder el cierre, porque el TTL del servidor cubre ese caso.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { closeWithKeepalive, closeStreamSession, closeViewSessions } from './sessionClose'

const fetchMock = vi.fn()

// El proyecto corre vitest en entorno node: se provee un Storage mínimo en vez
// de arrastrar jsdom sólo para dos getters.
function makeStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  }
}
let localStorage: ReturnType<typeof makeStorage>
let sessionStorage: ReturnType<typeof makeStorage>

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
  localStorage = makeStorage()
  sessionStorage = makeStorage()
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('sessionStorage', sessionStorage)
  localStorage.setItem('accessToken', 'tok-abc')
})

afterEach(() => vi.unstubAllGlobals())

describe('closeWithKeepalive', () => {
  it('emite DELETE con keepalive y el token en Authorization', async () => {
    const ok = await closeWithKeepalive('/cameras/cam1/stream?streamType=sub')

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/cameras/cam1/stream?streamType=sub')
    expect(init.method).toBe('DELETE')
    expect(init.keepalive).toBe(true)
    expect(init.headers.Authorization).toBe('Bearer tok-abc')
  })

  it('nunca pone el token en la URL', async () => {
    await closeWithKeepalive('/cameras/cam1/stream')
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).not.toContain('tok-abc')
  })

  it('acepta el token desde sessionStorage', async () => {
    localStorage.clear()
    sessionStorage.setItem('accessToken', 'tok-session')
    await closeWithKeepalive('/cameras/cam1/stream')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-session')
  })

  it('sin token no emite la petición (evita un 401 inútil al descargar)', async () => {
    localStorage.clear()
    const ok = await closeWithKeepalive('/cameras/cam1/stream')
    expect(ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('un fetch que rechaza NO lanza: devuelve false', async () => {
    fetchMock.mockRejectedValue(new Error('network down during unload'))
    await expect(closeWithKeepalive('/cameras/cam1/stream')).resolves.toBe(false)
  })

  it('no reintenta: una sola emisión por llamada', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    await closeWithKeepalive('/cameras/cam1/stream')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('closeStreamSession', () => {
  it('arma la ruta con streamType y reason', async () => {
    await closeStreamSession('cam9', 'main_h264', 'exit_focus', 'vp_1')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/cameras/cam9/stream?')
    expect(url).toContain('streamType=main_h264')
    expect(url).toContain('reason=exit_focus')
  })

  it('escapa identificadores con caracteres especiales', async () => {
    await closeStreamSession('cam/../admin', 'sub', 'cleanup_unmount', 'vp_1')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('cam%2F..%2Fadmin')
    expect(url).not.toContain('/cam/../admin/')
  })

  it('llamarla dos veces emite dos DELETE idempotentes (el servidor tolera el segundo)', async () => {
    await closeStreamSession('cam1', 'sub', 'cleanup_unmount', 'vp_1')
    await closeStreamSession('cam1', 'sub', 'layout_change', 'vp_1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'DELETE')).toBe(true)
  })
})

describe('closeViewSessions', () => {
  it('cierra todas las sesiones del view por viewId', async () => {
    await closeViewSessions('tab-123')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/cameras/my-sessions?viewId=tab-123')
    expect(init.method).toBe('DELETE')
    expect(init.keepalive).toBe(true)
  })
})
