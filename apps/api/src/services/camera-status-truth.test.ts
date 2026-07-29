import { describe, it, expect } from 'vitest'
import { resolveCameraStatus, DEFAULT_STATUS_TTL_MS, type CameraStatusInput } from './camera-status-truth'

const NOW = 1_000_000_000
const recent = NOW - 10_000                 // dentro del TTL
const old    = NOW - (DEFAULT_STATUS_TTL_MS + 60_000)  // vencido

const base: CameraStatusInput = {
  onlineInNvr: null, onlineInNvrAt: null,
  rtspMainOk: null, rtspSubOk: null, rtspCheckedAt: null,
  streamHealthStatus: 'UNKNOWN',
}

describe('resolveCameraStatus — precedencia', () => {
  it('AUTH_FAILED gana sobre todo', () => {
    const r = resolveCameraStatus({ ...base, streamHealthStatus: 'AUTH_FAILED', rtspMainOk: true, rtspCheckedAt: recent, onlineInNvr: true, onlineInNvrAt: recent }, NOW)
    expect(r.effectiveStatus).toBe('AUTH_FAILED')
    expect(r.online).toBe(false)
    expect(r.finalDecisionReason).toBe('auth_failed')
  })

  // REQUISITO 10 (caso Cuenta Pacientes): rtspMainOk HISTÓRICO=true pero el NVR
  // reporta el canal OFFLINE ahora → OFFLINE, no "Online (RTSP)".
  it('onlineInNvr=false reciente PREVALECE sobre rtspMainOk histórico=true', () => {
    const r = resolveCameraStatus({
      ...base,
      onlineInNvr: false, onlineInNvrAt: recent,   // NVR: canal offline ahora
      rtspMainOk: true, rtspSubOk: true, rtspCheckedAt: old,  // éxito RTSP viejo
    }, NOW)
    expect(r.effectiveStatus).toBe('OFFLINE')
    expect(r.online).toBe(false)
    expect(r.source).toBe('nvr')
    expect(r.finalDecisionReason).toBe('nvr_reports_offline_recent')
  })

  // Review Codex #126 (P1): un AUTH_FAILED VIEJO no debe fijar "Auth fallida" para
  // siempre tras reparar credenciales — vence y una observación fresca lo supera.
  it('AUTH_FAILED VENCIDO no prevalece sobre onlineInNvr=true reciente', () => {
    const r = resolveCameraStatus({
      ...base, streamHealthStatus: 'AUTH_FAILED', rtspCheckedAt: old,
      onlineInNvr: true, onlineInNvrAt: recent,
    }, NOW)
    expect(r.effectiveStatus).toBe('HEALTHY')
    expect(r.online).toBe(true)
    expect(r.finalDecisionReason).toBe('nvr_online_rtsp_unverified')
  })

  it('ambos RTSP fallidos recientes → OFFLINE', () => {
    const r = resolveCameraStatus({ ...base, rtspMainOk: false, rtspSubOk: false, rtspCheckedAt: recent }, NOW)
    expect(r.effectiveStatus).toBe('OFFLINE')
    expect(r.finalDecisionReason).toBe('both_rtsp_failed_recent')
  })

  it('un stream reciente OK y el otro fallido → STREAM_DEGRADED (online)', () => {
    const r = resolveCameraStatus({ ...base, rtspMainOk: true, rtspSubOk: false, rtspCheckedAt: recent }, NOW)
    expect(r.effectiveStatus).toBe('STREAM_DEGRADED')
    expect(r.online).toBe(true)
    expect(r.finalDecisionReason).toBe('one_stream_only_recent')
  })

  it('algún RTSP reciente OK → HEALTHY', () => {
    const r = resolveCameraStatus({ ...base, rtspSubOk: true, rtspCheckedAt: recent }, NOW)
    expect(r.effectiveStatus).toBe('HEALTHY')
    expect(r.online).toBe(true)
  })

  it('NVR online reciente sin RTSP verificado → HEALTHY por NVR', () => {
    const r = resolveCameraStatus({ ...base, onlineInNvr: true, onlineInNvrAt: recent }, NOW)
    expect(r.effectiveStatus).toBe('HEALTHY')
    expect(r.online).toBe(true)
    expect(r.finalDecisionReason).toBe('nvr_online_rtsp_unverified')
  })
})

describe('resolveCameraStatus — frescura / TTL (req 2, 3, 4)', () => {
  it('un rtspOk=true VENCIDO no mantiene la cámara online', () => {
    const r = resolveCameraStatus({ ...base, rtspMainOk: true, rtspSubOk: true, rtspCheckedAt: old }, NOW)
    expect(r.online).toBe(false)
    expect(r.stale).toBe(true)
    expect(r.effectiveStatus).toBe('UNKNOWN')
    expect(r.finalDecisionReason).toBe('all_observations_stale')
  })

  it('onlineInNvr=false vencido → OFFLINE stale (nunca vuelve a verde por rtsp viejo)', () => {
    const r = resolveCameraStatus({
      ...base, onlineInNvr: false, onlineInNvrAt: old, rtspMainOk: true, rtspCheckedAt: old,
    }, NOW)
    expect(r.effectiveStatus).toBe('OFFLINE')
    expect(r.online).toBe(false)
    expect(r.stale).toBe(true)
    expect(r.finalDecisionReason).toBe('nvr_offline_stale')
  })

  it('observación reciente NO está stale y expone observedAt/expiresAt', () => {
    const r = resolveCameraStatus({ ...base, onlineInNvr: false, onlineInNvrAt: recent }, NOW)
    expect(r.stale).toBe(false)
    expect(r.observedAt).toBe(recent)
    expect(r.expiresAt).toBe(recent + DEFAULT_STATUS_TTL_MS)
  })

  it('todo nulo → UNKNOWN offline stale', () => {
    const r = resolveCameraStatus(base, NOW)
    expect(r.effectiveStatus).toBe('UNKNOWN')
    expect(r.online).toBe(false)
    expect(r.stale).toBe(true)
  })
})

describe('resolveCameraStatus — recuperación (req 8)', () => {
  it('tras volver el NVR online reciente, deja de ser OFFLINE', () => {
    const offline = resolveCameraStatus({ ...base, onlineInNvr: false, onlineInNvrAt: recent }, NOW)
    expect(offline.effectiveStatus).toBe('OFFLINE')
    const recovered = resolveCameraStatus({ ...base, onlineInNvr: true, onlineInNvrAt: NOW }, NOW)
    expect(recovered.effectiveStatus).toBe('HEALTHY')
    expect(recovered.online).toBe(true)
  })
})
