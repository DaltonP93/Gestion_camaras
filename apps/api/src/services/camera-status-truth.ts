// Fuente de verdad ÚNICA del estado online/offline de una cámara.
//
// P0 confirmado en producción: un canal que el NVR reporta OFFLINE (y con ambos
// RTSP fallando) seguía mostrándose "Online (RTSP)" porque el frontend confiaba en
// `rtspMainOk`/`rtspSubOk`/`online` HISTÓRICOS y dejaba que prevalecieran sobre un
// `onlineInNvr=false` actual. Nada expiraba esos valores viejos.
//
// Este módulo PURO (reloj inyectado, sin DB/red) reconcilia TODAS las observaciones
// con su antigüedad y aplica una precedencia fija, devolviendo además el motivo de
// la decisión y metadatos de frescura (para diagnóstico). Lo consumen el worker de
// salud (para persistir la verdad) y el frontend (para mostrarla) — misma lógica.
//
// Precedencia (de mayor a menor autoridad):
//   AUTH_FAILED  >  OFFLINE confirmado por el NVR (reciente)  >  ambos RTSP fallidos
//   (reciente)  >  STREAM_DEGRADED (un stream)  >  HEALTHY  >  UNKNOWN.
// Regla clave: una observación RECIENTE de `onlineInNvr=false` PREVALECE sobre
// éxitos RTSP antiguos; y ninguna observación vencida (stale) cuenta como evidencia
// positiva (un `rtspOk=true` viejo no mantiene la cámara en verde).

export type CameraEffectiveStatus =
  | 'AUTH_FAILED'
  | 'OFFLINE'
  | 'STREAM_DEGRADED'
  | 'HEALTHY'
  | 'UNKNOWN'

export interface CameraStatusInput {
  onlineInNvr: boolean | null | undefined
  /** epoch ms de la última observación de onlineInNvr (worker de salud). */
  onlineInNvrAt: number | null | undefined
  rtspMainOk: boolean | null | undefined
  rtspSubOk: boolean | null | undefined
  /** epoch ms de la última verificación RTSP (validador de stream). */
  rtspCheckedAt: number | null | undefined
  /** streamHealthStatus persistido — sólo se usa para detectar AUTH_FAILED. */
  streamHealthStatus?: string | null
  /** Ventana de validez de una observación (ms). Por defecto 5 min. */
  ttlMs?: number
}

export interface CameraStatusResult {
  effectiveStatus: CameraEffectiveStatus
  /** Decisión booleana única para la UI/tabla (verde vs rojo). */
  online: boolean
  /** Qué observación determinó la decisión. */
  source: 'nvr' | 'rtsp' | 'stream_health' | 'none'
  /** true si NO hubo ninguna observación fresca (todo vencido). */
  stale: boolean
  /** epoch ms de la observación que decidió (o null). */
  observedAt: number | null
  /** epoch ms en que esa observación vence (observedAt + ttl), o null. */
  expiresAt: number | null
  /** Motivo legible de la decisión (para diagnóstico/log). */
  finalDecisionReason: string
}

export const DEFAULT_STATUS_TTL_MS = 5 * 60 * 1000

/**
 * Resuelve el estado efectivo de una cámara a partir de sus observaciones y su
 * antigüedad, en el instante `nowMs`. Determinista y sin efectos.
 */
export function resolveCameraStatus(input: CameraStatusInput, nowMs: number): CameraStatusResult {
  const ttl = input.ttlMs ?? DEFAULT_STATUS_TTL_MS
  const fresh = (ts: number | null | undefined): ts is number =>
    typeof ts === 'number' && Number.isFinite(ts) && nowMs - ts <= ttl && nowMs - ts >= -ttl

  const nvrAt  = input.onlineInNvrAt ?? null
  const rtspAt = input.rtspCheckedAt ?? null
  const nvrFresh  = fresh(nvrAt)
  const rtspFresh = fresh(rtspAt)

  const authFailed        = input.streamHealthStatus === 'AUTH_FAILED'
  const nvrOfflineRecent  = input.onlineInNvr === false && nvrFresh
  const nvrOnlineRecent   = input.onlineInNvr === true  && nvrFresh
  const mainOk = input.rtspMainOk === true
  const subOk  = input.rtspSubOk === true
  const mainFail = input.rtspMainOk === false
  const subFail  = input.rtspSubOk === false
  const bothRtspFailedRecent = rtspFresh && mainFail && subFail
  const anyRtspOkRecent      = rtspFresh && (mainOk || subOk)
  const degradedRecent       = rtspFresh && ((mainOk && subFail) || (subOk && mainFail))

  const mk = (
    effectiveStatus: CameraEffectiveStatus, online: boolean,
    source: CameraStatusResult['source'], observedAt: number | null,
    finalDecisionReason: string, stale = false,
  ): CameraStatusResult => ({
    effectiveStatus, online, source, stale, observedAt,
    expiresAt: observedAt != null ? observedAt + ttl : null,
    finalDecisionReason,
  })

  // 1) AUTH_FAILED gana, PERO sólo si es RECIENTE. streamHealthStatus lo escribe el
  //    validador RTSP junto con lastRtspCheckAt; el worker de salud no lo limpia, así
  //    que un AUTH_FAILED viejo NO debe fijar la cámara en "Auth fallida" para siempre
  //    tras reparar credenciales — debe vencer como cualquier otra evidencia (review
  //    Codex #126). Si está vencido, se ignora y se evalúan las reglas siguientes.
  if (authFailed && rtspFresh) return mk('AUTH_FAILED', false, 'stream_health', rtspAt, 'auth_failed')

  // 2) OFFLINE confirmado por el NVR (reciente) PREVALECE sobre éxitos RTSP viejos.
  if (nvrOfflineRecent) return mk('OFFLINE', false, 'nvr', nvrAt, 'nvr_reports_offline_recent')

  // 3) Ambos RTSP fallaron en una verificación reciente → offline.
  if (bothRtspFailedRecent) return mk('OFFLINE', false, 'rtsp', rtspAt, 'both_rtsp_failed_recent')

  // 4) Un stream reciente responde (el otro no) → degradado pero online.
  if (degradedRecent) return mk('STREAM_DEGRADED', true, 'rtsp', rtspAt, 'one_stream_only_recent')

  // 5) Algún RTSP reciente OK → healthy.
  if (anyRtspOkRecent) return mk('HEALTHY', true, 'rtsp', rtspAt, 'rtsp_ok_recent')

  // 6) NVR reciente ONLINE pero RTSP no verificado (o vencido) → online por NVR.
  if (nvrOnlineRecent) return mk('HEALTHY', true, 'nvr', nvrAt, 'nvr_online_rtsp_unverified')

  // 7) Nada fresco: NO afirmar online con datos vencidos. Si lo último conocido del
  //    NVR fue offline, mantener OFFLINE (stale); si no, UNKNOWN. Un rtspOk viejo
  //    NUNCA vuelve a poner la cámara en verde.
  if (input.onlineInNvr === false) return mk('OFFLINE', false, 'nvr', nvrAt, 'nvr_offline_stale', true)
  const lastObserved = [nvrAt, rtspAt].filter((t): t is number => typeof t === 'number').sort((a, b) => b - a)[0] ?? null
  return mk('UNKNOWN', false, 'none', lastObserved, 'all_observations_stale', true)
}
