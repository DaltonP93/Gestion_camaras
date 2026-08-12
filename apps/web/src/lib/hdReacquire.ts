// src/lib/hdReacquire.ts
//
// Decisión PURA de cuándo volver a pedir alta calidad tras una ocultación larga.
//
// EL DEFECTO QUE CORRIGE (revisión de #146): la guarda vivía en un ref por
// CÁMARA que sólo se reseteaba al cambiar de cámara en foco. Después de una
// readquisición exitosa, una segunda ocultación larga sobre la misma cámara ya
// no volvía a pedir HD, porque la cámara seguía marcada como "ya atendida".
//
// La guarda pertenece al CICLO `hidden → visible`, no a la cámara. El sello del
// ciclo es el instante en que la pestaña se ocultó: ciclos distintos tienen
// sellos distintos, así que cada ocultación larga puede intentarlo una vez.

export interface HdReacquireState {
  /** Sello (hiddenAt) del último ciclo ya atendido. null = ninguno. */
  handledCycle: number | null
  /** Hay un intento en curso: evita dobles arranques por eventos duplicados. */
  inFlight: boolean
}

export interface HdReacquireInput {
  /** Instante en que la pestaña se ocultó; null si nunca se ocultó. */
  hiddenAt: number | null
  /** Cuánto estuvo oculta (ms). */
  hiddenMs: number
  /** TTL EFECTIVO de la sesión HD según el backend (ms). */
  hdTtlMs: number
  /** ¿Hay una cámara en foco con calidad alta? */
  focusIsHd: boolean
  state: HdReacquireState
}

export interface HdReacquireDecision {
  /** ¿Debe dispararse el re-pedido de HD ahora? */
  shouldReacquire: boolean
  /** Estado a persistir tras la decisión. */
  nextState: HdReacquireState
  reason:
    | 'reacquire'
    | 'not_hd'
    | 'within_ttl'
    | 'cycle_already_handled'
    | 'in_flight'
    | 'never_hidden'
}

/**
 * PURA. Decide si corresponde readquirir HD al volver la pestaña a visible.
 *
 * Se readquiere cuando: hay foco en HD, la ocultación superó el TTL efectivo,
 * este ciclo todavía no fue atendido y no hay otro intento en curso.
 */
export function decideHdReacquire(input: HdReacquireInput): HdReacquireDecision {
  const { hiddenAt, hiddenMs, hdTtlMs, focusIsHd, state } = input
  const keep = (reason: HdReacquireDecision['reason']): HdReacquireDecision =>
    ({ shouldReacquire: false, nextState: state, reason })

  if (!focusIsHd) return keep('not_hd')
  if (hiddenAt === null) return keep('never_hidden')
  if (hiddenMs <= hdTtlMs) return keep('within_ttl')
  if (state.inFlight) return keep('in_flight')
  if (state.handledCycle === hiddenAt) return keep('cycle_already_handled')

  return {
    shouldReacquire: true,
    nextState: { handledCycle: hiddenAt, inFlight: true },
    reason: 'reacquire',
  }
}

/** Estado tras terminar un intento (con éxito o no): libera el single-flight. */
export function finishHdReacquire(state: HdReacquireState): HdReacquireState {
  return { ...state, inFlight: false }
}

/** Estado inicial. */
export const initialHdReacquireState: HdReacquireState = { handledCycle: null, inFlight: false }

// ─── Fallback tras un intento fallido ────────────────────────────────────────

export interface HdAttemptResult {
  ok: boolean
  errorCode?: string
}

export interface HdFallbackPlan {
  /** Tipo de stream que debe quedar en foco. */
  streamType: 'sub' | 'main' | 'main_h264'
  /** ¿Se muestra un overlay de error sobre la tarjeta? */
  showErrorOverlay: boolean
  /** ¿Hay que limpiar focusStreamInfo? */
  clearStreamInfo: boolean
  /** ¿Hay que remontar el player? */
  remountPlayer: boolean
}

/**
 * PURA. Qué hacer con la tarjeta tras un intento de readquirir HD.
 *
 * Si el intento falla —incluido el 429 de límite— se RESTAURA la baja calidad y
 * NO se muestra overlay: la transición posterior a una pestaña oculta no puede
 * dejar la tarjeta en negro ni tapar un substream que sí se puede reproducir.
 * El tratamiento general del 429 (mensaje exacto, botones) sigue siendo B1.
 *
 * La decisión se toma con el RESULTADO del intento, nunca leyendo estado de
 * React recién fijado, que puede no haberse renderizado todavía.
 */
export function decideHdFallback(result: HdAttemptResult): HdFallbackPlan {
  if (result.ok) {
    return { streamType: 'main_h264', showErrorOverlay: false, clearStreamInfo: false, remountPlayer: false }
  }
  return {
    streamType: 'sub',
    showErrorOverlay: false,   // nunca tapar la baja calidad con el error del HD
    clearStreamInfo: true,     // evita la combinación que produce pantalla negra
    remountPlayer: true,
  }
}
