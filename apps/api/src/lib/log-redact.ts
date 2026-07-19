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
