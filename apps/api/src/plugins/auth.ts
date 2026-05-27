// apps/api/src/plugins/auth.ts
import fp from 'fastify-plugin'
import fastifyJwt from '@fastify/jwt'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { Role } from '@prisma/client'

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
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    authorize: (roles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
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
        `[auth] 401 ${request.method} ${request.url} | ` +
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
          `[auth] 401 ${request.method} ${request.url} | ` +
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
})

export { authPlugin }
