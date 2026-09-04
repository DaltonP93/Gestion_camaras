import { describe, expect, it } from 'vitest'
import { CircuitBreaker } from './circuit-breaker'

function clockOf(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('CircuitBreaker', () => {
  it('cerrado permite; abre tras N fallos; abierto bloquea', () => {
    const c = clockOf()
    const b = new CircuitBreaker({ failureThreshold: 3, openMs: 1000 }, c.now)
    expect(b.tryAcquire()).toBe(true)
    b.onFailure(); b.onFailure(); expect(b.state()).toBe('closed')
    b.onFailure(); expect(b.state()).toBe('open')
    expect(b.tryAcquire()).toBe(false)
  })

  it('tras openMs pasa a half_open y permite un intento limitado', () => {
    const c = clockOf()
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 1000 }, c.now)
    b.onFailure(); expect(b.state()).toBe('open')
    c.advance(1000)
    expect(b.state()).toBe('half_open')
    expect(b.tryAcquire()).toBe(true)   // 1er cupo half-open
    expect(b.tryAcquire()).toBe(false)  // sin más cupos
  })

  it('éxito en half_open cierra; fallo en half_open reabre', () => {
    const c = clockOf()
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 500 }, c.now)
    b.onFailure(); c.advance(500)
    expect(b.tryAcquire()).toBe(true)
    b.onSuccess(); expect(b.state()).toBe('closed')

    b.onFailure(); c.advance(500)
    expect(b.tryAcquire()).toBe(true)
    b.onFailure(); expect(b.state()).toBe('open')
  })
})
