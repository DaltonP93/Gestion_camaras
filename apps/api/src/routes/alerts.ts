// apps/api/src/routes/alerts.ts
import type { FastifyPluginAsync } from 'fastify'

export const alertRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/alerts — listar alertas con filtros opcionales
  // ?status=unread   → no leídas y no resueltas
  // ?status=active   → no resueltas (todas)
  // ?resolved=false  → compat. legacy
  server.get('/', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { resolved, status, limit = '100' } = request.query as {
      resolved?: string; status?: string; limit?: string
    }

    let where: any = {}
    if (status === 'unread') {
      where = { resolved: false, readAt: null }
    } else if (status === 'active') {
      where = { resolved: false }
    } else if (resolved !== undefined) {
      where = { resolved: resolved === 'true' }
    }

    const alerts = await server.prisma.alert.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(parseInt(limit), 500),
    })

    return reply.send(alerts)
  })

  // GET /api/alerts/unread-count — contador rápido para la campana
  server.get('/unread-count', { preHandler: [server.authenticate] }, async (_req, reply) => {
    const count = await server.prisma.alert.count({
      where: { resolved: false, readAt: null },
    })
    return reply.send({ count })
  })

  // POST /api/alerts/read-all — marcar todas no leídas como leídas
  server.post('/read-all', { preHandler: [server.authenticate] }, async (_req, reply) => {
    const result = await server.prisma.alert.updateMany({
      where: { resolved: false, readAt: null },
      data: { readAt: new Date() },
    })
    return reply.send({ updated: result.count })
  })

  // POST /api/alerts/:id/read — marcar una alerta como leída
  server.post('/:id/read', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const alert = await server.prisma.alert.update({
      where: { id },
      data: { readAt: new Date() },
    })
    return reply.send(alert)
  })

  // PUT /api/alerts/:id/resolve — resolver alerta (también marca como leída)
  server.put('/:id/resolve', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const alert = await server.prisma.alert.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date(), readAt: new Date() },
    })
    return reply.send(alert)
  })
}
