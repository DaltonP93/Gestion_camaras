// apps/api/src/server.ts
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { prismaPlugin } from './plugins/prisma'
import { redisPlugin } from './plugins/redis'
import { authPlugin } from './plugins/auth'
import { authRoutes } from './routes/auth'
import { nvrRoutes } from './routes/nvr'
import { cameraRoutes } from './routes/cameras'
import { recordingRoutes } from './routes/recordings'
import { userRoutes } from './routes/users'
import { alertRoutes } from './routes/alerts'
import { wsHandler } from './routes/websocket'
import viewsPlugin from './routes/views'
import appearancePlugin from './routes/appearance'
import { startHealthWorker } from './jobs/healthWorker'

const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

async function main() {
  // ─── Plugins de seguridad ──────────────────────────────────
  await server.register(helmet, {
    contentSecurityPolicy: false,
  })

  await server.register(cors, {
    origin: process.env.NODE_ENV === 'production'
      ? ['http://localhost', 'https://localhost']
      : true,
    credentials: true,
  })

  await server.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Demasiadas solicitudes, intente en un momento',
    }),
  })

  // ─── Plugins de infraestructura ───────────────────────────
  await server.register(prismaPlugin)
  await server.register(redisPlugin)
  await server.register(authPlugin)
  await server.register(websocket)

  // ─── Rutas de la API ─────────────────────────────────────
  await server.register(authRoutes, { prefix: '/api/auth' })
  await server.register(nvrRoutes, { prefix: '/api/nvrs' })
  await server.register(cameraRoutes, { prefix: '/api/cameras' })
  await server.register(recordingRoutes, { prefix: '/api/recordings' })
  await server.register(userRoutes, { prefix: '/api/users' })
  await server.register(alertRoutes, { prefix: '/api/alerts' })
  await server.register(viewsPlugin, { prefix: '/api/views' })
  await server.register(appearancePlugin, { prefix: '/api/appearance' })
  await server.register(wsHandler, { prefix: '/ws' })

  // ─── Health check ─────────────────────────────────────────
  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }))

  // ─── Jobs en background ───────────────────────────────────
  startHealthWorker(server)

  // ─── Iniciar servidor ─────────────────────────────────────
  const host = process.env.API_HOST || '0.0.0.0'
  const port = parseInt(process.env.API_PORT || '4000')

  await server.listen({ host, port })
  server.log.info(`VisionCore API corriendo en http://${host}:${port}`)
}

main().catch((err) => {
  console.error('Error al iniciar el servidor:', err)
  process.exit(1)
})

export { server }
