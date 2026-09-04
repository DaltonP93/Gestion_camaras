import { describe, expect, it } from 'vitest'
import {
  applyPlaybackDecision,
  buildClientCapabilities,
  type ServerDecision,
} from './nativePlaybackSelect'

function decision(over: Partial<ServerDecision> = {}): ServerDecision {
  return { decision: 'native_hevc', transport: 'rtsps', waiting: false, cameraId: 'cam-1', viewId: 'view-1', ...over }
}

describe('applyPlaybackDecision', () => {
  const current = { cameraId: 'cam-1', viewId: 'view-1' }

  it('native_hevc/native_h264 ⇒ acción native', () => {
    expect(applyPlaybackDecision(current, decision())).toMatchObject({ apply: true, action: 'native' })
    expect(applyPlaybackDecision(current, decision({ decision: 'native_h264', transport: 'rtsps' }))).toMatchObject({ apply: true, action: 'native' })
  })

  it('server_h264 ⇒ acción server, preservando waiting', () => {
    expect(applyPlaybackDecision(current, decision({ decision: 'server_h264', waiting: false }))).toMatchObject({ apply: true, action: 'server', waiting: false })
  })

  it('substream con waiting ⇒ acción substream + waiting true', () => {
    expect(applyPlaybackDecision(current, decision({ decision: 'substream', waiting: true }))).toMatchObject({ apply: true, action: 'substream', waiting: true })
  })

  it('unavailable ⇒ no aplica', () => {
    expect(applyPlaybackDecision(current, decision({ decision: 'unavailable', transport: null }))).toMatchObject({ apply: false, action: 'none', ignoredReason: 'UNAVAILABLE' })
  })

  it('T11 · decisión de OTRA cámara ⇒ descartada (STALE_SCOPE)', () => {
    expect(applyPlaybackDecision(current, decision({ cameraId: 'cam-2' }))).toMatchObject({ apply: false, action: 'none', ignoredReason: 'STALE_SCOPE' })
  })

  it('T11 · decisión de otra vista ⇒ descartada (STALE_SCOPE)', () => {
    expect(applyPlaybackDecision(current, decision({ viewId: 'view-9' }))).toMatchObject({ apply: false, ignoredReason: 'STALE_SCOPE' })
  })

  it('viewId nulo en la decisión no fuerza descarte (compat)', () => {
    expect(applyPlaybackDecision(current, decision({ viewId: null })).apply).toBe(true)
  })
})

describe('buildClientCapabilities', () => {
  it('navegador: sólo H.264, sin hw HEVC', () => {
    const p = buildClientCapabilities({ runtime: 'web', hwH264: true, hwHevc: false, transports: ['hls'] }, { cameraId: 'c1', viewId: 'v1' })
    expect(p.codecs).toEqual(['h264'])
    expect(p.hardwareDecodedCodecs).toEqual(['h264'])
    expect(p.cameraId).toBe('c1')
    expect(p.viewId).toBe('v1')
  })

  it('nativo HEVC hw: codecs incluye hevc y hardwareDecodedCodecs también', () => {
    const p = buildClientCapabilities({ runtime: 'android', hwH264: true, hwHevc: true, transports: ['rtsps'], maxHardwareDecoders: 12 })
    expect(p.codecs).toEqual(['h264', 'hevc'])
    expect(p.hardwareDecodedCodecs).toEqual(['h264', 'hevc'])
    expect(p.maxHardwareDecoders).toBe(12)
  })
})
