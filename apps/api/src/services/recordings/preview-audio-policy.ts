// Política de audio del PREVIEW de grabaciones — lógica PURA y testeable.
//
// CAUSA RAÍZ CONFIRMADA (diagnóstico staged, Torre Vieja / Entrada Farmacia):
// el NVR entrega video HEVC + audio G.711 (pcm_mulaw). El pipeline A/V del preview
// (HEVC→H.264 + G.711→AAC + fMP4) abre el RTSP, recibe y DECODIFICA video, pero se
// atasca en la etapa de encode/mux al procesar el audio junto — nunca produce un
// frame codificado ni un byte fMP4 (stopPoint=ENCODE_FAILED). La MISMA URI en
// modo VIDEO-ONLY produce fMP4 en ~5,5 s (video_only_h264 = success).
//
// Corrección: cuando el audio es G.711 μ-law/A-law (o el pipeline A/V no produce
// salida habiendo video decodificado), servir el preview VIDEO-ONLY reutilizando
// la misma URI RTSP. El audio de las DESCARGAS MP4 (VOD) NO se toca.

// Codecs de audio que rompen el mux A/V del preview en estos firmwares Hikvision.
// G.711 μ-law (pcm_mulaw) y A-law (pcm_alaw) — también sus alias comunes.
const PROBLEMATIC_AUDIO = /pcm_?mulaw|pcm_?alaw|(^|[^a-z])g\.?711([^a-z]|$)|ulaw|alaw|mu-?law|a-?law/i

/**
 * ¿Este codec de audio es de los que bloquean el encode/mux A/V del preview?
 * (G.711 μ-law/A-law). AAC y demás compatibles devuelven false.
 */
export function isProblematicPreviewAudio(codec: string | null | undefined): boolean {
  if (!codec) return false
  return PROBLEMATIC_AUDIO.test(codec.trim())
}

/**
 * Decisión de audio para el PRIMER spawn de un intento. Si ya se SABE (por una
 * detección previa en esta sesión/perfil) que el audio es problemático, arrancar
 * directo en video-only (optimización codec-aware: no gastar un intento A/V que ya
 * se sabe incompatible). Sin conocimiento previo, arrancar con A/V y dejar que la
 * detección por stderr decida.
 */
export function decideInitialPreviewAudio(opts: {
  knownProblematicAudio: boolean
  forceVideoOnly?: boolean
}): { videoOnly: boolean; reason: string } {
  if (opts.forceVideoOnly) return { videoOnly: true, reason: 'forced_video_only' }
  if (opts.knownProblematicAudio) return { videoOnly: true, reason: 'known_problematic_audio' }
  return { videoOnly: false, reason: 'try_av' }
}

/**
 * ¿Debe reiniciarse el intento ACTUAL en video-only? Se dispara en cuanto el
 * stderr de FFmpeg revela audio problemático, ANTES de que venza el watchdog y
 * SIN avanzar a otra URL — se reintenta la MISMA URI sin audio. Guardas: no si ya
 * es video-only, no si ya se envió el primer byte, no si ya se reintentó.
 */
export function shouldRestartVideoOnly(state: {
  audioCodec: string | null
  alreadyVideoOnly: boolean
  firstByteSent: boolean
  audioFallbackTried: boolean
}): boolean {
  if (state.alreadyVideoOnly || state.firstByteSent || state.audioFallbackTried) return false
  return isProblematicPreviewAudio(state.audioCodec)
}

/**
 * Clasificación del fallo A/V: si el intento abrió RTSP y DECODIFICÓ video pero no
 * produjo salida (ni frame codificado ni byte muxeado), la causa es audio/sync/mux
 * A/V — NO un rechazo de URI, ni timeout de RTSP, ni NVR offline. Devuelve la
 * categoría dedicada AUDIO_SYNC_OR_MUX_FAILURE sólo en ese caso concreto.
 */
export function isAudioSyncOrMuxFailure(ev: {
  videoDecoded: boolean
  firstByteSent: boolean
  audioProblematic: boolean
}): boolean {
  return ev.videoDecoded && !ev.firstByteSent && ev.audioProblematic
}

// ─────────────────────────────────────────────────────────────────────────────
// POLÍTICA DE AUDIO GENERAL (audioMode = auto | enabled | disabled)
//
// Política general aplicable a TODAS las cámaras, NVR y bloques de grabación.
// NO hay excepciones por cameraId/canal/modelo/nombre. Un audio ausente,
// desactivado, vacío, none, unknown, sin decoder o incompatible NUNCA debe
// impedir la reproducción del video: si el video es válido, se reproduce
// automáticamente sin audio.
// ─────────────────────────────────────────────────────────────────────────────

export type AudioMode = 'auto' | 'enabled' | 'disabled'

/** Normaliza un valor arbitrario a un AudioMode válido (o null si no lo es). */
export function normalizeAudioMode(v: unknown): AudioMode | null {
  if (v === 'auto' || v === 'enabled' || v === 'disabled') return v
  return null
}

/**
 * Resuelve el modo EFECTIVO según la precedencia:
 *   camera.audioMode → nvr.audioMode → system.recordingsAudioMode → 'auto'
 * Cada nivel puede ser null/ausente (hereda del siguiente). Nunca hardcodea
 * identidades: sólo consume los modos configurados.
 */
export function resolveEffectiveAudioMode(chain: {
  camera?: unknown
  nvr?: unknown
  system?: unknown
}): AudioMode {
  return (
    normalizeAudioMode(chain.camera) ??
    normalizeAudioMode(chain.nvr) ??
    normalizeAudioMode(chain.system) ??
    'auto'
  )
}

/** Motivos posibles de la decisión de audio del preview. */
export type PreviewAudioReason =
  | 'configured_disabled'
  | 'no_audio_stream'
  | 'audio_codec_none'
  | 'audio_codec_unknown'
  | 'audio_decoder_unavailable'
  | 'audio_mux_incompatible'
  | 'known_video_only_camera'
  | 'audio_usable'

export interface PreviewAudioDecision {
  includeAudio: boolean
  videoOnly: boolean
  reason: PreviewAudioReason
}

/** Información conocida de la pista de audio (de ffprobe o del stderr en vivo). */
export interface AudioStreamInfo {
  /** ¿Se detectó una pista de audio en el contenedor? */
  present?: boolean
  /** codecName reportado (puede ser 'none' | 'unknown' | '' | null). */
  codecName?: string | null
  /** La pista existe pero está marcada como desactivada/deshabilitada. */
  disabled?: boolean
  /** Faltan parámetros necesarios para decodificar/muxear (sample_rate, etc.). */
  parametersIncomplete?: boolean
}

/** Evidencia extraída del stderr de FFmpeg durante el intento en curso. */
export interface StderrAudioEvidence {
  /** No hay decoder de AUDIO disponible ("decoder ... not found" para la pista de audio). */
  audioDecoderUnavailable?: boolean
  /** El audio impide abrir/generar el mux (o A/V no produjo salida con video ya decodificado). */
  audioMuxIncompatible?: boolean
}

/** Perfil aprendido de una cámara (evidencia estable de video-only). */
export interface KnownCameraAudioProfile {
  videoOnly?: boolean
  detectedAudioCodec?: string | null
}

const NONE_TOKENS = new Set(['none', 'null', 'nil', 'na', 'n/a'])

/**
 * DECISIÓN CENTRAL Y ÚNICA de la política de audio del preview.
 *
 * Colapsa el modo efectivo + la info de la pista + la evidencia del stderr + el
 * perfil conocido de la cámara en una única decisión {includeAudio, videoOnly,
 * reason}. Esta función es PURA: no toca FFmpeg, ni la DB, ni el DOM. Todo el
 * resto del sistema (constructor de args, clasificador de error, logs) debe
 * derivar su comportamiento de aquí, sin reimplementar la lógica.
 *
 * @param configuredMode  modo YA resuelto por precedencia (resolveEffectiveAudioMode)
 */
export function resolvePreviewAudioPolicy(opts: {
  configuredMode: AudioMode
  audioStream?: AudioStreamInfo | null
  stderrEvidence?: StderrAudioEvidence | null
  knownCameraProfile?: KnownCameraAudioProfile | null
}): PreviewAudioDecision {
  const videoOnly = (reason: PreviewAudioReason): PreviewAudioDecision =>
    ({ includeAudio: false, videoOnly: true, reason })

  // 1) disabled: nunca intentar audio, aunque el RTSP lo anuncie. -an directo.
  if (opts.configuredMode === 'disabled') return videoOnly('configured_disabled')

  // 2) Perfil conocido estable: la cámara ya demostró requerir video-only.
  if (opts.knownCameraProfile?.videoOnly) return videoOnly('known_video_only_camera')

  // 3) Evidencia dura del stderr (fallback reactivo): decoder o mux de audio.
  if (opts.stderrEvidence?.audioDecoderUnavailable) return videoOnly('audio_decoder_unavailable')
  if (opts.stderrEvidence?.audioMuxIncompatible) return videoOnly('audio_mux_incompatible')

  // 4) Inspección de la pista de audio (ffprobe / stderr).
  //   audioStream === undefined ⇒ AÚN NO inspeccionado (p.ej. primer spawn sin
  //   ffprobe): en auto/enabled se intenta A/V y el fallback reactivo cubre fallos.
  //   audioStream === null / {present:false} ⇒ inspeccionado y AUSENTE ⇒ video-only.
  const a = opts.audioStream
  if (a === undefined) return { includeAudio: true, videoOnly: false, reason: 'audio_usable' }
  if (a === null || a.present === false || a.disabled) return videoOnly('no_audio_stream')

  const codec = (a.codecName ?? '').trim().toLowerCase()
  //   - codec vacío/null ⇒ tratado como 'none'.
  if (codec === '' || NONE_TOKENS.has(codec)) return videoOnly('audio_codec_none')
  if (codec === 'unknown') return videoOnly('audio_codec_unknown')
  //   - G.711 μ-law/A-law y afines: el pipeline A/V no los muxea ⇒ incompatible.
  if (isProblematicPreviewAudio(codec)) return videoOnly('audio_mux_incompatible')
  //   - parámetros incompletos: no se puede muxear con garantías.
  if (a.parametersIncomplete) return videoOnly('audio_mux_incompatible')

  // 5) Audio presente, habilitado y utilizable ⇒ incluir audio.
  //    (auto y enabled coinciden aquí; el fallback reactivo cubre fallos en runtime.)
  return { includeAudio: true, videoOnly: false, reason: 'audio_usable' }
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK REACTIVO derivado de la política central (no de una lista de codecs).
//
// El fallback reactivo del preview NO debe depender sólo de isProblematicPreviewAudio
// (que reconoce G.711 pero NO none/unknown/vacío/sin-decoder). Debe construir la
// evidencia de audio desde el stderr y delegar la DECISIÓN en resolvePreviewAudioPolicy.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrae evidencia de AUDIO desde el texto de stderr de FFmpeg. Distingue
 * audio de video por **correlación de índice de stream** (#prog:idx), NO por una
 * allow-list de codecs — reconoce cualquier codec presente o futuro (adpcm,
 * g726, g722, speex, opus, pcm, aac, …). Como respaldo para líneas de error sin
 * índice, usa una deny-list acotada de codecs de VIDEO. Trabaja sobre el tail
 * acumulado (multilinea), por lo que la definición del stream y el error de
 * decoder pueden llegar en chunks/orden distintos.
 */
export function detectAudioStderrEvidence(stderrText: string): {
  audioStreamSeen: boolean
  audioCodec: string | null
  audioDecoderUnavailable: boolean
  audioMuxIncompatible: boolean
  audioParametersIncomplete: boolean
  audioTrackDisabled: boolean
} {
  const t = stderrText || ''

  // 1) Mapa de streams declarados: "Stream #0:1: Audio: <codec>" / "...: Video: <codec>".
  //    Se indexa por clave completa "0:1" y por índice numérico "1" (respaldo).
  type StreamType = 'audio' | 'video'
  const streams = new Map<string, { type: StreamType; codec: string | null }>()
  let audioStreamSeen = false
  let audioCodec: string | null = null
  const declRe = /stream #(\d+):(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*(video|audio):\s*([a-z0-9_]+)?/ig
  let dm: RegExpExecArray | null
  while ((dm = declRe.exec(t)) !== null) {
    const prog = dm[1], idx = dm[2]
    const type = dm[3].toLowerCase() as StreamType
    const codec = dm[4] ? dm[4].toLowerCase() : null
    const entry = { type, codec }
    streams.set(`${prog}:${idx}`, entry)
    if (!streams.has(idx)) streams.set(idx, entry) // respaldo numérico (1er programa)
    if (type === 'audio') {
      audioStreamSeen = true
      if (audioCodec == null && codec) audioCodec = codec
    }
  }

  // Deny-list ACOTADA de codecs de VIDEO (conjunto estable en playback de NVR).
  // Todo lo que NO sea video se considera potencialmente audio (sin allow-list).
  const isVideoCodec = (c: string | null): boolean =>
    !!c && /^(hevc|h265|h\.265|h264|h\.264|avc1?|mpeg4|mpeg2video|mjpeg|vp8|vp9|av1|h263)$/i.test(c)

  // Resuelve el tipo de stream al que apunta una línea de error.
  const refTypeOf = (line: string): StreamType | null => {
    // Pista inline explícita "(Audio: ...)" / "(Video: ...)".
    if (/\(audio[:\s)]/i.test(line)) return 'audio'
    if (/\(video[:\s)]/i.test(line)) return 'video'
    // Referencia por índice "#0:1".
    const full = line.match(/#(\d+):(\d+)/)
    if (full) { const e = streams.get(`${full[1]}:${full[2]}`); if (e) return e.type }
    // Referencia por índice numérico "stream 1".
    const num = line.match(/\bstream #?(\d+)\b/i)
    if (num) { const e = streams.get(num[1]); if (e) return e.type }
    return null
  }

  // Extrae el codec nombrado en una línea de error ("(codec X)" / "for codec X" / "for: X").
  const codecInLine = (line: string): string | null => {
    const m =
      line.match(/\(codec\s+([a-z0-9_]+)\)/i) ||
      line.match(/for(?:\s+codec)?:?\s+([a-z0-9_]+)\b/i) ||
      line.match(/unsupported codec[^\n]*?\b([a-z0-9_]+)\b\s*$/i)
    return m ? m[1].toLowerCase() : null
  }

  let audioDecoderUnavailable = false
  let audioMuxIncompatible = false
  let audioParametersIncomplete = false

  for (const raw of t.split('\n')) {
    const line = raw.trim()
    if (!line) continue

    const isDecoderErr = /decoder[^\n]*not found|not found[^\n]*decoder|no decoder[^\n]*for|error while opening decoder|could not open decoder|unsupported codec/i.test(line)
    const isCodecParams = /could not find codec parameters/i.test(line)
    const isMuxTag = /could not find tag for codec|automatic encoder selection failed/i.test(line)
    if (!isDecoderErr && !isCodecParams && !isMuxTag) continue

    // Tipo del stream referido: correlación por índice/inline; si no hay, por codec.
    let type = refTypeOf(line)
    if (type == null) {
      const c = codecInLine(line)
      if (isVideoCodec(c)) type = 'video'
      else if (c && c !== 'none' && c !== 'unknown') type = 'audio' // codec no-video ⇒ audio
      else if (/\b(none|unknown)\b/i.test(line)) type = 'audio'     // "for: none"/"unknown"
    }
    if (type !== 'audio') continue // video o indeterminado no-audio ⇒ no evidencia de audio

    if (isDecoderErr) audioDecoderUnavailable = true
    if (isCodecParams) audioParametersIncomplete = true
    if (isMuxTag) audioMuxIncompatible = true
  }

  const audioTrackDisabled = /audio[^\n]*\b(disabled|deshabilitad)/i.test(t)

  return {
    audioStreamSeen, audioCodec,
    audioDecoderUnavailable, audioMuxIncompatible, audioParametersIncomplete, audioTrackDisabled,
  }
}

/**
 * DECISIÓN del fallback reactivo, derivada de resolvePreviewAudioPolicy (no de
 * una lista de codecs). Aplica las guardas del intento en curso.
 *
 * restart=true ⇒ hay que matar el intento A/V y relanzar la MISMA URI en
 * video-only. `stableAudioEvidence` indica si la evidencia es estable de audio
 * (para marcar la cámara como problemática) — nunca por timeout/auth/red/URI.
 */
export function decideReactiveAudioRestart(opts: {
  configuredMode: AudioMode
  /** codec de audio ya detectado por el parser de streams (o null). */
  detectedAudioCodec: string | null
  /** ¿se vio una línea "Audio:" en el stderr? (aunque el codec sea vacío). */
  audioStreamSeen: boolean
  /** tail de stderr acumulado, para detectar decoder/params de audio. */
  stderrText: string
  attemptVideoOnly: boolean
  firstByteSent: boolean
  audioFallbackTried: boolean
  knownProblematic?: boolean
}): { restart: boolean; decision: PreviewAudioDecision | null; stableAudioEvidence: boolean } {
  // Guardas: no reintentar si ya es video-only, ya hubo primer byte, o ya se reintentó.
  if (opts.attemptVideoOnly || opts.firstByteSent || opts.audioFallbackTried) {
    return { restart: false, decision: null, stableAudioEvidence: false }
  }

  const ev = detectAudioStderrEvidence(opts.stderrText)
  const codec = opts.detectedAudioCodec ?? ev.audioCodec
  const audioSeen = opts.audioStreamSeen || ev.audioStreamSeen || codec != null

  // audioStream: undefined = aún sin evidencia de audio (no forzar video-only);
  // definido cuando se vio la pista o su codec.
  const audioStream: AudioStreamInfo | undefined = audioSeen
    ? { present: true, codecName: codec, disabled: ev.audioTrackDisabled || undefined, parametersIncomplete: ev.audioParametersIncomplete || undefined }
    : undefined

  const stderrEvidence: StderrAudioEvidence = {
    audioDecoderUnavailable: ev.audioDecoderUnavailable || undefined,
    audioMuxIncompatible: ev.audioMuxIncompatible || undefined,
  }

  const decision = resolvePreviewAudioPolicy({
    configuredMode: opts.configuredMode,
    audioStream,
    stderrEvidence,
    knownCameraProfile: { videoOnly: opts.knownProblematic },
  })

  // Sólo estable si la causa es de AUDIO (no configured_disabled/known, que no son
  // "aprendizaje" de una cámara concreta por evidencia de codec).
  const AUDIO_EVIDENCE_REASONS = new Set<PreviewAudioReason>([
    'no_audio_stream', 'audio_codec_none', 'audio_codec_unknown',
    'audio_decoder_unavailable', 'audio_mux_incompatible',
  ])
  const stableAudioEvidence = decision.videoOnly && AUDIO_EVIDENCE_REASONS.has(decision.reason)

  return { restart: decision.videoOnly, decision, stableAudioEvidence }
}

/**
 * Buffer de reensamblado de líneas de stderr. Node NO garantiza que los chunks
 * coincidan con líneas: se acumula y sólo se emiten líneas COMPLETAS; la última
 * (sin '\n') queda pendiente hasta el próximo chunk o el flush final. No inserta
 * saltos artificiales entre fragmentos: reconstruye la línea original tal cual.
 * La MISMA línea reconstruida alimenta a todos los consumidores.
 */
export function makeStderrLineBuffer() {
  let carry = ''
  return {
    /** Acumula un chunk y devuelve las líneas COMPLETAS disponibles. */
    push(chunk: string): string[] {
      carry += chunk
      const parts = carry.split(/\r?\n/)
      carry = parts.pop() ?? ''
      return parts
    },
    /** Devuelve el residual final (línea sin '\n') y lo vacía. */
    flush(): string | null {
      const r = carry
      carry = ''
      return r || null
    },
  }
}
