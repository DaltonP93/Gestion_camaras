// Tests de la política de reintentos HLS. Foco: un 500 de substream normal NO
// debe fallar de inmediato (antes 0 reintentos → fallback prematuro a main_h264).
import { describe, it, expect } from 'vitest'
import { hlsRetryDecision, NORMAL_500_BACKOFF } from './hlsRetryPolicy'

describe('hlsRetryDecision', () => {
  it('500 en substream normal: reintenta con backoff 1/2/4/6/8s (no falla al primer 500)', () => {
    // Regresión del bug: el primer 500 debe reintentar, no fallar.
    const first = hlsRetryDecision(500, false, 0)
    expect(first.shouldRetry).toBe(true)
    expect(first.preparing).toBe(true)
    expect(first.maxRetries).toBe(NORMAL_500_BACKOFF.length)
    // Backoff progresivo
    expect(hlsRetryDecision(500, false, 0).delayMs).toBe(1000)
    expect(hlsRetryDecision(500, false, 1).delayMs).toBe(2000)
    expect(hlsRetryDecision(500, false, 2).delayMs).toBe(4000)
    expect(hlsRetryDecision(500, false, 3).delayMs).toBe(6000)
    expect(hlsRetryDecision(500, false, 4).delayMs).toBe(8000)
  })

  it('500 en substream normal: sólo falla tras agotar los 5 reintentos', () => {
    expect(hlsRetryDecision(500, false, 4).shouldRetry).toBe(true)
    const exhausted = hlsRetryDecision(500, false, 5)
    expect(exhausted.shouldRetry).toBe(false)   // recién ahora se declara el fallo
  })

  it('500 en stream transcodificado: ventana larga (~40 reintentos de 800ms)', () => {
    const d = hlsRetryDecision(500, true, 0)
    expect(d.shouldRetry).toBe(true)
    expect(d.delayMs).toBe(800)
    expect(d.maxRetries).toBe(40)
  })

  it('404 en substream normal: 1 solo reintento', () => {
    expect(hlsRetryDecision(404, false, 0).shouldRetry).toBe(true)
    expect(hlsRetryDecision(404, false, 0).delayMs).toBe(4000)
    expect(hlsRetryDecision(404, false, 1).shouldRetry).toBe(false)
  })

  it('otros errores de red: hasta 5 reintentos con backoff creciente', () => {
    expect(hlsRetryDecision(undefined, false, 0).delayMs).toBe(3000)
    expect(hlsRetryDecision(undefined, false, 1).delayMs).toBe(6000)
    expect(hlsRetryDecision(undefined, false, 5).shouldRetry).toBe(false)
  })
})
