// Lógica pura del ciclo de vida de un intento de preview (testeable sin FFmpeg/HTTP).
// Extraída de recordings.ts para poder probar la decisión crítica: qué bytes de
// stdout se aceptan como "primer byte" y con qué status HTTP se responde el fallo.

export interface AttemptGate {
  state: 'waiting_first_byte' | 'streaming' | 'terminal'
  variantTimedOut: boolean
  procExited: boolean
  clientGone: boolean
  responseEnded: boolean
}

/**
 * ¿Debe aceptarse este bloque de stdout como el primer byte válido?
 * Sólo si el intento sigue esperando el primer byte y nada lo terminó. Un byte
 * que llega tras el timeout/kill/cierre (NVR lento que vacía datos durante el
 * SIGTERM) NO debe aceptarse — enviaría un MP4 truncado y marcaría éxito falso.
 */
export function shouldAcceptFirstByte(g: AttemptGate): boolean {
  return g.state === 'waiting_first_byte'
    && !g.variantTimedOut
    && !g.procExited
    && !g.clientGone
    && !g.responseEnded
}

/** Status HTTP para el error final del preview según la categoría de la causa. */
export function errorStatusForCategory(category: string): number {
  switch (category) {
    case 'NVR_BANDWIDTH_OR_SESSION_LIMIT': return 503
    case 'NVR_OFFLINE_OR_TIMEOUT':         return 504
    case 'FIRST_BYTE_TIMEOUT':             return 504
    case 'AUTH_FAILED':                    return 401
    default:                               return 502
  }
}

/**
 * ¿La terminación de un intento es una CANCELACIÓN (no un fallo del NVR)?
 * No debe emitirse all_variants_failed ni error al cliente en estos casos.
 */
export function isCancellation(opts: { clientGone: boolean; sessionAlive: boolean }): boolean {
  return opts.clientGone || !opts.sessionAlive
}
