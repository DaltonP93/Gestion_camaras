import { describe, it, expect } from 'vitest'
import {
  isProblematicPreviewAudio, decideInitialPreviewAudio,
  shouldRestartVideoOnly, isAudioSyncOrMuxFailure,
  normalizeAudioMode, resolveEffectiveAudioMode, resolvePreviewAudioPolicy,
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

// ─── Política general audioMode (precedencia + decisión central) ──────────────

describe('normalizeAudioMode', () => {
  it('acepta los tres modos válidos', () => {
    expect(normalizeAudioMode('auto')).toBe('auto')
    expect(normalizeAudioMode('enabled')).toBe('enabled')
    expect(normalizeAudioMode('disabled')).toBe('disabled')
  })
  it('rechaza cualquier otro valor con null', () => {
    for (const v of [null, undefined, '', 'ON', 'yes', 'off', 1, {}]) {
      expect(normalizeAudioMode(v)).toBeNull()
    }
  })
})

describe('resolveEffectiveAudioMode — precedencia camera→nvr→system→auto', () => {
  it('camera gana sobre nvr y system', () => {
    expect(resolveEffectiveAudioMode({ camera: 'disabled', nvr: 'enabled', system: 'auto' })).toBe('disabled')
  })
  it('sin camera, hereda de nvr', () => {
    expect(resolveEffectiveAudioMode({ camera: null, nvr: 'disabled', system: 'enabled' })).toBe('disabled')
  })
  it('sin camera ni nvr, hereda de system', () => {
    expect(resolveEffectiveAudioMode({ camera: null, nvr: null, system: 'enabled' })).toBe('enabled')
  })
  it('todo ausente ⇒ auto', () => {
    expect(resolveEffectiveAudioMode({})).toBe('auto')
    expect(resolveEffectiveAudioMode({ camera: 'bogus', nvr: '', system: undefined })).toBe('auto')
  })
})

describe('resolvePreviewAudioPolicy — decisión central', () => {
  const AAC = { present: true, codecName: 'aac' }

  it('disabled ⇒ video-only aunque el RTSP anuncie audio válido (primer intento)', () => {
    const d = resolvePreviewAudioPolicy({ configuredMode: 'disabled', audioStream: AAC })
    expect(d).toEqual({ includeAudio: false, videoOnly: true, reason: 'configured_disabled' })
  })

  it('perfil conocido video-only ⇒ video-only', () => {
    const d = resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: AAC, knownCameraProfile: { videoOnly: true } })
    expect(d.videoOnly).toBe(true)
    expect(d.reason).toBe('known_video_only_camera')
  })

  it('auto + sin pista de audio (inspeccionada) ⇒ video-only (no_audio_stream)', () => {
    expect(resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: null }).reason).toBe('no_audio_stream')
    expect(resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: { present: false } }).reason).toBe('no_audio_stream')
  })

  it('auto/enabled + audio AÚN NO inspeccionado (undefined) ⇒ intentar A/V', () => {
    // Primer spawn sin ffprobe: no forzar video-only por falta de inspección.
    expect(resolvePreviewAudioPolicy({ configuredMode: 'auto' })).toEqual({ includeAudio: true, videoOnly: false, reason: 'audio_usable' })
    expect(resolvePreviewAudioPolicy({ configuredMode: 'enabled' }).videoOnly).toBe(false)
  })

  it('disabled ⇒ video-only incluso sin inspeccionar (undefined)', () => {
    expect(resolvePreviewAudioPolicy({ configuredMode: 'disabled' }).reason).toBe('configured_disabled')
  })

  it('pista marcada como desactivada ⇒ video-only', () => {
    const d = resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: { present: true, codecName: 'aac', disabled: true } })
    expect(d.videoOnly).toBe(true)
    expect(d.reason).toBe('no_audio_stream')
  })

  it('codec none / vacío / null ⇒ audio_codec_none', () => {
    for (const codecName of ['none', '', null, 'NONE', 'n/a']) {
      const d = resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: { present: true, codecName } })
      expect(d.reason).toBe('audio_codec_none')
      expect(d.videoOnly).toBe(true)
    }
  })

  it('codec unknown ⇒ audio_codec_unknown', () => {
    const d = resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: { present: true, codecName: 'unknown' } })
    expect(d.reason).toBe('audio_codec_unknown')
  })

  it('G.711 (pcm_mulaw/pcm_alaw) ⇒ audio_mux_incompatible', () => {
    for (const codecName of ['pcm_mulaw', 'pcm_alaw', 'g711']) {
      expect(resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: { present: true, codecName } }).reason)
        .toBe('audio_mux_incompatible')
    }
  })

  it('parámetros incompletos ⇒ audio_mux_incompatible', () => {
    const d = resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: { present: true, codecName: 'aac', parametersIncomplete: true } })
    expect(d.reason).toBe('audio_mux_incompatible')
  })

  it('stderr: decoder de audio no disponible ⇒ audio_decoder_unavailable', () => {
    const d = resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: AAC, stderrEvidence: { audioDecoderUnavailable: true } })
    expect(d.reason).toBe('audio_decoder_unavailable')
    expect(d.videoOnly).toBe(true)
  })

  it('stderr: mux de audio incompatible ⇒ audio_mux_incompatible', () => {
    const d = resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: AAC, stderrEvidence: { audioMuxIncompatible: true } })
    expect(d.reason).toBe('audio_mux_incompatible')
  })

  it('auto + AAC válido ⇒ incluir audio (audio_usable)', () => {
    const d = resolvePreviewAudioPolicy({ configuredMode: 'auto', audioStream: AAC })
    expect(d).toEqual({ includeAudio: true, videoOnly: false, reason: 'audio_usable' })
  })

  it('enabled + AAC válido ⇒ incluir audio; enabled + none ⇒ video-only', () => {
    expect(resolvePreviewAudioPolicy({ configuredMode: 'enabled', audioStream: AAC }).includeAudio).toBe(true)
    expect(resolvePreviewAudioPolicy({ configuredMode: 'enabled', audioStream: { present: true, codecName: 'none' } }).videoOnly).toBe(true)
  })
})
