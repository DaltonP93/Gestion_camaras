// apps/api/src/plugins/auth.ts
import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import { redactUrlSecrets } from '../lib/log-redact'
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

const authPlugin: FastifyPluginAsync = fp(async (server) => {
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error(
      'JWT_SECRET no está definido o tiene menos de 32 caracteres. ' +
      'Generá uno seguro: openssl rand -hex 64'
    )
  }

  await server.register(fastifyJwt, {
    secret: jwtSecret,
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN || '60m',
    },
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
