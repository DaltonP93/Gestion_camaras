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

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    authorize: (roles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    user: JWTPayload
  }
}

const authPlugin: FastifyPluginAsync = fp(async (server) => {
  await server.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || 'fallback_secret_cambiar_en_produccion',
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    },
  })

  // Decorator: verificar que el request tiene token válido
  server.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch (err) {
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
      } catch (err) {
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
