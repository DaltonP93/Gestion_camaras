import { describe, it, expect } from 'vitest'
import {
  shouldFeedStreamDebounce, classifyMediaMtxPath, mediaMtxStateToObservation,
  nextBackoffMs, shouldAttemptRestart,
} from './camera-stream-diagnostics'
import { stepDebounce, initialDebounceState, DEFAULT_DEBOUNCE } from './camera-health-debounce'

describe('shouldFeedStreamDebounce', () => {
  it('alimenta stream-error sólo si la señal física NO es OFFLINE', () => {
    expect(shouldFeedStreamDebounce('ONLINE')).toBe(true)
    expect(shouldFeedStreamDebounce('UNKNOWN')).toBe(true)
    expect(shouldFeedStreamDebounce('OFFLINE')).toBe(false)   // ya hay CAMERA_OFFLINE
  })
})

describe('classifyMediaMtxPath (TASK 5)', () => {
  it('distingue los estados del path', () => {
    expect(classifyMediaMtxPath({ found: false })).toBe('PATH_MISSING')
    expect(classifyMediaMtxPath({ found: true, source: null })).toBe('PATH_NO_SOURCE')
    expect(classifyMediaMtxPath({ found: true, source: 'rtsp://x', ready: false })).toBe('SOURCE_NOT_READY')
    expect(classifyMediaMtxPath({ found: true, source: 'rtsp://x', ready: true, bytesReceived: 0 })).toBe('READER_NO_DATA')
    expect(classifyMediaMtxPath({ found: true, source: 'rtsp://x', ready: true, bytesReceived: 100, hlsReady: false })).toBe('HLS_NOT_READY')
    expect(classifyMediaMtxPath({ found: true, source: 'rtsp://x', ready: true, bytesReceived: 100, hlsReady: true })).toBe('READY')
    expect(classifyMediaMtxPath({ found: true, source: 'rtsp://x', rtspError: '401 Unauthorized' })).toBe('RTSP_REJECTED')
  })
})

describe('backoff (TASK 5) — no reiniciar en loop', () => {
  it('crece exponencial con tope y respeta el máximo de intentos', () => {
    expect(nextBackoffMs(0)).toBe(2000)
    expect(nextBackoffMs(1)).toBe(4000)
    expect(nextBackoffMs(10)).toBe(60_000)  // capado
    expect(shouldAttemptRestart(4, 5)).toBe(true)
    expect(shouldAttemptRestart(5, 5)).toBe(false)
  })
})

// TEST 9.9 — HLS 500 con InputProxy ONLINE => CAMERA_STREAM_ERROR, NO CAMERA_OFFLINE.
describe('HLS 500 con cámara físicamente ONLINE', () => {
  it('confirma stream-error por el debounce de pipeline, sin tocar el físico', () => {
    // Señal física siempre ONLINE.
    let physical = initialDebounceState()
    let stream = initialDebounceState()
    let now = 1_000_000
    const physicalActions: string[] = []
    const streamActions: string[] = []
    // 3 ciclos: InputProxy ONLINE + HLS 500 (fallo duro de pipeline).
    for (let i = 0; i < 3; i++) {
      now += 60_000
      const p = stepDebounce(physical, 'ONLINE', now, DEFAULT_DEBOUNCE)
      physical = p.state; physicalActions.push(p.action)
      // gating: como el físico está ONLINE, alimentamos el stream-debounce con el fallo duro
      if (shouldFeedStreamDebounce('ONLINE')) {
        const s = stepDebounce(stream, 'OFFLINE', now, DEFAULT_DEBOUNCE)
        stream = s.state; streamActions.push(s.action)
      }
    }
    expect(physicalActions.every(a => a === 'none')).toBe(true)          // nunca CAMERA_OFFLINE
    expect(streamActions).toContain('confirm_offline')                   // sí CAMERA_STREAM_ERROR
    expect(mediaMtxStateToObservation('PATH_MISSING')).toBe('OFFLINE')
  })
})
