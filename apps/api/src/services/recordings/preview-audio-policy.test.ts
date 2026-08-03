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
  it('reconoce decoder de audio ausente para none/unknown SIN índice', () => {
    expect(detectAudioStderrEvidence('No decoder found for codec none').audioDecoderUnavailable).toBe(true)
    expect(detectAudioStderrEvidence('no decoder found for: none').audioDecoderUnavailable).toBe(true)
  })
  // INVARIANTE (Codex sobre #140): si la línea trae un ÍNDICE de stream, manda
  // el registro y NADA más. Sin declaración previa la evidencia queda pendiente
  // aunque el mensaje incluya "(codec pcm_alaw)" — antes se inferí­a audio, lo
  // que permitía que un codec de video futuro (vvc) disparara fallback de audio.
  it('línea INDEXADA sin declaración: pendiente, nunca inferida por codec', () => {
    const ev = detectAudioStderrEvidence('Decoder (codec pcm_alaw) not found for input stream #0:1')
    expect(ev.audioDecoderUnavailable).toBe(false)
    expect(ev.videoDecoderUnavailable).toBe(false)
    expect(ev.unresolvedDecoderErrors).toBe(1)
  })
  it('la misma línea, ya declarado #0:1 como audio, sí resuelve a audio', () => {
    const ev = detectAudioStderrEvidence(
      'Stream #0:1: Audio: pcm_alaw\nDecoder (codec pcm_alaw) not found for input stream #0:1'
    )
    expect(ev.audioDecoderUnavailable).toBe(true)
    expect(ev.unresolvedDecoderErrors).toBe(0)
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

// ─── P2 Codex (3ª ronda): evidencia NEUTRAL + streamRegistry con estado ───────

import { createAudioEvidenceTracker, extractExplicitCodec } from './preview-audio-policy'
import { classifyRtspError } from './rtsp-url'
import { PreviewProcessRegistry } from './preview-process-registry'

/**
 * Simula el camino REAL de la ruta: buffer de líneas + tracker CON ESTADO por
 * intento + decisión reactiva. `tailCap` reproduce el capado de stderrTail para
 * demostrar que el registro de streams NO depende del tail.
 */
function runAttempt(chunks: string[], opts: { configuredMode?: 'auto' | 'enabled' | 'disabled'; tailCap?: number } = {}) {
  const configuredMode = opts.configuredMode ?? 'auto'
  const tailCap = opts.tailCap ?? 30
  const buf = makeStderrLineBuffer()
  const tracker = createAudioEvidenceTracker()
  const tail: string[] = []
  let audioStreamSeen = false
  let detectedAudioCodec: string | null = null
  let attemptVideoOnly = false
  let audioFallbackTried = false
  let restarts = 0
  let learnedCamera = false          // cameraAudioProblematic.add(...)
  const feed = (line: string) => {
    const l = line.trim()
    if (!l) return
    tail.push(l); if (tail.length > tailCap) tail.shift()
    tracker.push(l)
    const ev = tracker.evidence()
    if (ev.audioStreamSeen) audioStreamSeen = true
    if (ev.audioCodec) detectedAudioCodec = ev.audioCodec
    const r = decideReactiveAudioRestart({
      configuredMode, detectedAudioCodec, audioStreamSeen,
      evidence: ev, attemptVideoOnly, firstByteSent: false, audioFallbackTried,
    })
    if (r.restart) {
      restarts++
      audioFallbackTried = true
      attemptVideoOnly = true
      if (r.stableAudioEvidence) learnedCamera = true
    }
  }
  for (const c of chunks) for (const l of buf.push(c)) feed(l)
  const resid = buf.flush(); if (resid) feed(resid)
  return { restarts, learnedCamera, evidence: tracker.evidence(), tail, streams: tracker.streams() }
}

describe('P2-3 test 1 — error ANTES de la declaración permanece NEUTRAL', () => {
  const ERR = 'Error while opening decoder for input stream #0:0'

  it('sin declaración todavía: sin evidencia de audio, sin fallback, sin aprender la cámara', () => {
    const r = runAttempt([ERR + '\n'])
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.evidence.videoDecoderUnavailable).toBe(false)
    expect(r.evidence.unresolvedDecoderErrors).toBe(1) // queda PENDIENTE, no clasificado
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
  })

  it('cuando luego llega "Stream #0:0: Video: hevc": se resuelve como VIDEO', () => {
    const r = runAttempt([ERR + '\n', 'Stream #0:0: Video: hevc\n'])
    expect(r.evidence.videoDecoderUnavailable).toBe(true)
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.evidence.unresolvedDecoderErrors).toBe(0)
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
    // Y la categoría de error sigue siendo de VIDEO.
    expect(classifyRtspError(`${ERR}\nStream #0:0: Video: hevc`)).toBe('CODEC_UNSUPPORTED')
  })
})

describe('P2-3 test 2 — error antes de la declaración de AUDIO se resuelve al declararse', () => {
  it('#0:1 sin declaración ⇒ neutral; luego Audio: adpcm_g726le ⇒ fallback una sola vez', () => {
    const r = runAttempt([
      'Error while opening decoder for input stream #0:1\n',
      'Stream #0:1: Audio: adpcm_g726le\n',
    ])
    expect(r.evidence.audioDecoderUnavailable).toBe(true)
    expect(r.restarts).toBe(1)
    expect(r.learnedCamera).toBe(true)
  })
})

describe('P2-3 test 3 — el registro de streams sobrevive al capado del tail', () => {
  it('declaración de VIDEO evictada del tail: el error de #0:0 sigue siendo video', () => {
    const filler = Array.from({ length: 8 }, (_, i) => `frame log line ${i}\n`)
    const r = runAttempt(
      ['Stream #0:0: Video: hevc\n', ...filler, 'Decoder (codec hevc) not found for input stream #0:0\n'],
      { tailCap: 3 },
    )
    // La declaración YA no está en el tail…
    expect(r.tail.join('\n')).not.toContain('Stream #0:0: Video: hevc')
    // …pero sigue en el registro persistente y el error se atribuye a VIDEO.
    expect(r.streams.get('0:0')?.type).toBe('video')
    expect(r.evidence.videoDecoderUnavailable).toBe(true)
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.restarts).toBe(0)
  })

  it('declaración de AUDIO evictada del tail: el error de #0:1 sigue siendo audio', () => {
    const filler = Array.from({ length: 8 }, (_, i) => `frame log line ${i}\n`)
    const r = runAttempt(
      ['Stream #0:1: Audio: adpcm_g726le\n', ...filler, 'Error while opening decoder for input stream #0:1\n'],
      { tailCap: 3 },
    )
    expect(r.streams.get('0:1')?.type).toBe('audio')
    expect(r.evidence.audioDecoderUnavailable).toBe(true)
    expect(r.restarts).toBe(1)
  })
})

describe('P2-3 test 4 — palabras genéricas NUNCA son codecName', () => {
  it('extractExplicitCodec rechaza input/stream/output/decoder/error', () => {
    expect(extractExplicitCodec('Error while opening decoder for input stream #0:0')).toBeNull()
    expect(extractExplicitCodec('Error while opening decoder for output stream #0:1')).toBeNull()
    expect(extractExplicitCodec('could not open decoder for stream 1')).toBeNull()
    expect(extractExplicitCodec('Unsupported codec with id 98 for input stream #0:1')).toBeNull()
    for (const w of ['input', 'stream', 'output', 'decoder', 'error']) {
      expect(extractExplicitCodec(`No decoder found for codec ${w}`), w).toBeNull()
    }
  })
  it('sí extrae codecs desde campos explícitos y verificables', () => {
    expect(extractExplicitCodec('Decoder (codec adpcm_g726le) not found for input stream #0:1')).toBe('adpcm_g726le')
    expect(extractExplicitCodec('No decoder found for codec adpcm_g726le')).toBe('adpcm_g726le')
    expect(extractExplicitCodec('no decoder found for: none')).toBe('none')
    expect(extractExplicitCodec('Unsupported codec: speex')).toBe('speex')
    expect(extractExplicitCodec('Could not find tag for codec pcm_alaw in stream #1')).toBe('pcm_alaw')
  })
})

describe('P2-3 tests 5/6 — correlación por índice manda', () => {
  it('5. "(codec adpcm_g726le) not found ... #0:1" con #0:1 = audio ⇒ fallback video-only', () => {
    const r = runAttempt([
      'Stream #0:0: Video: hevc\nStream #0:1: Audio: adpcm_g726le\n',
      'Decoder (codec adpcm_g726le) not found for input stream #0:1\n',
    ])
    expect(r.restarts).toBe(1)
    expect(r.evidence.audioDecoderUnavailable).toBe(true)
  })
  it('6. el MISMO mensaje para #0:0 = video ⇒ CODEC_UNSUPPORTED, sin fallback', () => {
    const r = runAttempt([
      'Stream #0:0: Video: hevc\n',
      'Decoder (codec hevc) not found for input stream #0:0\n',
    ])
    expect(r.restarts).toBe(0)
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.evidence.videoDecoderUnavailable).toBe(true)
    expect(classifyRtspError('Stream #0:0: Video: hevc\nDecoder (codec hevc) not found for input stream #0:0'))
      .toBe('CODEC_UNSUPPORTED')
  })
  it('el registro gana sobre el codec: error con codec de audio pero índice de VIDEO ⇒ video', () => {
    const r = runAttempt([
      'Stream #0:0: Video: hevc\n',
      'Decoder (codec adpcm_g726le) not found for input stream #0:0\n',
    ])
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.restarts).toBe(0)
  })
})

describe('P2-3 test 7 — error sin índice y sin codec explícito ⇒ neutral', () => {
  it('no clasifica, no dispara fallback, no aprende', () => {
    const r = runAttempt(['Error while opening decoder\n', 'could not open decoder\n'])
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.evidence.videoDecoderUnavailable).toBe(false)
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
  })
})

describe('P2-3 tests 8/9/10/11 — no regresión y aprendizaje seguro', () => {
  it('8. Box 4: HEVC + "Audio: none" conserva el fallback correcto', () => {
    const r = runAttempt(['Stream #0:0: Video: hevc\nStream #0:1: Audio: none\n'])
    expect(r.restarts).toBe(1)
    expect(r.learnedCamera).toBe(true)
  })
  it('9. AAC válido no dispara fallback', () => {
    const r = runAttempt(['Stream #0:0: Video: h264\nStream #0:1: Audio: aac (LC), 16000 Hz\n'])
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
  })
  it('10. múltiples chunks/eventos ⇒ un solo fallback', () => {
    const r = runAttempt([
      'Stream #0:0: Video: hev', 'c\nStream #0:1: Aud', 'io: none\n',
      'more a\n', 'more b\n', 'Output #0, mp4\n',
    ])
    expect(r.restarts).toBe(1)
  })
  it('11. no se aprende la cámara con evidencia pendiente/neutral', () => {
    // Error pendiente que nunca se resuelve ⇒ jamás se marca la cámara.
    const r = runAttempt(['Error while opening decoder for input stream #0:3\n', 'Output #0, mp4\n'])
    expect(r.learnedCamera).toBe(false)
    expect(r.evidence.unresolvedDecoderErrors).toBe(1)
  })
})

describe('P2-3 test 12 — el intento previo se termina y recolecta antes del relanzamiento', () => {
  it('aliveCount()==0 antes de relanzar video-only sobre la misma URI', async () => {
    const reg = new PreviewProcessRegistry()
    const killed: string[] = []
    const fakeProc: any = { pid: 4242, kill: (sig: string) => { killed.push(sig); return true } }
    const rec = reg.register(fakeProc, Date.now())

    // Evidencia de audio ⇒ decisión de fallback.
    const r = runAttempt(['Stream #0:0: Video: hevc\nStream #0:1: Audio: none\n'])
    expect(r.restarts).toBe(1)

    // Terminación idempotente del intento A/V y recolección real del proceso.
    const term = reg.terminate(rec.attemptId, 'audio_fallback', { onSigterm: () => {}, onSigkill: () => {} })
    reg.markExited(rec.attemptId)          // exit/close real del proceso
    await term
    expect(killed[0]).toBe('SIGTERM')
    // Sólo AHORA puede relanzarse: no quedan hijos vivos (cero huérfanos).
    expect(reg.aliveCount()).toBe(0)
  })
})

// ─── P2 Codex (4ª ronda): el ÍNDICE de stream es la única fuente de verdad ────

import { isAudioCodecName, isVideoCodecName } from './preview-audio-policy'

describe('P2-4 test 1 — codec de video FUTURO indexado antes de la declaración', () => {
  const ERR = 'Decoder (codec vvc) not found for input stream #0:0'

  it('inmediato: pendiente, type=null, sin fallback, sin aprender la cámara', () => {
    const r = runAttempt([ERR + '\n'])
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.evidence.videoDecoderUnavailable).toBe(false)
    expect(r.evidence.unresolvedDecoderErrors).toBe(1)
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
  })

  it('tras "Stream #0:0: Video: vvc": videoDecoderUnavailable y CODEC_UNSUPPORTED', () => {
    const r = runAttempt([ERR + '\n', 'Stream #0:0: Video: vvc\n'])
    expect(r.evidence.videoDecoderUnavailable).toBe(true)
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.evidence.unresolvedDecoderErrors).toBe(0)
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
    expect(classifyRtspError(`${ERR}\nStream #0:0: Video: vvc`)).toBe('CODEC_UNSUPPORTED')
  })
})

describe('P2-4 test 2 — caso simétrico de audio', () => {
  const ERR = 'Decoder (codec adpcm_g726le) not found for input stream #0:1'
  it('antes de la declaración: pendiente, sin fallback', () => {
    const r = runAttempt([ERR + '\n'])
    expect(r.evidence.unresolvedDecoderErrors).toBe(1)
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
  })
  it('tras "Stream #0:1: Audio: adpcm_g726le": un solo fallback video-only', () => {
    const r = runAttempt([ERR + '\n', 'Stream #0:1: Audio: adpcm_g726le\n'])
    expect(r.evidence.audioDecoderUnavailable).toBe(true)
    expect(r.restarts).toBe(1)
    expect(r.learnedCamera).toBe(true)
  })
})

describe('P2-4 tests 3/4 — el registro tiene precedencia absoluta sobre el codec', () => {
  it('3. codec con pinta de audio pero índice declarado VIDEO ⇒ video, sin fallback', () => {
    const r = runAttempt([
      'Decoder (codec adpcm_g726le) not found for input stream #0:0\n',
      'Stream #0:0: Video: vvc\n',
    ])
    expect(r.evidence.videoDecoderUnavailable).toBe(true)
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
  })
  it('4. codec de video futuro con índice NUNCA se infiere como audio', () => {
    for (const codec of ['vvc', 'h266', 'avs3', 'codec_del_futuro']) {
      const r = runAttempt([`Decoder (codec ${codec}) not found for input stream #0:0\n`])
      expect(r.evidence.audioDecoderUnavailable, codec).toBe(false)
      expect(r.restarts, codec).toBe(0)
      expect(r.learnedCamera, codec).toBe(false)
    }
  })
})

describe('P2-4 tests 5/6 — inferencia por codec SÓLO sin índice, con evidencia positiva', () => {
  it('5. sin índice + codec de familia de audio ⇒ audio', () => {
    const r = runAttempt(['Decoder (codec adpcm_g726le) not found\n'])
    expect(r.evidence.audioDecoderUnavailable).toBe(true)
    expect(r.restarts).toBe(1)
  })
  it('6. sin índice + codec vvc ⇒ nunca audio (queda video, jamás por exclusión)', () => {
    const r = runAttempt(['Decoder (codec vvc) not found\n'])
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.restarts).toBe(0)
  })
  it('sin índice + codec desconocido (ni audio ni video) ⇒ NEUTRAL', () => {
    const r = runAttempt(['Decoder (codec zzz_futuro) not found\n'])
    expect(r.evidence.audioDecoderUnavailable).toBe(false)
    expect(r.evidence.videoDecoderUnavailable).toBe(false)
    expect(r.restarts).toBe(0)
  })
  it('reconocedores: positivo de audio y positivo de video, sin exclusión', () => {
    for (const c of ['pcm_mulaw', 'adpcm_g726le', 'aac', 'opus', 'g722', 'speex']) {
      expect(isAudioCodecName(c), c).toBe(true)
    }
    for (const c of ['vvc', 'h266', 'avs3', 'hevc', 'h264']) {
      expect(isAudioCodecName(c), c).toBe(false)
    }
    expect(isVideoCodecName('vvc')).toBe(true)
    expect(isVideoCodecName('adpcm_g726le')).toBe(false)
  })
})

describe('P2-4 tests 7/8 — pendientes sin resolver y múltiples por índice', () => {
  it('7. pending que nunca recibe declaración: sin fallback ni aprendizaje', () => {
    const r = runAttempt([
      'Decoder (codec vvc) not found for input stream #0:0\n',
      'frame= 1 fps=0.0\n', 'Output #0, mp4\n',
    ])
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
    expect(r.evidence.unresolvedDecoderErrors).toBe(1)
  })
  it('8. varias evidencias pendientes del MISMO índice ⇒ un único reinicio', () => {
    const r = runAttempt([
      'Decoder (codec adpcm_g726le) not found for input stream #0:1\n',
      'Error while opening decoder for input stream #0:1\n',
      'Could not find codec parameters for stream #0:1\n',
      'Stream #0:1: Audio: adpcm_g726le\n',
      'more stderr\n',
    ])
    expect(r.restarts).toBe(1)
    expect(r.evidence.audioDecoderUnavailable).toBe(true)
    expect(r.evidence.unresolvedDecoderErrors).toBe(0)
  })
})

describe('P2-4 tests 9/10 — chunks y tail', () => {
  it('9. declaración en un chunk posterior se reensambla y resuelve', () => {
    const r = runAttempt([
      'Decoder (codec adpcm_g726le) not found for input stream #0:1\nStr',
      'eam #0:1: Aud', 'io: adpcm_g726le\n',
    ])
    expect(r.evidence.audioDecoderUnavailable).toBe(true)
    expect(r.restarts).toBe(1)
  })
  it('10. declaración evictada del tail: el registro conserva el tipo', () => {
    const filler = Array.from({ length: 8 }, (_, i) => `log ${i}\n`)
    const r = runAttempt(
      ['Stream #0:0: Video: vvc\n', ...filler, 'Decoder (codec vvc) not found for input stream #0:0\n'],
      { tailCap: 3 },
    )
    expect(r.tail.join('\n')).not.toContain('Stream #0:0: Video: vvc')
    expect(r.streams.get('0:0')?.type).toBe('video')
    expect(r.evidence.videoDecoderUnavailable).toBe(true)
    expect(r.restarts).toBe(0)
  })
})

describe('P2-4 tests 11/12/13 — no regresión', () => {
  it('11. Box 4 "Audio: none" mantiene el fallback correcto', () => {
    const r = runAttempt(['Stream #0:0: Video: hevc\nStream #0:1: Audio: none\n'])
    expect(r.restarts).toBe(1)
    expect(r.learnedCamera).toBe(true)
  })
  it('12. AAC válido mantiene audio (sin fallback)', () => {
    const r = runAttempt(['Stream #0:0: Video: h264\nStream #0:1: Audio: aac (LC), 16000 Hz\n'])
    expect(r.restarts).toBe(0)
    expect(r.learnedCamera).toBe(false)
  })
  it('13. decoder HEVC real sigue siendo CODEC_UNSUPPORTED', () => {
    const r = runAttempt([
      'Stream #0:0: Video: hevc\n',
      'Decoder (codec hevc) not found for input stream #0:0\n',
    ])
    expect(r.evidence.videoDecoderUnavailable).toBe(true)
    expect(r.restarts).toBe(0)
    expect(classifyRtspError('Stream #0:0: Video: hevc\nDecoder (codec hevc) not found for input stream #0:0'))
      .toBe('CODEC_UNSUPPORTED')
  })
  it('9-bis. "Could not find codec parameters for stream 1 (Audio: pcm_mulaw)" declara el tipo inline', () => {
    const r = runAttempt(['Could not find codec parameters for stream 1 (Audio: pcm_mulaw, 8000 Hz)\n'])
    expect(r.streams.get('num:1')?.type).toBe('audio')
    expect(r.evidence.audioParametersIncomplete).toBe(true)
  })
})

describe('P2-4 test 14 — recolección del intento previo antes del relanzamiento', () => {
  it('el A/V anterior sale y se recolecta (aliveCount()==0) antes del video-only', async () => {
    const reg = new PreviewProcessRegistry()
    const signals: string[] = []
    const proc: any = { pid: 777, kill: (s: string) => { signals.push(s); return true } }
    const rec = reg.register(proc, Date.now())

    const r = runAttempt([
      'Decoder (codec adpcm_g726le) not found for input stream #0:1\n',
      'Stream #0:1: Audio: adpcm_g726le\n',
    ])
    expect(r.restarts).toBe(1)

    const term = reg.terminate(rec.attemptId, 'audio_fallback', { onSigterm: () => {}, onSigkill: () => {} })
    reg.markExited(rec.attemptId)
    await term
    expect(signals[0]).toBe('SIGTERM')
    expect(reg.aliveCount()).toBe(0)
  })
})
