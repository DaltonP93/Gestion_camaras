// apps/api/src/routes/analytics.ts
// Analítica de video (servicio Python + Roboflow Supervision).
// Endpoints internos (secreto compartido) para el microservicio de analítica
// y endpoints de usuario para configuración por cámara y consulta de eventos.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { broadcastAlertScoped } from './websocket'
import { sendAlertNotification } from '../services/notification.service'
import { decryptNvrPasswordOrNull } from '../services/credentials'
import { buildRtspUrl, buildRtspUrlMasked } from '../services/hikvision'
import { getStreamPath, publishStream, markAnalyticsConsumer } from '../services/stream'
import { configureStreamConsumerRegistry, setStreamConsumerLogger } from '../services/stream-consumer-registry'
import { analyticsEventsTotal, analyticsEventsRejectedTotal, analyticsAlertsCreatedTotal } from '../services/metrics'
import { AuditAction } from '../services/audit'
import { getViewableCameraIds } from '../services/camera-scope'

// Scope de VISIBILIDAD por cámara del usuario que consulta analítica (RBAC, DEV15).
// Consistente con el scope de alertas (routes/alerts.ts):
//   ADMIN          → sin restricción (isAdmin=true; allowed no se usa).
//   resto de roles → sólo eventos de sus cámaras `canView`.
// A diferencia de las alertas, AnalyticsEvent.cameraId es REQUERIDO (todo evento
// pertenece a una cámara), así que NO hay caso `cameraId=null` visible para todos.
// Fuente de los cameraIds permitidos: getViewableCameraIds (camera-scope.ts).
async function resolveAnalyticsScope(prisma: any, user: { role?: string; sub: string }) {
  const isAdmin = user.role === 'ADMIN'
  const allowed = isAdmin ? [] : await getViewableCameraIds(prisma, user.sub)
  return { isAdmin, allowed }
}

const ANALYTICS_SECRET = process.env.ANALYTICS_SECRET || ''
const UPLOADS_DIR      = process.env.UPLOADS_DIR || '/app/uploads'
// URL del servicio analytics (para proxy de status/frames) y del RTSP de
// MediaMTX visto DESDE el contenedor analytics (red interna de docker)
const ANALYTICS_URL          = process.env.ANALYTICS_URL || 'http://analytics:8500'
const ANALYTICS_MEDIAMTX_RTSP = process.env.ANALYTICS_MEDIAMTX_RTSP || 'rtsp://mediamtx:8554'
const ALPR_ENABLED = process.env.ANALYTICS_ALPR_ENABLED === 'true'
// Por defecto analytics SOLO consume el restream de MediaMTX (una sesión RTSP
// contra el NVR, compartida con live view). El fallback directo al NVR abre
// una segunda sesión que puede tumbar live view — solo con opt-in explícito.
const ALLOW_DIRECT_RTSP = process.env.ANALYTICS_ALLOW_DIRECT_RTSP === 'true'
// TTL del "consumidor analytics" de un path (refrescado en cada poll ~60s).
// Mientras esté vigente, removeStream NO borra el path aunque live view salga.
const ANALYTICS_CONSUMER_TTL_MS = 180_000

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
    // Permanencia: segundos dentro de la zona para disparar LOITERING
    loiteringSec:   z.number().int().min(5).max(3600).optional(),
    // Aforo: más de N objetos dentro dispara OCCUPANCY_LIMIT
    occupancyLimit: z.number().int().min(1).max(500).optional(),
  })).max(10).nullable().optional(),
  // Config de alertas por tipo de evento
  alertConfig: z.record(
    z.enum(['person', 'vehicle', 'zone_intrusion', 'line_crossing', 'loitering', 'occupancy_limit']),
    z.object({
      generateAlert: z.boolean().optional(),
      sendEmail:     z.boolean().optional(),
      severity:      z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
      cooldownSec:   z.number().int().min(5).max(3600).optional(),
    })
  ).nullable().optional(),
  lines: z.array(z.object({
    name:    z.string().min(1).max(60),
    start:   z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    end:     z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    classes: z.array(z.enum(SUPPORTED_CLASSES)).optional(),
  })).max(10).nullable().optional(),
})

const eventSchema = z.object({
  cameraId:   z.string().min(1),
  type:       z.enum(['person', 'vehicle', 'zone_intrusion', 'line_crossing', 'loitering', 'occupancy_limit', 'zone_exit', 'zone_reminder']),
  className:  z.string().min(1).max(40),
  confidence: z.number().min(0).max(1),
  trackId:    z.number().int().optional(),
  zoneName:   z.string().max(60).optional(),
  direction:  z.enum(['in', 'out']).optional(),
  bboxes:     z.array(z.array(z.union([z.number(), z.string()]))).max(64).optional(),
  // Correlaciona entrada/permanencia/salida de un mismo incidente de zona
  incidentId: z.string().max(120).optional(),
  occurredAt: z.string().datetime(),
  // JPEG anotado (cajas dibujadas por supervision), base64 sin prefijo data:
  snapshotJpegBase64: z.string().max(4_000_000).optional(),
})

const ALERT_TYPE_BY_EVENT: Record<string, 'PERSON_DETECTED' | 'VEHICLE_DETECTED' | 'ZONE_INTRUSION' | 'LINE_CROSSING' | 'LOITERING' | 'OCCUPANCY_LIMIT'> = {
  person:          'PERSON_DETECTED',
  vehicle:         'VEHICLE_DETECTED',
  zone_intrusion:  'ZONE_INTRUSION',
  line_crossing:   'LINE_CROSSING',
  loitering:       'LOITERING',
  occupancy_limit: 'OCCUPANCY_LIMIT',
  // zone_reminder reutiliza el tipo de alerta de intrusión (marcado como recordatorio)
  zone_reminder:   'ZONE_INTRUSION',
  zone_exit:       'ZONE_INTRUSION',
}

// Defaults cuando la cámara no tiene alertConfig para ese tipo de evento
const ALERT_DEFAULTS: Record<string, { generateAlert: boolean; sendEmail: boolean; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' }> = {
  person:          { generateAlert: true,  sendEmail: false, severity: 'LOW' },
  vehicle:         { generateAlert: true,  sendEmail: false, severity: 'LOW' },
  zone_intrusion:  { generateAlert: true,  sendEmail: true,  severity: 'HIGH' },
  line_crossing:   { generateAlert: false, sendEmail: false, severity: 'LOW' },
  loitering:       { generateAlert: true,  sendEmail: true,  severity: 'HIGH' },
  occupancy_limit: { generateAlert: true,  sendEmail: true,  severity: 'HIGH' },
  // zone_exit: sólo traza, sin alerta. zone_reminder: alerta de recordatorio
  // (por defecto sin email para no saturar; configurable por cámara).
  zone_exit:       { generateAlert: false, sendEmail: false, severity: 'LOW' },
  zone_reminder:   { generateAlert: true,  sendEmail: false, severity: 'MEDIUM' },
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
  // Promover el registry de consumidores a Redis (sobrevive reinicios y sirve
  // con múltiples workers); memoria como fallback si Redis no está disponible.
  configureStreamConsumerRegistry((server as any).redis ?? null)
  setStreamConsumerLogger({ info: (m) => server.log.info(m) })
  server.log.info(`[analytics] stream_consumer_registry backend=${(server as any).redis ? 'redis' : 'memory'}`)

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

    const result = []
    for (const cfg of configs) {
      const cam = byId.get(cfg.cameraId)
      if (!cam || !cam.nvr.active) continue
      const plainPass = decryptNvrPasswordOrNull(cam.nvr.password)
      if (!plainPass) {
        server.log.warn(`[analytics] decrypt_failed cameraId=${cam.id} nvrId=${cam.nvrId}`)
        continue
      }
      const nvrPlain = { ...cam.nvr, password: plainPass }

      // Regla de arquitectura: analytics consume el RESTREAM de MediaMTX
      // (misma sesión RTSP contra el NVR que la vista en vivo, sourceOnDemand)
      // — nunca una segunda sesión directa que le robe el cupo a live view.
      const streamPath = getStreamPath(nvrPlain as any, cam as any, 'sub')
      try {
        const ok = await publishStream(nvrPlain as any, cam as any, 'sub')
        server.log.info(
          `[analytics] mediamtx_shared_path_${ok ? 'reused' : 'create_failed'} ` +
          `path=${streamPath} cameraId=${cam.id}`
        )
      } catch (err) {
        server.log.warn(`[analytics] mediamtx_shared_path_error path=${streamPath}: ${err}`)
      }

      // Marcar el path como consumido por analytics: mientras esté vigente,
      // removeStream (cleanup de live view) NO lo borra — evita que al salir
      // de live view se caiga el stream que analytics está usando.
      await markAnalyticsConsumer(streamPath, ANALYTICS_CONSUMER_TTL_MS)

      result.push({
        cameraId:         cam.id,
        cameraName:       cam.name,
        nvrName:          cam.nvr.name,
        streamPath,
        // Primario: restream compartido de MediaMTX (una sesión contra el NVR)
        analyticsRtspUrl: `${ANALYTICS_MEDIAMTX_RTSP}/${streamPath}`,
        // Fallback directo al NVR: null salvo opt-in explícito (abre 2ª sesión)
        directRtspUrl:    ALLOW_DIRECT_RTSP ? buildRtspUrl(nvrPlain, cam.channel, true) : null,
        rtspMasked:       buildRtspUrlMasked(nvrPlain, cam.channel, true),
        classes:          cfg.classes,
        minConfidence:    cfg.minConfidence,
        sampleFps:        cfg.sampleFps,
        zones:            cfg.zones,
        lines:            cfg.lines,
        alertConfig:      cfg.alertConfig,
        cooldownSec:      cfg.cooldownSec,
        updatedAt:        cfg.updatedAt.toISOString(),
      })
    }

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
    analyticsEventsTotal.inc({ type: body.type })

    const camera = await server.prisma.camera.findUnique({
      where: { id: body.cameraId }, include: { nvr: true },
    })
    if (!camera) {
      analyticsEventsRejectedTotal.inc({ reason: 'camera_not_found' })
      return reply.status(404).send({ message: 'Cámara no encontrada' })
    }

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

    // Decisión de alerta según la config por cámara/tipo (con defaults:
    // line_crossing es conteo puro, intrusión/loitering/aforo alertan + email)
    const camCfg = await server.prisma.cameraAnalyticsConfig.findUnique({
      where: { cameraId: camera.id },
      select: { alertConfig: true },
    })
    const typeCfg = {
      ...ALERT_DEFAULTS[body.type],
      ...(((camCfg?.alertConfig as any) ?? {})[body.type] ?? {}),
    }

    let alertId: string | null = null
    if (typeCfg.generateAlert) {
      const alertType = ALERT_TYPE_BY_EVENT[body.type]
      const classLabel = CLASS_LABEL_ES[body.className] ?? body.className
      const message =
        body.type === 'zone_intrusion'
          ? `Intrusión en zona "${body.zoneName ?? 'zona'}": ${classLabel.toLowerCase()} en ${camera.name}`
        : body.type === 'loitering'
          ? `Permanencia prolongada en zona "${body.zoneName ?? 'zona'}" de ${camera.name}`
        : body.type === 'occupancy_limit'
          ? `Aforo superado en zona "${body.zoneName ?? 'zona'}" de ${camera.name}`
        : body.type === 'zone_reminder'
          ? `Recordatorio: ${classLabel.toLowerCase()} sigue en zona "${body.zoneName ?? 'zona'}" de ${camera.name}`
        : body.type === 'line_crossing'
          ? `Cruce de línea "${body.zoneName ?? 'línea'}" (${body.direction === 'in' ? 'entrada' : 'salida'}) en ${camera.name}`
          : `${classLabel} detectada en ${camera.name} (${camera.nvr.name})`

      const severity = typeCfg.severity

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
      alertId = alert.id
      analyticsAlertsCreatedTotal.inc({ type: body.type })

      await broadcastAlertScoped(server.prisma, camera.id, {
        type: 'alert',
        alert: {
          id: alert.id, type: alert.type, severity: alert.severity,
          message: alert.message, cameraId: camera.id, nvrName: camera.nvr.name,
          cameraName: camera.name, snapshotUrl, createdAt: alert.createdAt,
        },
      })

      if (typeCfg.sendEmail) {
        sendAlertNotification(server.prisma, {
          id: alert.id, type: alert.type, severity: alert.severity,
          message: alert.message, detail: alert.detail,
          cameraId: alert.cameraId, nvrId: alert.nvrId,
        }).catch((e) => server.log.error(`[analytics] email_failed: ${e}`))
      }
    }

    const event = await server.prisma.analyticsEvent.create({
      data: {
        cameraId:   camera.id,
        type:       body.type,
        className:  body.className,
        confidence: body.confidence,
        trackId:    body.trackId ?? null,
        zoneName:   body.zoneName ?? null,
        direction:  body.direction ?? null,
        incidentId: body.incidentId ?? null,
        bboxes:     body.bboxes ?? undefined,
        snapshotUrl,
        alertId,
        occurredAt: new Date(body.occurredAt),
      },
    })

    server.log.info(
      `[analytics] event_received cameraId=${camera.id} type=${body.type}` +
      ` class=${body.className} conf=${body.confidence.toFixed(2)}` +
      ` zone=${body.zoneName ?? 'none'} direction=${body.direction ?? 'none'}`
    )
    return reply.send({ ok: true, eventId: event.id, alertId })
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
      lines:         body.lines ?? undefined,
      alertConfig:   body.alertConfig ?? undefined,
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
      zoneName?: string; direction?: string; incidentId?: string
      hasSnapshot?: string; order?: string; minConfidence?: string
      from?: string; to?: string; page?: string; limit?: string
    }
    const where: any = {}
    // RBAC (DEV15): un no-admin sólo ve eventos de sus cámaras `canView`. El scope
    // se AND-ea con el resto de filtros; si pidió ?cameraId=<ajena> la intersección
    // queda vacía ⇒ resultado vacío (mismo comportamiento que el listado de alertas).
    const { isAdmin, allowed } = await resolveAnalyticsScope(server.prisma, request.user)
    if (!isAdmin) where.cameraId = { in: allowed }
    if (q.cameraId) {
      // Intersección con el scope: si ya hay filtro de scope, sólo pasa si la
      // cámara pedida está permitida (para no-admin), si no ⇒ conjunto vacío.
      if (isAdmin) where.cameraId = q.cameraId
      else where.cameraId = { in: allowed.includes(q.cameraId) ? [q.cameraId] : [] }
    }
    if (q.type) where.type = q.type
    if (q.className) where.className = q.className
    if (q.zoneName) where.zoneName = { contains: q.zoneName, mode: 'insensitive' }
    if (q.direction) where.direction = q.direction
    if (q.incidentId) where.incidentId = q.incidentId
    // hasSnapshot=true → sólo eventos con imagen (para el módulo Snapshots)
    if (q.hasSnapshot === 'true') where.snapshotUrl = { not: null }
    if (q.minConfidence) {
      const mc = parseFloat(q.minConfidence)
      if (!isNaN(mc)) where.confidence = { gte: mc }
    }
    if (q.from || q.to) {
      where.occurredAt = {}
      if (q.from) where.occurredAt.gte = new Date(q.from)
      if (q.to)   where.occurredAt.lte = new Date(q.to)
    }
    const page  = Math.max(1, parseInt(q.page ?? '1'))
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '50')))
    const order: 'asc' | 'desc' = q.order === 'asc' ? 'asc' : 'desc'

    const [events, total] = await Promise.all([
      server.prisma.analyticsEvent.findMany({
        where, orderBy: { occurredAt: order },
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

  // Resumen para dashboard GLOBAL, filtrable por múltiples dimensiones.
  // Acepta arrays (repetidos ?x=a&x=b o separados por coma) validados con Zod.
  // NO construye SQL con strings: usa where de Prisma y Prisma.sql/Prisma.join
  // (todo parametrizado) para la serie temporal con granularidad + timezone.
  server.get('/summary', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const raw = request.query as Record<string, unknown>
    const toArr = (v: unknown): string[] =>
      v == null ? []
      : (Array.isArray(v) ? v : [v]).flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean)

    const opts = z.object({
      from:        z.string().optional(),
      to:          z.string().optional(),
      granularity: z.enum(['5min', 'hour', 'day', 'week']).default('hour'),
      timezone:    z.string().max(64).default('America/Asuncion'),
    }).parse(raw)

    const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const to   = opts.to   ? new Date(opts.to)   : new Date()
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
      return reply.status(400).send({ code: 'INVALID_RANGE', message: 'Rango de fechas inválido' })
    }

    const nvrIds      = toArr(raw.nvrIds)
    const cameraIds   = toArr(raw.cameraIds)
    const types       = toArr(raw.types)
    const classNames  = toArr(raw.classNames)
    const zoneNames   = toArr(raw.zoneNames)
    const directions  = toArr(raw.directions).filter(d => d === 'in' || d === 'out')

    // nvrIds → cameraIds (los eventos no guardan nvrId). NVR y cámara se
    // INTERSECAN: elegir un NVR y luego una cámara dentro debe acotar a esa
    // cámara, no devolver todo el NVR. (unión daría el NVR completo.)
    let cameraFilter: string[] = []
    if (nvrIds.length > 0) {
      const nvrCams = await server.prisma.camera.findMany({
        where: { nvrId: { in: nvrIds } }, select: { id: true },
      })
      const nvrCamIds = nvrCams.map(c => c.id)
      cameraFilter = cameraIds.length > 0
        ? nvrCamIds.filter(id => cameraIds.includes(id))   // intersección
        : nvrCamIds
    } else {
      cameraFilter = [...cameraIds]
    }

    // Si se pidió filtro de cámara/NVR pero la intersección quedó vacía, el filtro
    // sigue "activo": debe devolver 0 resultados, no todo (cameraId IN []).
    let cameraFilterActive = nvrIds.length > 0 || cameraIds.length > 0

    // RBAC (DEV15): un no-admin NO ve todas las cámaras — su scope efectivo es su
    // set `canView`. Sin filtro explícito ⇒ el filtro base es su canView; con filtro
    // (nvrIds/cameraIds) ⇒ INTERSECCIÓN de lo pedido con su canView. ADMIN: sin cambios.
    const { isAdmin, allowed } = await resolveAnalyticsScope(server.prisma, request.user)
    if (!isAdmin) {
      cameraFilter = cameraFilterActive
        ? cameraFilter.filter(id => allowed.includes(id))   // intersección con canView
        : [...allowed]                                       // sin filtro ⇒ sólo canView
      cameraFilterActive = true   // el no-admin queda SIEMPRE scopeado por cámara
    }

    const where: any = { occurredAt: { gte: from, lte: to } }
    if (cameraFilterActive) where.cameraId = { in: cameraFilter }
    if (types.length)       where.type      = { in: types }
    if (classNames.length)  where.className = { in: classNames }
    if (zoneNames.length)   where.zoneName  = { in: zoneNames }
    if (directions.length)  where.direction = { in: directions }

    // Line counts: sólo si el filtro de tipo lo permite (sin filtro o incluye
    // line_crossing). Si el usuario filtró por otro tipo, no filtrar líneas de él.
    const includeLines = types.length === 0 || types.includes('line_crossing')

    const [byType, byCamera, byClass, totalEvents, lineCrossings] = await Promise.all([
      server.prisma.analyticsEvent.groupBy({ by: ['type'], where, _count: { _all: true } }),
      server.prisma.analyticsEvent.groupBy({ by: ['cameraId'], where, _count: { _all: true } }),
      server.prisma.analyticsEvent.groupBy({ by: ['className'], where, _count: { _all: true } }),
      server.prisma.analyticsEvent.count({ where }),
      includeLines
        ? server.prisma.analyticsEvent.groupBy({
            by: ['cameraId', 'zoneName', 'direction'],
            where: { ...where, type: 'line_crossing' },
            _count: { _all: true },
          })
        : Promise.resolve([] as any[]),
    ])

    const camIds = byCamera.map(c => c.cameraId)
    const cams = camIds.length > 0
      ? await server.prisma.camera.findMany({ where: { id: { in: camIds } }, select: { id: true, name: true } })
      : []
    const nameById = new Map(cams.map(c => [c.id, c.name]))
    const countByType = new Map(byType.map(t => [t.type, t._count._all]))
    const sum = (...keys: string[]) => keys.reduce((n, k) => n + (countByType.get(k) ?? 0), 0)

    // KPIs derivados
    const kpis = {
      totalEvents,                    // eventos brutos (una detección/regla = 1)
      uniqueIncidents: 0,             // incidentes únicos (distinct incidentId) — se llena abajo
      uniqueTracks:    0,             // objetos únicos (distinct trackId) — se llena abajo
      persons:     sum('person'),
      vehicles:    sum('vehicle'),
      intrusions:  sum('zone_intrusion'),
      loitering:   sum('loitering'),
      occupancy:   sum('occupancy_limit'),
      lineCrossings: sum('line_crossing'),
      activeCameras: byCamera.length,
    }

    // Serie temporal con granularidad + timezone. Bucket y filtros vía Prisma.sql
    // (parametrizados — sin concatenar strings). date_trunc admite el nombre como
    // parámetro; 5min se calcula por epoch.
    const conds: Prisma.Sql[] = [Prisma.sql`"occurredAt" >= ${from}`, Prisma.sql`"occurredAt" <= ${to}`]
    // Filtro de cámara activo con intersección vacía → FALSE (0 filas), no IN ()
    if (cameraFilterActive) {
      conds.push(cameraFilter.length
        ? Prisma.sql`"cameraId" IN (${Prisma.join(cameraFilter)})`
        : Prisma.sql`FALSE`)
    }
    if (types.length)        conds.push(Prisma.sql`"type" IN (${Prisma.join(types)})`)
    if (classNames.length)   conds.push(Prisma.sql`"className" IN (${Prisma.join(classNames)})`)
    if (zoneNames.length)    conds.push(Prisma.sql`"zoneName" IN (${Prisma.join(zoneNames)})`)
    if (directions.length)   conds.push(Prisma.sql`"direction" IN (${Prisma.join(directions)})`)
    const whereSql = Prisma.join(conds, ' AND ')
    // occurredAt es 'timestamp without time zone' con el instante en UTC. Para
    // agrupar por hora/día en la timezone pedida hay que PRIMERO marcarlo como UTC
    // (→ timestamptz) y LUEGO convertirlo a la zona destino. Un solo AT TIME ZONE
    // interpretaría el valor como si ya estuviera en esa zona → hora/día erróneos.
    const bucketExpr = opts.granularity === '5min'
      ? Prisma.sql`to_timestamp(floor(extract(epoch from ("occurredAt" AT TIME ZONE 'UTC')) / 300) * 300)`
      : Prisma.sql`date_trunc(${opts.granularity}, ("occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${opts.timezone})`
    const series = await server.prisma.$queryRaw<{ bucket: Date; count: bigint }[]>(
      Prisma.sql`SELECT ${bucketExpr} AS bucket, COUNT(*)::bigint AS count
                 FROM "analytics_events" WHERE ${whereSql} GROUP BY 1 ORDER BY 1`
    )

    // Métricas NO duplicadas: un mismo objeto genera varios eventos (vehicle +
    // zone_intrusion + zone_reminder + zone_exit). Estas cuentan objetos/incidentes
    // ÚNICOS, no eventos brutos, para que el operador no confunda 196 eventos de
    // intrusión con 196 objetos distintos.
    // trackId es LOCAL por cámara (cada CameraWorker tiene su propio ByteTrack),
    // así que dos cámaras pueden compartir trackId=1 siendo objetos distintos →
    // se cuenta por el par (cameraId, trackId). El CASE excluye eventos sin track
    // (trackId NULL) para no inflar el conteo. incidentId ya es global (incluye
    // cameraId), por eso se cuenta directo.
    const [distinct] = await server.prisma.$queryRaw<{ inc: bigint; trk: bigint }[]>(
      Prisma.sql`SELECT COUNT(DISTINCT "incidentId")::bigint AS inc,
                        COUNT(DISTINCT CASE WHEN "trackId" IS NOT NULL THEN ("cameraId", "trackId") END)::bigint AS trk
                 FROM "analytics_events" WHERE ${whereSql}`
    )
    kpis.uniqueIncidents = Number(distinct?.inc ?? 0)
    kpis.uniqueTracks    = Number(distinct?.trk ?? 0)

    // Comparación con el periodo ANTERIOR (misma duración y mismos filtros).
    const periodMs = to.getTime() - from.getTime()
    const prevFrom = new Date(from.getTime() - periodMs)
    const prevWhere = { ...where, occurredAt: { gte: prevFrom, lt: from } }
    const previousTotal = await server.prisma.analyticsEvent.count({ where: prevWhere })
    const comparison = {
      previousTotal,
      delta: totalEvents - previousTotal,
      deltaPct: previousTotal > 0 ? Math.round(((totalEvents - previousTotal) / previousTotal) * 100) : null,
    }

    // Mapa de calor día-de-semana (0=domingo) × hora (0-23) en la timezone pedida.
    // Mismo cuidado de timezone que la serie: marcar UTC y luego convertir a la
    // zona destino antes de extraer día/hora (occurredAt es timestamp sin tz, UTC).
    const heatmapRows = await server.prisma.$queryRaw<{ dow: number; hour: number; count: bigint }[]>(
      Prisma.sql`SELECT extract(dow  from ("occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${opts.timezone})::int AS dow,
                        extract(hour from ("occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${opts.timezone})::int AS hour,
                        COUNT(*)::bigint AS count
                 FROM "analytics_events" WHERE ${whereSql} GROUP BY 1, 2`
    )
    const heatmap = heatmapRows.map(r => ({ dow: Number(r.dow), hour: Number(r.hour), count: Number(r.count) }))

    return reply.send({
      comparison, heatmap,
      from: from.toISOString(), to: to.toISOString(),
      granularity: opts.granularity, timezone: opts.timezone,
      filters: { nvrIds, cameraIds, types, classNames, zoneNames, directions },
      kpis, totalEvents,
      byType:   byType.map(t => ({ type: t.type, count: t._count._all })),
      byClass:  byClass.map(c => ({ className: c.className, count: c._count._all })).sort((a, b) => b.count - a.count),
      byCamera: byCamera
        .map(c => ({ cameraId: c.cameraId, cameraName: nameById.get(c.cameraId) ?? 'Desconocida', count: c._count._all }))
        .sort((a, b) => b.count - a.count),
      lineCounts: lineCrossings.map(l => ({
        cameraId:   l.cameraId,
        cameraName: nameById.get(l.cameraId) ?? 'Desconocida',
        lineName:   l.zoneName ?? 'línea',
        direction:  l.direction ?? '—',
        count:      l._count._all,
      })),
      // Serie temporal (reemplaza byHour; el frontend agrupa según granularity)
      series: series.map(r => ({ bucket: r.bucket.toISOString(), count: Number(r.count) })),
    })
  })

  // ── Observabilidad: proxy al servicio Python ─────────────────────────────

  // GET /api/analytics/service-status — estado agregado del contenedor
  // analytics. Devuelve SOLO campos seguros (nunca secretos ni URLs RTSP).
  server.get('/service-status', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (_request, reply) => {
    try {
      const res = await fetch(`${ANALYTICS_URL}/status`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) {
        return reply.send({ connected: false, error: `HTTP ${res.status}` })
      }
      const s = (await res.json()) as {
        serviceStatus?: string; modelLoaded?: boolean; modelError?: string | null
        lastRefreshError?: string | null
        dependenciesLoaded?: boolean; importError?: string | null; configError?: string | null
        provider?: string | null; hint?: string | null
        bootStartedAt?: string | null; lastBootAt?: string | null
        workers?: Array<{ status: string; framesProcessed?: number; eventsSent?: number }>
      }
      const workers = Array.isArray(s.workers) ? s.workers : []
      const workersRunning = workers.filter(w => w.status === 'running').length
      const workersError = workers.filter(w =>
        w.status === 'disabled_due_errors' || w.status === 'rtsp_down' || w.status === 'reconnecting'
      ).length
      const framesProcessed = workers.reduce((n, w) => n + (w.framesProcessed ?? 0), 0)
      const eventsSent = workers.reduce((n, w) => n + (w.eventsSent ?? 0), 0)
      // Lista por worker sin datos sensibles (nombre y estado ya son seguros)
      const workerSummaries = workers.map((w: any) => ({
        cameraId: w.cameraId, cameraName: w.cameraName, status: w.status,
        fpsActual: w.fpsActual, framesProcessed: w.framesProcessed, eventsSent: w.eventsSent,
        usingFallback: w.usingFallback, lastError: w.lastError,
        zoneOccupancy: w.zoneOccupancy, lineCounts: w.lineCounts,
      }))
      return reply.send({
        connected: true,
        serviceStatus: s.serviceStatus ?? 'unknown',
        modelLoaded: Boolean(s.modelLoaded),
        modelError: s.modelError ?? null,
        // Diagnóstico granular (nunca secretos): permite a la UI distinguir
        // servicio conectado / dependencias / modelo / workers.
        dependenciesLoaded: s.dependenciesLoaded ?? null,
        importError: s.importError ?? null,
        configError: s.configError ?? null,
        provider: s.provider ?? null,
        hint: s.hint ?? null,
        bootStartedAt: s.bootStartedAt ?? null,
        lastBootAt: s.lastBootAt ?? null,
        lastRefreshError: s.lastRefreshError ?? null,
        workersRunning,
        workersError,
        framesProcessed,
        eventsSent,
        workers: workerSummaries,
      })
    } catch (err: any) {
      return reply.send({ connected: false, error: err?.message ?? 'sin conexión al servicio analytics' })
    }
  })

  // GET /api/analytics/live-frame/:cameraId — último frame anotado (JPEG)
  // Contrato de estados (para que el frontend no trate "aún sin frame" como error):
  //   200 image/jpeg  frame disponible
  //   204 No Content  worker activo pero sin frame anotado todavía
  //   404             cámara sin config de analítica / sin worker
  //   409             analítica deshabilitada para esa cámara
  //   503             servicio Analytics desconectado o arrancando
  server.get('/live-frame/:cameraId', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { cameraId } = request.params as { cameraId: string }
    // RBAC (DEV15): un no-admin sólo puede ver el frame de una cámara con `canView`.
    // Se comprueba ANTES de tocar config/servicio para no filtrar estado de cámaras
    // ajenas (un 409/404 revelaría su existencia/estado de analítica).
    const { isAdmin, allowed } = await resolveAnalyticsScope(server.prisma, request.user)
    if (!isAdmin && !allowed.includes(cameraId)) {
      return reply.status(403).send({ message: 'Sin permiso para esta cámara' })
    }
    // 409 si la analítica está deshabilitada para la cámara (evita polling inútil)
    const cfg = await server.prisma.cameraAnalyticsConfig.findUnique({
      where: { cameraId }, select: { enabled: true },
    })
    if (cfg && cfg.enabled === false) {
      return reply.status(409).send({ message: 'Analítica deshabilitada para esta cámara' })
    }
    try {
      const res = await fetch(`${ANALYTICS_URL}/frame/${encodeURIComponent(cameraId)}`, {
        signal: AbortSignal.timeout(4000),
      })
      // Propagar el contrato del servicio Python tal cual (204/404/503)
      if (res.status === 204) return reply.status(204).send()
      if (res.status === 404) return reply.status(404).send({ message: 'Sin worker para esta cámara' })
      if (res.status === 503) return reply.status(503).send({ message: 'Servicio de analítica arrancando' })
      if (!res.ok) return reply.status(503).send({ message: 'Servicio de analítica no disponible' })
      const buf = Buffer.from(await res.arrayBuffer())
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(buf)
    } catch {
      return reply.status(503).send({ message: 'Servicio de analítica no disponible' })
    }
  })

  // ── ALPR (matrículas) — scaffold detrás de feature flag ─────────────────
  // El detector COCO NO lee chapas: esto queda preparado para un módulo ALPR
  // dedicado (modelo ONNX con licencia permisiva) cuando se habilite.

  server.post('/internal/plates', {
    preHandler: [requireAnalyticsSecret],
    bodyLimit: 6 * 1024 * 1024,
  }, async (request, reply) => {
    if (!ALPR_ENABLED) return reply.status(503).send({ message: 'ALPR deshabilitado (ANALYTICS_ALPR_ENABLED=false)' })
    const body = z.object({
      cameraId:        z.string().min(1),
      plateText:       z.string().min(2).max(16),
      plateConfidence: z.number().min(0).max(1),
      occurredAt:      z.string().datetime(),
      plateCropSnapshotUrl: z.string().max(300).optional(),
      fullSnapshotUrl:      z.string().max(300).optional(),
    }).parse(request.body)
    const event = await server.prisma.licensePlateEvent.create({
      data: { ...body, occurredAt: new Date(body.occurredAt) },
    })
    return reply.send({ ok: true, id: event.id })
  })

  // Búsqueda por chapa parcial (case-insensitive)
  server.get('/plates', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const q = request.query as { q?: string; cameraId?: string; from?: string; to?: string; limit?: string }
    const where: any = {}
    if (q.q) where.plateText = { contains: q.q.toUpperCase(), mode: 'insensitive' }
    if (q.cameraId) where.cameraId = q.cameraId
    if (q.from || q.to) {
      where.occurredAt = {}
      if (q.from) where.occurredAt.gte = new Date(q.from)
      if (q.to)   where.occurredAt.lte = new Date(q.to)
    }
    const plates = await server.prisma.licensePlateEvent.findMany({
      where, orderBy: { occurredAt: 'desc' },
      take: Math.min(200, parseInt(q.limit ?? '50')),
    })
    return reply.send({ plates, alprEnabled: ALPR_ENABLED })
  })
}
