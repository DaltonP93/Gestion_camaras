// Política de servidor para la `playbackURI` que reenvía el navegador.
//
// La búsqueda de grabaciones devuelve al navegador sólo path+query de la URI del
// NVR (sin host ni credenciales). El cliente la reenvía al pedir playback/preview y
// el servidor le inyecta host + credenciales del NVR. Sin esta política, un
// usuario con permiso sobre UNA cámara podía enviar la pista de OTRA cámara del
// mismo NVR (u otra ruta RTSP cualquiera del NVR) y el servidor la abría con
// credenciales de administrador del NVR (acceso cruzado).
//
// Regla: la URI debe ser EXACTAMENTE la forma que produce la búsqueda ISAPI para
// el canal de la cámara autorizada:
//   /Streaming/tracks/<canal*100+1 | canal*100+2>[/]?starttime=…[&endtime=…][&name=…][&size=…]
// (+1 = pista principal que devuelve la búsqueda; +2 = subpista que el propio
// servidor deriva). Todo lo demás se rechaza ANTES de descifrar credenciales,
// contactar el NVR o iniciar FFmpeg.

export const PLAYBACK_URI_MAX_LENGTH = 1024

export type PlaybackUriRejection =
  | 'not_string'
  | 'too_long'
  | 'illegal_characters'
  | 'bad_path'
  | 'bad_query'
  | 'missing_starttime'
  | 'channel_mismatch'

export type PlaybackUriCheck =
  | { ok: true; pathQuery: string; trackId: number }
  | { ok: false; reason: PlaybackUriRejection }

/** Pistas de grabación que pertenecen a un canal (principal y subpista). */
export function allowedTrackIdsForChannel(channel: number): number[] {
  if (!Number.isInteger(channel) || channel < 1) return []
  return [channel * 100 + 1, channel * 100 + 2]
}

// Sólo ASCII visible y sin los caracteres que cambian la interpretación de una
// URL (`%` codificación, `\` separador alternativo, `#` fragmento, `@` userinfo).
const ALLOWED_CHARS = /^[\x21-\x7e]+$/
const FORBIDDEN_CHARS = /[%\\#@]/
const TRACK_PATH = /^\/Streaming\/tracks\/(\d{1,7})\/?$/i
const TS_VALUE = /^\d{8}T\d{6}Z$/
// Tabla de reglas como `Map`: sólo devuelve las claves propias. Un objeto literal
// heredaría de Object.prototype y `constructor` / `__proto__` resolverían a una
// función o al prototipo (la validación lanzaba en vez de rechazar ⇒ 500).
const QUERY_RULES: ReadonlyMap<string, RegExp> = new Map([
  ['starttime', TS_VALUE],
  ['endtime',   TS_VALUE],
  ['name',      /^[A-Za-z0-9_.-]{1,128}$/],
  ['size',      /^\d{1,20}$/],
])

/** Validación puramente sintáctica (sin canal). */
export function parsePlaybackUri(raw: unknown): PlaybackUriCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_string' }
  if (raw.length === 0 || raw.length > PLAYBACK_URI_MAX_LENGTH) return { ok: false, reason: 'too_long' }
  if (!ALLOWED_CHARS.test(raw) || FORBIDDEN_CHARS.test(raw)) return { ok: false, reason: 'illegal_characters' }

  const q = raw.indexOf('?')
  if (q < 0 || raw.indexOf('?', q + 1) >= 0) return { ok: false, reason: 'bad_query' }
  const pathPart = raw.slice(0, q)
  const queryPart = raw.slice(q + 1)

  const m = TRACK_PATH.exec(pathPart)
  if (!m) return { ok: false, reason: 'bad_path' }
  const trackId = Number(m[1])

  if (queryPart.length === 0) return { ok: false, reason: 'missing_starttime' }
  const seen = new Set<string>()
  for (const pair of queryPart.split('&')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) return { ok: false, reason: 'bad_query' }
    const key = pair.slice(0, eq).toLowerCase()
    const value = pair.slice(eq + 1)
    const rule = QUERY_RULES.get(key)
    if (!rule || seen.has(key) || !rule.test(value)) return { ok: false, reason: 'bad_query' }
    seen.add(key)
  }
  if (!seen.has('starttime')) return { ok: false, reason: 'missing_starttime' }

  return { ok: true, pathQuery: raw, trackId }
}

/** Valida sintaxis Y que la pista pertenezca al canal de la cámara autorizada. */
export function validatePlaybackUriForChannel(raw: unknown, channel: number): PlaybackUriCheck {
  const parsed = parsePlaybackUri(raw)
  if (!parsed.ok) return parsed
  if (!allowedTrackIdsForChannel(channel).includes(parsed.trackId)) {
    return { ok: false, reason: 'channel_mismatch' }
  }
  return parsed
}

/** Código HTTP y cuerpo de error uniformes para las rutas que consumen la URI. */
export function playbackUriErrorResponse(reason: PlaybackUriRejection): {
  status: 400 | 403
  body: { code: string; message: string }
} {
  if (reason === 'channel_mismatch') {
    return {
      status: 403,
      body: { code: 'PLAYBACK_URI_FORBIDDEN', message: 'La grabación solicitada no pertenece a la cámara autorizada' },
    }
  }
  return {
    status: 400,
    body: { code: 'PLAYBACK_URI_INVALID', message: 'playbackURI inválida' },
  }
}
