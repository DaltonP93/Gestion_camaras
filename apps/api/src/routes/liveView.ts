// apps/api/src/routes/liveView.ts
// Endpoint de viewport heartbeat: reconcilia cámaras visibles sin N llamadas individuales
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { reconcileView, MAX_TRANSCODE_SESSIONS, getAdminSessionsSummary, getTranscodesDiagnostic, getStreamCounts, getSessionsDiagnostic } from '../services/stream-manager'
import { getFfmpegCapabilities, isTranscodingEnabled } from '../services/stream'

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

    // Conteos actuales de streams — el frontend los usa para mostrar "X/Y" en el
    // banner de límite alcanzado y decidir el backoff antes de reintentar.
    return reply.send({ ...result, streamCounts: getStreamCounts(user.sub) })
  })

  // GET /api/live-view/sessions
  // Diagnóstico de sesiones de streaming activas (sin credenciales). Devuelve
  // datos de TODOS los usuarios (cameraId/userId/viewId), por eso es solo ADMIN
  // — igual que /api/cameras/stream-sessions. Purga las vencidas antes de listar.
  server.get('/sessions', { preHandler: [server.authorize(['ADMIN'])] }, async (_request, reply) => {
    return reply.send(getSessionsDiagnostic())
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
  // Diagnóstico completo de procesos FFmpeg activos — incluye reinicios, stderr y estado MediaMTX.
  server.get('/transcodes', { preHandler: [server.authenticate] }, async (_request, reply) => {
    const procs    = await getTranscodesDiagnostic()
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
