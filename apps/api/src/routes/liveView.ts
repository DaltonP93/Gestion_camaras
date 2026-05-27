// apps/api/src/routes/liveView.ts
// Endpoint de viewport heartbeat: reconcilia cámaras visibles sin N llamadas individuales
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { reconcileView } from '../services/stream-manager'

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

    return reply.send(result)
  })
}
