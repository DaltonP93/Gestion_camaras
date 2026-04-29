// apps/api/src/routes/cameras.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { publishStream, getStreamPath, getHlsUrl, getWebRtcUrl, getStreamStatus } from '../services/stream'
import { captureSnapshot, sendPTZCommand, type PTZCommand } from '../services/hikvision'
import { AuditAction } from '../services/audit'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

const cameraUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  location: z.string().optional(),
  ptzEnabled: z.boolean().optional(),
  active: z.boolean().optional(),
})

const ptzSchema = z.object({
  command: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT', 'ZOOM_IN', 'ZOOM_OUT', 'STOP']),
  speed: z.number().min(1).max(100).default(50),
})

export const cameraRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/cameras — Listar cámaras (filtradas por permisos)
  server.get('/', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const user = request.user
    const { nvrId } = request.query as { nvrId?: string }

    let cameras
    if (['ADMIN', 'SUPERVISOR'].includes(user.role)) {
      cameras = await server.prisma.camera.findMany({
        where: nvrId ? { nvrId } : {},
        include: { nvr: { select: { id: true, name: true, ipAddress: true } } },
        orderBy: [{ nvrId: 'asc' }, { channel: 'asc' }],
      })
    } else {
      const perms = await server.prisma.userPermission.findMany({
        where: { userId: user.sub, cameraId: { not: null }, canView: true },
        select: { cameraId: true },
      })
      const cameraIds = perms.map((p) => p.cameraId!).filter(Boolean)

      cameras = await server.prisma.camera.findMany({
        where: {
          id: { in: cameraIds },
          ...(nvrId ? { nvrId } : {}),
        },
        include: { nvr: { select: { id: true, name: true, ipAddress: true } } },
        orderBy: [{ nvrId: 'asc' }, { channel: 'asc' }],
      })
    }

    return reply.send(cameras)
  })

  // GET /api/cameras/:id/stream — Obtener URLs de streaming
  server.get('/:id/stream', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user

    const camera = await server.prisma.camera.findUnique({
      where: { id },
      include: { nvr: true },
    })

    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    // Auditor no puede ver streams en vivo
    if (user.role === 'AUDITOR') {
      return reply.status(403).send({ message: 'Acceso denegado: rol auditor no puede ver streams en vivo' })
    }

    // Verificar permiso para operador
    if (user.role === 'OPERATOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: id, canView: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso para esta cámara' })
    }

    // Publicar el stream en MediaMTX si no existe
    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    await publishStream(nvr as any, camera)

    const streamPath = getStreamPath(camera.nvr, camera)

    await AuditAction(server.prisma, user.sub, 'VIEW_CAMERA', id, request, {
      cameraName: camera.name,
      nvrName: camera.nvr.name,
    })

    return reply.send({
      cameraId: id,
      streamPath,
      hls: getHlsUrl(streamPath),
      webrtc: getWebRtcUrl(streamPath),
      channel: camera.channel,
      nvrName: camera.nvr.name,
    })
  })

  // GET /api/cameras/:id/stream/status — Estado del stream
  server.get('/:id/stream/status', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const camera = await server.prisma.camera.findUnique({
      where: { id },
      include: { nvr: true },
    })

    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const streamPath = getStreamPath(camera.nvr, camera)
    const status = await getStreamStatus(streamPath)

    return reply.send({ ...status, streamPath })
  })

  // GET /api/cameras/:id/snapshot — Capturar imagen
  server.get('/:id/snapshot', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const camera = await server.prisma.camera.findUnique({
      where: { id },
      include: { nvr: true },
    })

    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const snapshot = await captureSnapshot(nvr as any, camera.channel)

    if (!snapshot) {
      return reply.status(503).send({ message: 'No se pudo capturar imagen' })
    }

    reply.header('Content-Type', 'image/jpeg')
    return reply.send(snapshot)
  })

  // POST /api/cameras/:id/ptz — Control PTZ
  server.post('/:id/ptz', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { command, speed } = ptzSchema.parse(request.body)
    const user = request.user

    const camera = await server.prisma.camera.findUnique({
      where: { id },
      include: { nvr: true },
    })

    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })
    if (!camera.ptzEnabled) return reply.status(400).send({ message: 'PTZ no habilitado en esta cámara' })

    // Verificar permiso PTZ para operador
    if (user.role === 'OPERATOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: id, canPtz: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso PTZ para esta cámara' })
    }

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const ok = await sendPTZCommand(nvr as any, camera.channel, command as PTZCommand, speed)

    await AuditAction(server.prisma, user.sub, 'PTZ_COMMAND', id, request, { command, speed })

    return reply.send({ success: ok, command })
  })

  // PUT /api/cameras/:id — Actualizar datos de cámara (ADMIN/SUPERVISOR)
  server.put('/:id', {
    preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = cameraUpdateSchema.parse(request.body)

    const camera = await server.prisma.camera.update({
      where: { id },
      data,
    })

    return reply.send(camera)
  })
}
