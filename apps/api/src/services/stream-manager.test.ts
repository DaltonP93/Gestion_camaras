// Tests del ciclo de vida de sesiones de streaming — foco en la purga que evita
// que el límite global se dispare por sesiones huérfanas (pestañas muertas,
// recargas, errores HLS). Usa los seams __*ForTest para poblar el mapa en memoria
// sin depender de prisma/MediaMTX.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  pruneStaleSessions,
  getStreamCounts,
  getSessionsDiagnostic,
  __seedSessionForTest,
  __setViewHeartbeatForTest,
  __resetSessionsForTest,
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
})
