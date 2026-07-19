// apps/api/src/server.ts
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import multipart from '@fastify/multipart'
import path from 'path'
import fs from 'fs'
import { redactUrlSecrets } from './lib/log-redact'
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
import profileRoutes from './routes/profile'
import alertSettingsRoutes from './routes/alertSettings'
import { liveViewRoutes } from './routes/liveView'
import { searchRoutes } from './routes/search'
import { nvrConfigRoutes } from './routes/nvrConfig'
import { adminRoutes } from './routes/admin'
import { analyticsRoutes } from './routes/analytics'
import { metricsRoutes } from './routes/metrics'
import { startHealthWorker } from './jobs/healthWorker'
import { startSyncWorker } from './jobs/syncWorker'
import { publishStream } from './services/stream'
import { decryptNvrPasswordOrNull as decryptPass } from './services/credentials'

const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    // Redactar tokens del query en el log de request (p.ej. /ws/alerts?token=<JWT>,
    // /recordings/.../stream?token=...) y el header Authorization.
    serializers: {
      req(req: any) {
        return {
          method: req.method,
          url: redactUrlSecrets(req.url ?? ''),
          hostname: req.hostname,
          remoteAddress: req.ip,
        }
      },
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie'],
      censor: '***',
    },
  },
})

async function main() {
  // ─── Validación de variables de entorno críticas ──────────
  if (!process.env.JWT_SECRET) {
    server.log.error('[startup] FATAL: JWT_SECRET no está definido. La autenticación no funcionará. Define JWT_SECRET en .env')
    process.exit(1)
  }
  if (!process.env.JWT_REFRESH_SECRET) {
    server.log.warn('[startup] JWT_REFRESH_SECRET no definido — se usará JWT_SECRET como fallback. Define JWT_REFRESH_SECRET en .env para mayor seguridad.')
  }
  if (!process.env.NVR_CREDENTIAL_KEY) {
    server.log.warn('[startup] NVR_CREDENTIAL_KEY no definido — se usará JWT_SECRET para cifrar credenciales del NVR. Define NVR_CREDENTIAL_KEY en .env.')
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    server.log.warn('[startup] JWT_SECRET parece muy corto (< 32 chars). Usa un secreto de al menos 32 caracteres aleatorios.')
  }

  // ─── Plugins de seguridad ──────────────────────────────────
  await server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  })

  // CORS: lista blanca por env var (CORS_ORIGINS=https://camaras.example.com,https://otro.com)
  // Si no está definida, refleja el origin (compatibilidad con dev / detrás de nginx)
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : null
  await server.register(cors, {
    origin: corsOrigins ?? true,
    credentials: true,
  })

  await server.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Demasiadas solicitudes, intente en un momento',
    }),
  })

  // ─── Manejador global de errores ───────────────────────────
  // ZodError (schema.parse en handlers) → 400 con detalle de validación en vez
  // del 500 genérico; el resto conserva su statusCode (o 500) sin filtrar
  // stack traces al cliente. Las respuestas de error explícitas de cada
  // endpoint no pasan por aquí — solo los throws no manejados.
  server.setErrorHandler((error: any, request, reply) => {
    if (error?.name === 'ZodError' && Array.isArray(error.issues)) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Datos de solicitud inválidos',
        details: error.issues.map((i: any) => ({
          path: Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? ''),
          message: i.message,
        })),
      })
    }
    const status = typeof error?.statusCode === 'number' && error.statusCode >= 400
      ? error.statusCode
      : 500
    if (status >= 500) {
      server.log.error({ err: error, url: request.url }, 'unhandled_error')
      return reply.status(status).send({ code: 'INTERNAL_ERROR', message: 'Error interno del servidor' })
    }
    return reply.status(status).send({
      code: error?.code ?? 'REQUEST_ERROR',
      message: error?.message ?? 'Error en la solicitud',
    })
  })

  // ─── Plugins de infraestructura ───────────────────────────
  await server.register(prismaPlugin)
  await server.register(redisPlugin)
  await server.register(authPlugin)
  await server.register(websocket)

  // ─── Plugins de archivos estáticos y multipart ───────────
  const uploadsDir = process.env.UPLOADS_DIR || '/app/uploads'
  fs.mkdirSync(path.join(uploadsDir, 'branding'), { recursive: true })

  await server.register(staticFiles, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  })

  await server.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 4 },
  })

  // ─── Rutas de la API ─────────────────────────────────────
  await server.register(authRoutes, { prefix: '/api/auth' })
  await server.register(nvrRoutes, { prefix: '/api/nvrs' })
  await server.register(cameraRoutes, { prefix: '/api/cameras' })
  await server.register(recordingRoutes, { prefix: '/api/recordings' })
  await server.register(userRoutes, { prefix: '/api/users' })
  await server.register(alertRoutes, { prefix: '/api/alerts' })
  await server.register(viewsPlugin, { prefix: '/api/views' })
  await server.register(appearancePlugin, { prefix: '/api/appearance' })
  await server.register(profileRoutes, { prefix: '/api/profile' })
  await server.register(alertSettingsRoutes, { prefix: '/api/alerts' })
  await server.register(liveViewRoutes, { prefix: '/api/live-view' })
  await server.register(searchRoutes, { prefix: '/api/search' })
  await server.register(nvrConfigRoutes, { prefix: '/api/nvrs' })
  await server.register(adminRoutes, { prefix: '/api/admin' })
  await server.register(analyticsRoutes, { prefix: '/api/analytics' })
  await server.register(metricsRoutes)  // /metrics (Prometheus), sin prefijo /api
  await server.register(wsHandler, { prefix: '/ws' })

  const COMMIT_SHA = process.env.COMMIT_SHA || 'development'

  // ─── Health checks (public, no auth) ──────────────────────
  // /health        — acceso directo en puerto 4000
  // /api/health    — accesible vía nginx (mismo contenido)
  // /api/health/deep — comprueba DB y Redis

  const healthResponse = () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    commit: COMMIT_SHA,
  })

  server.get('/health',     async () => healthResponse())
  server.get('/api/health', async () => healthResponse())

  server.get('/api/health/deep', async (_request, reply) => {
    let dbOk = false
    let dbLatencyMs = -1
    try {
      const t0 = Date.now()
      await server.prisma.$queryRaw`SELECT 1`
      dbLatencyMs = Date.now() - t0
      dbOk = true
    } catch {}

    let redisOk = false
    let redisLatencyMs = -1
    try {
      const t0 = Date.now()
      await server.redis.ping()
      redisLatencyMs = Date.now() - t0
      redisOk = true
    } catch {}

    const healthy = dbOk && redisOk
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      commit: COMMIT_SHA,
      checks: {
        db:    { ok: dbOk,    latencyMs: dbLatencyMs },
        redis: { ok: redisOk, latencyMs: redisLatencyMs },
      },
    })
  })

  // ─── Jobs en background ───────────────────────────────────
  startHealthWorker(server)
  startSyncWorker(server)

  // ─── Iniciar servidor ─────────────────────────────────────
  const host = process.env.API_HOST || '0.0.0.0'
  const port = parseInt(process.env.API_PORT || '4000')

  await server.listen({ host, port })
  server.log.info(`VisionCore API v1.0.0 commit=${COMMIT_SHA} corriendo en http://${host}:${port}`)

  // Re-registrar todos los streams en MediaMTX al arrancar
  // MediaMTX pierde los paths dinámicos al reiniciarse; este bloque los restaura
  setTimeout(async () => {
    try {
      const nvrs = await server.prisma.nVR.findMany({
        where: { active: true },
        include: { cameras: { where: { active: true } } },
      })
      let count = 0
      let skipped = 0
      for (const nvr of nvrs) {
        const plainPass = decryptPass(nvr.password)
        if (!plainPass) {
          server.log.error(`[startup] DECRYPT_ERROR para NVR ${nvr.name} (${nvr.id}) — streams omitidos. Verifica NVR_CREDENTIAL_KEY y vuelve a guardar las credenciales del NVR.`)
          skipped++
          continue
        }
        const nvrDecrypted = { ...nvr, password: plainPass }
        for (const camera of nvr.cameras) {
          await publishStream(nvrDecrypted as any, camera)
          count++
        }
      }
      server.log.info(`[startup] ${count} paths on-demand registrados en MediaMTX (RTSP inactivo hasta primer viewer — sourceOnDemand=true)${skipped > 0 ? ` | ${skipped} NVR(s) omitidos por DECRYPT_ERROR` : ''}`)
    } catch (err) {
      server.log.warn(`[startup] Error registrando streams en MediaMTX: ${err}`)
    }
  }, 5000)
}

main().catch((err) => {
  console.error('Error al iniciar el servidor:', err)
  process.exit(1)
})

export { server }
