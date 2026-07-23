// apps/api/src/services/recordings/rtsp-url.ts
// Helpers PUROS de URLs RTSP de reproducción y clasificación de errores.
// Extraídos de routes/recordings.ts — sin estado ni efectos: todo testeable.

export type PlaybackVariant = 'main_full' | 'main_no_name_size' | 'sub_full' | 'sub_no_name_size'
export type PlaybackStreamMode = 'main' | 'sub' | 'auto'

// Mask credentials in any rtsp:// or http(s):// URL embedded in log text.
// FFmpeg stderr echoes the full input URL including the password — never
// store or log it in clear.
export function maskUrlCredentials(text: string): string {
  return text.replace(/(rtsps?|https?):\/\/([^:\/\s@]+):([^@\/\s]+)@/gi, '$1://$2:***@')
}

// Classify RTSP/FFmpeg failures into actionable categories so the frontend
// can show the real cause instead of a generic "retry with H.264".
export function classifyRtspError(text: string): string {
  const t = text.toLowerCase()
  // 453 first — its stderr also contains "4XX Client Error" and "DESCRIBE
  // failed", which would otherwise mismatch as auth/open errors
  if (/453|not enough bandwidth/.test(t))                             return 'NVR_BANDWIDTH_OR_SESSION_LIMIT'
  // 400 Bad Request del NVR: sólo patrones RTSP/FFmpeg reales, NO cualquier "400"
  // suelto (puerto 400, 400 kb/s, 400x300, etc. no deben clasificarse así).
  if (/rtsp\/\d\.\d\s+400|server returned 400|400 bad request|(?:describe|setup|play|options|teardown|method[^:\n]*)\s+failed:\s*400/.test(t))
                                                                       return 'RTSP_PLAYBACK_URI_REJECTED'
  if (/401|unauthorized|credenciales/.test(t))                        return 'RTSP_AUTH_OR_TRACK_DENIED'
  if (/404|not found|no encontrado/.test(t))                          return 'RTSP_TRACK_NOT_FOUND'
  if (/connection refused|conexi.n rechazada|timed? ?out|timeout/.test(t)) return 'NVR_OFFLINE_OR_TIMEOUT'
  if (/no supported streams|invalid data found|could not find codec/.test(t)) return 'CODEC_UNSUPPORTED'
  if (/could not open|open context|error opening input/.test(t))      return 'RTSP_OPEN_FAILED'
  return 'UNKNOWN'
}

// Categorías GRANULARES del punto EXACTO donde se detiene una estrategia. A
// diferencia de classifyRtspError (heurística sólo-stderr), ésta consume la
// EVIDENCIA POR ETAPAS del diagnóstico: no puede afirmarse "el NVR rechazó la
// URL" cuando track 101 sólo agotó el tiempo sin producir salida — eso es un
// MUXER_NO_OUTPUT / OPENED_NO_PACKETS, no un URI_REJECTED.
export type StageFailureCategory =
  | 'RTSP_URI_REJECTED'
  | 'RTSP_AUTH_FAILED'
  | 'NVR_BANDWIDTH_OR_SESSION_LIMIT'
  | 'RTSP_OPEN_TIMEOUT'
  | 'RTSP_OPEN_FAILED'
  | 'RTSP_OPENED_NO_PACKETS'
  | 'VIDEO_STREAM_MISSING'
  | 'VIDEO_NO_KEYFRAME'
  | 'DECODE_FAILED'
  | 'ENCODE_FAILED'
  | 'MUXER_NO_OUTPUT'
  | 'OUTPUT_PIPE_DRAIN_RACE'
  | 'STARTUP_BUDGET_EXCEEDED'
  | 'STAGE_OK'
  | 'UNKNOWN'

export interface StageEvidence {
  inputOpened: boolean          // se vio "Input #0" / streams
  videoStreamPresent: boolean   // hay Stream Video en el SDP/probe
  firstVideoPacketMs: number | null
  firstDecodedFrameMs: number | null
  firstEncodedFrameMs: number | null
  firstMuxedByteMs: number | null
  bytesAfterKill?: boolean       // el primer byte llegó DESPUÉS del SIGKILL
  timedOut: boolean
  budgetExceeded?: boolean
  stderr: string
}

// Devuelve la categoría del punto de detención. El orden importa: errores duros
// del transporte (auth/453/400/open) ganan; luego se avanza etapa por etapa.
export function classifyStageFailure(ev: StageEvidence): StageFailureCategory {
  const t = (ev.stderr || '').toLowerCase()
  if (ev.budgetExceeded) return 'STARTUP_BUDGET_EXCEEDED'
  // Éxito real: hubo primer byte muxeado ANTES de cualquier kill.
  if (ev.firstMuxedByteMs != null && !ev.bytesAfterKill) return 'STAGE_OK'
  // Byte muxeado pero SÓLO tras el kill → carrera de drenaje del pipe (el proceso
  // ya había producido salida cuando lo matamos). NO es rechazo del NVR.
  if (ev.firstMuxedByteMs != null && ev.bytesAfterKill) return 'OUTPUT_PIPE_DRAIN_RACE'

  // Errores duros de transporte (independientes de la etapa alcanzada).
  if (/453|not enough bandwidth/.test(t)) return 'NVR_BANDWIDTH_OR_SESSION_LIMIT'
  if (/rtsp\/\d\.\d\s+400|server returned 400|400 bad request|(?:describe|setup|play|options|teardown|method[^:\n]*)\s+failed:\s*400/.test(t)) return 'RTSP_URI_REJECTED'
  if (/401|unauthorized|credenciales/.test(t)) return 'RTSP_AUTH_FAILED'

  // El input nunca abrió: distinguir timeout de fallo explícito.
  if (!ev.inputOpened) {
    if (/could not open|open context|error opening input|connection refused/.test(t)) return 'RTSP_OPEN_FAILED'
    return 'RTSP_OPEN_TIMEOUT'
  }
  // Input abierto pero sin stream de video utilizable.
  if (!ev.videoStreamPresent) return 'VIDEO_STREAM_MISSING'
  // Abrió pero nunca llegó un paquete de video (RTP no fluye / firewall / PLAY sin datos).
  if (ev.firstVideoPacketMs == null) return 'RTSP_OPENED_NO_PACKETS'
  // Llegaron paquetes pero nunca se decodificó un frame (sin keyframe o decode roto).
  if (ev.firstDecodedFrameMs == null) {
    if (/decod|corrupt|invalid data|no frame/.test(t)) return 'DECODE_FAILED'
    return 'VIDEO_NO_KEYFRAME'
  }
  // Se decodificó pero nunca se codificó un frame de salida.
  if (ev.firstEncodedFrameMs == null) return 'ENCODE_FAILED'
  // Se codificó pero el muxer nunca emitió un byte.
  return 'MUXER_NO_OUTPUT'
}

// ── Selección del error FINAL cuando TODAS las variantes fallaron ────────────
// Los intentos sub (track 102) corren AL FINAL de la cadena: si se toma "el
// último error" a secas, un 400 esperado del substream (muchos NVR no soportan
// playback substream) PISA la causa real — p.ej. el track MAIN (101) agotó el
// tiempo sin entregar video. Prioridad:
//   1) NVR_BANDWIDTH_OR_SESSION_LIMIT (453) de CUALQUIER intento — causa
//      accionable para el operador, siempre gana.
//   2) El error del intento MAIN de mayor prioridad (estrategia que NO empieza
//      con 'sub'): los intentos corren en orden de prioridad, así que es el
//      PRIMER main del arreglo.
//   3) Sólo si TODOS los intentos fueron sub, usar el error sub (el último).
// detail siempre acompaña al intento elegido. chosenFrom explica el porqué en
// el log de all_variants_failed.
export interface PlaybackAttemptError {
  variant:  string   // nombre de estrategia: 'nvr_rewritten', 'generated_main', 'sub_full', ...
  category: string
  detail:   string
}

export function pickFinalPlaybackError(
  attemptErrors: readonly PlaybackAttemptError[],
): { error: PlaybackAttemptError; chosenFrom: '453' | 'main' | 'sub' } {
  const limit = attemptErrors.find(e => e.category === 'NVR_BANDWIDTH_OR_SESSION_LIMIT')
  if (limit) return { error: limit, chosenFrom: '453' }
  const main = attemptErrors.find(e => !e.variant.startsWith('sub'))
  if (main) return { error: main, chosenFrom: 'main' }
  return { error: attemptErrors[attemptErrors.length - 1], chosenFrom: 'sub' }
}

// Normaliza /Streaming/tracks/NNN/? → /Streaming/tracks/NNN?  (quita el slash
// antes del '?'). Algunos firmwares Hikvision entregan la playbackURI con ese
// slash y rechazan/aceptan según la variante — por eso se prueba de ambas formas.
export function normalizeTracksSlashBeforeQuery(uri: string): string {
  return uri.replace(/(\/Streaming\/tracks\/\d+)\/(\?)/i, '$1$2')
}

function trackFromPath(pathQuery: string, fallback: number): number {
  const m = pathQuery.match(/\/Streaming\/tracks\/(\d+)/i)
  return m ? parseInt(m[1], 10) : fallback
}

// Strip name/size params from a playback RTSP URL — some NVR firmwares
// reject the full variant under load but accept the plain time-range form.
export function stripNameSizeParams(url: string): string {
  return url
    .replace(/([?&])name=[^&]*&?/i, '$1')
    .replace(/([?&])size=[^&]*&?/i, '$1')
    .replace(/[?&]$/, '')
}

// tracks/401 → tracks/402 (main → substream). Returns null when the URL has
// no main-track id to transform.
export function toSubstreamTrackUrl(url: string): string | null {
  const m = url.match(/\/Streaming\/tracks\/(\d+)/i)
  if (!m) return null
  const id = parseInt(m[1], 10)
  if (id % 100 !== 1) return null
  return url.replace(/\/Streaming\/tracks\/\d+/i, `/Streaming/tracks/${id + 1}`)
}

export function buildVariantUrl(baseUrl: string, variant: PlaybackVariant): string | null {
  let u: string | null = baseUrl
  if (variant.startsWith('sub')) {
    u = toSubstreamTrackUrl(u)
    if (!u) return null
  }
  if (variant.endsWith('no_name_size')) {
    // Without name/size params this variant is identical to its *_full twin
    if (!/[?&](name|size)=/i.test(u)) return null
    u = stripNameSizeParams(u)
  }
  return u
}

/** Ordered attempt chain for a preview, honoring mode and preferred variant
 *  (the last one that worked for this camera). Deduped by URL (e.g.
 *  fallback_timestamps URLs have no name/size so *_no_name_size collapses
 *  into *_full). */
export function buildVariantChain(
  baseUrl: string,
  opts: { mode: PlaybackStreamMode; preferred?: PlaybackVariant | undefined },
): Array<{ variant: PlaybackVariant; url: string }> {
  const order: PlaybackVariant[] =
    opts.mode === 'main' ? ['main_full', 'main_no_name_size']
    : opts.mode === 'sub' ? ['sub_full', 'sub_no_name_size']
    : ['main_full', 'main_no_name_size', 'sub_full', 'sub_no_name_size']

  // Preferred variant (last one that worked) goes first
  if (opts.preferred && order.includes(opts.preferred)) {
    order.splice(order.indexOf(opts.preferred), 1)
    order.unshift(opts.preferred)
  }

  const chain: Array<{ variant: PlaybackVariant; url: string }> = []
  const seenUrls = new Set<string>()
  for (const variant of order) {
    const url = buildVariantUrl(baseUrl, variant)
    if (!url || seenUrls.has(url)) continue
    seenUrls.add(url)
    chain.push({ variant, url })
  }
  return chain
}

export function injectCredentialsIntoPlaybackUri(opts: {
  playbackURI: string
  username:    string
  password:    string
  ipAddress:   string
  rtspPort:    number
}): { url: string; masked: string } {
  const { playbackURI, username, password, ipAddress, rtspPort } = opts
  const encodedPass = encodeURIComponent(password)
  const pathQuery   = playbackURI.startsWith('/') ? playbackURI : `/${playbackURI}`
  return {
    url:    `rtsp://${username}:${encodedPass}@${ipAddress}:${rtspPort}${pathQuery}`,
    masked: `rtsp://${username}:***@${ipAddress}:${rtspPort}${pathQuery}`,
  }
}

// Rewrite the starttime in an NVR playbackURI so preview begins at the
// requested playhead instead of the start of the recorded block. The NVR's
// playbackURI carries starttime/endtime as YYYYMMDDTHHmmssZ query params.
export function rewritePlaybackUriStart(playbackURI: string, effectiveStart: Date): {
  uri: string; rewritten: boolean; originalStart: string | null
} {
  const fmtTs = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  const m = playbackURI.match(/([?&]starttime=)(\d{8}T\d{6}Z)/i)
  if (!m) return { uri: playbackURI, rewritten: false, originalStart: null }
  const newTs = fmtTs(effectiveStart)
  if (m[2] === newTs) return { uri: playbackURI, rewritten: false, originalStart: m[2] }
  return {
    uri: playbackURI.replace(m[0], `${m[1]}${newTs}`),
    rewritten: true,
    originalStart: m[2],
  }
}

// ── Matriz de estrategias de reproducción ─────────────────────────────────────
// El problema real de compatibilidad Hikvision no es main/sub × name/size sobre
// UNA base, sino QUÉ URL base usar. Esta función arma un plan ordenado y deduplicado
// de estrategias BASE distintas (A→E del análisis), cada una un intento FFmpeg:
//   nvr_original                — playbackURI exacta del NVR (con slash, start original)
//   nvr_original_normalized     — playbackURI sin slash antes de '?'
//   nvr_rewritten               — normalizada + starttime reescrito al playhead
//   nvr_rewritten_no_metadata   — la anterior sin name/size
//   generated_main              — URL generada /Streaming/tracks/{ch*100+1}?start&end
//   sub_full / sub_no_name_size — substream (sólo si el perfil del NVR lo permite)
// baseStrategy y streamVariant quedan separados (streamVariant='full' salvo *_no_metadata).
export type PlaybackBaseStrategy =
  | 'nvr_original' | 'nvr_original_normalized' | 'nvr_rewritten'
  | 'nvr_rewritten_no_metadata' | 'generated_main' | 'sub_full' | 'sub_no_name_size'

export interface PlaybackAttempt {
  strategy: PlaybackBaseStrategy
  url:     string   // con credenciales
  masked:  string
  track:   number
  // ¿El starttime de esta URL coincide con el playhead solicitado (effectiveStart)?
  // Las que NO lo respetan (nvr_original/normalized con el start del bloque) sólo
  // sirven de fallback controlado — nunca deben "ganar" reproduciendo desde el
  // inicio equivocado ni quedar como estrategia preferida general.
  respectsPlayhead: boolean
}

// Extrae el starttime (YYYYMMDDTHHMMSSZ) de un pathQuery de playback.
function starttimeOf(pathQuery: string): string | null {
  const m = pathQuery.match(/[?&]starttime=(\d{8}T\d{6}Z)/i)
  return m ? m[1].toUpperCase() : null
}
const fmtPlaybackTs = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'

// Extrae starttime/endtime (formato Hikvision YYYYMMDDTHHMMSSZ) de una URL o
// pathQuery de playback — para auditar el desfase horario de punta a punta sin
// exponer credenciales (opera sólo sobre la query, nunca sobre el userinfo).
export function extractRtspPlaybackTimes(uriOrPath: string): { starttime: string | null; endtime: string | null } {
  const s = uriOrPath.match(/[?&]starttime=(\d{8}T\d{6}Z)/i)
  const e = uriOrPath.match(/[?&]endtime=(\d{8}T\d{6}Z)/i)
  return { starttime: s ? s[1].toUpperCase() : null, endtime: e ? e[1].toUpperCase() : null }
}

// Convierte un timestamp Hikvision de playback (YYYYMMDDTHHMMSSZ) a ISO 8601 UTC.
// NO concatena 'Z' a mano ni convierte dos veces: interpreta el string tal cual
// (el sufijo Z ya indica que la etiqueta es UTC en este formato). Devuelve null si
// no matchea. Se usa para derivar la ventana solicitada desde la playbackURI del
// NVR sin exigir fechas por separado.
export function hikTimestampToIso(ts: string): string | null {
  const m = ts.trim().toUpperCase().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!m) return null
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

// Fingerprint estable y corto de una URL/pathQuery — SIN credenciales (FNV-1a).
// Sirve para correlacionar estrategias duplicadas en los logs sin filtrar user/pass.
export function urlFingerprint(uriOrPath: string): string {
  // Quitar cualquier userinfo por si llega una URL con credenciales.
  const safe = uriOrPath.replace(/\/\/[^/@]+@/, '//')
  let h = 0x811c9dc5
  for (let i = 0; i < safe.length; i++) {
    h ^= safe.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function buildPlaybackAttemptPlan(opts: {
  playbackURI?: string | null
  channel:      number
  effectiveStart: Date
  end:          Date
  creds:        { username: string; password: string; ipAddress: string; rtspPort: number }
  mode?:        PlaybackStreamMode           // 'main' | 'sub' | 'auto' (default auto)
  includeSubstream?: boolean                 // false si el perfil del NVR lo marcó sin soporte
  preferred?:   PlaybackBaseStrategy | null  // estrategia que funcionó antes en este NVR
  playheadToleranceSec?: number              // tolerancia para "respeta el playhead" (default 2s)
  // Sumidero opcional: se rellena con las estrategias descartadas por dedup (misma
  // URL final que otra anterior). Permite al llamador registrarlas sin que la
  // función deje de ser pura respecto a su valor de retorno.
  dedupSink?:   Array<{ strategy: PlaybackBaseStrategy; duplicateOf: PlaybackBaseStrategy; urlFingerprint: string }>
}): PlaybackAttempt[] {
  const { playbackURI, channel, effectiveStart, end, creds } = opts
  const mode = opts.mode ?? 'auto'
  const wantMain = mode === 'main' || mode === 'auto'
  const wantSub  = (mode === 'sub' || mode === 'auto') && opts.includeSubstream !== false
  const toleranceMs = (opts.playheadToleranceSec ?? 2) * 1000
  const wantTs = fmtPlaybackTs(effectiveStart)
  const inject = (pathQuery: string) => injectCredentialsIntoPlaybackUri({
    playbackURI: pathQuery, username: creds.username, password: creds.password,
    ipAddress: creds.ipAddress, rtspPort: creds.rtspPort,
  })
  // ¿El starttime del pathQuery cae dentro de la tolerancia del playhead?
  const respects = (pathQuery: string): boolean => {
    const st = starttimeOf(pathQuery)
    if (!st) return false
    const parsed = Date.parse(st.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))
    if (Number.isNaN(parsed)) return st === wantTs
    return Math.abs(parsed - effectiveStart.getTime()) <= toleranceMs
  }

  // Candidatos (path+query, sin credenciales). El ORDEN prioriza las que respetan
  // el playhead solicitado; original/normalizada van al final como fallback.
  const paths: Array<{ strategy: PlaybackBaseStrategy; pathQuery: string }> = []
  if (wantMain) {
    let rewritten: string | null = null
    if (playbackURI) {
      const normalized = normalizeTracksSlashBeforeQuery(playbackURI)
      rewritten = rewritePlaybackUriStart(normalized, effectiveStart).uri
      // 1) respetan el playhead
      paths.push({ strategy: 'nvr_rewritten_no_metadata', pathQuery: stripNameSizeParams(rewritten) })
      paths.push({ strategy: 'nvr_rewritten',             pathQuery: rewritten })
    }
    const generated = buildFallbackRecordingRtspUrl({ ...creds, channel, start: effectiveStart, end })
    const genPath = generated.masked.replace(/^rtsp:\/\/[^/]+/, '')
    // generated_main va entre las de rewritten y las fallback: siempre respeta el playhead
    paths.push({ strategy: 'generated_main', pathQuery: genPath })
    if (playbackURI) {
      const normalized = normalizeTracksSlashBeforeQuery(playbackURI)
      // 2) fallback controlado (pueden NO respetar el playhead si el NVR incrustó otro start)
      paths.push({ strategy: 'nvr_original_normalized', pathQuery: normalized })
      paths.push({ strategy: 'nvr_original',            pathQuery: playbackURI })
    }
  }
  if (wantSub) {
    // Sub derivada de la mejor base main disponible (generated respeta el playhead).
    const generated = buildFallbackRecordingRtspUrl({ ...creds, channel, start: effectiveStart, end })
    const genPath = generated.masked.replace(/^rtsp:\/\/[^/]+/, '')
    const subBase = toSubstreamTrackUrl(genPath)
    if (subBase) {
      paths.push({ strategy: 'sub_full',         pathQuery: subBase })
      paths.push({ strategy: 'sub_no_name_size', pathQuery: stripNameSizeParams(subBase) })
    }
  }

  // Estrategia preferida primero SÓLO si respeta el playhead (no promover una que
  // reproduce desde el inicio equivocado).
  if (opts.preferred) {
    const i = paths.findIndex(p => p.strategy === opts.preferred)
    if (i > 0 && respects(paths[i].pathQuery)) paths.unshift(paths.splice(i, 1)[0])
  }

  // Construir, deduplicar por pathQuery final. Las descartadas por dedup se
  // reportan al sumidero (con la estrategia de la que son duplicado y un
  // fingerprint sin credenciales) en vez de desaparecer en silencio.
  const plan: PlaybackAttempt[] = []
  const seenBy = new Map<string, PlaybackBaseStrategy>()
  for (const { strategy, pathQuery } of paths) {
    const pq = pathQuery.startsWith('/') ? pathQuery : `/${pathQuery}`
    const dupOf = seenBy.get(pq)
    if (dupOf) {
      opts.dedupSink?.push({ strategy, duplicateOf: dupOf, urlFingerprint: urlFingerprint(pq) })
      continue
    }
    seenBy.set(pq, strategy)
    const { url, masked } = inject(pq)
    plan.push({ strategy, url, masked, track: trackFromPath(pq, channel * 100 + 1), respectsPlayhead: respects(pq) })
  }
  return plan
}

export function buildFallbackRecordingRtspUrl(opts: {
  username:  string
  password:  string
  ipAddress: string
  rtspPort:  number
  channel:   number
  start:     Date
  end:       Date
}): { url: string; masked: string; trackId: number } {
  const { username, password, ipAddress, rtspPort, channel, start, end } = opts
  const trackId     = channel * 100 + 1
  const encodedPass = encodeURIComponent(password)
  const fmtTs       = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  const pathQuery   = `/Streaming/tracks/${trackId}?starttime=${fmtTs(start)}&endtime=${fmtTs(end)}`
  return {
    url:    `rtsp://${username}:${encodedPass}@${ipAddress}:${rtspPort}${pathQuery}`,
    masked: `rtsp://${username}:***@${ipAddress}:${rtspPort}${pathQuery}`,
    trackId,
  }
}
