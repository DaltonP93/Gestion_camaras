// Presupuesto de arranque del preview de grabaciones — lógica PURA y testeable.
//
// Problema que resuelve: el presupuesto total naïve (attempts * firstByteTimeout)
// NO reserva tiempo para el overhead REAL entre intentos — la gracia de SIGKILL
// tras un timeout y el retardo de reintento antes de lanzar la siguiente variante.
// Ese overhead se acumula, así que los últimos intentos recibían menos que el
// watchdog completo (evidencia de producción: con 4 estrategias el último recibió
// 16,484 s; con 3, 19,322 s — en vez de los 25 s que merece cada uno).
//
// La corrección: cada intento recibe SIEMPRE el watchdog COMPLETO (deadline
// individual fija), y el presupuesto GLOBAL se dimensiona lo bastante amplio para
// que todos los intentos conservados puedan agotar su watchdog + overhead. Si el
// plan no cabe bajo el tope duro, se recortan las variantes de menor prioridad y
// se registran explícitamente (nunca se comprime un intento por debajo del piso).

export interface BudgetConfig {
  /** Watchdog de primer byte por intento (deadline individual completa). */
  firstByteTimeoutMs: number
  /** Gracia tras SIGTERM antes de SIGKILL a un FFmpeg colgado. */
  killGraceMs: number
  /** Retardo entre el fallo de una variante y el arranque de la siguiente. */
  retryDelayMs: number
  /** Margen de seguridad para overhead no modelado (spawn, demux, GC). */
  safetyMarginMs: number
  /** Tope duro del presupuesto total (cota al peor caso). */
  hardCapMs: number
  /** Piso del presupuesto total (headroom mínimo aunque haya pocos intentos). */
  minTotalMs: number
}

export interface BudgetPlan {
  /** Cuántos intentos se conservan (≤ solicitados). */
  keptAttempts: number
  /** Cuántos se descartaron por no caber bajo el tope duro. */
  skippedAttempts: number
  /** Coste worst-case de UN intento: watchdog + gracia SIGKILL + retardo. */
  perAttemptCostMs: number
  /** Deadline individual por intento — SIEMPRE el watchdog completo. */
  perAttemptTimeoutMs: number
  /** Deadline global: cabe todos los intentos conservados a tiempo completo. */
  effectiveTotalBudgetMs: number
}

/**
 * Dimensiona el presupuesto de arranque garantizando que CADA intento conservado
 * reciba el watchdog de primer byte COMPLETO. No depende del reloj: es una función
 * pura de (nº de intentos, config), por lo que se puede validar con un reloj
 * simulado en los tests (recorrer los intentos acumulando elapsed y comprobar que
 * ninguno se queda por debajo del watchdog completo).
 */
export function planStartupBudget(attemptCount: number, cfg: BudgetConfig): BudgetPlan {
  const perAttemptTimeoutMs = cfg.firstByteTimeoutMs
  // Coste worst-case de un intento fallido: agota el watchdog completo, luego la
  // gracia de SIGKILL, luego el retardo antes de lanzar el siguiente.
  const perAttemptCostMs = cfg.firstByteTimeoutMs + cfg.killGraceMs + cfg.retryDelayMs

  // Cuántos intentos caben bajo el tope duro concediendo a cada uno el watchdog
  // COMPLETO. El último intento no lleva retardo de reintento detrás (no hay
  // siguiente), así que se le devuelve ese retardo al presupuesto disponible.
  const usableCap = Math.max(0, cfg.hardCapMs - cfg.safetyMarginMs)
  let maxAttempts = Math.floor((usableCap + cfg.retryDelayMs) / perAttemptCostMs)
  if (maxAttempts < 1) maxAttempts = 1  // siempre al menos un intento a tiempo completo

  const keptAttempts = Math.min(Math.max(0, attemptCount), maxAttempts)
  const skippedAttempts = Math.max(0, attemptCount - keptAttempts)

  // Deadline global: suficiente para que todos los intentos conservados agoten su
  // watchdog + overhead. El último no lleva retardo detrás → se descuenta uno.
  const raw = keptAttempts * perAttemptCostMs - cfg.retryDelayMs + cfg.safetyMarginMs
  const effectiveTotalBudgetMs = Math.min(cfg.hardCapMs, Math.max(cfg.minTotalMs, raw))

  return { keptAttempts, skippedAttempts, perAttemptCostMs, perAttemptTimeoutMs, effectiveTotalBudgetMs }
}
