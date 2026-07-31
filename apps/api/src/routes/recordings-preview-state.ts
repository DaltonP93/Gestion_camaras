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
    // Video decodifica pero el mux A/V (G.711) no produce salida — se sirve
    // video-only; si aun así falla es un error del pipeline, no del NVR.
    case 'AUDIO_SYNC_OR_MUX_FAILURE':      return 502
    // Audio inválido (none/unknown/sin decoder): NO es un fallo de video. El
    // preview cae a video-only; sólo llega aquí si video-only tampoco produjo
    // salida, así que se trata como problema del pipeline (502), nunca 4xx de
    // "códec no soportado" que dispararía un retry H.264 indebido.
    case 'AUDIO_STREAM_INVALID':           return 502
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

// Superficie del registro que necesita la decisión de takeover (para testear con un
// doble sin construir Fastify). La implementa PreviewProcessRegistry.
export interface TakeoverRegistry {
  aliveCount(): number
  terminateAll(reason: string, hooks?: unknown): Promise<void>
  waitAllExited(timeoutMs: number): Promise<boolean>
}

export type TakeoverOutcome =
  | { proceed: true }
  | { proceed: false; status: number; code: string }

/**
 * Decisión del TAKEOVER de un segundo GET /stream (req 1, 2, 6, 10). El route llama
 * ESTA función — no una reimplementación — para que el test la cubra de verdad.
 *
 * Si no hay procesos vivos → proceder (spawn). Si los hay: terminar TODOS y esperar
 * su SALIDA REAL (exit/close) de forma acotada. El siguiente FFmpeg SÓLO puede
 * crearse cuando aliveCount()===0 tras esa salida real; si al vencer el deadline
 * sigue vivo alguno (p.ej. SIGKILL enviado pero sin exit todavía), NO se procede:
 * se responde 503 PREVIOUS_FFMPEG_NOT_REAPED y NUNCA se spawnea un segundo proceso.
 */
export async function resolveStreamTakeover(
  reg: TakeoverRegistry,
  opts: { reason: string; deadlineMs: number; hooks?: unknown; onTakeoverStart?: (alive: number) => void },
): Promise<TakeoverOutcome> {
  if (reg.aliveCount() === 0) return { proceed: true }
  opts.onTakeoverStart?.(reg.aliveCount())
  void reg.terminateAll(opts.reason, opts.hooks)
  const reaped = await reg.waitAllExited(opts.deadlineMs)
  if (!reaped || reg.aliveCount() > 0) {
    return { proceed: false, status: 503, code: 'PREVIOUS_FFMPEG_NOT_REAPED' }
  }
  return { proceed: true }
}
