import { describe, expect, it } from 'vitest'
import { decideLivePlayback, decideAdmissionOrWait, type LivePlaybackDecisionInput } from './live-playback-decision'

const serverCaps = { ffmpegAvailable: true, transcodingEnabled: true, maxTranscodeSessions: 2 }

function input(over: Partial<LivePlaybackDecisionInput> = {}): LivePlaybackDecisionInput {
  return {
    client: { runtime: 'android', codecs: ['h264', 'hevc'], hardwareDecodedCodecs: ['h264', 'hevc'], transports: ['rtsps'], maxHardwareDecoders: 4 },
    server: serverCaps,
    relayReady: true,
    nativePlaybackEnabled: true,
    camera: { mainCodec: 'hevc' },
    capacity: { availableTranscodeSlots: 2 },
    access: { live: true, hd: true },
    ...over,
  }
}

describe('decideLivePlayback', () => {
  it('HEVC + relay listo + HD ⇒ native_hevc (main), sin cupo', () => {
    expect(decideLivePlayback(input())).toMatchObject({ decision: 'native_hevc', transport: 'rtsps', consumesServerTranscodeSlot: false })
  })
  it('elige whep si no hay rtsps', () => {
    expect(decideLivePlayback(input({ client: { runtime: 'ios', codecs: ['hevc'], hardwareDecodedCodecs: ['hevc'], transports: ['whep'], maxHardwareDecoders: 2 } }))).toMatchObject({ decision: 'native_hevc', transport: 'whep' })
  })
  it('navegador ⇒ server_h264 fallback', () => {
    expect(decideLivePlayback(input({ client: { runtime: 'web', codecs: ['h264'], hardwareDecodedCodecs: ['h264'], transports: ['hls'] } }))).toMatchObject({ decision: 'server_h264', reason: 'SERVER_TRANSCODE_FALLBACK' })
  })
  it('P0-3 · relay NO listo ⇒ no nativo, nativeBlockedReason RELAY_BACKEND_NOT_READY', () => {
    const r = decideLivePlayback(input({ relayReady: false }))
    expect(r.decision).not.toBe('native_hevc')
    expect(r.nativeBlockedReason).toBe('RELAY_BACKEND_NOT_READY')
  })
  it('T8 · sin HD (canHighQuality) y cámara HEVC ⇒ no nativo, nativeBlockedReason HD_PERMISSION_MISSING', () => {
    const r = decideLivePlayback(input({ access: { live: true, hd: false } }))
    expect(r.decision).not.toBe('native_hevc')
    expect(r.nativeBlockedReason).toBe('HD_PERMISSION_MISSING')
  })
  it('sin acceso live ⇒ unavailable', () => {
    expect(decideLivePlayback(input({ access: { live: false, hd: false } }))).toMatchObject({ decision: 'unavailable', reason: 'CAMERA_ACCESS_DENIED' })
  })
  it('sin cupo ⇒ substream en espera', () => {
    expect(decideLivePlayback(input({ client: { runtime: 'web', codecs: ['h264'], hardwareDecodedCodecs: ['h264'], transports: ['hls'] }, capacity: { availableTranscodeSlots: 0 } }))).toMatchObject({ decision: 'substream', waiting: true })
  })
  it('transcode no disponible ⇒ substream', () => {
    expect(decideLivePlayback(input({ server: { ffmpegAvailable: false, transcodingEnabled: false, maxTranscodeSessions: 2 }, client: { runtime: 'web', codecs: ['h264'], hardwareDecodedCodecs: ['h264'], transports: ['hls'] } }))).toMatchObject({ decision: 'substream', reason: 'SUBSTREAM_TRANSCODE_UNAVAILABLE' })
  })
  it('cámara H.264 navegador ⇒ server_h264 directo', () => {
    expect(decideLivePlayback(input({ camera: { mainCodec: 'h264' }, client: { runtime: 'web', codecs: ['h264'], hardwareDecodedCodecs: ['h264'], transports: ['hls'] } }))).toMatchObject({ decision: 'server_h264', reason: 'SERVER_H264_DIRECT' })
  })
  it('cámara H.264 nativo (sub, sólo live) ⇒ native_h264', () => {
    expect(decideLivePlayback(input({ camera: { mainCodec: 'h264' }, access: { live: true, hd: false }, client: { runtime: 'windows', codecs: ['h264'], hardwareDecodedCodecs: ['h264'], transports: ['rtsps'], maxHardwareDecoders: 2 } }))).toMatchObject({ decision: 'native_h264', transport: 'rtsps' })
  })
  it('playback OFF ⇒ sin nativeBlockedReason', () => {
    expect(decideLivePlayback(input({ nativePlaybackEnabled: false, relayReady: false })).nativeBlockedReason).toBeUndefined()
  })
})

describe('decideAdmissionOrWait (helper puro)', () => {
  it('cupo libre ⇒ start; sin cupo ⇒ wait; cancel ⇒ cancelled', () => {
    expect(decideAdmissionOrWait({ maxSlots: 2, activeSlots: 1, cancelRequested: false }).action).toBe('start')
    expect(decideAdmissionOrWait({ maxSlots: 2, activeSlots: 2, cancelRequested: false }).action).toBe('wait')
    expect(decideAdmissionOrWait({ maxSlots: 2, activeSlots: 0, cancelRequested: true }).action).toBe('cancelled')
  })
  it('INVARIANTE: jamás start con activeSlots >= maxSlots', () => {
    for (let a = 2; a <= 6; a++) expect(decideAdmissionOrWait({ maxSlots: 2, activeSlots: a, cancelRequested: false }).action).not.toBe('start')
  })
})
