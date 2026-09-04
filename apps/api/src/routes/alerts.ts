// apps/api/src/routes/alerts.ts
import type { FastifyPluginAsync, FastifyInstance } from 'fastify'
import type { JWTPayload } from '../plugins/auth'
import { deriveAlertSummary } from '../services/alert-summary'
import {
  alertStatusWhere, alertWhere, alertCameraScopeWhere, withAlertScope,
  parseAlertStatus, parseAlertSeverity, parseAlertPage, parseAlertLimit,
} from '../services/alert-query'
import { getViewableCameraIds } from '../services/camera-scope'

// Scope de VISIBILIDAD por cámara del usuario que hace la petición (RBAC / DEV14).
//   ADMIN          → sin restricción (scope = {}, allowed vacío no se usa).
//   resto de roles → sólo alertas de sus cámaras canView + alertas sin cameraId.
// `allowed` (Set) sirve para el chequeo puntual de una alerta en las mutaciones;
// `scope` es el where reusable para listados/conteos.
async function resolveAlertScope(server: FastifyInstance, user: JWTPayload) {
  const isAdmin = user.role === 'ADMIN'
  const allowedList = isAdmin ? [] : await getViewableCameraIds(server.prisma, user.sub)
  return {
    isAdmin,
    allowed: new Set(allowedList),
    scope: alertCameraScopeWhere(isAdmin, allowedList),
  }
}

// ¿Es visible ESTA alerta para el usuario? ADMIN todo; resto: su cámara canView
// o alerta sin cameraId (sistema/NVR).
function alertVisible(isAdmin: boolean, alertCameraId: string | null | undefined, allowed: Set<string>): boolean {
  if (isAdmin) return true
  if (alertCameraId == null) return true
  return allowed.has(alertCameraId)
}

export const alertRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/alerts/summary — contadores ÚNICOS server-side (fuente de verdad).
  // Usa alertStatusWhere (el MISMO builder que la lista) para que jamás diverjan.
  //   unread(Nuevas) = !resolved && readAt=null; acknowledged(Reconocidas) =
  //   !resolved && readAt!=null; pending = unread+acknowledged; resolved; total;
  //   criticalPending = pendiente y severidad HIGH/CRITICAL. Campana/menú = unread,
  //   Dashboard = pending.
  // RBAC: los KPIs cuentan SÓLO lo visible para el usuario (su scope de cámara).
  server.get('/summary', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { scope } = await resolveAlertScope(server, request.user)
    const [unread, acknowledged, resolved, criticalPending] = await Promise.all([
      server.prisma.alert.count({ where: withAlertScope(alertStatusWhere('unread'), scope) }),
      server.prisma.alert.count({ where: withAlertScope(alertStatusWhere('acknowledged'), scope) }),
      server.prisma.alert.count({ where: withAlertScope(alertStatusWhere('resolved'), scope) }),
      server.prisma.alert.count({ where: withAlertScope({ resolved: false, severity: { in: ['HIGH', 'CRITICAL'] } }, scope) }),
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
  // RBAC: se aplica el scope de cámara del usuario (cameraId permitido OR cameraId null).
  server.get('/', { preHandler: [server.authenticate] }, async (request, reply) => {
    const q = request.query as Record<string, unknown>
    const status = parseAlertStatus(q.status)
    const severity = parseAlertSeverity(q.severity)
    const page = parseAlertPage(q.page)
    const limit = parseAlertLimit(q.limit)
    const { scope } = await resolveAlertScope(server, request.user)
    const where = withAlertScope(alertWhere(status, severity), scope)

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

  // GET /api/alerts/unread-count — contador rápido para la campana (scopeado por cámara)
  server.get('/unread-count', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { scope } = await resolveAlertScope(server, request.user)
    const count = await server.prisma.alert.count({
      where: withAlertScope({ resolved: false, readAt: null }, scope),
    })
    return reply.send({ count })
  })

  // POST /api/alerts/read-all — marcar todas no leídas como leídas (sólo las visibles)
  server.post('/read-all', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { scope } = await resolveAlertScope(server, request.user)
    const result = await server.prisma.alert.updateMany({
      where: withAlertScope({ resolved: false, readAt: null }, scope),
      data: { readAt: new Date() },
    })
    return reply.send({ updated: result.count })
  })

  // POST /api/alerts/:id/read — marcar una alerta como leída
  // RBAC: no se puede leer una alerta fuera del scope de cámara ⇒ 404 (inexistente) / 403 (ajena).
  server.post('/:id/read', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { isAdmin, allowed } = await resolveAlertScope(server, request.user)
    const existing = await server.prisma.alert.findUnique({ where: { id }, select: { id: true, cameraId: true } })
    if (!existing) return reply.status(404).send({ message: 'Alerta no encontrada' })
    if (!alertVisible(isAdmin, existing.cameraId, allowed)) {
      return reply.status(403).send({ message: 'Sin permiso para esta alerta' })
    }
    const alert = await server.prisma.alert.update({
      where: { id },
      data: { readAt: new Date() },
    })
    return reply.send(alert)
  })

  // PUT /api/alerts/:id/resolve — resolver alerta (también marca como leída)
  // RBAC: authorize limita a ADMIN/SUPERVISOR; ADMIN sin restricción, SUPERVISOR
  // sólo alertas dentro de su scope de cámara ⇒ 404 (inexistente) / 403 (ajena).
  server.put('/:id/resolve', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { isAdmin, allowed } = await resolveAlertScope(server, request.user)
    const existing = await server.prisma.alert.findUnique({ where: { id }, select: { id: true, cameraId: true } })
    if (!existing) return reply.status(404).send({ message: 'Alerta no encontrada' })
    if (!alertVisible(isAdmin, existing.cameraId, allowed)) {
      return reply.status(403).send({ message: 'Sin permiso para esta alerta' })
    }
    const alert = await server.prisma.alert.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date(), readAt: new Date() },
    })
    return reply.send(alert)
  })
}
