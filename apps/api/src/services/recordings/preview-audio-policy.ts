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
 * Tipo de stream declarado por FFmpeg.
 */
export type StreamKind = 'audio' | 'video'

/** Instantánea de evidencia de audio/video acumulada durante UN intento FFmpeg. */
export interface AudioEvidenceSnapshot {
  audioStreamSeen: boolean
  audioCodec: string | null
  audioDecoderUnavailable: boolean
  audioMuxIncompatible: boolean
  audioParametersIncomplete: boolean
  audioTrackDisabled: boolean
  /** Error de decoder atribuido al VIDEO: mantiene CODEC_UNSUPPORTED, nunca fallback de audio. */
  videoDecoderUnavailable: boolean
  /** Errores aún NO atribuibles a audio ni a video: permanecen NEUTRALES. */
  unresolvedDecoderErrors: number
}

// Deny-list ACOTADA de codecs de VIDEO. Ya NO alcanza por sí sola para inferir
// audio "por descarte": sólo sirve para descartar como video un codec que fue
// extraído de un campo EXPLÍCITO de codec.
const VIDEO_CODEC_RE = /^(hevc|h265|h\.265|h266|h\.266|vvc|h264|h\.264|avc1?|avs2|avs3|mpeg4|mpeg2video|mpeg1video|mjpeg|vp8|vp9|av1|av2|h263|theora|prores|dvvideo|rawvideo)$/i

// Familias de codecs de AUDIO — evidencia POSITIVA. Se usa SÓLO en errores SIN
// índice de stream: la ausencia de un codec en VIDEO_CODEC_RE nunca prueba que
// sea audio (un codec de video futuro como vvc/avs3 no debe leerse como audio).
const AUDIO_CODEC_FAMILY_RE = /^(pcm_|adpcm_|g\.?7\d\d|aac|ac3|eac3|atrac|amr|wma|ra_|ilbc|gsm|dts|truehd|mlp|opus|vorbis|speex|flac|alac|ape|tak|wavpack|musepack|mpc|nellymoser|sipr|cook|qdm|s302m|dsd_|sonic|comfortnoise|mp1|mp2|mp3|qcelp|evrc|binkaudio|twinvq)/i

/** ¿Este nombre de codec pertenece a una familia de AUDIO conocida? */
export function isAudioCodecName(codec: string | null | undefined): boolean {
  return !!codec && AUDIO_CODEC_FAMILY_RE.test(codec)
}

// Palabras que NUNCA son un nombre de codec. Red de seguridad adicional: los
// patrones de extracción ya son estructuralmente explícitos, pero este filtro
// garantiza que un cambio futuro no reintroduzca capturas como "input".
const NON_CODEC_WORDS = new Set([
  'input', 'output', 'stream', 'streams', 'decoder', 'encoder', 'error', 'errors',
  'id', 'with', 'for', 'codec', 'codecs', 'parameters', 'parameter', 'opening',
  'open', 'while', 'the', 'and', 'in', 'on', 'of', 'to', 'from', 'found', 'not',
  'file', 'index', 'type', 'data', 'invalid', 'unsupported', 'failed', 'selection',
])

/**
 * Extrae el nombre de codec SÓLO desde formatos explícitos y verificables.
 *
 * NO existe ninguna extracción genérica tipo "for X": la frase
 * "Error while opening decoder for input stream #0:0" NO contiene un codec, y
 * capturar "input" como codec provocaba clasificar un fallo de VIDEO como audio.
 */
export function extractExplicitCodec(line: string): string | null {
  const m =
    // Decoder (codec adpcm_g726le) not found for input stream #0:1
    line.match(/\(codec\s+([a-z0-9_.]+)\s*\)/i) ||
    // No decoder found for codec adpcm_g726le
    line.match(/\bno decoder found for codec[:\s]+([a-z0-9_.]+)/i) ||
    // No decoder found for: none
    line.match(/\bno decoder found for:\s*([a-z0-9_.]+)/i) ||
    // Unsupported codec: adpcm_g726le   (NO matchea "Unsupported codec with id 98 ...")
    line.match(/\bunsupported codec:\s*([a-z0-9_.]+)/i) ||
    // codec 'adpcm_g726le'
    line.match(/\bcodec\s+'([a-z0-9_.]+)'/i) ||
    // Could not find tag for codec adpcm_g726le in stream #1
    line.match(/\bcould not find tag for codec\s+([a-z0-9_.]+)/i)
  if (!m) return null
  const codec = m[1].toLowerCase()
  if (NON_CODEC_WORDS.has(codec)) return null
  return codec
}

/** ¿Este nombre de codec corresponde a VIDEO? */
export function isVideoCodecName(codec: string | null | undefined): boolean {
  return !!codec && VIDEO_CODEC_RE.test(codec)
}

// Declaración de stream: "Stream #0:1: Audio: adpcm_g726le" / "Stream #0:0: Video: hevc"
const STREAM_DECL_RE = /\bstream #(\d+):(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*(video|audio):\s*([a-z0-9_.]+)?/i
// Declaración IMPLÍCITA dentro de una línea de error: FFmpeg nombra el tipo del
// stream referido — "…for stream 1 (Audio: pcm_mulaw, 8000 Hz)" o
// "…input stream #0:0, Video: hevc". Es una afirmación DIRECTA del tipo (no una
// inferencia por nombre de codec), por lo que alimenta el registro de streams.
const INLINE_STREAM_TYPE_RE = /\bstream #?(\d+)(?::(\d+))?\s*[(,]\s*(audio|video)\s*:\s*([a-z0-9_.]+)?/i
// Errores relevantes.
const DECODER_ERR_RE = /decoder[^\n]*not found|not found[^\n]*decoder|\bno decoder\b[^\n]*\bfor\b|error while opening decoder|could not open decoder|unsupported codec/i
const CODEC_PARAMS_RE = /could not find codec parameters/i
const MUX_TAG_RE = /could not find tag for codec|automatic encoder selection failed/i

/** Tipo de error de decoder/codec observado en una línea de stderr. */
export type DecoderErrorKind = 'decoder' | 'codec_parameters' | 'mux_tag'

/**
 * Evidencia de error INDEXADA que aún no puede clasificarse porque el stream
 * referido todavía no fue declarado. Permanece NEUTRAL hasta que llegue la
 * declaración: nunca infiere el tipo a partir del nombre del codec.
 */
export interface PendingDecoderEvidence {
  streamKey: string
  errorKind: DecoderErrorKind
  explicitCodec: string | null
  /** Primera línea saneada y truncada de este hecho lógico (diagnóstico). */
  rawFingerprint: string
  /** Última línea saneada observada (sólo si difiere de la primera). */
  lastRawFingerprint: string | null
  /** Orden de llegada de la PRIMERA ocurrencia dentro del intento. */
  createdSequence: number
  /** Orden de llegada de la ÚLTIMA ocurrencia. */
  lastSequence: number
  /** Cuántas veces se observó este MISMO hecho lógico. */
  occurrences: number
}

// ─── Límites defensivos del almacenamiento pendiente ─────────────────────────
// Un FFmpeg ruidoso o bloqueado puede repetir el mismo error de decoder miles de
// veces mientras el stream sigue sin declararse. La evidencia pendiente se
// deduplica por hecho LÓGICO (streamKey + errorKind + codec normalizado) y se
// acota con estos topes explícitos, para que la memoria no crezca con el volumen
// de stderr ni se multiplique con previews concurrentes.

/** Máximo de hechos lógicos distintos retenidos por stream. */
export const MAX_PENDING_EVIDENCE_PER_STREAM = 4
/** Máximo de streams distintos con evidencia pendiente por intento. */
export const MAX_PENDING_STREAMS_PER_ATTEMPT = 16
/** Máximo global de hechos lógicos pendientes por intento. */
export const MAX_PENDING_EVIDENCE_TOTAL_PER_ATTEMPT = 32

/** Contadores del almacenamiento pendiente (diagnóstico y logs acotados). */
export interface PendingEvidenceStats {
  /** Hechos lógicos distintos retenidos ahora mismo. */
  pendingUniqueCount: number
  /** Ocurrencias totales observadas (incluye las deduplicadas). */
  totalOccurrences: number
  /** Ocurrencias descartadas por alcanzar un límite (nunca se crean entradas). */
  suppressedCount: number
  /** Streams distintos con evidencia pendiente. */
  pendingStreamCount: number
}

/**
 * Tracker CON ESTADO de evidencia de audio/video para UN intento FFmpeg.
 *
 * INVARIANTE CENTRAL — el índice de stream es la ÚNICA fuente de verdad:
 *   · Si la línea de error referencia un índice (#0:0, #0:1, "stream 1"), la
 *     clasificación depende EXCLUSIVAMENTE del streamRegistry. Si el índice no
 *     está registrado todavía, la evidencia queda PENDIENTE y NEUTRAL — no se
 *     infiere por el nombre del codec, aunque el mensaje incluya "(codec X)".
 *     Un codec de video futuro (vvc/h266/avs3…) jamás debe leerse como audio
 *     sólo por no figurar en la lista de codecs de video.
 *   · La inferencia por codec explícito SÓLO se usa en errores SIN índice, y
 *     exige evidencia POSITIVA: familia de codec de audio reconocida (o el
 *     marcador none/unknown). La ausencia en la lista de video no prueba audio.
 *
 * El registro persiste todo el intento y no depende del stderrTail (capado a 30
 * líneas), por lo que una declaración evictada del tail sigue siendo válida.
 */
export function createAudioEvidenceTracker() {
  const streamRegistry = new Map<string, { type: StreamKind; codec: string | null }>()
  // streamKey → (claveLógica → agregado). La clave lógica NO depende del
  // fingerprint: un texto de error variable no puede evadir la deduplicación.
  const pending = new Map<string, Map<string, PendingDecoderEvidence>>()
  let pendingUniqueCount = 0
  let totalOccurrences = 0
  let suppressedCount = 0

  let sequence = 0
  let audioStreamSeen = false
  let audioCodec: string | null = null
  let audioDecoderUnavailable = false
  let audioMuxIncompatible = false
  let audioParametersIncomplete = false
  let audioTrackDisabled = false
  let videoDecoderUnavailable = false

  const applyKind = (kind: StreamKind, errorKind: DecoderErrorKind) => {
    if (kind === 'audio') {
      if (errorKind === 'decoder') audioDecoderUnavailable = true
      if (errorKind === 'codec_parameters') audioParametersIncomplete = true
      if (errorKind === 'mux_tag') audioMuxIncompatible = true
    } else if (errorKind === 'decoder') {
      videoDecoderUnavailable = true
    }
  }

  /**
   * Resuelve las evidencias pendientes de un stream recién declarado: cada
   * hecho LÓGICO se aplica UNA sola vez, aunque se haya observado miles de
   * veces. Luego se liberan sus referencias (fingerprints incluidos).
   */
  const resolvePendingFor = (keys: string[], kind: StreamKind) => {
    for (const k of keys) {
      const facts = pending.get(k)
      if (!facts) continue
      pending.delete(k)
      pendingUniqueCount -= facts.size
      for (const e of facts.values()) applyKind(kind, e.errorKind)
      facts.clear()
    }
  }

  /**
   * Registra una ocurrencia de evidencia pendiente, deduplicada por hecho
   * lógico. Política de overflow DETERMINISTA: se conservan los primeros hechos
   * únicos; al alcanzar cualquier límite no se crean entradas nuevas y sólo se
   * incrementa suppressedCount. Las repeticiones de un hecho ya retenido nunca
   * se suprimen: sólo actualizan occurrences/lastSequence/lastRawFingerprint.
   */
  const recordPending = (
    streamKey: string, errorKind: DecoderErrorKind,
    explicitCodec: string | null, fingerprint: string,
  ) => {
    totalOccurrences++
    const factKey = `${errorKind}|${explicitCodec ?? ''}`
    const facts = pending.get(streamKey)

    const existing = facts?.get(factKey)
    if (existing) {
      existing.occurrences++
      existing.lastSequence = sequence
      existing.lastRawFingerprint = fingerprint === existing.rawFingerprint ? existing.lastRawFingerprint : fingerprint
      return
    }

    // Nuevo hecho lógico: validar los tres topes antes de crear la entrada.
    if (!facts && pending.size >= MAX_PENDING_STREAMS_PER_ATTEMPT) { suppressedCount++; return }
    if (facts && facts.size >= MAX_PENDING_EVIDENCE_PER_STREAM) { suppressedCount++; return }
    if (pendingUniqueCount >= MAX_PENDING_EVIDENCE_TOTAL_PER_ATTEMPT) { suppressedCount++; return }

    const target = facts ?? new Map<string, PendingDecoderEvidence>()
    if (!facts) pending.set(streamKey, target)
    target.set(factKey, {
      streamKey, errorKind, explicitCodec,
      rawFingerprint: fingerprint,
      lastRawFingerprint: null,
      createdSequence: sequence,
      lastSequence: sequence,
      occurrences: 1,
    })
    pendingUniqueCount++
  }

  const registerStream = (prog: string | null, idx: string, kind: StreamKind, codec: string | null) => {
    const entry = { type: kind, codec }
    const keys: string[] = []
    if (prog != null) { streamRegistry.set(`${prog}:${idx}`, entry); keys.push(`${prog}:${idx}`) }
    if (!streamRegistry.has(`num:${idx}`)) streamRegistry.set(`num:${idx}`, entry)
    keys.push(`num:${idx}`)
    if (kind === 'audio') audioStreamSeen = true
    resolvePendingFor(keys, kind)
  }

  /** Claves de referencia de stream mencionadas en una línea. */
  const refKeysOf = (line: string): string[] => {
    const full = line.match(/#(\d+):(\d+)/)
    if (full) return [`${full[1]}:${full[2]}`, `num:${full[2]}`]
    const bare = line.match(/\bstream\s+(\d+):(\d+)/i)
    if (bare) return [`${bare[1]}:${bare[2]}`, `num:${bare[2]}`]
    const num = line.match(/\bstream #?(\d+)\b/i)
    if (num) return [`num:${num[1]}`]
    return []
  }

  const sanitize = (line: string): string =>
    line.replace(/(rtsps?|https?):\/\/([^:/\s@]+):([^@/\s]+)@/gi, '$1://$2:***@').slice(0, 200)

  return {
    /** Consume UNA línea de stderr ya reconstruida. */
    push(rawLine: string): void {
      const line = (rawLine || '').trim()
      if (!line) return
      sequence++

      // 1) Declaración canónica: "Stream #0:1: Audio: adpcm_g726le".
      const decl = line.match(STREAM_DECL_RE)
      if (decl) {
        const kind = decl[3].toLowerCase() as StreamKind
        const codec = decl[4] ? decl[4].toLowerCase() : null
        registerStream(decl[1], decl[2], kind, codec)
        if (kind === 'audio') {
          if (audioCodec == null && codec) audioCodec = codec
          if (/\b(disabled|deshabilitad)/i.test(line)) audioTrackDisabled = true
        }
        return
      }

      // 2) Declaración IMPLÍCITA en una línea de error: FFmpeg indica el tipo del
      //    stream referido, p.ej. "…for stream 1 (Audio: pcm_mulaw, 8000 Hz)" o
      //    "…input stream #0:0, Video: hevc". Es una afirmación directa del tipo
      //    (no una inferencia por codec), así que alimenta el registro.
      const inlineDecl = line.match(INLINE_STREAM_TYPE_RE)
      if (inlineDecl) {
        const prog = inlineDecl[2] != null ? inlineDecl[1] : null
        const idx = inlineDecl[2] != null ? inlineDecl[2] : inlineDecl[1]
        const kind = inlineDecl[3].toLowerCase() as StreamKind
        const codec = inlineDecl[4] ? inlineDecl[4].toLowerCase() : null
        registerStream(prog, idx, kind, codec)
        if (kind === 'audio' && audioCodec == null && codec) audioCodec = codec
      }

      // 3) ¿Es una línea de error relevante?
      const errorKinds: DecoderErrorKind[] = []
      if (DECODER_ERR_RE.test(line)) errorKinds.push('decoder')
      if (CODEC_PARAMS_RE.test(line)) errorKinds.push('codec_parameters')
      if (MUX_TAG_RE.test(line)) errorKinds.push('mux_tag')
      if (errorKinds.length === 0) {
        if (/\baudio\b/i.test(line) && /\b(disabled|deshabilitad)/i.test(line)) audioTrackDisabled = true
        return
      }

      const keys = refKeysOf(line)
      const explicitCodec = extractExplicitCodec(line)

      // 4) LÍNEA INDEXADA ⇒ sólo manda el registro.
      if (keys.length > 0) {
        for (const k of keys) {
          const reg = streamRegistry.get(k)
          if (reg) { for (const ek of errorKinds) applyKind(reg.type, ek); return }
        }
        // Índice aún NO registrado ⇒ PENDIENTE y NEUTRAL. Sin inferencia por codec.
        // El almacenamiento está deduplicado por hecho lógico y acotado: repetir
        // el mismo error miles de veces no hace crecer la estructura.
        const key = keys[0]
        const fingerprint = sanitize(line)
        for (const ek of errorKinds) recordPending(key, ek, explicitCodec, fingerprint)
        return
      }

      // 5) LÍNEA SIN ÍNDICE ⇒ se admite inferencia por codec EXPLÍCITO, pero sólo
      //    con evidencia POSITIVA (familia de audio conocida, o none/unknown).
      //    Un codec desconocido/futuro queda NEUTRAL, nunca audio por exclusión.
      if (!explicitCodec) return
      if (isVideoCodecName(explicitCodec)) {
        for (const ek of errorKinds) applyKind('video', ek)
        return
      }
      // none/unknown: marcador de pista sin codec real (firma de Box 4), válido
      // como evidencia de audio sólo cuando NO hay índice que consultar.
      const noneMarker = NONE_TOKENS.has(explicitCodec) || explicitCodec === 'unknown'
      if (isAudioCodecName(explicitCodec) || noneMarker) {
        for (const ek of errorKinds) applyKind('audio', ek)
      }
    },

    /** Instantánea de la evidencia acumulada. */
    evidence(): AudioEvidenceSnapshot {
      return {
        audioStreamSeen, audioCodec,
        audioDecoderUnavailable, audioMuxIncompatible, audioParametersIncomplete,
        audioTrackDisabled, videoDecoderUnavailable,
        // Hechos LÓGICOS pendientes (no ocurrencias): acotado por diseño.
        unresolvedDecoderErrors: pendingUniqueCount,
      }
    },

    /** Copia del registro de streams (diagnóstico/tests). */
    streams(): Map<string, { type: StreamKind; codec: string | null }> {
      return new Map(streamRegistry)
    },

    /** Evidencias pendientes sin resolver, deduplicadas (diagnóstico/tests). */
    pendingEvidence(): PendingDecoderEvidence[] {
      const out: PendingDecoderEvidence[] = []
      for (const facts of pending.values()) out.push(...facts.values())
      return out.sort((a, b) => a.createdSequence - b.createdSequence)
    },

    /** Contadores acotados para logs sanitizados. */
    pendingStats(): PendingEvidenceStats {
      return {
        pendingUniqueCount,
        totalOccurrences,
        suppressedCount,
        pendingStreamCount: pending.size,
      }
    },

    /**
     * Libera TODA la estructura pendiente (close/exit). Las evidencias sin
     * resolver quedan neutrales para siempre: nunca se convierten en audio.
     */
    clearPending(): void {
      for (const facts of pending.values()) facts.clear()
      pending.clear()
      pendingUniqueCount = 0
    },
  }
}

/**
 * Versión PURA sobre texto multilinea: alimenta un tracker nuevo y devuelve la
 * evidencia. Útil para tests y para clasificar un tail acumulado. En el camino
 * caliente del preview se usa el tracker CON ESTADO por intento, porque el tail
 * puede haber evictado la declaración del stream.
 */
export function detectAudioStderrEvidence(stderrText: string): AudioEvidenceSnapshot {
  const tracker = createAudioEvidenceTracker()
  for (const line of (stderrText || '').split('\n')) tracker.push(line)
  return tracker.evidence()
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
  /**
   * Evidencia del tracker CON ESTADO del intento (preferido): sobrevive al
   * capado del tail, por lo que la declaración del stream nunca se pierde.
   */
  evidence?: AudioEvidenceSnapshot
  /** Alternativa: tail de stderr acumulado (se deriva una evidencia efímera). */
  stderrText?: string
  attemptVideoOnly: boolean
  firstByteSent: boolean
  audioFallbackTried: boolean
  knownProblematic?: boolean
}): { restart: boolean; decision: PreviewAudioDecision | null; stableAudioEvidence: boolean } {
  // Guardas: no reintentar si ya es video-only, ya hubo primer byte, o ya se reintentó.
  if (opts.attemptVideoOnly || opts.firstByteSent || opts.audioFallbackTried) {
    return { restart: false, decision: null, stableAudioEvidence: false }
  }

  const ev = opts.evidence ?? detectAudioStderrEvidence(opts.stderrText ?? '')
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
