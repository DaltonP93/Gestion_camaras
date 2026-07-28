import { describe, it, expect } from 'vitest'
import {
  isProblematicPreviewAudio, decideInitialPreviewAudio,
  shouldRestartVideoOnly, isAudioSyncOrMuxFailure,
} from './preview-audio-policy'

describe('isProblematicPreviewAudio', () => {
  it('G.711 μ-law / A-law y alias => true (caso real Entrada Farmacia)', () => {
    for (const c of ['pcm_mulaw', 'pcm_alaw', 'PCM_MULAW', 'g711', 'G.711', 'ulaw', 'alaw', 'mu-law', 'a-law']) {
      expect(isProblematicPreviewAudio(c)).toBe(true)
    }
  })
  it('AAC y otros compatibles => false', () => {
    for (const c of ['aac', 'AAC', 'mp2', 'opus', 'mp3', 'ac3']) {
      expect(isProblematicPreviewAudio(c)).toBe(false)
    }
  })
  it('null/undefined/vacío => false', () => {
    expect(isProblematicPreviewAudio(null)).toBe(false)
    expect(isProblematicPreviewAudio(undefined)).toBe(false)
    expect(isProblematicPreviewAudio('')).toBe(false)
  })
})

describe('decideInitialPreviewAudio (codec-aware)', () => {
  it('audio problemático ya conocido => arranca video-only directo', () => {
    expect(decideInitialPreviewAudio({ knownProblematicAudio: true }).videoOnly).toBe(true)
  })
  it('sin conocimiento previo => intenta A/V', () => {
    expect(decideInitialPreviewAudio({ knownProblematicAudio: false }).videoOnly).toBe(false)
  })
  it('forceVideoOnly gana', () => {
    expect(decideInitialPreviewAudio({ knownProblematicAudio: false, forceVideoOnly: true }).videoOnly).toBe(true)
  })
})

describe('shouldRestartVideoOnly (fallback reactivo por stderr)', () => {
  const base = { audioCodec: 'pcm_mulaw', alreadyVideoOnly: false, firstByteSent: false, audioFallbackTried: false }
  // TEST: HEVC + pcm_mulaw => fallback video-only
  it('audio pcm_mulaw detectado y sin primer byte => reinicia video-only', () => {
    expect(shouldRestartVideoOnly(base)).toBe(true)
  })
  // TEST: HEVC + pcm_alaw => fallback video-only
  it('audio pcm_alaw => reinicia video-only', () => {
    expect(shouldRestartVideoOnly({ ...base, audioCodec: 'pcm_alaw' })).toBe(true)
  })
  it('audio AAC compatible => NO reinicia (conserva ruta A/V)', () => {
    expect(shouldRestartVideoOnly({ ...base, audioCodec: 'aac' })).toBe(false)
  })
  it('ya es video-only => NO reinicia (evita loop)', () => {
    expect(shouldRestartVideoOnly({ ...base, alreadyVideoOnly: true })).toBe(false)
  })
  it('ya se envió primer byte => NO reinicia (éxito)', () => {
    expect(shouldRestartVideoOnly({ ...base, firstByteSent: true })).toBe(false)
  })
  it('ya se reintentó => NO reinicia', () => {
    expect(shouldRestartVideoOnly({ ...base, audioFallbackTried: true })).toBe(false)
  })
})

describe('isAudioSyncOrMuxFailure (categoría real, no URI_REJECTED/timeout)', () => {
  // TEST: video decodificado + sin salida A/V => AUDIO_SYNC_OR_MUX_FAILURE
  it('video decodificado, sin primer byte, audio problemático => true', () => {
    expect(isAudioSyncOrMuxFailure({ videoDecoded: true, firstByteSent: false, audioProblematic: true })).toBe(true)
  })
  it('sin video decodificado => false (no es la causa audio)', () => {
    expect(isAudioSyncOrMuxFailure({ videoDecoded: false, firstByteSent: false, audioProblematic: true })).toBe(false)
  })
  it('con primer byte => false (funcionó)', () => {
    expect(isAudioSyncOrMuxFailure({ videoDecoded: true, firstByteSent: true, audioProblematic: true })).toBe(false)
  })
  it('audio no problemático => false', () => {
    expect(isAudioSyncOrMuxFailure({ videoDecoded: true, firstByteSent: false, audioProblematic: false })).toBe(false)
  })
})
