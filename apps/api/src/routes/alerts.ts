// apps/api/src/routes/alerts.ts
import type { FastifyPluginAsync } from 'fastify'
import { deriveAlertSummary } from '../services/alert-summary'
import {
  alertStatusWhere, alertWhere,
  parseAlertStatus, parseAlertSeverity, parseAlertPage, parseAlertLimit,
} from '../services/alert-query'

export const alertRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/alerts/summary — contadores ÚNICOS server-side (fuente de verdad).
  // Usa alertStatusWhere (el MISMO builder que la lista) para que jamás diverjan.
  //   unread(Nuevas) = !resolved && readAt=null; acknowledged(Reconocidas) =
  //   !resolved && readAt!=null; pending = unread+acknowledged; resolved; total;
  //   criticalPending = pendiente y severidad HIGH/CRITICAL. Campana/menú = unread,
  //   Dashboard = pending.
  server.get('/summary', { preHandler: [server.authenticate] }, async (_req, reply) => {
    const [unread, acknowledged, resolved, criticalPending] = await Promise.all([
      server.prisma.alert.count({ where: alertStatusWhere('unread') }),
      server.prisma.alert.count({ where: alertStatusWhere('acknowledged') }),
      server.prisma.alert.count({ where: alertStatusWhere('resolved') }),
      server.prisma.alert.count({ where: { resolved: false, severity: { in: ['HIGH', 'CRITICAL'] } } }),
    ])
    return reply.send(deriveAlertSummary({ unread, acknowledged, resolved, criticalPending }))
  })

  // GET /api/alerts — lista PAGINADA con filtro server-side (PR A).
  //   ?status=unread|acknowledged|resolved|all|active  (active = pendientes, legacy)
  //   ?severity=all|LOW|MEDIUM|HIGH|CRITICAL
  //   ?page=0&limit=50
  // Respuesta: { items, total, page, limit }. Las condiciones de estado son idénticas a
  // /alerts/summary (mismo builder), de modo que si summary.unread=2, status=unread
  // devuelve exactamente esas 2 filas aunque estén fuera de las primeras 200.
  server.get('/', { preHandler: [server.authenticate] }, async (request, reply) => {
    const q = request.query as Record<string, unknown>
    const status = parseAlertStatus(q.status)
    const severity = parseAlertSeverity(q.severity)
    const page = parseAlertPage(q.page)
    const limit = parseAlertLimit(q.limit)
    const where = alertWhere(status, severity)

    const [items, total] = await Promise.all([
      server.prisma.alert.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: page * limit,
        take: limit,
      }),
      server.prisma.alert.count({ where }),
    ])

    return reply.send({ items, total, page, limit })
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
