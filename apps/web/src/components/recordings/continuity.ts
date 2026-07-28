// Decisión PURA de continuidad entre bloques de grabación.
//
// P1 confirmado: dos mecanismos competían por la transición de un bloque al
// siguiente — el timer de continuidad (que pasaba a `no_recording` cuando el gap
// superaba CONTINUITY_GAP_MS=5000, exigiendo el botón "Saltar al siguiente
// bloque") y el watcher del reloj global (que re-arrancaba el siguiente bloque).
// Resultado: previews duplicados y cancelados (session_init repetidos, un gap real
// de 6000ms rompía la continuidad automática).
//
// Este módulo fija el contrato: UNA sola decisión por transición, con lock por
// slot (transitionKey) para impedir dos startPreview simultáneos.

export type ContinuityAction = 'start_now' | 'wait_clock' | 'none'

export interface NextBlock {
  recordingId: string
  effectiveStartMs: number
  effectiveEndMs: number
}

export interface ContinuityDecision {
  action: ContinuityAction
  reason: string
  /** slot|currentRecId|nextRecId|effectiveStartMs — identifica la transición. */
  transitionKey: string | null
  /** 1x1 / slot que maneja el reloj: adelantar el reloj global a nextEffectiveStart. */
  advanceClock: boolean
  gapMs: number
}

/** Clave única de una transición (para el lock por slot). */
export function transitionKey(
  slotIndex: number, currentRecordingId: string, nextRecordingId: string, effectiveStartMs: number,
): string {
  return `${slotIndex}|${currentRecordingId}|${nextRecordingId}|${effectiveStartMs}`
}

/**
 * Decide cómo continuar tras terminar un bloque.
 *  - Sin siguiente bloque → 'none'.
 *  - Multicámara (otras cámaras reproduciendo): NO adelantar el reloj global;
 *    poner el slot en waiting_next_recording y arrancar UNA vez cuando el reloj
 *    llegue a nextEffectiveStart ('wait_clock'). Si el bloque ya solapa (el reloj
 *    ya pasó el inicio, gap<=0) → 'start_now' inmediato.
 *  - 1x1 / slot que maneja el reloj: avanzar automáticamente el playhead a
 *    nextEffectiveStart y arrancar ('start_now', advanceClock). NO depende de
 *    CONTINUITY_GAP_MS: continúa para cualquier siguiente bloque del rango.
 */
export function decideContinuity(opts: {
  slotIndex: number
  currentRecordingId: string
  currentEffectiveEndMs: number
  next: NextBlock | null
  otherSlotsPlaying: boolean
}): ContinuityDecision {
  if (!opts.next) {
    return { action: 'none', reason: 'no_next_block', transitionKey: null, advanceClock: false, gapMs: 0 }
  }
  const key = transitionKey(opts.slotIndex, opts.currentRecordingId, opts.next.recordingId, opts.next.effectiveStartMs)
  const gapMs = opts.next.effectiveStartMs - opts.currentEffectiveEndMs

  if (opts.otherSlotsPlaying) {
    // Solape/contiguo con el reloj ya pasado → arrancar ya para no perder sincronía.
    if (gapMs <= 0) {
      return { action: 'start_now', reason: 'multicam_overlap', transitionKey: key, advanceClock: false, gapMs }
    }
    // Hueco: esperar a que el reloj global llegue (no adelantarlo — otras cámaras).
    return { action: 'wait_clock', reason: 'multicam_wait_gap', transitionKey: key, advanceClock: false, gapMs }
  }

  // 1x1 / slot que maneja el reloj: avanzar y arrancar. El hueco sólo significa
  // que se salta el aire muerto — nunca se muestra no_recording ni se exige clic.
  return {
    action: 'start_now',
    reason: gapMs > 0 ? 'auto_jump_gap' : (gapMs < 0 ? 'overlap' : 'contiguous'),
    transitionKey: key, advanceClock: true, gapMs,
  }
}

/**
 * ¿El reloj global ya alcanzó el inicio efectivo del siguiente bloque? (para el
 * camino 'wait_clock' de multicámara — arrancar exactamente una vez al llegar).
 */
export function clockReachedNextStart(clockMs: number, nextEffectiveStartMs: number): boolean {
  return clockMs >= nextEffectiveStartMs
}

/**
 * Lock por slot: ¿se puede tomar posesión de ESTA transición? Sólo si aún no se
 * tomó la misma (mismo transitionKey). Impide que el timer de continuidad y el
 * watcher del reloj arranquen dos previews para la misma transición.
 */
export function canClaimTransition(currentClaimedKey: string | null | undefined, newKey: string): boolean {
  return currentClaimedKey !== newKey
}
