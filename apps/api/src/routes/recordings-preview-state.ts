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
    // Categorías granulares por etapa (classifyStageFailure).
    case 'RTSP_AUTH_FAILED':               return 401
    case 'RTSP_OPEN_TIMEOUT':              return 504
    case 'RTSP_OPENED_NO_PACKETS':         return 504
    case 'VIDEO_NO_KEYFRAME':              return 504
    case 'MUXER_NO_OUTPUT':                return 504
    case 'OUTPUT_PIPE_DRAIN_RACE':         return 504
    case 'STARTUP_BUDGET_EXCEEDED':        return 504
    case 'ENCODE_FAILED':                  return 500
    default:                               return 502
  }
}

/**
 * ¿Hubo una CARRERA DE DRENAJE del pipe? Aparecieron bytes de stdout pero no se
 * aceptaron como primer byte porque el intento ya había terminado
 * (timeout/kill/exit). Prueba que FFmpeg SÍ producía salida muxeada: el punto de
 * detención NO es un rechazo del NVR sino la salida/tiempo. Se usa para no
 * clasificar erróneamente track 101 como URI rechazada.
 */
export function isDrainRace(opts: {
  variantTimedOut: boolean; procExited: boolean; sawStdoutByte: boolean; firstByteAccepted: boolean
}): boolean {
  return opts.sawStdoutByte && !opts.firstByteAccepted && (opts.variantTimedOut || opts.procExited)
}

/**
 * ¿La terminación de un intento es una CANCELACIÓN (no un fallo del NVR)?
 * No debe emitirse all_variants_failed ni error al cliente en estos casos.
 */
export function isCancellation(opts: { clientGone: boolean; sessionAlive: boolean }): boolean {
  return opts.clientGone || !opts.sessionAlive
}
