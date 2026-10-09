// apps/api/src/plugins/auth.ts
import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import { redactUrlSecrets } from '../lib/log-redact'
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../lib/auth-cookies'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { Role } from '@prisma/client'
import type { RequestTicket } from '../services/stream-manager'
import { loadCurrentActor, liveSessionIdForRefreshToken } from '../services/current-actor'

export interface JWTPayload {
  sub: string
  username: string
  role: Role
  /**
   * Id de la `Session` que originó el access (login, 2FA, enrolamiento, refresh).
   * Liga el access a esa sesión: al cerrarla o revocarla, el access deja de valer
   * en la petición siguiente (ver `verifyCurrentActor`). No es `jti` ni `step`.
   */
  sid?: string
  iat?: number
  exp?: number
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JWTPayload
    user: JWTPayload
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Ticket de llegada de ESTA petición: hora del servidor + secuencia
     * monótona. Lo estampa el PRIMER hook `onRequest` registrado en
     * `server.ts`, antes de rate-limit y de la autenticación.
     *
     * Por qué no basta con tomarlo en la primera línea del handler: la
     * autenticación es un `preHandler` que ya hizo `await request.jwtVerify()`.
     * Si una petición vieja de start-stream entraba a autenticarse, el cierre
     * que llegaba después terminaba su propia autenticación primero y marcaba
     * el view; al reanudarse, la petición vieja tomaba un ticket con secuencia
     * MAYOR y pasaba por reapertura legítima, recreando la sesión fantasma que
     * esta barrera existe para impedir (revisión de #148).
     */
    requestTicket: RequestTicket
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    authorize: (roles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireStepUp: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

const authPlugin: FastifyPluginAsync = fp(async (server) => {
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error(
      'JWT_SECRET no está definido o tiene menos de 32 caracteres. ' +
      'Generá uno seguro: openssl rand -hex 64'
    )
  }

  // @fastify/cookie debe registrarse ANTES de jwt: habilita request.cookies, de
  // donde @fastify/jwt extrae el access_token cuando no viene en el header.
  await server.register(fastifyCookie)

  await server.register(fastifyJwt, {
    secret: jwtSecret,
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN || '60m',
    },
    // request.jwtVerify() busca el token en el header Authorization y, si no está,
    // en la cookie HttpOnly access_token. Así conviven el flujo por cookie (navegador)
    // y el Bearer (integraciones/tests) sin cambiar la lógica de verificación.
    cookie: {
      cookieName: ACCESS_COOKIE,
      signed: false,
    },
    // Actor vigente (sesión viva, usuario activo, rol de la base) en TODO jwtVerify.
    trusted: (request, claims) => verifyCurrentActor(server, request, claims),
  })

  // Decorator: verificar que el request tiene token válido (header o cookie)
  server.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch (err: any) {
      if (sendIfActorUnavailable(request, reply)) return
      const hasHeader = !!request.headers.authorization
      // Distinguish expired from missing/malformed — critical for 24/7 session diagnosis
      const reason = err?.message || 'unknown'
      const code   = err?.code   || ''
      server.log.warn(
        `[auth] 401 ${request.method} ${redactUrlSecrets(request.url)} | ` +
        `header=${hasHeader} | code=${code} | reason=${reason}`
      )
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Token inválido o expirado',
      })
    }
  })

  // Decorator: verificar rol del usuario
  server.decorate(
    'authorize',
    (roles: Role[]) => async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify()
        const user = request.user as JWTPayload

        if (!roles.includes(user.role)) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: 'No tienes permisos para realizar esta acción',
          })
        }
      } catch (err: any) {
        if (sendIfActorUnavailable(request, reply)) return
        const hasHeader = !!request.headers.authorization
        const reason = err?.message || 'unknown'
        const code   = err?.code   || ''
        server.log.warn(
          `[auth] 401 ${request.method} ${redactUrlSecrets(request.url)} | ` +
          `header=${hasHeader} | code=${code} | reason=${reason}`
        )
        reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Token inválido o expirado',
        })
      }
    }
  )

  // Decorator: exigir re-autenticación reciente (step-up MFA) para acciones sensibles.
  // Debe ir DESPUÉS de authenticate/authorize (usa request.user). Espera el token de
  // elevación en el header 'x-step-up-token'; si falta o es inválido responde 403 con
  // code STEP_UP_REQUIRED para que el frontend solicite el segundo factor y reintente.
  server.decorate('requireStepUp', async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.headers['x-step-up-token']
    const token = Array.isArray(raw) ? raw[0] : raw
    const deny = () => reply.status(403).send({
      statusCode: 403, error: 'Forbidden',
      message: 'Esta acción requiere una verificación de seguridad adicional',
      code: 'STEP_UP_REQUIRED',
    })
    if (!token) return deny()
    try {
      const claims = server.jwt.verify(token) as any
      const user = request.user as JWTPayload
      if (claims?.step !== 'elevated' || claims?.sub !== user?.sub) return deny()
    } catch {
      return deny()
    }
  })
})

// ─── Actor vigente ───────────────────────────────────────────────────────────

// Peticiones cuya verificación de actor NO pudo completarse porque la base falló.
// Se responde 503 (no 401): un 401 haría que el web intente /auth/refresh y, si la
// base sigue caída, cierre la sesión del usuario por un problema transitorio.
const actorCheckUnavailable = new WeakSet<FastifyRequest>()

/** ¿La verificación de actor de esta petición falló por la base (no por el token)? */
export function isActorCheckUnavailable(request: FastifyRequest): boolean {
  return actorCheckUnavailable.has(request)
}

// PUENTE DE DESPLIEGUE para el access emitido antes de ligarlo a su sesión (sin
// `sid`), SÓLO en el ticket del WS: las pestañas abiertas durante el despliegue
// siguen corriendo el bundle VIEJO, que pide el ticket una vez y, ante un 401, no
// renueva ni reintenta (perderían las alertas hasta recargar). El resto de las rutas
// responde 401 y el bundle viejo se recupera solo por /auth/refresh (interceptor de
// axios). El access previo se liga a la sesión VIVA del mismo usuario cuya cookie de
// refresh llega con la petición (Path=/api/auth); sin esa cookie, 401. Puede
// retirarse cuando no queden access previos (TTL máximo del access, 24 h).
const LEGACY_ACCESS_BRIDGE_ROUTES = new Set(['/api/auth/ws-ticket'])

/** id de la sesión a la que se liga un access previo (sin `sid`) en el puente, o null. */
async function legacyAccessSessionId(
  server: FastifyInstance, request: FastifyRequest, claims: Record<string, unknown>,
): Promise<string | null> {
  // Forma del access previo: {sub, username, role}. Nunca un token intermedio
  // (`step`: 2FA, enrolamiento, step-up) ni un refresh (`jti`).
  if (claims.sid !== undefined || claims.step !== undefined || claims.jti !== undefined) return null
  if (typeof claims.username !== 'string' || typeof claims.role !== 'string') return null
  if (!LEGACY_ACCESS_BRIDGE_ROUTES.has(request.routeOptions?.url ?? '')) return null
  return liveSessionIdForRefreshToken(server.prisma, claims.sub, request.cookies?.[REFRESH_COOKIE])
}

/**
 * ACTOR VIGENTE en cada `request.jwtVerify()` (authenticate, authorize, hls-auth,
 * apariencia y cualquier ruta futura): además de la firma, el usuario existe y está
 * activo y la sesión `sid` sigue viva. El rol y el username que quedan en
 * `request.user` son los de la BASE: se pisan en los claims decodificados, que son
 * el mismo objeto que @fastify/jwt asigna a `request.user`.
 *
 * Nunca rechaza la promesa: @fastify/jwt no maneja el rechazo de `trusted` (la
 * petición quedaría colgada). Base caída ⇒ false (fail-closed) + marca 503.
 */
async function verifyCurrentActor(
  server: FastifyInstance, request: FastifyRequest, claims: Record<string, unknown>,
): Promise<boolean> {
  try {
    let r = await loadCurrentActor(server.prisma, claims as { sub?: unknown; sid?: unknown })
    const sub = typeof claims?.sub === 'string' ? claims.sub.slice(0, 8) : '-'
    if (!r.ok && r.reason === 'NO_SESSION_CLAIM') {
      const sid = await legacyAccessSessionId(server, request, claims)
      if (sid) {
        claims.sid = sid
        r = await loadCurrentActor(server.prisma, claims as { sub?: unknown; sid?: unknown })
        if (r.ok) server.log.info(`[auth] access_previo_ligado_por_refresh user=${sub}`)
      }
    }
    if (!r.ok) {
      server.log.info(`[auth] actor_rechazado reason=${r.reason} user=${sub}`)
      return false
    }
    claims.role = r.actor.role
    claims.username = r.actor.username
    return true
  } catch (err: any) {
    actorCheckUnavailable.add(request)
    server.log.error(`[auth] actor_no_verificable code=${err?.code || 'unknown'} — fail-closed`)
    return false
  }
}

/** 503 si la base impidió verificar el actor; si no, null (el llamador sigue con su 401). */
function sendIfActorUnavailable(request: FastifyRequest, reply: FastifyReply) {
  if (!isActorCheckUnavailable(request)) return null
  return reply.status(503).send({
    statusCode: 503, error: 'Service Unavailable', code: 'AUTH_UNAVAILABLE',
    message: 'No se pudo verificar la sesión. Reintentá en unos segundos.',
  })
}

export { authPlugin }
