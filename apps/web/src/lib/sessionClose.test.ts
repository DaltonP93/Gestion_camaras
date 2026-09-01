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

    expect(ok).toMatchObject({ emitted: true })
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
    expect(ok).toEqual({ emitted: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('un fetch que rechaza NO lanza: informa que no se emitió', async () => {
    fetchMock.mockRejectedValue(new Error('network down during unload'))
    await expect(closeWithKeepalive('/cameras/cam1/stream'))
      .resolves.toEqual({ emitted: false })
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

  it('envía la capability de retención en JSON, nunca en la URL', async () => {
    await closeStreamSession(
      'cam1', 'main_h264', 'page_change', 'vp_1', 'sa-A', 'ret-secreto',
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).not.toContain('ret-secreto')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ retentionToken: 'ret-secreto' })
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

// ─── El desenlace lo declara el SERVIDOR ─────────────────────────────────────
//
// `emitted` sólo dice que la petición salió. Tratarlo como confirmación de
// cierre era el defecto: un 401, un 500 o un `ignored` salen igual de emitidos,
// y el cliente borraba su anotación de una sesión que seguía viva.

describe('lectura del desenlace', () => {
  const conCuerpo = (body: any, status = 200) => {
    fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body })
  }

  it('un 200 con `session_closed` se informa tal cual', async () => {
    conCuerpo({ ok: true, outcome: 'session_closed', attemptId: 'sa-A-1' })

    await expect(closeWithKeepalive('/x')).resolves.toEqual({
      emitted: true, status: 200, outcome: 'session_closed',
      attemptId: 'sa-A-1', remainingAttempts: undefined,
    })
  })

  it('un `attempt_released` conserva cuántos arrendamientos quedan', async () => {
    conCuerpo({ ok: true, outcome: 'attempt_released', attemptId: 'sa-A-1', remainingAttempts: 2 })

    await expect(closeWithKeepalive('/x')).resolves.toMatchObject({
      outcome: 'attempt_released', attemptId: 'sa-A-1', remainingAttempts: 2,
    })
  })

  it('un `ignored` NO es un cierre', async () => {
    conCuerpo({ ok: true, outcome: 'ignored' })

    await expect(closeWithKeepalive('/x')).resolves.toMatchObject({ outcome: 'ignored' })
  })

  it.each([401, 403, 500, 502])('un %i sale emitido pero SIN desenlace', async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ outcome: 'session_closed' }) })

    // Ni siquiera se lee el cuerpo: un error HTTP no cerró nada, y aceptar un
    // `outcome` de una respuesta de error sería creerle a la página de error.
    await expect(closeWithKeepalive('/x')).resolves.toEqual({ emitted: true, status })
  })

  it('un cuerpo ilegible —la página se está descargando— tampoco confirma', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new Error('sin cuerpo') },
    })

    await expect(closeWithKeepalive('/x')).resolves.toEqual({ emitted: true, status: 200 })
  })

  it('un `outcome` desconocido se descarta en vez de aceptarse a ciegas', async () => {
    conCuerpo({ ok: true, outcome: 'lo-que-sea' })

    await expect(closeWithKeepalive('/x')).resolves.toMatchObject({ outcome: undefined })
  })

  it('closeStreamSession propaga el desenlace y manda el intento en la query', async () => {
    conCuerpo({ ok: true, outcome: 'attempt_released', attemptId: 'sa-A-1', remainingAttempts: 1 })

    const r = await closeStreamSession('cam1', 'main_h264', 'stale_response', 'v1', 'sa-A-1')

    expect(r).toMatchObject({ outcome: 'attempt_released', attemptId: 'sa-A-1' })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('expectedStartAttemptId=sa-A-1')
    expect(url).toContain('reason=stale_response')
  })
})
