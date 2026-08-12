// Tests de la revisión de #146 en el frontend: el cierre debe declarar SIEMPRE
// la pestaña dueña, y el TTL de HD debe venir del backend, no suponerse.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { closeStreamSession, closeViewSessions } from './sessionClose'
import { resolveHdSessionTtlMs } from './hdSessionTtl'

const fetchMock = vi.fn()

function makeStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
  const ls = makeStorage()
  vi.stubGlobal('localStorage', ls)
  vi.stubGlobal('sessionStorage', makeStorage())
  ls.setItem('accessToken', 'tok-abc')
})

afterEach(() => vi.unstubAllGlobals())

describe('(1) el cierre declara la pestaña dueña', () => {
  it('closeStreamSession incluye viewId cuando se le pasa', async () => {
    await closeStreamSession('cam1', 'main_h264', 'exit_fullscreen', 'vp_abc')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('viewId=vp_abc')
    expect(url).toContain('streamType=main_h264')
  })

  it('el viewId es OBLIGATORIO en la firma: ningún llamador puede omitirlo', () => {
    // Garantía de tipos, no de runtime: la revisión de #147 encontró cinco
    // llamadores que lo omitían y el backend ignoraba esos cierres por
    // ambigüedad, dejando sesiones consumiendo cupo hasta el TTL.
    // @ts-expect-error — falta el argumento viewId
    expect(() => closeStreamSession('cam1', 'sub', 'cleanup_unmount')).toBeTypeOf('function')
  })

  it('escapa el viewId', async () => {
    await closeStreamSession('cam1', 'sub', 'x', 'vp a/b&c')
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('viewId=vp+a%2Fb%26c')
  })

  it('closeViewSessions sigue cerrando por pestaña', async () => {
    await closeViewSessions('vp_abc')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/cameras/my-sessions?viewId=vp_abc')
    expect(init.keepalive).toBe(true)
  })
})

describe('(9) el TTL de HD proviene del backend', () => {
  const DEFAULT = 90_000

  it('acepta el valor efectivo que informa el backend', () => {
    expect(resolveHdSessionTtlMs({ streamHdIdleTimeoutMs: 30_000 }, DEFAULT)).toBe(30_000)
    expect(resolveHdSessionTtlMs({ streamHdIdleTimeoutMs: 90_000 }, DEFAULT)).toBe(90_000)
    expect(resolveHdSessionTtlMs({ streamHdIdleTimeoutMs: 180_000 }, DEFAULT)).toBe(180_000)
  })

  it('un valor de 5 s llega ya acotado a 15 s por el backend y se respeta', () => {
    // El clamping ocurre en el servidor (getSessionTtl); el frontend consume el
    // valor EFECTIVO tal cual, sin volver a interpretarlo.
    expect(resolveHdSessionTtlMs({ streamHdIdleTimeoutMs: 15_000 }, DEFAULT)).toBe(15_000)
  })

  it('cae al default si el backend no informa el campo (versión anterior)', () => {
    expect(resolveHdSessionTtlMs({}, DEFAULT)).toBe(DEFAULT)
  })

  it('rechaza valores no utilizables en vez de romper la reanudación', () => {
    expect(resolveHdSessionTtlMs({ streamHdIdleTimeoutMs: 0 }, DEFAULT)).toBe(DEFAULT)
    expect(resolveHdSessionTtlMs({ streamHdIdleTimeoutMs: -1 }, DEFAULT)).toBe(DEFAULT)
    expect(resolveHdSessionTtlMs({ streamHdIdleTimeoutMs: Number.NaN }, DEFAULT)).toBe(DEFAULT)
    expect(resolveHdSessionTtlMs({ streamHdIdleTimeoutMs: '90000' as any }, DEFAULT)).toBe(DEFAULT)
  })
})
