// apps/api/src/routes/dashboard.ts
// Resumen ÚNICO server-side del Dashboard (P1). Reemplaza los contadores derivados
// client-side de un arreglo compartido y el gráfico "Actividad últimas 24h" que
// usaba Math.random. Una sola fuente para totales de cámaras/NVR, resumen de
// alertas y la serie temporal REAL de alertas por hora.
import type { FastifyPluginAsync } from 'fastify'
import { deriveAlertSummary, bucketAlertsByHour } from '../services/alert-summary'

export const dashboardRoutes: FastifyPluginAsync = async (server) => {
  server.get('/overview', { preHandler: [server.authenticate] }, async (request, reply) => {
    const hoursRaw = (request.query as { hours?: string }).hours
    const hours = Math.min(72, Math.max(1, parseInt(hoursRaw ?? '24', 10) || 24))
    const now = Date.now()
    const since = new Date(now - hours * 3_600_000)

    const [
      camerasTotal, camerasOnline, nvrsTotal, nvrsOnline,
      unread, acknowledged, resolved, criticalPending,
      recentAlerts,
    ] = await Promise.all([
      // Total de cámaras = filas REALES de cámara (fuente única; evita el 144 vs 141
      // del header vs Dashboard que sumaban cameras.length vs channels por separado).
      server.prisma.camera.count(),
      server.prisma.camera.count({ where: { online: true } }),
      server.prisma.nVR.count(),
      server.prisma.nVR.count({ where: { online: true } }),
      server.prisma.alert.count({ where: { resolved: false, readAt: null } }),
      server.prisma.alert.count({ where: { resolved: false, readAt: { not: null } } }),
      server.prisma.alert.count({ where: { resolved: true } }),
      server.prisma.alert.count({ where: { resolved: false, severity: { in: ['HIGH', 'CRITICAL'] } } }),
      server.prisma.alert.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
      }),
    ])

    const buckets = bucketAlertsByHour(recentAlerts.map((a) => a.createdAt.getTime()), now, hours)

    return reply.send({
      cameras: { total: camerasTotal, online: camerasOnline },
      nvrs:    { total: nvrsTotal, online: nvrsOnline },
      alerts:  deriveAlertSummary({ unread, acknowledged, resolved, criticalPending }),
      activity: buckets.map((b) => ({ hourStart: new Date(b.hourStartMs).toISOString(), alerts: b.alerts })),
    })
  })
}
