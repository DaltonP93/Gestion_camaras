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
  /** true si lo que pidió el operador NO es lo que corre (elevado o recortado). */
  wasClamped: boolean
  /** true si el kill grace configurado fue normalizado a los límites válidos. */
  killGraceWasNormalized: boolean
  exitConfirmationMarginMs: number
}

/**
 * Parsea un entero de milisegundos SIN acotar. Devuelve null si el valor no es
 * utilizable, en cuyo caso el llamador aplica su default determinista.
 *
 * Una cadena debe ser un entero DECIMAL COMPLETO. No se usa parseInt suelto
 * porque acepta prefijos parciales: "1e5" daría 1 y "2000ms" daría 2000, de modo
 * que una configuración mal formada se aceptaría en silencio (review Codex #145).
 */
function parseStrictMs(value: unknown): number | null {
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
  return floored > 0 ? floored : null
}

const clampMs = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

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
  // Intención cruda del operador (ya validada, todavía sin acotar).
  const parsedGrace = parseStrictMs(input.previewKillGraceMs)
  const parsedWait = parseStrictMs(input.configuredTerminationWaitMs)
  const parsedMargin = parseStrictMs(input.exitConfirmationMarginMs)

  const previewKillGraceMs = parsedGrace != null
    ? clampMs(parsedGrace, MIN_KILL_GRACE_MS, MAX_KILL_GRACE_MS)
    : DEFAULT_KILL_GRACE_MS
  const exitConfirmationMarginMs = parsedMargin != null
    ? clampMs(parsedMargin, 500, 60_000)
    : EXIT_CONFIRMATION_MARGIN_MS
  const requestedTerminationWaitMs = parsedWait != null
    ? clampMs(parsedWait, MIN_TERMINATION_WAIT_MS, MAX_TERMINATION_WAIT_MS)
    : null

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
    // HONESTO: true siempre que lo que pidió el operador NO sea lo que corre —
    // ya sea porque se elevó al piso o porque se recortó al máximo. Antes un
    // valor por encima del tope se acotaba en silencio, sin log (Codex #145).
    wasClamped: parsedWait != null && effectiveTerminationWaitMs !== parsedWait,
    // El kill grace también puede haberse normalizado (p.ej. 100 corre como 500).
    killGraceWasNormalized: parsedGrace != null && previewKillGraceMs !== parsedGrace,
    exitConfirmationMarginMs,
  }
}

let cached: TerminationTiming | null = null
let clampLogged = false
let resolvedLogged = false

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
  if (!resolvedLogged) {
    resolvedLogged = true
    // SIEMPRE se registran los valores EFECTIVOS. El entorno crudo puede diferir
    // de lo que corre (un kill grace de 100 corre como 500; una espera de 900000
    // se recorta a 600000), así que leer las variables no alcanza para saber con
    // qué tiempos opera el proceso (review Codex #145).
    log?.(
      `[recordings-preview] recordings_termination_timing_resolved` +
      ` previewKillGraceMs=${cached.previewKillGraceMs}` +
      ` exitConfirmationMarginMs=${cached.exitConfirmationMarginMs}` +
      ` minimumTerminationWaitMs=${cached.minimumTerminationWaitMs}` +
      ` requestedTerminationWaitMs=${cached.requestedTerminationWaitMs ?? 'none'}` +
      ` effectiveTerminationWaitMs=${cached.effectiveTerminationWaitMs}` +
      ` wasClamped=${cached.wasClamped}` +
      ` killGraceWasNormalized=${cached.killGraceWasNormalized}`
    )
  }
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
  resolvedLogged = false
}
