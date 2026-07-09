// apps/api/src/routes/analytics.ts
// Analítica de video (servicio Python + Roboflow Supervision).
// Endpoints internos (secreto compartido) para el microservicio de analítica
// y endpoints de usuario para configuración por cámara y consulta de eventos.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { broadcastAlert } from './websocket'
import { sendAlertNotification } from '../services/notification.service'
import { decryptNvrPasswordOrNull } from '../services/credentials'
import { buildRtspUrl, buildRtspUrlMasked } from '../services/hikvision'
import { AuditAction } from '../services/audit'

const ANALYTICS_SECRET = process.env.ANALYTICS_SECRET || ''
const UPLOADS_DIR      = process.env.UPLOADS_DIR || '/app/uploads'

// COCO classes the pipeline supports (kept in sync with apps/analytics)
const SUPPORTED_CLASSES = ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle'] as const

const VEHICLE_CLASSES = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle'])

const configSchema = z.object({
  enabled:       z.boolean(),
  classes:       z.array(z.enum(SUPPORTED_CLASSES)).min(1),
  minConfidence: z.number().min(0.1).max(0.95),
  sampleFps:     z.number().min(0.2).max(10),
  cooldownSec:   z.number().int().min(5).max(3600),
  zones: z.array(z.object({
    name:    z.string().min(1).max(60),
    points:  z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(3).max(30),
    classes: z.array(z.enum(SUPPORTED_CLASSES)).optional(),
  })).max(10).nullable().optional(),
})

const eventSchema = z.object({
  cameraId:   z.string().min(1),
  type:       z.enum(['person', 'vehicle', 'zone_intrusion', 'line_crossing']),
  className:  z.string().min(1).max(40),
  confidence: z.number().min(0).max(1),
  trackId:    z.number().int().optional(),
  zoneName:   z.string().max(60).optional(),
  bboxes:     z.array(z.array(z.union([z.number(), z.string()]))).max(64).optional(),
  occurredAt: z.string().datetime(),
  // JPEG anotado (cajas dibujadas por supervision), base64 sin prefijo data:
  snapshotJpegBase64: z.string().max(4_000_000).optional(),
})

const ALERT_TYPE_BY_EVENT: Record<string, 'PERSON_DETECTED' | 'VEHICLE_DETECTED' | 'ZONE_INTRUSION' | 'LINE_CROSSING'> = {
  person:         'PERSON_DETECTED',
  vehicle:        'VEHICLE_DETECTED',
  zone_intrusion: 'ZONE_INTRUSION',
  line_crossing:  'LINE_CROSSING',
}

const CLASS_LABEL_ES: Record<string, string> = {
  person: 'Persona', car: 'Auto', truck: 'Camión', bus: 'Bus',
  motorcycle: 'Moto', bicycle: 'Bicicleta',
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export const analyticsRoutes: FastifyPluginAsync = async (server) => {

  // Guard for the internal (service-to-service) endpoints
  const requireAnalyticsSecret = async (request: any, reply: any) => {
    if (!ANALYTICS_SECRET) {
      return reply.status(503).send({ message: 'Analítica deshabilitada: define ANALYTICS_SECRET' })
    }
    const provided = request.headers['x-analytics-secret']
    if (typeof provided !== 'string' || !timingSafeEqual(provided, ANALYTICS_SECRET)) {
      return reply.status(401).send({ message: 'Secreto de analítica inválido' })
    }
  }

  // ── GET /api/analytics/internal/cameras ──────────────────────────────────
  // Lista de cámaras con analítica habilitada + URL RTSP del substream.
  // Solo accesible con el secreto compartido, dentro de la red interna.
  server.get('/internal/cameras', { preHandler: [requireAnalyticsSecret] }, async (_request, reply) => {
    const configs = await server.prisma.cameraAnalyticsConfig.findMany({ where: { enabled: true } })
    if (configs.length === 0) return reply.send({ cameras: [] })

    const cameras = await server.prisma.camera.findMany({
      where: { id: { in: configs.map(c => c.cameraId) }, active: true },
      include: { nvr: true },
    })
    const byId = new Map(cameras.map(c => [c.id, c]))

    const result = configs.flatMap(cfg => {
      const cam = byId.get(cfg.cameraId)
      if (!cam || !cam.nvr.active) return []
      const plainPass = decryptNvrPasswordOrNull(cam.nvr.password)
      if (!plainPass) {
        server.log.warn(`[analytics] decrypt_failed cameraId=${cam.id} nvrId=${cam.nvrId}`)
        return []
      }
      const nvrPlain = { ipAddress: cam.nvr.ipAddress, rtspPort: cam.nvr.rtspPort, username: cam.nvr.username, password: plainPass }
      return [{
        cameraId:      cam.id,
        cameraName:    cam.name,
        nvrName:       cam.nvr.name,
        rtspUrl:       buildRtspUrl(nvrPlain, cam.channel, true), // substream
        rtspMasked:    buildRtspUrlMasked(nvrPlain, cam.channel, true),
        classes:       cfg.classes,
        minConfidence: cfg.minConfidence,
        sampleFps:     cfg.sampleFps,
        zones:         cfg.zones,
        cooldownSec:   cfg.cooldownSec,
        updatedAt:     cfg.updatedAt.toISOString(),
      }]
    })

    return reply.send({ cameras: result })
  })

  // ── POST /api/analytics/internal/events ──────────────────────────────────
  // Webhook del servicio Python: persiste el evento, guarda el snapshot y
  // dispara el pipeline de alertas existente (campana + email + deliveries).
  server.post('/internal/events', {
    preHandler: [requireAnalyticsSecret],
    bodyLimit: 6 * 1024 * 1024,
  }, async (request, reply) => {
    const body = eventSchema.parse(request.body)

    const camera = await server.prisma.camera.findUnique({
      where: { id: body.cameraId }, include: { nvr: true },
    })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    // Snapshot → /uploads/analytics/YYYYMM/<eventId>.jpg
    let snapshotUrl: string | null = null
    const eventId = crypto.randomBytes(12).toString('hex')
    if (body.snapshotJpegBase64) {
      try {
        const buf = Buffer.from(body.snapshotJpegBase64, 'base64')
        if (buf.length > 0 && buf.length <= 3 * 1024 * 1024) {
          const yyyymm = new Date(body.occurredAt).toISOString().slice(0, 7).replace('-', '')
          const dir = path.join(UPLOADS_DIR, 'analytics', yyyymm)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, `${eventId}.jpg`), buf)
          snapshotUrl = `/uploads/analytics/${yyyymm}/${eventId}.jpg`
        }
      } catch (err) {
        server.log.warn(`[analytics] snapshot_save_failed: ${err}`)
      }
    }

    const alertType = ALERT_TYPE_BY_EVENT[body.type]
    const classLabel = CLASS_LABEL_ES[body.className] ?? body.className
    const message = body.type === 'zone_intrusion'
      ? `Intrusión en zona "${body.zoneName ?? 'zona'}": ${classLabel.toLowerCase()} en ${camera.name}`
      : `${classLabel} detectada en ${camera.name} (${camera.nvr.name})`

    // ZONE_INTRUSION es HIGH (dispara email con la config por defecto);
    // detecciones sueltas son LOW para no saturar el correo — se ven en la campana.
    const severity = body.type === 'zone_intrusion' ? 'HIGH' : 'LOW'

    const alert = await server.prisma.alert.create({
      data: {
        cameraId: camera.id,
        nvrId:    camera.nvrId,
        type:     alertType,
        severity,
        message,
        detail: {
          className: body.className, confidence: body.confidence,
          zoneName: body.zoneName ?? null, snapshotUrl, trackId: body.trackId ?? null,
        },
      },
    })

    const event = await server.prisma.analyticsEvent.create({
      data: {
        cameraId:   camera.id,
        type:       body.type,
        className:  body.className,
        confidence: body.confidence,
        trackId:    body.trackId ?? null,
        zoneName:   body.zoneName ?? null,
        bboxes:     body.bboxes ?? undefined,
        snapshotUrl,
        alertId:    alert.id,
        occurredAt: new Date(body.occurredAt),
      },
    })

    broadcastAlert({
      type: 'alert',
      alert: {
        id: alert.id, type: alert.type, severity: alert.severity,
        message: alert.message, nvrName: camera.nvr.name,
        cameraName: camera.name, snapshotUrl, createdAt: alert.createdAt,
      },
    })

    sendAlertNotification(server.prisma, {
      id: alert.id, type: alert.type, severity: alert.severity,
      message: alert.message, detail: alert.detail,
      cameraId: alert.cameraId, nvrId: alert.nvrId,
    }).catch((e) => server.log.error(`[analytics] email_failed: ${e}`))

    server.log.info(
      `[analytics] event_received cameraId=${camera.id} type=${body.type}` +
      ` class=${body.className} conf=${body.confidence.toFixed(2)} zone=${body.zoneName ?? 'none'}`
    )
    return reply.send({ ok: true, eventId: event.id, alertId: alert.id })
  })

  // ── Configuración por cámara (usuarios) ──────────────────────────────────

  server.get('/config', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (_request, reply) => {
    const configs = await server.prisma.cameraAnalyticsConfig.findMany()
    return reply.send({ configs, supportedClasses: SUPPORTED_CLASSES, serviceConfigured: Boolean(ANALYTICS_SECRET) })
  })

  server.get('/config/:cameraId', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { cameraId } = request.params as { cameraId: string }
    const config = await server.prisma.cameraAnalyticsConfig.findUnique({ where: { cameraId } })
    return reply.send({ config, supportedClasses: SUPPORTED_CLASSES })
  })

  server.put('/config/:cameraId', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { cameraId } = request.params as { cameraId: string }
    const body = configSchema.parse(request.body)

    const camera = await server.prisma.camera.findUnique({ where: { id: cameraId }, select: { id: true, name: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const data = {
      enabled:       body.enabled,
      classes:       body.classes,
      minConfidence: body.minConfidence,
      sampleFps:     body.sampleFps,
      cooldownSec:   body.cooldownSec,
      zones:         body.zones ?? undefined,
    }
    const config = await server.prisma.cameraAnalyticsConfig.upsert({
      where:  { cameraId },
      create: { cameraId, ...data },
      update: data,
    })

    await AuditAction(server.prisma, (request.user as any).sub, 'ANALYTICS_CONFIG_UPDATED', cameraId, request, {
      cameraName: camera.name, enabled: body.enabled, classes: body.classes,
    })
    server.log.info(`[analytics] config_updated cameraId=${cameraId} enabled=${body.enabled} classes=${body.classes.join(',')}`)
    return reply.send({ config })
  })

  // ── Eventos (usuarios) ────────────────────────────────────────────────────

  server.get('/events', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR', 'AUDITOR'])] }, async (request, reply) => {
    const q = request.query as {
      cameraId?: string; type?: string; className?: string
      from?: string; to?: string; page?: string; limit?: string
    }
    const where: any = {}
    if (q.cameraId) where.cameraId = q.cameraId
    if (q.type) where.type = q.type
    if (q.className) where.className = q.className
    if (q.from || q.to) {
      where.occurredAt = {}
      if (q.from) where.occurredAt.gte = new Date(q.from)
      if (q.to)   where.occurredAt.lte = new Date(q.to)
    }
    const page  = Math.max(1, parseInt(q.page ?? '1'))
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '50')))

    const [events, total] = await Promise.all([
      server.prisma.analyticsEvent.findMany({
        where, orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * limit, take: limit,
      }),
      server.prisma.analyticsEvent.count({ where }),
    ])

    // Adjuntar nombres de cámara en un solo query
    const camIds = [...new Set(events.map(e => e.cameraId))]
    const cams = camIds.length > 0
      ? await server.prisma.camera.findMany({
          where: { id: { in: camIds } },
          select: { id: true, name: true, nvr: { select: { name: true } } },
        })
      : []
    const camById = new Map(cams.map(c => [c.id, c]))

    return reply.send({
      events: events.map(e => ({
        ...e,
        cameraName: camById.get(e.cameraId)?.name ?? 'Desconocida',
        nvrName:    camById.get(e.cameraId)?.nvr?.name ?? '',
      })),
      total, page, limit,
    })
  })

  // Resumen para dashboard: conteos por tipo y por cámara en un rango
  server.get('/summary', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const q = request.query as { from?: string; to?: string }
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to   = q.to   ? new Date(q.to)   : new Date()
    const where = { occurredAt: { gte: from, lte: to } }

    const [byType, byCamera, totalEvents] = await Promise.all([
      server.prisma.analyticsEvent.groupBy({ by: ['type'], where, _count: { _all: true } }),
      server.prisma.analyticsEvent.groupBy({ by: ['cameraId'], where, _count: { _all: true } }),
      server.prisma.analyticsEvent.count({ where }),
    ])

    const camIds = byCamera.map(c => c.cameraId)
    const cams = camIds.length > 0
      ? await server.prisma.camera.findMany({ where: { id: { in: camIds } }, select: { id: true, name: true } })
      : []
    const nameById = new Map(cams.map(c => [c.id, c.name]))

    return reply.send({
      from: from.toISOString(), to: to.toISOString(), totalEvents,
      byType:   byType.map(t => ({ type: t.type, count: t._count._all })),
      byCamera: byCamera
        .map(c => ({ cameraId: c.cameraId, cameraName: nameById.get(c.cameraId) ?? 'Desconocida', count: c._count._all }))
        .sort((a, b) => b.count - a.count),
    })
  })
}
