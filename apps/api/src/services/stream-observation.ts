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

// ═══ Observación por PATHS EFECTIVOS (corrige falsos positivos por inspeccionar
//     el path equivocado: el worker sondeaba _sub mientras el usuario reproducía
//     _main/_main_h264 por fallback — caso real: Salida UTI con video en vivo y
//     CAMERA_STREAM_ERROR generado igual) ═══════════════════════════════════════

export type EffectiveStreamType = 'sub' | 'main' | 'main_h264' | 'unknown'

export interface DemandedPathState {
  path: string
  streamType: EffectiveStreamType
  sessions: number              // sesiones activas sobre ESTE path
  configured: boolean | null
  runtimeFound: boolean | null
  ready: boolean
  bytesReceived: number
  readers: number
  /** ¿Los bytes progresaron desde el ciclo anterior? null = sin historial. */
  bytesProgressed: boolean | null
}

export interface CameraPipelineResult {
  observation: HealthObservation
  reason: string
  demandActive: boolean
  /** Entrega video por fallback main/main_h264 con el substream caído. */
  degraded: boolean
}

export interface CameraDemandEvidence {
  activeSessions: number
  lastStreamFailureAt: number | null
  /** start-stream ACEPTADO (no prueba de frames — ver lastHlsSuccessAt). */
  lastStreamStartAcceptedAt: number | null
  lastHlsSuccessAt: number | null
}

/**
 * Observa TODOS los paths efectivamente demandados de una cámara. Regla central:
 * si CUALQUIER path demandado entrega video (ready y, con lectores, con bytes
 * progresando), la cámara está ONLINE — jamás CAMERA_STREAM_ERROR. Un path ready
 * con lectores cuyos bytes NO progresan entre ciclos es un stream CONGELADO y
 * cuenta como fallo (siempre sobre el path efectivo).
 */
export function observeCameraPaths(
  paths: DemandedPathState[],
  demand: CameraDemandEvidence,
  subKnownDown: boolean,
  now: number,
  demandWindowMs: number = DEFAULT_DEMAND_WINDOW_MS,
): CameraPipelineResult {
  const inWindow = (ts: number | null) => ts != null && now - ts <= demandWindowMs
  const failedAfterAccept =
    inWindow(demand.lastStreamFailureAt) &&
    (demand.lastStreamFailureAt as number) >= (demand.lastStreamStartAcceptedAt ?? 0)
  const demandActive = demand.activeSessions > 0 || failedAfterAccept

  if (paths.length === 0 || paths.every(p => p.runtimeFound === null)) {
    return { observation: 'UNKNOWN', reason: 'mediamtx_api_unavailable', demandActive, degraded: false }
  }

  const isFrozen = (p: DemandedPathState) => p.ready && p.readers > 0 && p.bytesProgressed === false
  const delivering = paths.filter(p => p.ready && !isFrozen(p))
  if (delivering.length > 0) {
    // ¿Entrega por fallback con el sub caído? (sub demandado sin entregar, o
    // rtspSubOk=false persistido, mientras un main/main_h264 sí entrega)
    const subFailing = subKnownDown ||
      paths.some(p => p.streamType === 'sub' && !p.ready)
    const mainDelivers = delivering.some(p => p.streamType === 'main' || p.streamType === 'main_h264')
    const degraded = subFailing && mainDelivers
    return {
      observation: 'ONLINE',
      reason: degraded ? 'delivering_via_fallback' : 'path_delivering',
      demandActive, degraded,
    }
  }

  const frozen = paths.filter(isFrozen)
  if (frozen.length > 0 && demandActive) {
    return { observation: 'OFFLINE', reason: `frozen_stream:${frozen[0].path}`, demandActive, degraded: false }
  }

  if (!demandActive) {
    return { observation: 'UNKNOWN', reason: 'idle_on_demand', demandActive, degraded: false }
  }
  const anyConfigured = paths.some(p => p.configured !== false)
  return {
    observation: 'OFFLINE',
    reason: anyConfigured ? 'source_not_ready_with_demand' : 'path_missing_with_demand',
    demandActive, degraded: false,
  }
}

/**
 * Aplica el resultado de una sonda HLS a la observación previa. status=0 (no se
 * pudo NI contactar el endpoint HLS — probable infra/nginx/mediamtx reiniciando)
 * NO fuerza OFFLINE por sí solo: sólo mantiene OFFLINE si hay evidencia adicional
 * del path efectivo (MediaMTX no ready Y un start-stream fallido real).
 */
export function applyProbeResult(
  prior: { observation: HealthObservation; reason: string },
  probe: { playable: boolean; status: number },
  extra: { anyPathReady: boolean; hardStartFailure: boolean },
): { observation: HealthObservation; reason: string } {
  if (probe.playable) return { observation: 'ONLINE', reason: 'hls_probe_playable' }
  if (probe.status === 0) {
    if (!extra.anyPathReady && extra.hardStartFailure) {
      return { observation: 'OFFLINE', reason: `${prior.reason}+hls_unreachable_with_evidence` }
    }
    return { observation: 'UNKNOWN', reason: 'hls_probe_unreachable_inconclusive' }
  }
  return { observation: 'OFFLINE', reason: `${prior.reason}+hls_probe_status_${probe.status}` }
}

/**
 * Fairness round-robin del presupuesto de sondas: prioriza las cámaras sondeadas
 * hace MÁS tiempo (nunca sondeadas primero). Con más candidatas que presupuesto,
 * todas reciben sonda en ciclos sucesivos — no siempre las tres primeras.
 */
export function selectProbeTargets(
  candidateIds: string[],
  lastProbedAt: Map<string, number>,
  budget: number,
): string[] {
  return [...candidateIds]
    .sort((a, b) => (lastProbedAt.get(a) ?? 0) - (lastProbedAt.get(b) ?? 0))
    .slice(0, Math.max(0, budget))
}
