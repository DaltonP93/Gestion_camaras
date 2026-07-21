// Máquina de estados de DEBOUNCE de salud de cámara — PURA y testeable (sin DB,
// sin red, sin reloj real: el tiempo entra por parámetro). Evita tormentas de
// alertas: una sola lectura offline NO crea alerta; se confirma tras N lecturas
// consecutivas o T segundos; se recupera tras M lecturas online. UNKNOWN nunca
// incrementa ni reinicia los contadores (una lectura ISAPI fallida no debe marcar
// offline ni disparar 31 alertas falsas).
//
// El MISMO reductor sirve para dos dominios independientes por cámara:
//  - salud física (InputProxy): OFFLINE = sin señal → CAMERA_OFFLINE
//  - salud de pipeline (RTSP/MediaMTX/HLS): OFFLINE = stream falla → CAMERA_STREAM_ERROR

export type HealthObservation = 'ONLINE' | 'OFFLINE' | 'UNKNOWN'
export type DebouncePhase = 'ONLINE' | 'OFFLINE_PENDING' | 'OFFLINE_CONFIRMED'

export interface DebounceState {
  phase: DebouncePhase
  offlineStreak: number
  onlineStreak: number
  firstFailureAt: number | null   // epoch ms de la 1ª lectura offline de la racha
  confirmedAt: number | null      // epoch ms de la confirmación (para el detalle)
}

export interface DebounceConfig {
  offlineConfirmChecks: number    // p.ej. 3 lecturas consecutivas
  offlineConfirmMs: number        // …o este tiempo desde el 1er fallo (p.ej. 90000)
  recoveryConfirmChecks: number   // p.ej. 2 lecturas online para recuperar
}

// Acción que el caller (healthWorker) debe ejecutar tras el paso.
export type DebounceAction =
  | 'none'
  | 'offline_pending'   // 1er offline: log camera_offline_pending, NO alerta
  | 'confirm_offline'   // confirmado: crear/dedup alerta + notificar
  | 'recover'           // confirmado→online: resolver alerta + notificar recuperación

export function initialDebounceState(): DebounceState {
  return { phase: 'ONLINE', offlineStreak: 0, onlineStreak: 0, firstFailureAt: null, confirmedAt: null }
}

export const DEFAULT_DEBOUNCE: DebounceConfig = {
  offlineConfirmChecks: 3,
  offlineConfirmMs: 90_000,
  recoveryConfirmChecks: 2,
}

/**
 * Avanza la máquina con UNA observación. Devuelve el nuevo estado (inmutable) y la
 * acción a ejecutar. `now` es epoch ms (inyectado → tests deterministas).
 */
export function stepDebounce(
  prev: DebounceState,
  obs: HealthObservation,
  now: number,
  config: DebounceConfig = DEFAULT_DEBOUNCE,
): { state: DebounceState; action: DebounceAction } {
  // UNKNOWN: no toca contadores ni fase (evidencia insuficiente).
  if (obs === 'UNKNOWN') {
    return { state: { ...prev }, action: 'none' }
  }

  if (obs === 'OFFLINE') {
    const firstFailureAt = prev.firstFailureAt ?? now
    const offlineStreak = prev.offlineStreak + 1
    const next: DebounceState = {
      ...prev, offlineStreak, onlineStreak: 0, firstFailureAt,
    }
    if (prev.phase === 'OFFLINE_CONFIRMED') {
      return { state: next, action: 'none' }   // ya confirmado: no repetir
    }
    const elapsed = now - firstFailureAt
    const shouldConfirm = offlineStreak >= config.offlineConfirmChecks || elapsed >= config.offlineConfirmMs
    if (shouldConfirm) {
      return { state: { ...next, phase: 'OFFLINE_CONFIRMED', confirmedAt: now }, action: 'confirm_offline' }
    }
    if (prev.phase === 'ONLINE') {
      return { state: { ...next, phase: 'OFFLINE_PENDING' }, action: 'offline_pending' }
    }
    return { state: next, action: 'none' }   // sigue PENDING, aún sin confirmar
  }

  // obs === 'ONLINE'
  const onlineStreak = prev.onlineStreak + 1
  const next: DebounceState = { ...prev, onlineStreak, offlineStreak: 0 }
  if (prev.phase === 'ONLINE') {
    return { state: { ...next, firstFailureAt: null }, action: 'none' }
  }
  // venía de PENDING o CONFIRMED
  if (onlineStreak >= config.recoveryConfirmChecks) {
    const wasConfirmed = prev.phase === 'OFFLINE_CONFIRMED'
    return {
      state: { ...next, phase: 'ONLINE', firstFailureAt: null, confirmedAt: null },
      // Sólo hay que resolver/notificar si LLEGÓ a confirmarse (creó alerta).
      action: wasConfirmed ? 'recover' : 'none',
    }
  }
  return { state: next, action: 'none' }   // esperando la 2ª lectura online
}

// ── Filtro de razones de fallo de streaming (TASK 4) ──────────────────────────
// Un fallo de pipeline SÓLO cuenta si es "duro". Las razones del cliente por
// cancelación de navegación / cleanup / cierre voluntario NO son evidencia de
// fallo y se tratan como UNKNOWN (no incrementan el contador de stream-error).
const SOFT_STREAM_REASONS = new Set([
  'url_cleared', 'effect_cleanup', 'cleanup', 'navigation', 'unmount',
  'viewer_closed', 'no_consumers', 'user_stopped', 'component_unmount',
  'session_alive_cookie_expired',
])

export function isHardStreamFailure(reason: string | undefined | null): boolean {
  if (!reason) return false
  return !SOFT_STREAM_REASONS.has(reason.toLowerCase().trim())
}

// ¿La cámara está en mantenimiento? (no debe generar alertas — TASK 6). `now` es
// epoch ms. maintenanceMode = manual; maintenanceUntil = ventana con expiración.
export function isCameraInMaintenance(
  camera: { maintenanceMode?: boolean | null; maintenanceUntil?: Date | string | null },
  now: number,
): boolean {
  if (camera.maintenanceMode === true) return true
  if (camera.maintenanceUntil) {
    const until = camera.maintenanceUntil instanceof Date ? camera.maintenanceUntil.getTime() : new Date(camera.maintenanceUntil).getTime()
    if (!Number.isNaN(until) && until > now) return true
  }
  return false
}

/**
 * Traduce un reporte de fallo/éxito de streaming a una observación de debounce.
 * Razones "blandas" (cleanup/navegación/cierre) => UNKNOWN (no cuentan).
 */
export function streamReportToObservation(report: {
  ok: boolean; reason?: string | null
}): HealthObservation {
  if (report.ok) return 'ONLINE'
  return isHardStreamFailure(report.reason) ? 'OFFLINE' : 'UNKNOWN'
}
