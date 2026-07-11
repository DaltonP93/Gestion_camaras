// Tests del refcount de consumidores de path (Analytics ⇄ Live View).
// Verifica que removeStream (cleanup de live view) respete un path que
// Analytics está usando, y que la marca expire por TTL.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { markAnalyticsConsumer, clearAnalyticsConsumer, hasAnalyticsConsumer } from './stream'

describe('refcount de consumidores analytics', () => {
  beforeEach(() => {
    vi.useRealTimers()
    clearAnalyticsConsumer('nvr_x_ch01_sub')
  })

  it('un path marcado por analytics está activo', () => {
    expect(hasAnalyticsConsumer('nvr_x_ch01_sub')).toBe(false)
    markAnalyticsConsumer('nvr_x_ch01_sub', 180_000)
    expect(hasAnalyticsConsumer('nvr_x_ch01_sub')).toBe(true)
  })

  it('la marca expira tras el TTL (live puede volver a borrar el path)', () => {
    vi.useFakeTimers()
    markAnalyticsConsumer('nvr_x_ch01_sub', 1_000)
    expect(hasAnalyticsConsumer('nvr_x_ch01_sub')).toBe(true)
    vi.advanceTimersByTime(1_500)
    expect(hasAnalyticsConsumer('nvr_x_ch01_sub')).toBe(false)
    vi.useRealTimers()
  })

  it('clearAnalyticsConsumer libera la marca de inmediato', () => {
    markAnalyticsConsumer('nvr_x_ch01_sub', 180_000)
    clearAnalyticsConsumer('nvr_x_ch01_sub')
    expect(hasAnalyticsConsumer('nvr_x_ch01_sub')).toBe(false)
  })

  it('refrescar la marca (nuevo poll) extiende la vigencia', () => {
    vi.useFakeTimers()
    markAnalyticsConsumer('nvr_x_ch01_sub', 2_000)
    vi.advanceTimersByTime(1_500)
    markAnalyticsConsumer('nvr_x_ch01_sub', 2_000) // poll de refresh
    vi.advanceTimersByTime(1_500)                  // 3s desde el primero
    expect(hasAnalyticsConsumer('nvr_x_ch01_sub')).toBe(true) // sigue vivo
    vi.useRealTimers()
  })
})
