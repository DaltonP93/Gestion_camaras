// apps/api/src/routes/mediamtxAuth.ts
//
// A1 · F0 — Endpoint auth-hook de MediaMTX (SÓLO se registra si
// NATIVE_MEDIA_RELAY_ENABLED=true; ver server.ts). Con la flag apagada la ruta NO
// existe (404) y el comportamiento del API es idéntico a hoy. A1 sigue NO-GO:
// esto es SÓLO CÓDIGO detrás de la flag; no habilita nada ni toca infra/MediaMTX.
//
// MediaMTX puede delegar auth a un endpoint HTTP (authHTTPAddress): en cada
// read/publish POSTea {user,password,ip,action,path,protocol,id,query}. Este hook:
//   1) Autentica al LLAMADOR (que sea MediaMTX) con MEDIA_RELAY_SECRET (timing-safe;
//      header o campo) y exige origen interno/loopback. Sin secreto correcto ⇒ deny.
//   2) Extrae el grantId + secreto del grant que presenta el cliente (password RTSP
//      o query), resuelve el streamPath del `path`, y RE-VALIDA el grant de sesión
//      SIN consumirlo (`validateSession`). Sólo action:'read' (publish ⇒ deny).
//   3) En allow, registra el binding conexión↔grant (`id`→grant) para el revoke→kick.
//
// Fail-closed ante cualquier error/flag off/backend no atómico. NUNCA loguea el
// secreto, credenciales, query ni URIs; los errores van saneados (sólo razón +
// prefijo de grantId).

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { getMediaGrantManager } from '../services/media/grant-service'
import { timingSafeEqualHex, sha256Hex } from '../services/media/media-grants'
import type { GrantScopeQuery } from '../services/media/contracts'

const NATIVE_MEDIA_RELAY_ENABLED = process.env.NATIVE_MEDIA_RELAY_ENABLED === 'true'
const MEDIA_RELAY_SECRET = process.env.MEDIA_RELAY_SECRET || ''
// TTL del binding de la sesión de relay (ms). Acotado; default 60000. Es la vida
// del vínculo conexión↔grant, NO baja el TTL de seguridad de 90s del lifecycle.
const SESSION_TTL_MS = Math.min(300_000, Math.max(5_000, Number(process.env.MEDIA_RELAY_SESSION_TTL_MS) || 60_000))

// Payload de auth de MediaMTX. Campos desconocidos se ignoran (passthrough).
const mtxSchema = z.object({
  user:     z.string().max(512).optional(),
  password: z.string().max(1024).optional(),
  ip:       z.string().max(64).optional(),
  action:   z.string().max(32).optional(),
  path:     z.string().max(512).optional(),
  protocol: z.string().max(32).optional(),
  id:       z.string().max(256).optional(),
  query:    z.string().max(2048).optional(),
  // Campo alternativo para el secreto del LLAMADOR (además del header).
  relaySecret: z.string().max(1024).optional(),
}).passthrough()

/** ¿El origen es loopback/red interna? (defensa A-T4: sólo MediaMTX debería llegar.) */
function isInternalIp(ip: string | undefined): boolean {
  if (!ip) return false
  const a = ip.replace(/^::ffff:/, '')
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true
  if (a.startsWith('10.') || a.startsWith('192.168.')) return true
  const m = /^172\.(\d+)\./.exec(a)
  if (m) { const o = Number(m[1]); if (o >= 16 && o <= 31) return true }
  return false
}

/** streamPath del `path` de MediaMTX: sin barras iniciales ni query. */
function resolveStreamPath(path: string | undefined): string {
  return (path ?? '').replace(/^\/+/, '').split('?')[0].trim()
}

/** Extrae grantId + secreto del cliente: preferir user/password; luego query. */
function extractGrant(body: z.infer<typeof mtxSchema>): { grantId: string; secret: string } | null {
  const qs = new URLSearchParams(body.query ?? '')
  const grantId = (body.user && body.user.length > 0 ? body.user : (qs.get('grant') ?? qs.get('grantId') ?? '')).trim()
  const secret = (body.password && body.password.length > 0 ? body.password : (qs.get('secret') ?? qs.get('token') ?? '')).trim()
  if (!grantId || !secret) return null
  return { grantId, secret }
}

export const mediamtxAuthRoutes: FastifyPluginAsync = async (server) => {
  const manager = getMediaGrantManager(server)

  server.post('/auth', async (request, reply) => {
    // 1) Fail-closed absoluto con la flag apagada (defensa en profundidad; la ruta
    //    tampoco se registra sin la flag).
    if (!NATIVE_MEDIA_RELAY_ENABLED) return reply.status(404).send({ code: 'NATIVE_MEDIA_RELAY_DISABLED' })
    if (!MEDIA_RELAY_SECRET) return reply.status(503).send({ code: 'MEDIA_RELAY_SECRET_UNSET' })

    // 2) Origen interno/loopback (sólo MediaMTX debería alcanzar el hook).
    if (!isInternalIp(request.ip)) return reply.status(403).send({ code: 'ORIGIN_NOT_ALLOWED' })

    let body: z.infer<typeof mtxSchema>
    try { body = mtxSchema.parse(request.body) } catch { return reply.status(400).send({ code: 'BAD_REQUEST' }) }

    // 3) Autenticar al LLAMADOR (MediaMTX) con el secreto compartido (timing-safe).
    const hdr = request.headers['x-media-relay-secret']
    const providedSecret = typeof hdr === 'string' && hdr.length > 0 ? hdr : (body.relaySecret ?? '')
    if (!providedSecret || !timingSafeEqualHex(sha256Hex(providedSecret), sha256Hex(MEDIA_RELAY_SECRET))) {
      return reply.status(401).send({ code: 'RELAY_SECRET_INVALID' })
    }

    // 4) Sólo lectura: publish (o cualquier acción != read) se niega.
    if ((body.action ?? 'read') !== 'read') return reply.status(403).send({ code: 'ACTION_NOT_ALLOWED' })

    // 5) Backend atómico obligatorio para relay (igual que la emisión hoy).
    if (!manager.crossProcessAtomic) return reply.status(503).send({ code: 'RELAY_BACKEND_NOT_ATOMIC' })

    const streamPath = resolveStreamPath(body.path)
    if (!streamPath) return reply.status(400).send({ code: 'BAD_PATH' })

    const presented = extractGrant(body)
    if (!presented) return reply.status(401).send({ code: 'GRANT_CREDENTIALS_MISSING' })

    try {
      const stored = await manager.peek(presented.grantId)
      if (!stored) {
        server.log.info(`mediamtx_auth deny reason=NOT_FOUND grant=${presented.grantId.slice(0, 10)}`)
        return reply.status(403).send({ ok: false, reason: 'NOT_FOUND' })
      }
      // userId/cameraId/transport NO son presentables por el relay (se autentica por
      // secreto, no como usuario); se toman del grant. El streamPath SÍ se presenta
      // (del `path`) ⇒ un grant usado contra otro path da SCOPE_MISMATCH real.
      const scope: GrantScopeQuery = {
        userId: stored.userId, cameraId: stored.cameraId,
        streamPath, transport: stored.transport, action: 'read',
      }
      const result = await manager.validateSession(presented, scope)
      if (!result.ok) {
        server.log.info(`mediamtx_auth deny reason=${result.reason} grant=${presented.grantId.slice(0, 10)}`)
        return reply.status(403).send({ ok: false, reason: result.reason })
      }
      // Allow: registra el binding conexión↔grant (id de reader → grant) para el kick.
      const connectionId = body.id && body.id.length > 0 ? body.id : `${presented.grantId}:${streamPath}`
      await manager.bindConnection(connectionId, presented.grantId, stored.userId, streamPath, SESSION_TTL_MS)
      server.log.info(`mediamtx_auth allow grant=${presented.grantId.slice(0, 10)} conn=${connectionId.slice(0, 12)}`)
      return reply.status(200).send({ ok: true })
    } catch {
      // Fail-closed: cualquier error interno ⇒ deny (nunca abre por error).
      return reply.status(403).send({ ok: false, reason: 'BACKEND_UNAVAILABLE' })
    }
  })
}
