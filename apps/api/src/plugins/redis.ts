// apps/api/src/plugins/redis.ts
import fp from 'fastify-plugin'
import fastifyRedis from '@fastify/redis'
import type { FastifyPluginAsync } from 'fastify'

const redisPlugin: FastifyPluginAsync = fp(async (server) => {
  await server.register(fastifyRedis, {
    url: process.env.REDIS_URL || 'redis://redis:6379',
    closeClient: true,
  })

  // Resiliencia (#12): ioredis emite 'error' ante caídas/reintentos de conexión.
  // Sin un listener, un error de socket se convierte en un 'unhandled error
  // event' que puede tumbar el proceso. Aquí sólo se registra con contexto (sin
  // exponer la URL de Redis) y se deja que ioredis maneje su propio reintento;
  // no se cambia la semántica de conexión. El plano de grants ya falla cerrado
  // cuando Redis no está disponible (ver grant-service / startRevokeRecovery).
  server.redis.on('error', (err: Error & { code?: string }) => {
    server.log.error(`[redis] error de conexión: ${err?.code || err?.message || 'unknown'}`)
  })

  server.log.info('Redis conectado')
})

export { redisPlugin }
