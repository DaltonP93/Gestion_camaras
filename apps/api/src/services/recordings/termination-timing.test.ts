import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveTerminationTiming,
  getTerminationTiming,
  resetTerminationTimingCache,
  EXIT_CONFIRMATION_MARGIN_MS,
  DEFAULT_TERMINATION_WAIT_MS,
  DEFAULT_KILL_GRACE_MS,
} from './termination-timing'

describe('resolveTerminationTiming — orden entre kill grace y espera de salida', () => {
  it('TEST 1 — kill grace MAYOR que la espera configurada ⇒ se eleva y wasClamped', () => {
    const t = resolveTerminationTiming({
      previewKillGraceMs: 20_000,
      configuredTerminationWaitMs: 12_000,
      exitConfirmationMarginMs: 3_000,
    })
    expect(t.minimumTerminationWaitMs).toBe(23_000)
    expect(t.effectiveTerminationWaitMs).toBe(23_000)
    expect(t.wasClamped).toBe(true)
    expect(t.requestedTerminationWaitMs).toBe(12_000)
    expect(t.previewKillGraceMs).toBe(20_000)
  })

  it('TEST 2 — con esa configuración NO se puede declarar stuck a los 12 s', () => {
    const t = resolveTerminationTiming({
      previewKillGraceMs: 20_000, configuredTerminationWaitMs: 12_000, exitConfirmationMarginMs: 3_000,
    })
    // El SIGKILL ocurre a los 20 s: la espera debe ir más allá.
    expect(t.effectiveTerminationWaitMs).toBeGreaterThan(20_000)
    expect(t.effectiveTerminationWaitMs).toBeGreaterThan(12_000)
  })

  it('TEST 3 — una salida a los 20,5 s cae DENTRO de la espera efectiva (no hay stuck ni sweep)', () => {
    const t = resolveTerminationTiming({
      previewKillGraceMs: 20_000, configuredTerminationWaitMs: 12_000, exitConfirmationMarginMs: 3_000,
    })
    const exitAtMs = 20_500
    expect(exitAtMs).toBeLessThan(t.effectiveTerminationWaitMs)
  })

  it('TEST 4 — espera configurada ya suficiente ⇒ se respeta y NO se marca clamped', () => {
    const t = resolveTerminationTiming({
      previewKillGraceMs: 5_000, configuredTerminationWaitMs: 15_000, exitConfirmationMarginMs: 3_000,
    })
    expect(t.minimumTerminationWaitMs).toBe(8_000)
    expect(t.effectiveTerminationWaitMs).toBe(15_000)
    expect(t.wasClamped).toBe(false)
  })

  it('INVARIANTE — la espera efectiva SIEMPRE supera la gracia + margen', () => {
    const graces = [500, 2_000, 5_000, 12_000, 20_000, 60_000, 300_000]
    const configured = [undefined, null, 0, -1, NaN, 1_000, 12_000, 90_000, 10 ** 12]
    for (const g of graces) {
      for (const c of configured) {
        const t = resolveTerminationTiming({
          previewKillGraceMs: g, configuredTerminationWaitMs: c as any, exitConfirmationMarginMs: 3_000,
        })
        expect(t.effectiveTerminationWaitMs, `grace=${g} configured=${String(c)}`)
          .toBeGreaterThanOrEqual(t.previewKillGraceMs + t.exitConfirmationMarginMs)
      }
    }
  })

  it('TEST 7 — valores inválidos: NaN, negativos, cero y overflow son deterministas', () => {
    for (const bad of [NaN, -1, 0, 'x', null, undefined, Infinity]) {
      const t = resolveTerminationTiming({
        previewKillGraceMs: bad as any, configuredTerminationWaitMs: bad as any,
      })
      expect(t.previewKillGraceMs).toBe(DEFAULT_KILL_GRACE_MS)
      expect(t.requestedTerminationWaitMs).toBeNull()
      expect(t.effectiveTerminationWaitMs).toBe(DEFAULT_TERMINATION_WAIT_MS)
      expect(t.wasClamped).toBe(false)      // el operador no pidió nada
    }
  })

  it('valores excesivos se acotan a límites razonables (sin overflow)', () => {
    const t = resolveTerminationTiming({
      previewKillGraceMs: 10 ** 9, configuredTerminationWaitMs: 10 ** 9,
    })
    expect(t.previewKillGraceMs).toBe(300_000)          // tope kill grace
    expect(t.requestedTerminationWaitMs).toBe(600_000)  // tope espera
    expect(Number.isFinite(t.effectiveTerminationWaitMs)).toBe(true)
  })

  it('con los valores por defecto del repo no cambia el comportamiento actual', () => {
    const t = resolveTerminationTiming({ previewKillGraceMs: 2_000 })
    expect(t.effectiveTerminationWaitMs).toBe(DEFAULT_TERMINATION_WAIT_MS)  // 12 s
    expect(t.wasClamped).toBe(false)
    expect(t.exitConfirmationMarginMs).toBe(EXIT_CONFIRMATION_MARGIN_MS)
  })

  it('el margen es configurable y participa del piso', () => {
    const t = resolveTerminationTiming({
      previewKillGraceMs: 10_000, configuredTerminationWaitMs: 5_000, exitConfirmationMarginMs: 5_000,
    })
    expect(t.minimumTerminationWaitMs).toBe(15_000)
    expect(t.effectiveTerminationWaitMs).toBe(15_000)
    expect(t.wasClamped).toBe(true)
  })
})

describe('getTerminationTiming — fuente única, memoizada y con clamping observable', () => {
  const ENV = { ...process.env }
  beforeEach(() => {
    resetTerminationTimingCache()
    process.env = { ...ENV }
    delete process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS
    delete process.env.RECORDINGS_TERMINATION_WAIT_MS
    delete process.env.RECORDINGS_EXIT_CONFIRMATION_MARGIN_MS
  })

  it('lee el entorno UNA sola vez (memoizado)', () => {
    process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS = '2000'
    const first = getTerminationTiming()
    process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS = '99000'   // cambio posterior
    expect(getTerminationTiming()).toBe(first)               // misma instancia
  })

  it('registra recordings_termination_wait_clamped UNA vez, sin secretos', () => {
    process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS = '20000'
    process.env.RECORDINGS_TERMINATION_WAIT_MS = '12000'
    const lines: string[] = []
    const t = getTerminationTiming((m) => lines.push(m))
    getTerminationTiming((m) => lines.push(m))   // segunda llamada: no re-loguea

    expect(t.effectiveTerminationWaitMs).toBe(23_000)
    expect(t.wasClamped).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('recordings_termination_wait_clamped')
    expect(lines[0]).toContain('configuredTerminationWaitMs=12000')
    expect(lines[0]).toContain('previewKillGraceMs=20000')
    expect(lines[0]).toContain('exitConfirmationMarginMs=3000')
    expect(lines[0]).toContain('effectiveTerminationWaitMs=23000')
    expect(lines[0]).not.toMatch(/rtsp:|password|token/i)
  })

  it('no registra nada cuando la configuración ya es suficiente', () => {
    process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS = '2000'
    process.env.RECORDINGS_TERMINATION_WAIT_MS = '30000'
    const lines: string[] = []
    const t = getTerminationTiming((m) => lines.push(m))
    expect(t.effectiveTerminationWaitMs).toBe(30_000)
    expect(t.wasClamped).toBe(false)
    expect(lines).toHaveLength(0)
  })
})
