// Tests del ciclo de vida de sesiones de streaming — foco en la purga que evita
// que el límite global se dispare por sesiones huérfanas (pestañas muertas,
// recargas, errores HLS). Usa los seams __*ForTest para poblar el mapa en memoria
// sin depender de prisma/MediaMTX.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  pruneStaleSessions,
  getStreamCounts,
  getSessionsDiagnostic,
  recordStreamOutcome,
  getStreamOutcomeCounters,
  getUserIdsWithOutcomes,
  getStreamIdleTimeoutMs,
  __seedSessionForTest,
  __setViewHeartbeatForTest,
  __resetSessionsForTest,
  __resetOutcomesForTest,
} from './stream-manager'

const now = () => new Date()
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000)

function seedSub(userId: string, cameraId: string, viewId: string, ageSec: number) {
  __seedSessionForTest({
    cameraId, userId, viewId, streamType: 'sub',
    streamPath: `nvr_x_${cameraId}_sub`,
    startedAt: secondsAgo(ageSec), lastHeartbeat: secondsAgo(ageSec),
  })
  __setViewHeartbeatForTest(userId, viewId, secondsAgo(ageSec))
}

describe('stream-manager session lifecycle', () => {
  beforeEach(() => __resetSessionsForTest())

  it('empty state: counts and diagnostic are zero', () => {
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(0)
    expect(getSessionsDiagnostic().counts.total).toBe(0)
    expect(pruneStaleSessions()).toBe(0)
  })

  it('does not prune fresh sessions (heartbeat within timeout)', () => {
    seedSub('u1', 'camA', 'view1', 0)          // recién iniciada
    __setViewHeartbeatForTest('u1', 'view1', now())
    expect(pruneStaleSessions()).toBe(0)
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(1)
  })

  it('prunes sessions whose view heartbeat expired (>90s)', () => {
    seedSub('u1', 'camA', 'view1', 120)        // vencida
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(1)
    expect(pruneStaleSessions()).toBe(1)
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(0)
  })

  it('accumulated stale sessions from dead tabs are all reclaimed', () => {
    // Simula 6 pestañas muertas + 2 vivas → 8 sesiones, límite global no debe
    // contar las 6 vencidas.
    for (let i = 0; i < 6; i++) seedSub('u1', `dead${i}`, `deadview${i}`, 200)
    seedSub('u1', 'live1', 'liveview', 0); __setViewHeartbeatForTest('u1', 'liveview', now())
    seedSub('u1', 'live2', 'liveview', 0); __setViewHeartbeatForTest('u1', 'liveview', now())
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(8)
    expect(pruneStaleSessions()).toBe(6)
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(2)
  })

  it('getStreamCounts reports per-user sub streams and configured maxes', () => {
    seedSub('u1', 'camA', 'v1', 0); __setViewHeartbeatForTest('u1', 'v1', now())
    seedSub('u1', 'camB', 'v1', 0); __setViewHeartbeatForTest('u1', 'v1', now())
    seedSub('u2', 'camC', 'v2', 0); __setViewHeartbeatForTest('u2', 'v2', now())
    const c1 = getStreamCounts('u1')
    expect(c1.currentUserStreams).toBe(2)
    expect(c1.currentGlobalStreams).toBe(3)
    expect(c1.maxGlobalStreams).toBeGreaterThan(0)
    expect(c1.maxUserStreams).toBeGreaterThan(0)
  })

  it('diagnostic lists sessions with age/idle and prunes stale first', () => {
    seedSub('u1', 'fresh', 'v1', 0); __setViewHeartbeatForTest('u1', 'v1', now())
    seedSub('u1', 'stale', 'v2', 300)   // vencida → purgada por el diagnostic
    const diag = getSessionsDiagnostic()
    expect(diag.counts.total).toBe(1)
    expect(diag.sessions[0].cameraId).toBe('fresh')
    expect(diag.sessions[0].idleSec).toBeGreaterThanOrEqual(0)
  })

  // ── Punto A del review: la purga debe reclamar sesiones vencidas del límite
  // POR USUARIO, no sólo del global. Un usuario con el máximo de sesiones
  // vencidas debe quedar en 0 tras la purga (y así poder iniciar una nueva).
  it('prune reclaims a full per-user quota of expired sessions', () => {
    for (let i = 0; i < 32; i++) seedSub('u1', `old${i}`, `oldview${i}`, 300)  // 32 vencidas
    expect(getStreamCounts('u1').currentUserStreams).toBe(32)
    const pruned = pruneStaleSessions()
    expect(pruned).toBe(32)
    expect(getStreamCounts('u1').currentUserStreams).toBe(0)  // habilitado a iniciar
  })

  // ── Aislamiento multi-view (dos pestañas / recarga rápida): la pestaña vieja
  // (cámaras distintas, heartbeat vencido) se purga; la nueva (fresca) se
  // conserva — no se mata la sesión recién iniciada por la otra pestaña/recarga.
  // (Una misma cámara comparte clave user:cam:sub, así que no puede duplicarse
  //  entre pestañas: el propio modelo evita ese leak.)
  it('two-tab / fast-reload: stale view pruned, fresh view kept', () => {
    seedSub('u1', 'camA', 'tab-old', 200)   // pestaña vieja — heartbeat vencido
    seedSub('u1', 'camB', 'tab-new', 0); __setViewHeartbeatForTest('u1', 'tab-new', now())
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(2)
    expect(pruneStaleSessions()).toBe(1)
    const diag = getSessionsDiagnostic()
    expect(diag.counts.total).toBe(1)
    expect(diag.sessions[0].viewId).toBe('tab-new')   // se conservó la pestaña activa
  })

  // ── Cambio de página/NVR/layout: el view previo cambia su conjunto visible y
  // su heartbeat expira; las cámaras del layout anterior se purgan, las del
  // nuevo (heartbeat fresco) se conservan.
  it('page/NVR/layout change: old-view cameras pruned, new-view kept', () => {
    // layout anterior (3x3) en un view que dejó de recibir heartbeat
    for (let i = 0; i < 9; i++) seedSub('u1', `prev${i}`, 'view-prev', 200)
    // layout nuevo (1x1) activo
    seedSub('u1', 'now1', 'view-now', 0); __setViewHeartbeatForTest('u1', 'view-now', now())
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(10)
    expect(pruneStaleSessions()).toBe(9)
    expect(getStreamCounts('u1').currentGlobalStreams).toBe(1)
  })
})

// ─── Contadores rodantes de resultados de start-stream (review Codex #117) ──
describe('stream-manager outcome counters', () => {
  beforeEach(() => {
    __resetOutcomesForTest()
    vi.useRealTimers()
  })

  it('aggregates outcomes per user with byCode breakdown', () => {
    recordStreamOutcome('u1', 'accepted')
    recordStreamOutcome('u1', 'accepted')
    recordStreamOutcome('u1', 'rejected_limit', 'STREAM_LIMIT_REACHED')
    recordStreamOutcome('u1', 'rejected_permission', 'NO_PERMISSION')
    recordStreamOutcome('u1', 'failed_other', 'MEDIA_SERVER_ERROR')
    const c = getStreamOutcomeCounters('u1')
    expect(c.accepted).toBe(2)
    expect(c.rejectedLimit).toBe(1)
    expect(c.rejectedPermission).toBe(1)
    expect(c.failedOther).toBe(1)
    expect(c.byCode).toEqual({ STREAM_LIMIT_REACHED: 1, NO_PERMISSION: 1, MEDIA_SERVER_ERROR: 1 })
  })

  it('isolates counters between users', () => {
    recordStreamOutcome('u1', 'accepted')
    recordStreamOutcome('u2', 'rejected_limit', 'STREAM_LIMIT_GLOBAL')
    expect(getStreamOutcomeCounters('u1').accepted).toBe(1)
    expect(getStreamOutcomeCounters('u1').rejectedLimit).toBe(0)
    expect(getStreamOutcomeCounters('u2').rejectedLimit).toBe(1)
  })

  it('expires events outside the 15-minute window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
    recordStreamOutcome('u1', 'rejected_limit', 'STREAM_LIMIT_REACHED')
    vi.setSystemTime(new Date('2026-01-01T10:14:00Z'))
    expect(getStreamOutcomeCounters('u1').rejectedLimit).toBe(1)   // aún vigente
    vi.setSystemTime(new Date('2026-01-01T10:16:00Z'))
    expect(getStreamOutcomeCounters('u1').rejectedLimit).toBe(0)   // expirado
    vi.useRealTimers()
  })

  it('getUserIdsWithOutcomes drops users whose events all expired (no ghost keys)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
    recordStreamOutcome('viejo', 'accepted')
    vi.setSystemTime(new Date('2026-01-01T10:10:00Z'))
    recordStreamOutcome('reciente', 'accepted')
    vi.setSystemTime(new Date('2026-01-01T10:16:00Z'))  // 'viejo' expiró, 'reciente' no
    expect(getUserIdsWithOutcomes()).toEqual(['reciente'])
    vi.useRealTimers()
  })

  it('getStreamOutcomeCounters removes the empty key from the index', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
    recordStreamOutcome('u1', 'accepted')
    vi.setSystemTime(new Date('2026-01-01T10:20:00Z'))
    getStreamOutcomeCounters('u1')                       // poda y borra la clave vacía
    expect(getUserIdsWithOutcomes()).toEqual([])
    vi.useRealTimers()
  })

  it('orphan threshold getter matches the manager idle timeout (default 90s)', () => {
    expect(getStreamIdleTimeoutMs()).toBe(90_000)
  })
})
