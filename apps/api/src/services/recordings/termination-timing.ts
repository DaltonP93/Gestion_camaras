// apps/api/src/services/recordings/termination-timing.ts
//
// FUENTE ÚNICA de los tiempos del ciclo de terminación del preview.
//
// El cierre de una sesión usa dos plazos que deben estar ORDENADOS entre sí:
//   · kill grace  — cuánto espera el registry entre SIGTERM y SIGKILL.
//   · termination wait — cuánto espera el route la salida REAL (exit/close)
//     antes de declarar la terminación atascada.
//
// Si el termination wait venciera ANTES del SIGKILL programado, la terminación
// se marcaría "atascada" sin motivo: aunque el proceso muriese al vencer la
// gracia, el lease sólo se liberaría en el barrido periódico y toda la cola de
// ese NVR quedaría bloqueada innecesariamente.
//
// Estas variables de entorno se leen ACÁ y en ningún otro archivo.

/** Margen para recibir exit/close, drenar stdio, correr markExited y actualizar aliveCount. */
export const EXIT_CONFIRMATION_MARGIN_MS = 3_000
/** Espera por defecto cuando no hay nada configurado. */
export const DEFAULT_TERMINATION_WAIT_MS = 12_000
/** Gracia SIGTERM→SIGKILL por defecto. */
export const DEFAULT_KILL_GRACE_MS = 2_000

// Límites razonables: descartan NaN, negativos, cero no intencional y overflow.
const MIN_KILL_GRACE_MS = 500
const MAX_KILL_GRACE_MS = 300_000        // 5 min
const MIN_TERMINATION_WAIT_MS = 2_000
const MAX_TERMINATION_WAIT_MS = 600_000  // 10 min

export interface TerminationTiming {
  previewKillGraceMs: number
  /** Lo que pidió el operador (ya normalizado), o null si no configuró nada. */
  requestedTerminationWaitMs: number | null
  /** Piso obligatorio: gracia + margen de confirmación. */
  minimumTerminationWaitMs: number
  /** El valor que se usa realmente. */
  effectiveTerminationWaitMs: number
  /** true si hubo que elevar lo configurado hasta el piso. */
  wasClamped: boolean
  exitConfirmationMarginMs: number
}

/**
 * Normaliza un entero de milisegundos dentro de [min,max]; null si el valor no
 * es utilizable, en cuyo caso el llamador aplica su default determinista.
 *
 * Una cadena debe ser un entero DECIMAL COMPLETO. No se usa parseInt suelto
 * porque acepta prefijos parciales: "1e5" daría 1 y "2000ms" daría 2000, de modo
 * que una configuración mal formada se aceptaría en silencio (o peor, se
 * elevaría al mínimo) en vez de caer al default (review Codex #145).
 */
function normalizeMs(value: unknown, min: number, max: number): number | null {
  let n: number
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return null   // rechaza "", "1e5", "2000ms", "-5", "1.5"
    n = Number(trimmed)
  } else if (typeof value === 'number') {
    n = value
  } else {
    return null
  }
  if (!Number.isFinite(n)) return null
  const floored = Math.floor(n)
  if (floored <= 0) return null
  return Math.min(max, Math.max(min, floored))
}

/**
 * PURA. Resuelve los plazos garantizando el orden entre ambos.
 *
 *   minimumTerminationWaitMs = previewKillGraceMs + exitConfirmationMarginMs
 *   effectiveTerminationWaitMs = max(configurado, minimum)
 *
 * El operador puede ELEVAR la espera, nunca dejarla por debajo de la gracia.
 */
export function resolveTerminationTiming(input: {
  previewKillGraceMs?: unknown
  configuredTerminationWaitMs?: unknown
  exitConfirmationMarginMs?: unknown
}): TerminationTiming {
  const previewKillGraceMs =
    normalizeMs(input.previewKillGraceMs, MIN_KILL_GRACE_MS, MAX_KILL_GRACE_MS) ?? DEFAULT_KILL_GRACE_MS
  const exitConfirmationMarginMs =
    normalizeMs(input.exitConfirmationMarginMs, 500, 60_000) ?? EXIT_CONFIRMATION_MARGIN_MS
  const requestedTerminationWaitMs =
    normalizeMs(input.configuredTerminationWaitMs, MIN_TERMINATION_WAIT_MS, MAX_TERMINATION_WAIT_MS)

  const minimumTerminationWaitMs = Math.max(
    MIN_TERMINATION_WAIT_MS,
    previewKillGraceMs + exitConfirmationMarginMs,
  )
  const requestedOrDefault = requestedTerminationWaitMs ?? DEFAULT_TERMINATION_WAIT_MS
  const effectiveTerminationWaitMs = Math.max(requestedOrDefault, minimumTerminationWaitMs)

  return {
    previewKillGraceMs,
    requestedTerminationWaitMs,
    minimumTerminationWaitMs,
    effectiveTerminationWaitMs,
    // Sólo se considera "recortado" si el operador pidió explícitamente un valor
    // insuficiente; subir el default interno no es una decisión suya.
    wasClamped: requestedTerminationWaitMs != null && effectiveTerminationWaitMs > requestedTerminationWaitMs,
    exitConfirmationMarginMs,
  }
}

let cached: TerminationTiming | null = null
let clampLogged = false

/**
 * Timing efectivo del proceso, resuelto UNA vez desde el entorno. Si el
 * operador configuró una espera insuficiente se registra una única línea
 * `recordings_termination_wait_clamped` (sin secretos) para que no falle en
 * silencio.
 */
export function getTerminationTiming(log?: (msg: string) => void): TerminationTiming {
  if (cached) return cached
  cached = resolveTerminationTiming({
    previewKillGraceMs: process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS,
    configuredTerminationWaitMs: process.env.RECORDINGS_TERMINATION_WAIT_MS,
    exitConfirmationMarginMs: process.env.RECORDINGS_EXIT_CONFIRMATION_MARGIN_MS,
  })
  if (cached.wasClamped && !clampLogged) {
    clampLogged = true
    log?.(
      `[recordings-preview] recordings_termination_wait_clamped` +
      ` configuredTerminationWaitMs=${cached.requestedTerminationWaitMs}` +
      ` previewKillGraceMs=${cached.previewKillGraceMs}` +
      ` exitConfirmationMarginMs=${cached.exitConfirmationMarginMs}` +
      ` effectiveTerminationWaitMs=${cached.effectiveTerminationWaitMs}`
    )
  }
  return cached
}

/** Sólo para tests: olvida el valor memoizado. */
export function resetTerminationTimingCache(): void {
  cached = null
  clampLogged = false
}
