// apps/api/src/routes/alerts.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

export const alertRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/alerts — Listar alertas
  server.get('/', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { resolved, limit = '50' } = request.query as { resolved?: string; limit?: string }

    const alerts = await server.prisma.alert.findMany({
      where: resolved !== undefined ? { resolved: resolved === 'true' } : {},
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: parseInt(limit),
    })

    return reply.send(alerts)
  })

  // PUT /api/alerts/:id/resolve — Marcar alerta como resuelta
  server.put('/:id/resolve', {
    preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const alert = await server.prisma.alert.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date() },
    })

    return reply.send(alert)
  })
}
