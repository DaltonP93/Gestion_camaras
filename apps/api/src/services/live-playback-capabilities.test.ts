import { describe, expect, it } from 'vitest'
import { negotiateLivePlaybackCapabilities } from './live-playback-capabilities'

const server = {
  ffmpegAvailable: true,
  transcodingEnabled: true,
  maxTranscodeSessions: 2,
}

describe('negotiateLivePlaybackCapabilities', () => {
  it('mantiene el navegador en fallback HLS con el límite real del servidor', () => {
    const result = negotiateLivePlaybackCapabilities({
      runtime: 'web',
      codecs: ['h264'],
      hardwareDecodedCodecs: ['h264'],
      transports: ['hls', 'whep'],
    }, server)

    expect(result.browserFallback).toEqual({
      mode: 'server_hls_transcode',
      h264DirectAvailable: true,
      hevcServerTranscodeAvailable: true,
      maxConcurrentServerTranscodes: 2,
    })
    expect(result.nativeDirect.available).toBe(false)
    expect(result.client.localDecoderCandidate).toBe(false)
  })

  it('reconoce un dispositivo HEVC pero no habilita relay inseguro', () => {
    const result = negotiateLivePlaybackCapabilities({
      runtime: 'android',
      codecs: ['h264', 'hevc'],
      hardwareDecodedCodecs: ['h264', 'hevc'],
      transports: ['rtsps'],
      maxHardwareDecoders: 12,
    }, server)

    expect(result.client).toMatchObject({
      hardwareHevc: true,
      maxHardwareDecoders: 12,
      localDecoderCandidate: true,
    })
    expect(result.nativeDirect).toMatchObject({
      available: false,
      candidate: true,
      blockingReason: 'SECURE_RELAY_NOT_IMPLEMENTED',
      consumesServerTranscodeSlot: false,
    })
    expect(result.security.rawNvrCredentialsExposed).toBe(false)
  })

  it('acota valores declarados por el cliente y no inventa capacidad FFmpeg', () => {
    const result = negotiateLivePlaybackCapabilities({
      runtime: 'ios',
      codecs: ['hevc'],
      hardwareDecodedCodecs: ['hevc'],
      transports: ['whep'],
      maxHardwareDecoders: 999,
    }, { ...server, ffmpegAvailable: false })

    expect(result.client.maxHardwareDecoders).toBe(64)
    expect(result.browserFallback).toMatchObject({
      mode: 'h264_direct_only',
      h264DirectAvailable: true,
      hevcServerTranscodeAvailable: false,
    })
  })
})
