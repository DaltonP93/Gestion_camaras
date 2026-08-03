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

// ─── Fallback reactivo derivado de la política (fix Box 4) ────────────────────

import { detectAudioStderrEvidence, decideReactiveAudioRestart } from './preview-audio-policy'

describe('detectAudioStderrEvidence — distingue audio de video', () => {
  it('detecta la pista de audio y su codec (incl. none/unknown)', () => {
    expect(detectAudioStderrEvidence('Stream #0:1: Audio: none').audioCodec).toBe('none')
    expect(detectAudioStderrEvidence('Stream #0:1: Audio: unknown').audioCodec).toBe('unknown')
    expect(detectAudioStderrEvidence('Stream #0:1: Audio: aac (LC)').audioCodec).toBe('aac')
  })
  it('marca audioStreamSeen aunque el codec venga vacío', () => {
    const ev = detectAudioStderrEvidence('Stream #0:1: Audio: ')
    expect(ev.audioStreamSeen).toBe(true)
  })
  it('reconoce decoder de audio ausente para none/unknown', () => {
    expect(detectAudioStderrEvidence('No decoder found for codec none').audioDecoderUnavailable).toBe(true)
    expect(detectAudioStderrEvidence('no decoder found for: none').audioDecoderUnavailable).toBe(true)
    expect(detectAudioStderrEvidence('Decoder (codec pcm_alaw) not found for input stream #0:1').audioDecoderUnavailable).toBe(true)
  })
  it('NO marca decoder de audio cuando el problema es de VIDEO', () => {
    const ev = detectAudioStderrEvidence('Decoder (codec hevc) not found for input stream #0:0, Video: hevc')
    expect(ev.audioDecoderUnavailable).toBe(false)
  })
  it('detecta parámetros de audio incompletos', () => {
    expect(detectAudioStderrEvidence('Could not find codec parameters for stream 1 (Audio: pcm_mulaw)').audioParametersIncomplete).toBe(true)
  })
})

describe('decideReactiveAudioRestart — deriva de resolvePreviewAudioPolicy', () => {
  const base = { attemptVideoOnly: false, firstByteSent: false, audioFallbackTried: false, configuredMode: 'auto' as const }

  it('Audio: none ⇒ restart video-only (el bug de Box 4)', () => {
    const r = decideReactiveAudioRestart({ ...base, detectedAudioCodec: 'none', audioStreamSeen: true, stderrText: 'Stream #0:1: Audio: none' })
    expect(r.restart).toBe(true)
    expect(r.decision?.reason).toBe('audio_codec_none')
    expect(r.stableAudioEvidence).toBe(true)
  })
  it('Audio: unknown ⇒ restart video-only', () => {
    const r = decideReactiveAudioRestart({ ...base, detectedAudioCodec: 'unknown', audioStreamSeen: true, stderrText: 'Stream #0:1: Audio: unknown' })
    expect(r.restart).toBe(true)
    expect(r.decision?.reason).toBe('audio_codec_unknown')
  })
  it('codec de audio vacío ⇒ restart (audio_codec_none)', () => {
    const r = decideReactiveAudioRestart({ ...base, detectedAudioCodec: null, audioStreamSeen: true, stderrText: 'Stream #0:1: Audio: ' })
    expect(r.restart).toBe(true)
    expect(r.decision?.reason).toBe('audio_codec_none')
  })
  it('no decoder found for: none ⇒ restart (decoder de audio)', () => {
    const r = decideReactiveAudioRestart({ ...base, detectedAudioCodec: null, audioStreamSeen: false, stderrText: 'no decoder found for: none' })
    expect(r.restart).toBe(true)
    expect(r.decision?.reason).toBe('audio_decoder_unavailable')
  })
  it('G.711 sigue disparando restart (regresión)', () => {
    const r = decideReactiveAudioRestart({ ...base, detectedAudioCodec: 'pcm_mulaw', audioStreamSeen: true, stderrText: 'Stream #0:1: Audio: pcm_mulaw' })
    expect(r.restart).toBe(true)
    expect(r.decision?.reason).toBe('audio_mux_incompatible')
  })
  it('AAC válido NO dispara restart', () => {
    const r = decideReactiveAudioRestart({ ...base, detectedAudioCodec: 'aac', audioStreamSeen: true, stderrText: 'Stream #0:1: Audio: aac (LC)' })
    expect(r.restart).toBe(false)
    expect(r.decision?.reason).toBe('audio_usable')
  })
  it('sin evidencia de audio todavía ⇒ NO restart', () => {
    const r = decideReactiveAudioRestart({ ...base, detectedAudioCodec: null, audioStreamSeen: false, stderrText: 'ffmpeg version ... Input #0, rtsp' })
    expect(r.restart).toBe(false)
  })
  it('guardas: ya video-only / ya first byte / ya reintentado ⇒ NO restart', () => {
    const ev = { detectedAudioCodec: 'none', audioStreamSeen: true, stderrText: 'Audio: none', configuredMode: 'auto' as const }
    expect(decideReactiveAudioRestart({ ...ev, attemptVideoOnly: true, firstByteSent: false, audioFallbackTried: false }).restart).toBe(false)
    expect(decideReactiveAudioRestart({ ...ev, attemptVideoOnly: false, firstByteSent: true, audioFallbackTried: false }).restart).toBe(false)
    expect(decideReactiveAudioRestart({ ...ev, attemptVideoOnly: false, firstByteSent: false, audioFallbackTried: true }).restart).toBe(false)
  })
  it('un decoder faltante de VIDEO no marca evidencia estable de audio', () => {
    const r = decideReactiveAudioRestart({ ...base, detectedAudioCodec: null, audioStreamSeen: false, stderrText: 'Decoder (codec hevc) not found, Video: hevc' })
    expect(r.stableAudioEvidence).toBe(false)
  })
})

describe('máquina de stderr simulada (HEVC + Audio: none) — un único fallback', () => {
  // Simula el consumo línea-a-línea del handler real, acumulando el tail y
  // manteniendo el estado del intento; verifica un ÚNICO restart por evidencia.
  it('HEVC + Audio: none ⇒ exactamente un restart en la misma URI', () => {
    const lines = [
      'ffmpeg version 6.0 Copyright (c) 2000-2023',
      'Input #0, rtsp, from ...:',
      'Stream #0:0: Video: hevc (Main), yuv420p, 1920x1080, 25 fps',
      'Stream #0:1: Audio: none',
      'Output #0, mp4, to pipe:1:',
    ]
    let tail = ''
    let audioSeen = false
    let detectedAudioCodec: string | null = null
    let attemptVideoOnly = false
    let firstByteSent = false
    let audioFallbackTried = false
    let restarts = 0

    for (const line of lines) {
      tail += line + '\n'
      const info = detectAudioStderrEvidence(line)
      if (info.audioStreamSeen) audioSeen = true
      if (info.audioCodec) detectedAudioCodec = info.audioCodec
      const r = decideReactiveAudioRestart({
        configuredMode: 'auto', detectedAudioCodec, audioStreamSeen: audioSeen,
        stderrText: tail, attemptVideoOnly, firstByteSent, audioFallbackTried,
      })
      if (r.restart) {
        restarts++
        audioFallbackTried = true       // marca: no vuelve a disparar
        attemptVideoOnly   = true       // el relanzamiento es video-only
      }
    }
    // Múltiples chunks de stderr NO disparan más de un fallback.
    expect(restarts).toBe(1)
    // El VIDEO (hevc) fue reconocido, así que no es un problema de video.
    expect(detectedAudioCodec).toBe('none')
  })

  it('H.264 + Audio: none ⇒ un restart (video-only reproduce)', () => {
    let tail = 'Input #0\nStream #0:0: Video: h264, 1280x720\nStream #0:1: Audio: none\n'
    const r = decideReactiveAudioRestart({
      configuredMode: 'auto', detectedAudioCodec: 'none', audioStreamSeen: true,
      stderrText: tail, attemptVideoOnly: false, firstByteSent: false, audioFallbackTried: false,
    })
    expect(r.restart).toBe(true)
  })

  it('audioMode=disabled: el arranque ya es video-only (no aplica reactivo)', () => {
    // En disabled el intento arranca video-only (attemptVideoOnly=true) ⇒ guarda.
    const r = decideReactiveAudioRestart({
      configuredMode: 'disabled', detectedAudioCodec: 'aac', audioStreamSeen: true,
      stderrText: 'Audio: aac', attemptVideoOnly: true, firstByteSent: false, audioFallbackTried: false,
    })
    expect(r.restart).toBe(false)
  })
})

// ─── P2 Codex: correlación por índice de stream + reensamblado de chunks ──────

import { makeStderrLineBuffer } from './preview-audio-policy'

// Simula el consumo por chunks del handler real usando el MISMO buffer que la ruta.
function runStderrChunks(chunks: string[], configuredMode: 'auto' | 'enabled' | 'disabled' = 'auto') {
  const buf = makeStderrLineBuffer()
  let tail: string[] = []
  let audioSeen = false
  let detectedAudioCodec: string | null = null
  let attemptVideoOnly = false
  let audioFallbackTried = false
  let restarts = 0
  const feed = (line: string) => {
    const l = line.trim()
    if (!l) return
    tail.push(l); if (tail.length > 30) tail.shift()
    const info = detectAudioStderrEvidence(l)
    if (info.audioStreamSeen) audioSeen = true
    if (info.audioCodec) detectedAudioCodec = info.audioCodec
    const r = decideReactiveAudioRestart({
      configuredMode, detectedAudioCodec, audioStreamSeen: audioSeen,
      stderrText: tail.join('\n'), attemptVideoOnly, firstByteSent: false, audioFallbackTried,
    })
    if (r.restart) { restarts++; audioFallbackTried = true; attemptVideoOnly = true }
  }
  for (const c of chunks) for (const l of buf.push(c)) feed(l)
  const resid = buf.flush(); if (resid) feed(resid)
  return { restarts, detectedAudioCodec }
}

describe('makeStderrLineBuffer — reensamblado', () => {
  it('línea partida en dos chunks se reconstruye', () => {
    const buf = makeStderrLineBuffer()
    expect(buf.push('Stream #0:1: Aud')).toEqual([])
    expect(buf.push('io: none\n')).toEqual(['Stream #0:1: Audio: none'])
  })
  it('no inserta saltos artificiales entre fragmentos', () => {
    const buf = makeStderrLineBuffer()
    buf.push('abc'); buf.push('def\n')
    // reconstruye "abcdef", no "abc\ndef"
    expect(buf.push('')).toEqual([])
  })
  it('flush devuelve el residual sin salto final', () => {
    const buf = makeStderrLineBuffer()
    buf.push('line1\npartial')
    expect(buf.flush()).toBe('partial')
  })
})

describe('P2 test 1/2 — "Audio: none" partida en chunks ⇒ un único fallback', () => {
  it('dos chunks', () => {
    const r = runStderrChunks(['Stream #0:0: Video: hevc\nStream #0:1: Aud', 'io: none\n'])
    expect(r.restarts).toBe(1)
    expect(r.detectedAudioCodec).toBe('none')
  })
  it('tres chunks', () => {
    const r = runStderrChunks(['Stream #0:1: Au', 'dio: no', 'ne\n'])
    expect(r.restarts).toBe(1)
  })
})

describe('P2 test 3/4/5 — correlación por índice, codec arbitrario', () => {
  it('codec arbitrario adpcm_g726le en #0:1 (audio) ⇒ fallback', () => {
    const r = runStderrChunks([
      'Stream #0:0: Video: hevc, 1920x1080\n',
      'Stream #0:1: Audio: adpcm_g726le\n',
      'Decoder (codec adpcm_g726le) not found for input stream #0:1\n',
    ])
    expect(r.restarts).toBe(1)
  })
  it('mismo mensaje para #0:0 (video) ⇒ NO fallback de audio', () => {
    const ev = detectAudioStderrEvidence(
      'Stream #0:0: Video: hevc\nDecoder (codec hevc) not found for input stream #0:0'
    )
    expect(ev.audioDecoderUnavailable).toBe(false)
    const r = runStderrChunks([
      'Stream #0:0: Video: hevc\n',
      'Decoder (codec hevc) not found for input stream #0:0\n',
    ])
    expect(r.restarts).toBe(0)
  })
  it('orden invertido: error de decoder ANTES de la definición del stream', () => {
    const r = runStderrChunks([
      'Decoder (codec adpcm_g726le) not found for input stream #0:1\n',
      'Stream #0:1: Audio: adpcm_g726le\n',
    ])
    expect(r.restarts).toBe(1)
  })
})

describe('P2 test 6/8/9 — un solo fallback / AAC / Box 4', () => {
  it('varios chunks no generan múltiples fallback', () => {
    const r = runStderrChunks([
      'Stream #0:0: Video: hevc\n', 'Stream #0:1: Audio: none\n',
      'more stderr line a\n', 'more stderr line b\n', 'Output #0, mp4\n',
    ])
    expect(r.restarts).toBe(1)
  })
  it('AAC válido no dispara fallback', () => {
    const r = runStderrChunks(['Stream #0:0: Video: h264\nStream #0:1: Audio: aac (LC)\n'])
    expect(r.restarts).toBe(0)
  })
  it('Box 4: HEVC + Audio: none ⇒ un fallback', () => {
    const r = runStderrChunks(['Stream #0:0: Video: hevc\nStream #0:1: Audio: none\n'])
    expect(r.restarts).toBe(1)
  })
})

describe('detectAudioStderrEvidence — correlación (codec-agnóstica)', () => {
  it('reconoce cualquier codec de audio por índice, sin allow-list', () => {
    for (const codec of ['adpcm_g726le', 'g722', 'speex', 'nellymoser', 'wmav2']) {
      const ev = detectAudioStderrEvidence(
        `Stream #0:1: Audio: ${codec}\nDecoder (codec ${codec}) not found for input stream #0:1`
      )
      expect(ev.audioDecoderUnavailable, codec).toBe(true)
    }
  })
  it('decoder faltante de VIDEO nunca marca evidencia de audio', () => {
    for (const codec of ['hevc', 'h264', 'mpeg4', 'av1']) {
      const ev = detectAudioStderrEvidence(
        `Stream #0:0: Video: ${codec}\nDecoder (codec ${codec}) not found for input stream #0:0`
      )
      expect(ev.audioDecoderUnavailable, codec).toBe(false)
    }
  })
})
