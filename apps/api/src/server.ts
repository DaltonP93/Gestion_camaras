// apps/api/src/server.ts
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { beginRequest, type RequestTicket } from './services/stream-manager'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import multipart from '@fastify/multipart'
import path from 'path'
import fs from 'fs'
import { redactUrlSecrets } from './lib/log-redact'
import { resolveCorsOptions } from './lib/cors-config'
import { prismaPlugin } from './plugins/prisma'
import { redisPlugin } from './plugins/redis'
import { authPlugin } from './plugins/auth'
import { authRoutes } from './routes/auth'
import { nvrRoutes } from './routes/nvr'
import { cameraRoutes } from './routes/cameras'
import { recordingRoutes, logPreviewStartupConfig } from './routes/recordings'
import { userRoutes } from './routes/users'
import { alertRoutes } from './routes/alerts'
import { dashboardRoutes } from './routes/dashboard'
import { securityRoutes } from './routes/security'
import { wsHandler } from './routes/websocket'
import viewsPlugin from './routes/views'
import appearancePlugin from './routes/appearance'
import profileRoutes from './routes/profile'
import alertSettingsRoutes from './routes/alertSettings'
import { liveViewRoutes } from './routes/liveView'
import { mediaGrantsRoutes } from './routes/mediaGrants'
import { getMediaGrantManager, startRevokeRecovery } from './services/media/grant-service'
import { SourceLifecycleController, startSourceLifecyclePoller, createMediaMtxPathLister } from './services/media/source-lifecycle'
import { searchRoutes } from './routes/search'
import { nvrConfigRoutes } from './routes/nvrConfig'
import { adminRoutes } from './routes/admin'
import { analyticsRoutes } from './routes/analytics'
import { aiDemoRoutes } from './routes/aiDemo'
import { diagnosticsRoutes } from './routes/diagnostics'
import { integrationsRoutes } from './routes/integrations'
import { onvifRoutes } from './routes/onvif'
import { hikConnectRoutes } from './routes/hikConnect'
import { mediamtxAuthRoutes } from './routes/mediamtxAuth'
import { metricsRoutes } from './routes/metrics'
import { startHealthWorker } from './jobs/healthWorker'
import { startSyncWorker } from './jobs/syncWorker'
import { publishStream, getActiveTranscodesList, stopTranscodeProcess } from './services/stream'
import { reRegisterStreams } from './services/stream-reregister'
import { decryptNvrPasswordOrNull as decryptPass, validateNvrCredentialKey } from './services/credentials'

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
  try {
    const nvrKeyWarning = validateNvrCredentialKey()
    if (nvrKeyWarning) server.log.warn(nvrKeyWarning)
  } catch (err) {
    server.log.error((err as Error).message)
    process.exit(1)
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    server.log.warn('[startup] JWT_SECRET parece muy corto (< 32 chars). Usa un secreto de al menos 32 caracteres aleatorios.')
  }

  // ─── Ticket de llegada — PRIMER hook onRequest de todos ────
  //
  // Debe registrarse ANTES de cualquier otro plugin, porque Fastify ejecuta los
  // hooks `onRequest` en orden de registro y varios de ellos son asíncronos:
  // `@fastify/rate-limit` hace su comprobación en `onRequest`, y la
  // autenticación espera en `preHandler`. Si el ticket se estampara después,
  // una petición vieja podría quedar detenida en esos hooks mientras un cierre
  // posterior la adelanta, y al reanudarse recibiría una secuencia MAYOR que la
  // del cierre: pasaría por reapertura legítima y recrearía la sesión fantasma
  // que esta barrera existe para impedir (revisión de #148).
  server.decorateRequest('requestTicket', null as unknown as RequestTicket)
  server.addHook('onRequest', async (request) => {
    request.requestTicket = beginRequest()
  })

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
  // Con CORS_ORIGINS definido → comportamiento idéntico al histórico (allowlist +
  // credenciales). Sin CORS_ORIGINS → NO se refleja cualquier origin con
  // credenciales: sólo se permite localhost/127.0.0.1/[::1] (dev usable); el resto
  // de orígenes cruzados quedan sin cabeceras CORS. Ver lib/cors-config.ts.
  await server.register(cors, resolveCorsOptions(process.env.CORS_ORIGINS))

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
      server.log.error({ err: error, url: redactUrlSecrets(request.url) }, 'unhandled_error')
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
  await server.register(dashboardRoutes, { prefix: '/api/dashboard' })
  await server.register(securityRoutes, { prefix: '/api/security' })
  await server.register(viewsPlugin, { prefix: '/api/views' })
  await server.register(appearancePlugin, { prefix: '/api/appearance' })
  await server.register(profileRoutes, { prefix: '/api/profile' })
  await server.register(alertSettingsRoutes, { prefix: '/api/alerts' })
  await server.register(liveViewRoutes, { prefix: '/api/live-view' })
  // C22.1 (P1): las rutas del plano de medios existen SÓLO con la flag activa.
  // Con la flag apagada no se registran ⇒ 404 (comportamiento idéntico a C21).
  if (process.env.NATIVE_PLAYBACK_ENABLED === 'true') {
    await server.register(mediaGrantsRoutes, { prefix: '/api/live-view' })
  }
  await server.register(searchRoutes, { prefix: '/api/search' })
  await server.register(nvrConfigRoutes, { prefix: '/api/nvrs' })
  await server.register(adminRoutes, { prefix: '/api/admin' })
  await server.register(analyticsRoutes, { prefix: '/api/analytics' })
  // C22.1 (P1): la ruta demo de IA existe SÓLO con la flag activa (si no, 404).
  if (process.env.AI_EVENTS_ENABLED === 'true') {
    await server.register(aiDemoRoutes, { prefix: '/api/ai' })
  }
  await server.register(diagnosticsRoutes, { prefix: '/api/diagnostics' })
  // Estado de integraciones (P1): SIEMPRE registrado (no condicional a flags), para
  // que la UI muestre "habilitado/deshabilitado" sin depender de un 404. Sólo reporta
  // el estado de las flags; nunca secretos ni configuración sensible.
  await server.register(integrationsRoutes, { prefix: '/api/integrations' })
  // ONVIF (P1): rutas existen SÓLO con la flag activa. Con la flag apagada no se
  // registran ⇒ 404 y ningún I/O ONVIF posible (comportamiento idéntico).
  if (process.env.ONVIF_ENABLED === 'true') {
    await server.register(onvifRoutes, { prefix: '/api/onvif' })
  }
  // Hik-Connect (P1): provider de conectividad remota (fallback vía nube). Las
  // rutas existen SÓLO con la flag activa; con la flag apagada no se registran ⇒
  // 404 y ningún I/O Hik-Connect posible (comportamiento idéntico).
  if (process.env.HIK_CONNECT_ENABLED === 'true') {
    await server.register(hikConnectRoutes, { prefix: '/api/hik-connect' })
  }
  // A1 · F0 — auth-hook de MediaMTX: rutas existen SÓLO con la flag activa. Con la
  // flag apagada NO se registran ⇒ 404, ningún grant relay_session ni kick posible
  // (comportamiento idéntico a hoy). A1 sigue NO-GO: esto es sólo código.
  if (process.env.NATIVE_MEDIA_RELAY_ENABLED === 'true') {
    await server.register(mediamtxAuthRoutes, { prefix: '/internal/mediamtx' })
  }
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

  // B1 — Recuperación de la revocación durable de medios. Si Redis cae durante un
  // logout / cambio de permisos, `revokeUserMediaGrants` encola el usuario y el
  // plano falla cerrado; aquí se drena ese outbox al reconectar Redis y en un
  // barrido periódico, para que ningún grant viejo re-valide tras el outage.
  // Inerte con las flags OFF y sin outage previo (no toca Redis si no hay pendientes).
  const revokeRecovery = startRevokeRecovery(server)
  server.addHook('onClose', async () => revokeRecovery.stop())

  // Apagado elegante (A2): terminar los FFmpeg de transcode en vivo por su vía
  // terminal ya existente cuando el servidor cierra. Los FFmpeg de preview/VOD
  // se cierran en su propio hook onClose (routes/recordings.ts).
  server.addHook('onClose', async () => {
    for (const t of getActiveTranscodesList()) {
      try { stopTranscodeProcess(t.streamPath) } catch { /* noop */ }
    }
  })

  // N1 — Lifecycle de fuente MediaMTX → registro de instancia del plano de medios.
  // SÓLO con NATIVE_SOURCE_LIFECYCLE_ENABLED activa: con la flag apagada no se
  // arranca, ningún path se registra ⇒ `issue` sigue negándose (NO_MEDIA_INSTANCE)
  // ⇒ comportamiento idéntico a C22.2. Sólo lee la API de MediaMTX (no la altera).
  if (process.env.NATIVE_SOURCE_LIFECYCLE_ENABLED === 'true') {
    const srcController = new SourceLifecycleController(getMediaGrantManager(server), {
      log: (m) => server.log.info(`media_source ${m}`),
    })
    const srcPoller = startSourceLifecyclePoller(
      srcController,
      createMediaMtxPathLister(),
      Number(process.env.NATIVE_SOURCE_LIFECYCLE_INTERVAL_MS) || 30_000,
      (m) => server.log.warn(`media_source ${m}`),
    )
    server.addHook('onClose', async () => srcPoller.stop())
    server.log.info('[startup] N1 source-lifecycle poller activo (NATIVE_SOURCE_LIFECYCLE_ENABLED=true)')
  }

  // ─── Iniciar servidor ─────────────────────────────────────
  const host = process.env.API_HOST || '0.0.0.0'
  const port = parseInt(process.env.API_PORT || '4000')

  await server.listen({ host, port })
  server.log.info(`VisionCore API v1.0.0 commit=${COMMIT_SHA} corriendo en http://${host}:${port}`)

  // ─── Apagado elegante (A2) ────────────────────────────────
  // dumb-init reenvía SIGTERM a Node; sin este manejador el proceso salía de
  // inmediato sin drenar Fastify ni disparar los hooks onClose (srcPoller,
  // terminación de FFmpeg de transcode/preview/VOD), dejando hijos huérfanos en
  // cada deploy/restart (invariante 5). server.close() ejecuta esos onClose.
  // Idempotente: una segunda señal durante el cierre se ignora.
  let shuttingDown = false
  const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 15_000
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    server.log.info(`[shutdown] señal ${signal} recibida — cerrando el servidor`)
    const forceTimer = setTimeout(() => {
      server.log.error(`[shutdown] timeout de ${SHUTDOWN_TIMEOUT_MS}ms — forzando salida`)
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceTimer.unref?.()
    try {
      await server.close()
      clearTimeout(forceTimer)
      server.log.info('[shutdown] cierre completo')
      process.exit(0)
    } catch (err) {
      clearTimeout(forceTimer)
      server.log.error(`[shutdown] error durante el cierre: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }
  process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
  process.once('SIGINT', () => { void gracefulShutdown('SIGINT') })
  // TASK 1 — config efectiva del preview de grabaciones (commit + presupuesto real
  // + detección de override viejo). Confirma qué código/presupuesto corren.
  logPreviewStartupConfig((m) => server.log.info(m), COMMIT_SHA)

  // Re-registrar todos los streams en MediaMTX al arrancar
  // MediaMTX pierde los paths dinámicos al reiniciarse; este bloque los restaura
  setTimeout(async () => {
    try {
      const nvrs = await server.prisma.nVR.findMany({
        where: { active: true },
        include: { cameras: { where: { active: true } } },
      })
      // Aislamiento por cámara: un fallo puntual de publishStream no aborta el
      // re-registro del resto del lote (ver services/stream-reregister.ts).
      await reRegisterStreams(nvrs as any, {
        decryptPass,
        publishStream: (nvr, camera) => publishStream(nvr as any, camera as any),
        log: {
          info: (m) => server.log.info(m),
          warn: (m) => server.log.warn(m),
          error: (m) => server.log.error(m),
        },
      })
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
