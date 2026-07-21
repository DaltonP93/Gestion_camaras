import { describe, it, expect } from 'vitest'
import { planStartupBudget, type BudgetConfig } from './preview-budget'

// Config de referencia = defaults de producción.
const CFG: BudgetConfig = {
  firstByteTimeoutMs: 25_000,
  killGraceMs: 2_000,
  retryDelayMs: 800,
  safetyMarginMs: 3_000,
  hardCapMs: 120_000,
  minTotalMs: 60_000,
}

/**
 * Reloj simulado: recorre los intentos conservados en el PEOR caso (cada uno
 * agota su watchdog completo, luego SIGKILL grace, luego retardo de reintento) y
 * verifica que el intento arranca ANTES del deadline global y dispone del
 * watchdog COMPLETO sin pasarse del presupuesto. Reproduce el bug de producción
 * (últimos intentos comprimidos) de forma determinista, sin timers reales.
 */
function simulateWorstCase(plan: ReturnType<typeof planStartupBudget>, cfg: BudgetConfig) {
  let elapsed = 0
  const perAttempt: Array<{ index: number; startedAt: number; deadlineAt: number; withinBudget: boolean }> = []
  for (let i = 0; i < plan.keptAttempts; i++) {
    const startedAt = elapsed
    const deadlineAt = startedAt + cfg.firstByteTimeoutMs
    // El intento debe poder correr el watchdog COMPLETO dentro del presupuesto.
    const withinBudget = deadlineAt <= plan.effectiveTotalBudgetMs
    perAttempt.push({ index: i, startedAt, deadlineAt, withinBudget })
    // Avanza el reloj: watchdog + gracia SIGKILL + retardo (salvo el último).
    elapsed += cfg.firstByteTimeoutMs + cfg.killGraceMs
    if (i < plan.keptAttempts - 1) elapsed += cfg.retryDelayMs
  }
  return perAttempt
}

describe('planStartupBudget', () => {
  it('da a CADA intento el watchdog completo (deadline individual fija)', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const plan = planStartupBudget(n, CFG)
      expect(plan.perAttemptTimeoutMs).toBe(CFG.firstByteTimeoutMs)
    }
  })

  it('reloj simulado: ningún intento conservado se comprime por debajo de 25 s', () => {
    // Casos exactos del reporte de producción: 3 y 4 estrategias.
    for (const n of [3, 4]) {
      const plan = planStartupBudget(n, CFG)
      expect(plan.skippedAttempts).toBe(0)          // ambos caben bajo el tope
      const sim = simulateWorstCase(plan, CFG)
      expect(sim).toHaveLength(n)
      for (const a of sim) {
        // Cada intento arranca con presupuesto suficiente para su watchdog completo.
        expect(a.withinBudget).toBe(true)
        expect(a.deadlineAt - a.startedAt).toBe(CFG.firstByteTimeoutMs)
      }
    }
  })

  it('el presupuesto global reserva overhead (kill grace + retardos + margen)', () => {
    const n = 4
    const plan = planStartupBudget(n, CFG)
    // Naïve (buggy) = n * firstByteTimeout = 100_000. El corregido debe superarlo
    // para acomodar killGrace y retardos entre intentos.
    const naive = n * CFG.firstByteTimeoutMs
    expect(plan.effectiveTotalBudgetMs).toBeGreaterThan(naive)
    // Cota worst-case del tiempo acumulado hasta el deadline del último intento.
    const sim = simulateWorstCase(plan, CFG)
    const last = sim[sim.length - 1]
    expect(last.deadlineAt).toBeLessThanOrEqual(plan.effectiveTotalBudgetMs)
  })

  it('respeta el tope duro y recorta variantes de menor prioridad', () => {
    // Con hardCap chico solo caben unos pocos intentos a tiempo completo.
    const tight: BudgetConfig = { ...CFG, hardCapMs: 60_000, minTotalMs: 10_000, safetyMarginMs: 1_000 }
    const plan = planStartupBudget(7, tight)
    expect(plan.keptAttempts).toBeLessThan(7)
    expect(plan.keptAttempts + plan.skippedAttempts).toBe(7)
    expect(plan.effectiveTotalBudgetMs).toBeLessThanOrEqual(tight.hardCapMs)
    // Los intentos conservados igual reciben watchdog completo.
    const sim = simulateWorstCase(plan, tight)
    for (const a of sim) expect(a.withinBudget).toBe(true)
  })

  it('siempre conserva al menos un intento aunque el tope sea diminuto', () => {
    const tiny: BudgetConfig = { ...CFG, hardCapMs: 5_000, minTotalMs: 5_000, safetyMarginMs: 0 }
    const plan = planStartupBudget(4, tiny)
    expect(plan.keptAttempts).toBe(1)
    expect(plan.skippedAttempts).toBe(3)
  })

  it('no descarta intentos cuando el plan cabe holgado', () => {
    const plan = planStartupBudget(2, CFG)
    expect(plan.keptAttempts).toBe(2)
    expect(plan.skippedAttempts).toBe(0)
  })

  it('perAttemptCost incluye watchdog + gracia SIGKILL + retardo', () => {
    const plan = planStartupBudget(1, CFG)
    expect(plan.perAttemptCostMs).toBe(
      CFG.firstByteTimeoutMs + CFG.killGraceMs + CFG.retryDelayMs
    )
  })
})
