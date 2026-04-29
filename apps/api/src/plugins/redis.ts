// apps/api/src/plugins/redis.ts
import fp from 'fastify-plugin'
import fastifyRedis from '@fastify/redis'
import type { FastifyPluginAsync } from 'fastify'

const redisPlugin: FastifyPluginAsync = fp(async (server) => {
  await server.register(fastifyRedis, {
    url: process.env.REDIS_URL || 'redis://redis:6379',
    closeClient: true,
  })

  server.log.info('Redis conectado')
})

export { redisPlugin }
