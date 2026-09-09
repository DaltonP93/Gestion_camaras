// apps/api/src/routes/hlsAuth.ts
//
// P1 — Autorización del HLS por ESPECTADOR en el borde (nginx auth_request).
//
// Hasta ahora MediaMTX aceptaba `user: any`: cualquiera que alcanzara `/hls/<path>`
// reconstruía CUALQUIER cámara (el streamPath es determinista). El aislamiento
// dependía sólo de la frontera de red. Ahora nginx delega a este endpoint un
// `auth_request` ANTES de proxyear cada request HLS a MediaMTX:
//
//   nginx  location /hls/  → auth_request /internal/hls-auth
//   este endpoint:
//     1) valida la cookie de sesión (JWT en access_token) → 401 si no hay/expiró.
//     2) deriva nvrId+canal del streamPath pedido (X-Original-URI).
//     3) exige canView sobre esa cámara (ADMIN/privilegiado ven todo) → 403 si no.
//   200 ⇒ nginx sigue al proxy; 401/403 ⇒ nginx corta antes de tocar MediaMTX.
//
// MediaMTX debe permanecer SOLO-INTERNO (no exponer :8888/:8889): el único camino
// público es vía nginx, que ahora exige la cookie. Fail-closed ante cualquier error.
// Nunca loguea cookies, tokens ni el JWT; sólo razón + prefijos.

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { JWTPayload } from '../plugins/auth'
import { userCanAccessNvrChannel } from '../services/access-policy'

/** ¿origen loopback/red interna? (sólo nginx/servicios internos deberían llegar). */
function isInternalIp(ip: string | undefined): boolean {
  if (!ip) return false
  const a = ip.replace(/^::ffff:/, '')
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true
  if (a.startsWith('10.') || a.startsWith('192.168.')) return true
  const m = /^172\.(\d+)\./.exec(a)
  if (m) { const o = Number(m[1]); if (o >= 16 && o <= 31) return true }
  return false
}

/**
 * Deriva { nvrId, channel } del nombre de path de MediaMTX.
 * Formato: `nvr_<nvrId>_ch<NN>_<type>` (type puede ser sub|main|main_h264).
 * El nvrId es un cuid sin `_`, así que el primer grupo es inequívoco.
 * Devuelve null si no matchea (⇒ deny).
 */
export function parseStreamName(streamName: string): { nvrId: string; channel: number } | null {
  const m = /^nvr_([^_]+)_ch(\d{1,4})_[A-Za-z0-9_]+$/.exec(streamName)
  if (!m) return null
  const channel = Number(m[2])
  if (!Number.isInteger(channel) || channel < 0) return null
  return { nvrId: m[1], channel }
}

/**
 * Extrae el nombre del stream desde la URI original de HLS.
 * Ej: `/hls/nvr_abc_ch01_sub/index.m3u8` → `nvr_abc_ch01_sub`.
 * Acepta con o sin prefijo `/hls/`; ignora query. null si no hay segmento.
 */
export function streamNameFromUri(uri: string | undefined): string | null {
  if (!uri) return null
  const path = uri.split('?')[0]
  const afterHls = path.replace(/^\/+/, '').replace(/^hls\//, '')
  const seg = afterHls.split('/')[0]?.trim()
  return seg && seg.length > 0 ? seg : null
}

export const hlsAuthRoutes: FastifyPluginAsync = async (server) => {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    // Defensa en profundidad: sólo alcanzable desde la red interna (nginx). Además
    // nginx marca esta location como `internal;` (no accesible desde afuera).
    if (!isInternalIp(request.ip)) return reply.status(403).send()

    // 1) Sesión válida por cookie (o header Bearer, que jwtVerify también acepta).
    let user: JWTPayload
    try {
      await request.jwtVerify()
      user = request.user as JWTPayload
    } catch {
      return reply.status(401).send()
    }

    // 2) streamPath pedido → nvrId + canal. nginx lo pasa en X-Original-URI.
    const rawUri = request.headers['x-original-uri']
    const uri = Array.isArray(rawUri) ? rawUri[0] : rawUri
    const streamName = streamNameFromUri(uri)
    const parsed = streamName ? parseStreamName(streamName) : null
    if (!parsed) {
      server.log.warn(`[hls-auth] 403 deny reason=BAD_PATH uri=${(uri ?? '').slice(0, 80)}`)
      return reply.status(403).send()
    }

    // 3) RBAC por cámara (ADMIN/privilegiado ven todo; resto exige canView).
    try {
      const allowed = await userCanAccessNvrChannel(server.prisma, user.sub, user.role, parsed.nvrId, parsed.channel)
      if (!allowed) {
        server.log.info(`[hls-auth] 403 deny user=${user.sub.slice(0, 8)} nvr=${parsed.nvrId.slice(0, 8)} ch=${parsed.channel}`)
        return reply.status(403).send()
      }
      return reply.status(200).send()
    } catch {
      // Fail-closed: cualquier error (DB caída, etc.) ⇒ deny, nunca abre.
      return reply.status(403).send()
    }
  }

  // Ruta EXACTA /internal/hls-auth (sin prefijo, sin barra final): es la que nginx
  // consulta con proxy_pass http://api/internal/hls-auth. Fastify sirve HEAD con el
  // mismo handler del GET automáticamente (players/prefetch que usan HEAD también pasan).
  server.get('/internal/hls-auth', { config: { rateLimit: false } as any }, handler)
}
