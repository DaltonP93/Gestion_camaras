import { describe, it, expect } from 'vitest'
import { classifyStageFailure, type StageEvidence } from './rtsp-url'

const base: StageEvidence = {
  inputOpened: false, videoStreamPresent: false,
  firstVideoPacketMs: null, firstDecodedFrameMs: null,
  firstEncodedFrameMs: null, firstMuxedByteMs: null,
  timedOut: false, stderr: '',
}

describe('classifyStageFailure', () => {
  it('STAGE_OK cuando hubo primer byte muxeado antes de cualquier kill', () => {
    expect(classifyStageFailure({ ...base, inputOpened: true, videoStreamPresent: true,
      firstVideoPacketMs: 100, firstDecodedFrameMs: 200, firstEncodedFrameMs: 300, firstMuxedByteMs: 400 })).toBe('STAGE_OK')
  })

  it('OUTPUT_PIPE_DRAIN_RACE cuando el byte llegó DESPUÉS del kill (no es rechazo del NVR)', () => {
    expect(classifyStageFailure({ ...base, inputOpened: true, videoStreamPresent: true,
      firstVideoPacketMs: 100, firstDecodedFrameMs: 200, firstEncodedFrameMs: 300,
      firstMuxedByteMs: 26000, bytesAfterKill: true })).toBe('OUTPUT_PIPE_DRAIN_RACE')
  })

  it('NO clasifica track 101 como URI_REJECTED cuando sólo agotó el tiempo sin salida', () => {
    // Caso REAL de producción: input abre, se ve el stream de video, pero nunca
    // hay primer byte muxeado y expira el watchdog. Debe ser MUXER_NO_OUTPUT, NO
    // "el NVR rechazó la URL".
    const cat = classifyStageFailure({ ...base, inputOpened: true, videoStreamPresent: true,
      firstVideoPacketMs: 500, firstDecodedFrameMs: 800, firstEncodedFrameMs: 1200,
      firstMuxedByteMs: null, timedOut: true })
    expect(cat).toBe('MUXER_NO_OUTPUT')
    expect(cat).not.toBe('RTSP_URI_REJECTED')
  })

  it('RTSP_URI_REJECTED sólo con un 400 real en stderr', () => {
    expect(classifyStageFailure({ ...base, stderr: 'method DESCRIBE failed: 400 Bad Request', timedOut: false }))
      .toBe('RTSP_URI_REJECTED')
  })

  it('RTSP_AUTH_FAILED con 401', () => {
    expect(classifyStageFailure({ ...base, stderr: '401 Unauthorized' })).toBe('RTSP_AUTH_FAILED')
  })

  it('NVR_BANDWIDTH_OR_SESSION_LIMIT con 453', () => {
    expect(classifyStageFailure({ ...base, stderr: 'RTSP/1.0 453 Not Enough Bandwidth' }))
      .toBe('NVR_BANDWIDTH_OR_SESSION_LIMIT')
  })

  it('RTSP_OPEN_TIMEOUT: input nunca abrió y expiró sin error explícito', () => {
    expect(classifyStageFailure({ ...base, inputOpened: false, timedOut: true }))
      .toBe('RTSP_OPEN_TIMEOUT')
  })

  it('RTSP_OPEN_FAILED: input no abrió con error explícito de apertura', () => {
    expect(classifyStageFailure({ ...base, inputOpened: false, stderr: 'Could not open input' }))
      .toBe('RTSP_OPEN_FAILED')
  })

  it('VIDEO_STREAM_MISSING: abrió pero sin stream de video (sólo audio AAC)', () => {
    expect(classifyStageFailure({ ...base, inputOpened: true, videoStreamPresent: false, timedOut: true }))
      .toBe('VIDEO_STREAM_MISSING')
  })

  it('RTSP_OPENED_NO_PACKETS: abrió con video pero nunca llegó paquete de video', () => {
    expect(classifyStageFailure({ ...base, inputOpened: true, videoStreamPresent: true,
      firstVideoPacketMs: null, timedOut: true })).toBe('RTSP_OPENED_NO_PACKETS')
  })

  it('VIDEO_NO_KEYFRAME: llegaron paquetes pero nunca se decodificó un frame', () => {
    expect(classifyStageFailure({ ...base, inputOpened: true, videoStreamPresent: true,
      firstVideoPacketMs: 300, firstDecodedFrameMs: null, timedOut: true })).toBe('VIDEO_NO_KEYFRAME')
  })

  it('DECODE_FAILED: sin frame decodificado y stderr con error de decode', () => {
    expect(classifyStageFailure({ ...base, inputOpened: true, videoStreamPresent: true,
      firstVideoPacketMs: 300, firstDecodedFrameMs: null, stderr: 'error while decoding' }))
      .toBe('DECODE_FAILED')
  })

  it('ENCODE_FAILED: decodificó pero nunca codificó', () => {
    expect(classifyStageFailure({ ...base, inputOpened: true, videoStreamPresent: true,
      firstVideoPacketMs: 300, firstDecodedFrameMs: 400, firstEncodedFrameMs: null, timedOut: true }))
      .toBe('ENCODE_FAILED')
  })

  it('STARTUP_BUDGET_EXCEEDED gana sobre todo', () => {
    expect(classifyStageFailure({ ...base, budgetExceeded: true, inputOpened: true })).toBe('STARTUP_BUDGET_EXCEEDED')
  })
})
