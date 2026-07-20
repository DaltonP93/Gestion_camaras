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

  // Construir, deduplicar por pathQuery final
  const plan: PlaybackAttempt[] = []
  const seen = new Set<string>()
  for (const { strategy, pathQuery } of paths) {
    const pq = pathQuery.startsWith('/') ? pathQuery : `/${pathQuery}`
    if (seen.has(pq)) continue
    seen.add(pq)
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
