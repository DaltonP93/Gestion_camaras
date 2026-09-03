// apps/api/src/services/media/admission-wait.test.ts
//
// N2b — espera cancelable de cupo. Determinista con reloj/sleep inyectados; más
// dos casos con el sleep real (defaultSleep) para ejercer el AbortSignal.

import { describe, it, expect } from 'vitest'
import { waitForCapacity } from './admission-wait'

describe('waitForCapacity (determinista con clock/sleep fake)', () => {
  it('acquired inmediato si hay cupo (no duerme)', async () => {
    let slept = 0
    const out = await waitForCapacity(() => 1, {
      timeoutMs: 10_000, sleep: async () => { slept++ }, now: () => 0,
    })
    expect(out).toBe('acquired')
    expect(slept).toBe(0)
  })

  it('acquired tras N sondeos cuando se libera el cupo', async () => {
    let t = 0
    let probes = 0
    const out = await waitForCapacity(
      () => (probes++ >= 2 ? 1 : 0),               // libre a partir del 3er sondeo
      { timeoutMs: 10_000, pollMs: 250, now: () => t, sleep: async (ms) => { t += ms } },
    )
    expect(out).toBe('acquired')
    expect(probes).toBe(3)
  })

  it('timeout si nunca hay cupo', async () => {
    let t = 0
    const out = await waitForCapacity(
      () => 0,
      { timeoutMs: 1000, pollMs: 250, now: () => t, sleep: async (ms) => { t += ms } },
    )
    expect(out).toBe('timeout')
  })

  it('cancelled si el signal ya estaba abortado (no sondea)', async () => {
    const ac = new AbortController(); ac.abort()
    let probes = 0
    const out = await waitForCapacity(() => { probes++; return 0 }, {
      timeoutMs: 10_000, signal: ac.signal, now: () => 0, sleep: async () => {},
    })
    expect(out).toBe('cancelled')
    expect(probes).toBe(0)
  })

  it('cancelled si se aborta durante la espera (sleep rechaza)', async () => {
    const ac = new AbortController()
    const out = await waitForCapacity(() => 0, {
      timeoutMs: 10_000, pollMs: 250, now: () => 0,
      sleep: async () => { ac.abort(); throw new Error('aborted') },
      signal: ac.signal,
    })
    expect(out).toBe('cancelled')
  })
})

describe('waitForCapacity (sleep real / AbortSignal)', () => {
  it('acquired con defaultSleep cuando el cupo se libera pronto', async () => {
    let free = false
    setTimeout(() => { free = true }, 12)
    const out = await waitForCapacity(() => (free ? 1 : 0), { timeoutMs: 500, pollMs: 5 })
    expect(out).toBe('acquired')
  })

  it('cancelled con defaultSleep al abortar', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 10)
    const out = await waitForCapacity(() => 0, { timeoutMs: 5000, pollMs: 5, signal: ac.signal })
    expect(out).toBe('cancelled')
  })
})
