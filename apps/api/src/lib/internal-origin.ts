// apps/api/src/lib/internal-origin.ts
//
// C03 — "¿Esta petición viene de la red interna?" decidido por el PAR TCP REAL.
//
// Las puertas de origen interno (/internal/hls-auth, el auth-hook de MediaMTX y
// POST /api/live-view/internal/media-grant/validate) NO deben usar request.ip:
// con `trustProxy` (ver lib/trusted-proxy) request.ip pasa a ser la IP del CLIENTE
// que nginx pone en X-Forwarded-For. nginx hace el auth_request del HLS desde su
// red interna para clientes de Internet: con request.ip esas puertas devolverían
// 403 a todo el HLS. Y al revés: una cabecera (X-Forwarded-For, X-Real-IP) nunca
// puede volver "interno" a un par externo. Fail-closed: sin dirección ⇒ no interno.
//
// Límite: el par sólo distingue "directo desde afuera" de "red interna", y nginx ES
// red interna. Una ruta interna alcanzable por una location de nginx (media-grant
// validate, bajo /api/) necesita además `isProxyForwarded`.

import type { FastifyRequest } from 'fastify'

/** ¿Dirección loopback/red interna? (mismos rangos que usaban hls-auth y el hook). */
export function isInternalIp(ip: string | undefined): boolean {
  if (!ip) return false
  const a = ip.replace(/^::ffff:/, '')
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true
  if (a.startsWith('10.') || a.startsWith('192.168.')) return true
  const m = /^172\.(\d+)\./.exec(a)
  if (m) { const o = Number(m[1]); if (o >= 16 && o <= 31) return true }
  return false
}

/** Dirección del par TCP (nunca cabeceras ni request.ip). undefined si el socket ya no está. */
export function socketPeerAddress(request: FastifyRequest): string | undefined {
  return request.raw.socket?.remoteAddress ?? undefined
}

/** ¿El par TCP de esta petición es loopback/red interna? */
export function isInternalPeer(request: FastifyRequest): boolean {
  return isInternalIp(socketPeerAddress(request))
}

/**
 * ¿La petición llegó REENVIADA por un proxy? Detrás de nginx el par TCP es siempre
 * nginx (interno), así que `isInternalPeer` sólo frena a un par externo DIRECTO
 * (que en el compose no existe: el 4000 se publica sólo en el loopback del host).
 * Todas las locations de nginx que van al API ponen X-Forwarded-For y X-Real-IP;
 * los llamados de servicio a servicio (MediaMTX, el relay) van directo y sin ellas.
 * Para rutas internas que viven bajo /api/ (alcanzables por la location /api/),
 * la presencia de cualquiera de las dos ⇒ se rechaza. No depende de TRUSTED_PROXIES.
 */
export function isProxyForwarded(request: FastifyRequest): boolean {
  return request.headers['x-forwarded-for'] !== undefined || request.headers['x-real-ip'] !== undefined
}
