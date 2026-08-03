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
    const clamped = lines.filter(l => l.includes('recordings_termination_wait_clamped'))
    expect(clamped).toHaveLength(1)
    expect(clamped[0]).toContain('configuredTerminationWaitMs=12000')
    expect(clamped[0]).toContain('previewKillGraceMs=20000')
    expect(clamped[0]).toContain('exitConfirmationMarginMs=3000')
    expect(clamped[0]).toContain('effectiveTerminationWaitMs=23000')
    expect(lines.join('\n')).not.toMatch(/rtsp:|password|token/i)
  })

  it('SIEMPRE registra los valores resueltos, una sola vez', () => {
    process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS = '2000'
    process.env.RECORDINGS_TERMINATION_WAIT_MS = '30000'
    const lines: string[] = []
    getTerminationTiming((m) => lines.push(m))
    getTerminationTiming((m) => lines.push(m))
    const resolved = lines.filter(l => l.includes('recordings_termination_timing_resolved'))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toContain('effectiveTerminationWaitMs=30000')
    expect(resolved[0]).toContain('wasClamped=false')
    expect(resolved[0]).toContain('killGraceWasNormalized=false')
  })

  it('no registra el clamp cuando la configuración ya es suficiente', () => {
    process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS = '2000'
    process.env.RECORDINGS_TERMINATION_WAIT_MS = '30000'
    const lines: string[] = []
    const t = getTerminationTiming((m) => lines.push(m))
    expect(t.effectiveTerminationWaitMs).toBe(30_000)
    expect(t.wasClamped).toBe(false)
    expect(lines.filter(l => l.includes('recordings_termination_wait_clamped'))).toHaveLength(0)
  })

  it('un recorte al MÁXIMO ya no pasa en silencio: wasClamped y log', () => {
    process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS = '2000'
    process.env.RECORDINGS_TERMINATION_WAIT_MS = '900000'   // > tope de 600000
    const lines: string[] = []
    const t = getTerminationTiming((m) => lines.push(m))
    expect(t.effectiveTerminationWaitMs).toBe(600_000)
    expect(t.wasClamped).toBe(true)      // antes era false y no había log
    expect(lines.filter(l => l.includes('recordings_termination_wait_clamped'))).toHaveLength(1)
  })

  it('un kill grace fuera de rango se marca como normalizado', () => {
    process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS = '100'     // < mínimo de 500
    const lines: string[] = []
    const t = getTerminationTiming((m) => lines.push(m))
    expect(t.previewKillGraceMs).toBe(500)
    expect(t.killGraceWasNormalized).toBe(true)
    expect(lines.filter(l => l.includes('killGraceWasNormalized=true'))).toHaveLength(1)
  })
})

describe('normalización estricta de cadenas (Codex #145)', () => {
  // parseInt acepta prefijos parciales: "1e5"->1, "2000ms"->2000. Una config mal
  // formada debe caer al DEFAULT determinista, no colarse ni elevarse al mínimo.
  it('cadenas no decimales completas caen al default, no a un valor parcial', () => {
    for (const bad of ['1e5', '2000ms', '12abc', '1.5', ' 20 00', '0x10', '+5000', '-5000', '', '   ']) {
      const t = resolveTerminationTiming({
        previewKillGraceMs: '2000', configuredTerminationWaitMs: bad,
      })
      expect(t.requestedTerminationWaitMs, `configured=${JSON.stringify(bad)}`).toBeNull()
      expect(t.effectiveTerminationWaitMs, `configured=${JSON.stringify(bad)}`).toBe(DEFAULT_TERMINATION_WAIT_MS)
      expect(t.wasClamped).toBe(false)
    }
  })

  it('"1e5" ya NO produce una espera efectiva de 5 s', () => {
    const t = resolveTerminationTiming({ previewKillGraceMs: 2_000, configuredTerminationWaitMs: '1e5' })
    expect(t.effectiveTerminationWaitMs).not.toBe(5_000)
    expect(t.effectiveTerminationWaitMs).toBe(DEFAULT_TERMINATION_WAIT_MS)
  })

  it('un kill grace mal formado cae al default (no al mínimo)', () => {
    const t = resolveTerminationTiming({ previewKillGraceMs: '2e3', configuredTerminationWaitMs: '15000' })
    expect(t.previewKillGraceMs).toBe(DEFAULT_KILL_GRACE_MS)
    expect(t.effectiveTerminationWaitMs).toBe(15_000)
  })

  it('cadenas decimales válidas siguen aceptándose (con espacios alrededor)', () => {
    const t = resolveTerminationTiming({ previewKillGraceMs: ' 20000 ', configuredTerminationWaitMs: '30000' })
    expect(t.previewKillGraceMs).toBe(20_000)
    expect(t.requestedTerminationWaitMs).toBe(30_000)
    expect(t.effectiveTerminationWaitMs).toBe(30_000)
  })

  it('tipos no numéricos ni cadena se rechazan', () => {
    for (const bad of [{}, [], true, () => 1]) {
      const t = resolveTerminationTiming({ configuredTerminationWaitMs: bad as any })
      expect(t.requestedTerminationWaitMs).toBeNull()
    }
  })
})

describe('honestidad de wasClamped (Codex #145, 4ª ronda)', () => {
  it('recorte al máximo cuenta como clamped', () => {
    const t = resolveTerminationTiming({ previewKillGraceMs: 2_000, configuredTerminationWaitMs: 900_000 })
    expect(t.effectiveTerminationWaitMs).toBe(600_000)
    expect(t.wasClamped).toBe(true)
  })
  it('elevación al piso cuenta como clamped', () => {
    const t = resolveTerminationTiming({ previewKillGraceMs: 20_000, configuredTerminationWaitMs: 12_000 })
    expect(t.wasClamped).toBe(true)
  })
  it('un valor exacto y dentro de rango NO cuenta como clamped', () => {
    const t = resolveTerminationTiming({ previewKillGraceMs: 2_000, configuredTerminationWaitMs: 30_000 })
    expect(t.wasClamped).toBe(false)
  })
  it('killGraceWasNormalized distingue ajuste de valor válido', () => {
    expect(resolveTerminationTiming({ previewKillGraceMs: 100 }).killGraceWasNormalized).toBe(true)
    expect(resolveTerminationTiming({ previewKillGraceMs: 999_999 }).killGraceWasNormalized).toBe(true)
    expect(resolveTerminationTiming({ previewKillGraceMs: 2_000 }).killGraceWasNormalized).toBe(false)
    // Sin configurar no hay "normalización": se aplica el default.
    expect(resolveTerminationTiming({}).killGraceWasNormalized).toBe(false)
  })
})

describe('lease y cooldown también se resuelven (Codex #145, 5ª ronda)', () => {
  it('el valor CRUDO no es el efectivo cuando está fuera de rango', () => {
    // Afirmación corregida: 5000 corre como 10000 y 0 corre como 120000.
    const t = resolveTerminationTiming({ unconsumedLeaseMs: '5000', capacityCooldownMs: '0' })
    expect(t.unconsumedLeaseMs).toBe(10_000)
    expect(t.capacityCooldownMs).toBe(120_000)
  })
  it('valores válidos se respetan', () => {
    const t = resolveTerminationTiming({ unconsumedLeaseMs: '60000', capacityCooldownMs: '300000' })
    expect(t.unconsumedLeaseMs).toBe(60_000)
    expect(t.capacityCooldownMs).toBe(300_000)
  })
  it('valores ausentes o mal formados caen a los defaults', () => {
    for (const bad of [undefined, null, '', '1e5', '45s', -1]) {
      const t = resolveTerminationTiming({ unconsumedLeaseMs: bad as any, capacityCooldownMs: bad as any })
      expect(t.unconsumedLeaseMs).toBe(45_000)
      expect(t.capacityCooldownMs).toBe(120_000)
    }
  })
  it('se acotan a máximos razonables', () => {
    const t = resolveTerminationTiming({ unconsumedLeaseMs: 10 ** 9, capacityCooldownMs: 10 ** 9 })
    expect(t.unconsumedLeaseMs).toBe(600_000)
    expect(t.capacityCooldownMs).toBe(3_600_000)
  })
  it('la línea resuelta los incluye', () => {
    resetTerminationTimingCache()
    process.env.RECORDINGS_UNCONSUMED_LEASE_MS = '5000'
    const lines: string[] = []
    getTerminationTiming((m) => lines.push(m))
    const resolved = lines.find(l => l.includes('recordings_termination_timing_resolved'))!
    expect(resolved).toContain('unconsumedLeaseMs=10000')
    expect(resolved).toContain('capacityCooldownMs=')
    delete process.env.RECORDINGS_UNCONSUMED_LEASE_MS
    resetTerminationTimingCache()
  })
})
