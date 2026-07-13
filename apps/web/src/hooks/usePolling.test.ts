// Tests del poller secuencial (lógica pura, sin DOM). Verifican que:
// - no se solapan ejecuciones aunque la request tarde,
// - se pausa mientras la pestaña está oculta,
// - se aplica backoff respetando Retry-After ante 429,
// - stop() cancela y no vuelve a ejecutar.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSequentialPoller } from './usePolling'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// Espera microtasks pendientes (promesas ya resueltas) sin avanzar el reloj.
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('createSequentialPoller', () => {
  it('ejecuta de inmediato y luego cada intervalMs (sin solapar)', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    const p = createSequentialPoller(fn, { intervalMs: 1000 })
    p.start()
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)          // inmediata
    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(3)
    p.stop()
  })

  it('no dispara una nueva ejecución mientras la anterior sigue en vuelo', async () => {
    let resolve!: () => void
    const fn = vi.fn().mockImplementation(() => new Promise<void>(r => { resolve = r }))
    const p = createSequentialPoller(fn, { intervalMs: 1000 })
    p.start()
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    // Avanzar mucho más que el intervalo: como la 1ª no terminó, no debe re-disparar
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(p.isInFlight()).toBe(true)
    resolve()                                     // termina la 1ª
    await flush()
    await vi.advanceTimersByTimeAsync(1000)       // recién ahora agenda la 2ª
    expect(fn).toHaveBeenCalledTimes(2)
    p.stop()
  })

  it('se pausa mientras la pestaña está oculta y reanuda al volver visible', async () => {
    let hidden = true
    const fn = vi.fn().mockResolvedValue(undefined)
    const p = createSequentialPoller(fn, { intervalMs: 1000, isHidden: () => hidden })
    p.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fn).toHaveBeenCalledTimes(0)           // oculto: no ejecuta
    hidden = false
    p.resume()
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    p.stop()
  })

  it('aplica backoff (Retry-After) ante 429', async () => {
    const err = { response: { status: 429, headers: { 'retry-after': '5' } } }
    const fn = vi.fn().mockRejectedValue(err)
    const p = createSequentialPoller(fn, {
      intervalMs: 1000,
      retryAfterMs: () => 5000,   // simula Retry-After: 5s
    })
    p.start()
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)       // aún no: el backoff es 5s
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000)       // a los 5s sí
    expect(fn).toHaveBeenCalledTimes(2)
    p.stop()
  })

  it('stop() cancela y no vuelve a ejecutar', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    const p = createSequentialPoller(fn, { intervalMs: 1000 })
    p.start()
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    p.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)           // no más ejecuciones
  })
})
