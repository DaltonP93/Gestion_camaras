// apps/api/src/plugins/auth.ts
import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import { assertJwtSecretAceptable } from '../lib/jwt-secret-policy'
import { redactUrlSecrets } from '../lib/log-redact'
import { ACCESS_COOKIE } from '../lib/auth-cookies'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { Role } from '@prisma/client'
import type { RequestTicket } from '../services/stream-manager'

export interface JWTPayload {
  sub: string
  username: string
  role: Role
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

const ACCESS_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR'])

/**
 * ¿Son estos claims los de un ACCESS token? Es la única forma de JWT válida como
 * credencial de petición (header Bearer o cookie). El servidor firma con la misma
 * clave otros tokens que NO deben abrir rutas:
 *   - intermedios `{sub, step}` (2fa, mfa-enroll, elevated): sin rol; las rutas que
 *     sólo excluyen OPERATOR o filtran AUDITOR los trataban como sin restricción;
 *   - refresh `{…, jti, rememberMe}`: 7 días y sólo revocable vía /auth/refresh.
 * Esos flujos los verifican explícitamente con `server.jwt.verify`, que no pasa por
 * aquí; esta regla sólo rige `request.jwtVerify()` (authenticate, authorize,
 * hls-auth, apariencia…).
 */
export function isAccessTokenClaims(claims: unknown): boolean {
  if (!claims || typeof claims !== 'object') return false
  const c = claims as Record<string, unknown>
  return typeof c.sub === 'string' && c.sub.length > 0 &&
    typeof c.role === 'string' && ACCESS_ROLES.has(c.role) &&
    c.step === undefined && c.jti === undefined
}

const authPlugin: FastifyPluginAsync = fp(async (server) => {
  // Presencia, largo ≥ 32, valores públicos conocidos (por hash) y heurísticas
  // mínimas: ver lib/jwt-secret-policy.ts. Lanza ANTES de registrar @fastify/jwt,
  // con un mensaje que nunca contiene el valor. server.ts ya lo valida al arrancar;
  // esto cubre a quien registre el plugin por su cuenta (pruebas, otros entrypoints).
  const jwtSecret = assertJwtSecretAceptable(process.env.JWT_SECRET)

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
    // Sólo access tokens como credencial de petición (ver isAccessTokenClaims).
    // Un token de otro tipo ⇒ 401 (FST_JWT_AUTHORIZATION_TOKEN_UNTRUSTED).
    trusted: (_request, claims) => isAccessTokenClaims(claims),
  })

  // Decorator: verificar que el request tiene token válido (header o cookie)
  server.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch (err: any) {
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

export { authPlugin }
