// apps/api/src/routes/liveView.ts
// Endpoint de viewport heartbeat: reconcilia cámaras visibles sin N llamadas individuales
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { reconcileView, MAX_TRANSCODE_SESSIONS, getAdminSessionsSummary } from '../services/stream-manager'
import { getFfmpegCapabilities, isTranscodingEnabled, getActiveTranscodesList } from '../services/stream'

const heartbeatSchema = z.object({
  viewId:           z.string().min(1).max(128),
  visibleCameraIds: z.array(z.string()).max(25),
  layout:           z.number().int().positive().optional(),
  page:             z.number().int().min(0).optional(),
})

export const liveViewRoutes: FastifyPluginAsync = async (server) => {
  // POST /api/live-view/heartbeat
  // Reconcilia el estado de las cámaras visibles para un view dado.
  // - Inicia streams para cámaras visibles sin sesión activa
  // - Detiene streams para cámaras que este view ya no necesita
  // - Toca sesiones existentes (keepalive)
  // - Devuelve URLs completas para todas las cámaras visibles
  server.post('/heartbeat', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    const body = heartbeatSchema.parse(request.body)

    const result = await reconcileView(
      server,
      user.sub,
      body.viewId,
      body.visibleCameraIds,
    )

    // Log estructurado para diagnosticar producción
    const errCount  = Object.keys(result.errors).length
    const logParts = [
      `[live-view] heartbeat`,
      `userId=${user.sub.slice(0, 8)}`,
      `viewId=${body.viewId.slice(0, 8)}`,
      `visible=${body.visibleCameraIds.length}`,
      `layout=${body.layout ?? '?'}`,
      `page=${body.page ?? '?'}`,
      `started=${result.startedIds.length}`,
      `stopped=${result.stoppedIds.length}`,
      `streams=${Object.keys(result.streams).length}`,
      `errors=${errCount}`,
    ]
    if (result.startedIds.length > 0) logParts.push(`startedIds=[${result.startedIds.join(',')}]`)
    if (result.stoppedIds.length > 0) logParts.push(`stoppedIds=[${result.stoppedIds.join(',')}]`)
    if (errCount > 0) {
      const errSummary = Object.entries(result.errors)
        .map(([id, e]) => `${id.slice(0,8)}:${e.code}`)
        .join(', ')
      logParts.push(`errDetail=[${errSummary}]`)
    }
    server.log.info(logParts.join(' '))

    return reply.send(result)
  })

  // GET /api/live-view/capabilities
  // Devuelve capacidades del servidor para que el frontend adapte la UI.
  server.get('/capabilities', { preHandler: [server.authenticate] }, async (_request, reply) => {
    const caps = getFfmpegCapabilities()
    return reply.send({
      ffmpegAvailable:     caps.available,
      transcodingEnabled:  isTranscodingEnabled(),
      encoders:            caps.encoders,
      maxTranscodeSessions: MAX_TRANSCODE_SESSIONS,
    })
  })

  // GET /api/live-view/transcodes
  // Lista procesos FFmpeg activos y sesiones main_h264 — para diagnóstico desde el API container.
  // Úsalo para confirmar que FFmpeg sigue vivo después de hacer click en "Transcodificar".
  // Equivalente a: docker compose exec api ps -ef | grep ffmpeg
  server.get('/transcodes', { preHandler: [server.authenticate] }, async (_request, reply) => {
    const procs    = getActiveTranscodesList()
    const sessions = getAdminSessionsSummary().filter(s => s.streamPath.endsWith('_main_h264'))
    return reply.send({
      activeFFmpegProcesses: procs,
      activeTranscodeSessions: sessions,
      summary: {
        ffmpegCount:  procs.length,
        aliveCount:   procs.filter(p => p.alive).length,
        sessionCount: sessions.length,
      },
    })
  })
}
