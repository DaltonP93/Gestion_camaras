// Observación REAL del pipeline de streaming (server-side) — lógica PURA.
//
// Reemplaza la observación anterior basada en rtspMainOk/rtspSubOk persistidos,
// que podían quedar true indefinidamente (evidencia real: Sala Recuperación
// Endoscopía con InputProxy ONLINE, rtspSubOk=true, streamHealthStatus=HEALTHY…
// y MediaMTX sin entregar video → nunca se creaba CAMERA_STREAM_ERROR).
//
// La observación se construye con el estado RUNTIME de MediaMTX (/v3/paths/list)
// y evidencia de demanda. CLAVE: los paths son sourceOnDemand — un path "no listo"
// SIN demanda es un path ocioso (benigno), NO un fallo. Sólo cuenta como fallo el
// path que no entrega video HABIENDO demanda real (sesiones activas o un intento
// de stream fallido reciente). Sin esta distinción, las ~140 cámaras ociosas
// generarían falsos CAMERA_STREAM_ERROR en cada ciclo.

import type { HealthObservation } from './camera-health-debounce'

export interface MediaMtxRuntimeSnapshot {
  /** El path existe en la config de MediaMTX. null = API de config no disponible. */
  configured: boolean | null
  /** El path apareció en /v3/paths/list (estado runtime). null = API no disponible. */
  runtimeFound: boolean | null
  /** MediaMTX reporta el source conectado y listo. */
  ready: boolean
  /** Bytes recibidos del origen RTSP. */
  bytesReceived: number
  /** Lectores (consumidores) conectados ahora. */
  readers: number
}

export interface StreamDemandEvidence {
  /** Sesiones de stream activas para esta cámara (stream-manager). */
  activeSessions: number
  /** Último start-stream con error DURO de pipeline (epoch ms; null = nunca). */
  lastStreamFailureAt: number | null
  /** Último start-stream exitoso (epoch ms; null = nunca). */
  lastStreamSuccessAt: number | null
  /** Última entrega HLS verificada (sonda o uso real) (epoch ms; null = nunca). */
  lastHlsSuccessAt: number | null
}

export interface StreamObservationResult {
  observation: HealthObservation
  reason: string
  /** ¿Hay demanda real dentro de la ventana? (para logs/diagnóstico) */
  demandActive: boolean
}

export const DEFAULT_DEMAND_WINDOW_MS = 10 * 60 * 1000  // 10 min

/**
 * Clasifica el estado del pipeline en ONLINE/OFFLINE/UNKNOWN para el debounce.
 * PURA: el reloj entra por parámetro (tests deterministas).
 *
 *  - ready                          → ONLINE (MediaMTX entrega; da igual la demanda)
 *  - API MediaMTX caída             → UNKNOWN (sin evidencia; jamás falso positivo)
 *  - no listo + demanda en ventana  → OFFLINE (fallo real: piden video y no sale)
 *  - no listo + sin demanda         → UNKNOWN (path on-demand ocioso — benigno)
 *  - path sin configurar + demanda  → OFFLINE (debería existir si hay demanda)
 */
export function observeStreamPipeline(
  mtx: MediaMtxRuntimeSnapshot,
  demand: StreamDemandEvidence,
  now: number,
  demandWindowMs: number = DEFAULT_DEMAND_WINDOW_MS,
): StreamObservationResult {
  const inWindow = (ts: number | null) => ts != null && now - ts <= demandWindowMs
  // Demanda real: hay sesiones vivas, o hubo un intento de stream FALLIDO reciente
  // más nuevo que el último éxito (si el último evento fue un éxito y el viewer se
  // fue, el path se apaga solo — eso no es demanda insatisfecha).
  const failedAfterSuccess =
    inWindow(demand.lastStreamFailureAt) &&
    (demand.lastStreamFailureAt as number) >= (demand.lastStreamSuccessAt ?? 0)
  const demandActive = demand.activeSessions > 0 || failedAfterSuccess

  // Sin API de MediaMTX no hay evidencia runtime: nunca inventar un fallo.
  if (mtx.runtimeFound === null) {
    return { observation: 'UNKNOWN', reason: 'mediamtx_api_unavailable', demandActive }
  }

  if (mtx.ready) {
    return { observation: 'ONLINE', reason: mtx.readers > 0 ? 'mediamtx_ready_with_readers' : 'mediamtx_ready', demandActive }
  }

  // No listo. ¿Path ni siquiera configurado?
  if (mtx.configured === false) {
    return demandActive
      ? { observation: 'OFFLINE', reason: 'path_missing_with_demand', demandActive }
      : { observation: 'UNKNOWN', reason: 'path_missing_idle', demandActive }
  }

  // Configurado pero sin source listo.
  if (demandActive) {
    return { observation: 'OFFLINE', reason: 'source_not_ready_with_demand', demandActive }
  }
  return { observation: 'UNKNOWN', reason: 'idle_on_demand', demandActive }
}
