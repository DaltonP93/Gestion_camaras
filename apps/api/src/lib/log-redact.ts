// Redacción de secretos en URLs/valores que van a los logs. El logger de request
// de Fastify registra req.url con el query string, que puede incluir ?token=<JWT>
// (p.ej. /ws/alerts?token=..., /recordings/.../stream?token=...). Estos tokens no
// deben quedar en logs, monitoreo ni capturas.

// Parámetros de query cuyo valor se enmascara.
const SECRET_QUERY_PARAMS = ['token', 'access_token', 'accessToken', 'refreshToken', 'password', 'pass']

/** Enmascara valores de parámetros sensibles en una URL o query string. */
export function redactUrlSecrets(url: string): string {
  if (!url) return url
  let out = url
  for (const p of SECRET_QUERY_PARAMS) {
    // token=<algo> hasta el siguiente & o fin — case-insensitive en el nombre
    out = out.replace(new RegExp(`([?&]${p}=)[^&#]*`, 'gi'), '$1***')
  }
  return out
}

/** Enmascara userinfo (user:pass@) en una URL tipo rtsp://user:pass@host. */
export function redactUrlUserinfo(url: string): string {
  if (!url) return url
  return url.replace(/(\/\/[^/@:]+:)[^/@]*@/g, '$1***@')
}

// Invariante #6: nunca registrar IPs internas reales (NVR ni sub-cámaras) en
// logs. Estos helpers enmascaran el host de una IPv4 conservando sólo los dos
// primeros octetos como contexto de subred; cualquier otra cosa (hostname,
// IPv6, vacío) se colapsa. No cambian la lógica, sólo lo que llega al log.

const IPV4_RE = /(\b\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g

/** Enmascara una IPv4 individual → `a.b.x.x`. Vacío/no-IPv4 → '' o '***'. */
export function maskIp(ip?: string | null): string {
  if (!ip) return ''
  const s = String(ip).trim()
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(s)
  if (m) return `${m[1]}.${m[2]}.x.x`
  return '***'
}

/** Enmascara todas las IPv4 embebidas en un texto (p.ej. snippets XML). */
export function redactIps(text: string): string {
  if (!text) return text
  return text.replace(IPV4_RE, '$1.x.x')
}

/** Enmascara un nombre de usuario para logs (invariante #6): nunca el valor.
 *  Devuelve 'set'/'unset' — indica si había credencial sin filtrar cuál. */
export function maskUser(user?: string | null): string {
  return user && String(user).trim() ? 'set' : 'unset'
}

// IPv6 embebida (con o sin brackets, con o sin zone-id): ≥2 grupos hextet-colon.
// Amplio a propósito — para logs preferimos colapsar de más que filtrar un host.
const IPV6_RE = /\[?(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%[0-9a-z]+)?\]?/gi

/**
 * Sanitiza CUALQUIER texto que vaya al log (invariante #6): colapsa IPv4 (→a.b.x.x)
 * e IPv6 (→[ipv6]), userinfo `user:pass@`, tokens de query sensibles, y encabezados
 * `Authorization: Bearer/Basic <token>`. Nunca deja host/credencial en claro.
 */
export function redactLog(text: string): string {
  if (!text) return ''
  let out = String(text)
  out = redactUrlUserinfo(out)                       // //user:pass@host → //user:***@host
  out = redactUrlSecrets(out)                        // ?token=…&password=… → ***
  out = out.replace(IPV6_RE, '[ipv6]')               // IPv6 (incl. zone-id) → [ipv6]
  out = out.replace(IPV4_RE, '$1.x.x')               // IPv4 → a.b.x.x
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
  out = out.replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
  out = out.replace(/(authorization["']?\s*[:=]\s*)["']?[^\s"',}]+/gi, '$1***')
  return out
}

/**
 * Serializa un error (incl. AxiosError) a un string SEGURO para el log: sólo
 * `code`/`message` sanitizados con `redactLog`. NUNCA loguear el objeto Error/Axios
 * crudo — su `config.url`/`config.headers.Authorization`/`request` filtran host y
 * credenciales.
 */
export function redactError(e: unknown): string {
  if (e == null) return 'error'
  const anyE = e as { code?: unknown; message?: unknown }
  const parts: string[] = []
  if (anyE.code != null) parts.push(String(anyE.code))
  if (anyE.message != null) parts.push(String(anyE.message))
  if (parts.length === 0) parts.push(typeof e === 'string' ? e : 'error')
  return redactLog(parts.join(': ')) || 'error'
}
