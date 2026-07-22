// Diagnóstico de PIPELINE de streaming (MediaMTX/HLS/RTSP) — lógica PURA.
// Distingue una falla de señal FÍSICA (InputProxy) de una falla de PIPELINE:
// un HLS 500 con la cámara físicamente ONLINE es CAMERA_STREAM_ERROR, NO
// CAMERA_OFFLINE. También clasifica el estado del path de MediaMTX sin reiniciar
// el stream en loop (el caller aplica backoff y tope de intentos).

import type { HealthObservation } from './camera-health-debounce'

// ── Gating del debounce de stream-error (TASK 4) ─────────────────────────────
// El debounce de pipeline SÓLO debe alimentarse cuando la señal física NO es
// OFFLINE confirmada: si la cámara está físicamente caída, que el stream falle es
// esperado y no debe generar un CAMERA_STREAM_ERROR además del CAMERA_OFFLINE.
export function shouldFeedStreamDebounce(inputProxyStatus: 'ONLINE' | 'OFFLINE' | 'UNKNOWN'): boolean {
  return inputProxyStatus === 'ONLINE' || inputProxyStatus === 'UNKNOWN'
}

// ── Clasificación del estado del path de MediaMTX (TASK 5) ───────────────────
export type MediaMtxPathState =
  | 'PATH_MISSING'       // el path no existe en MediaMTX
  | 'PATH_NO_SOURCE'     // configurado pero sin source
  | 'SOURCE_NOT_READY'   // source definido pero no listo (aún conectando)
  | 'READER_NO_DATA'     // listo pero sin datos que fluyan
  | 'HLS_NOT_READY'      // muxer HLS aún no preparado
  | 'RTSP_REJECTED'      // el origen RTSP fue rechazado
  | 'READY'              // path listo y con datos
  | 'UNKNOWN'

export interface MediaMtxPathInfo {
  found: boolean               // /v3/paths/get devolvió 200 (existe)
  confName?: string | null     // nombre de la config del path
  source?: string | null       // origen actual (null si sin source)
  ready?: boolean              // MediaMTX reporta el path listo
  bytesReceived?: number       // bytes recibidos del origen
  readers?: number             // consumidores conectados
  hlsReady?: boolean           // el manifest HLS ya está disponible
  rtspError?: string | null    // último error RTSP del origen (si lo hay)
}

export function classifyMediaMtxPath(info: MediaMtxPathInfo): MediaMtxPathState {
  if (!info.found) return 'PATH_MISSING'
  if (info.rtspError && /40[0-9]|unauthor|rejected|refused/i.test(info.rtspError)) return 'RTSP_REJECTED'
  if (!info.source) return 'PATH_NO_SOURCE'
  if (!info.ready) return 'SOURCE_NOT_READY'
  if ((info.bytesReceived ?? 0) <= 0) return 'READER_NO_DATA'
  if (info.hlsReady === false) return 'HLS_NOT_READY'
  return 'READY'
}

// ¿El estado de MediaMTX representa un fallo DURO del pipeline (cuenta para el
// debounce de stream-error) o un estado transitorio benigno (aún preparando)?
export function mediaMtxStateToObservation(state: MediaMtxPathState): HealthObservation {
  switch (state) {
    case 'READY':            return 'ONLINE'
    case 'PATH_MISSING':     // el path debería existir mientras hay demanda
    case 'RTSP_REJECTED':
    case 'READER_NO_DATA':
      return 'OFFLINE'
    // Estados transitorios: no penalizar todavía (evita falsos positivos al armar).
    case 'PATH_NO_SOURCE':
    case 'SOURCE_NOT_READY':
    case 'HLS_NOT_READY':
    default:
      return 'UNKNOWN'
  }
}

// ── Backoff con tope (TASK 5): no reiniciar el stream en loop ────────────────
export function nextBackoffMs(attempt: number, baseMs = 2000, maxMs = 60_000): number {
  const ms = baseMs * Math.pow(2, Math.max(0, attempt))
  return Math.min(maxMs, ms)
}
export function shouldAttemptRestart(attempt: number, maxAttempts = 5): boolean {
  return attempt < maxAttempts
}
