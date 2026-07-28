import { describe, it, expect } from 'vitest'
import {
  decideContinuity, transitionKey, clockReachedNextStart, canClaimTransition,
  type NextBlock,
} from './continuity'

const NEXT = (over: Partial<NextBlock> = {}): NextBlock => ({
  recordingId: 'rec-next', effectiveStartMs: 1_000_000, effectiveEndMs: 2_000_000, ...over,
})
const base = {
  slotIndex: 0,
  currentRecordingId: 'rec-cur',
  currentEffectiveEndMs: 1_000_000,   // fin del bloque actual
  otherSlotsPlaying: false,
}

describe('decideContinuity — 1x1 / slot que maneja el reloj', () => {
  it('gap 0 (contiguo) => start_now + advanceClock', () => {
    const d = decideContinuity({ ...base, next: NEXT({ effectiveStartMs: 1_000_000 }) })
    expect(d.action).toBe('start_now')
    expect(d.advanceClock).toBe(true)
    expect(d.gapMs).toBe(0)
  })
  it('solape negativo => start_now sin retroceso', () => {
    const d = decideContinuity({ ...base, next: NEXT({ effectiveStartMs: 990_000 }) })
    expect(d.action).toBe('start_now')
    expect(d.reason).toBe('overlap')
    expect(d.gapMs).toBeLessThan(0)
  })
  // Caso REAL: gap 6000 con default GAP 5000 — antes rompía la continuidad.
  it('gap 6000ms => continúa automáticamente (no acción manual)', () => {
    const d = decideContinuity({ ...base, next: NEXT({ effectiveStartMs: 1_006_000 }) })
    expect(d.action).toBe('start_now')
    expect(d.advanceClock).toBe(true)
    expect(d.gapMs).toBe(6000)
  })
  it('gap 30s en 1x1 => adelanta reloj e inicia automáticamente', () => {
    const d = decideContinuity({ ...base, next: NEXT({ effectiveStartMs: 1_030_000 }) })
    expect(d.action).toBe('start_now')
    expect(d.advanceClock).toBe(true)
    expect(d.reason).toBe('auto_jump_gap')
  })
})

describe('decideContinuity — multicámara', () => {
  it('gap 30s multicam => wait_clock, sin adelantar el reloj', () => {
    const d = decideContinuity({ ...base, otherSlotsPlaying: true, next: NEXT({ effectiveStartMs: 1_030_000 }) })
    expect(d.action).toBe('wait_clock')
    expect(d.advanceClock).toBe(false)
  })
  it('solape en multicam => start_now inmediato', () => {
    const d = decideContinuity({ ...base, otherSlotsPlaying: true, next: NEXT({ effectiveStartMs: 999_000 }) })
    expect(d.action).toBe('start_now')
    expect(d.advanceClock).toBe(false)
    expect(d.reason).toBe('multicam_overlap')
  })
})

describe('decideContinuity — sin siguiente bloque', () => {
  it('next=null => none', () => {
    expect(decideContinuity({ ...base, next: null }).action).toBe('none')
  })
})

describe('transitionKey + lock', () => {
  it('la clave identifica slot+cur+next+start', () => {
    expect(transitionKey(0, 'a', 'b', 1_000_000)).toBe('0|a|b|1000000')
  })
  it('canClaimTransition: sólo si aún no se tomó la misma clave', () => {
    const key = transitionKey(0, 'a', 'b', 1_000_000)
    expect(canClaimTransition(null, key)).toBe(true)
    expect(canClaimTransition(key, key)).toBe(false)      // ya tomada → no re-arrancar
    expect(canClaimTransition('otra', key)).toBe(true)
  })
  it('ended + expected_timer simultáneos => sólo el primero reclama', () => {
    const key = transitionKey(0, 'rec-cur', 'rec-next', 1_000_000)
    let claimed: string | null = null
    const claim = () => { if (canClaimTransition(claimed, key)) { claimed = key; return true } return false }
    expect(claim()).toBe(true)   // ended
    expect(claim()).toBe(false)  // expected_timer (mismo key) → suprimido
  })
})

describe('clockReachedNextStart', () => {
  it('arranca cuando el reloj alcanza nextEffectiveStart', () => {
    expect(clockReachedNextStart(999_999, 1_000_000)).toBe(false)
    expect(clockReachedNextStart(1_000_000, 1_000_000)).toBe(true)
    expect(clockReachedNextStart(1_000_500, 1_000_000)).toBe(true)
  })
})
