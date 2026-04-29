// apps/api/src/routes/recordings.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { searchRecordings, getPlaybackUrl } from '../services/hikvision'
import { AuditAction } from '../services/audit'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

const searchSchema = z.object({
  cameraId: z.string().min(1),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
})

const playbackSchema = z.object({
  cameraId: z.string().min(1),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
})

export const recordingRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/recordings/search — Buscar grabaciones
  server.get('/search', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const user = request.user
    const query = searchSchema.parse(request.query)

    // Operador no puede ver grabaciones
    if (user.role === 'OPERATOR') {
      return reply.status(403).send({ message: 'Sin acceso a grabaciones' })
    }

    const camera = await server.prisma.camera.findUnique({
      where: { id: query.cameraId },
      include: { nvr: true },
    })

    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    // Auditor: verificar permiso granular
    if (user.role === 'AUDITOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: query.cameraId, canPlayback: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso para grabaciones de esta cámara' })
    }

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const recordings = await searchRecordings(
      nvr as any,
      camera.channel,
      new Date(query.startTime),
      new Date(query.endTime)
    )

    await AuditAction(server.prisma, user.sub, 'SEARCH_RECORDINGS', query.cameraId, request, {
      startTime: query.startTime,
      endTime: query.endTime,
      resultsCount: recordings.length,
    })

    return reply.send({ recordings, camera: { id: camera.id, name: camera.name, channel: camera.channel } })
  })

  // POST /api/recordings/playback — Obtener URL de reproducción
  server.post('/playback', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const user = request.user
    const body = playbackSchema.parse(request.body)

    if (user.role === 'OPERATOR') {
      return reply.status(403).send({ message: 'Sin acceso a grabaciones' })
    }

    const camera = await server.prisma.camera.findUnique({
      where: { id: body.cameraId },
      include: { nvr: true },
    })

    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    if (user.role === 'AUDITOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: body.cameraId, canPlayback: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso de reproducción' })
    }

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const playback = await getPlaybackUrl(
      nvr as any,
      camera.channel,
      new Date(body.startTime),
      new Date(body.endTime)
    )

    await AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
      startTime: body.startTime,
      endTime: body.endTime,
    })

    return reply.send(playback)
  })

  // GET /api/recordings/audit — Log de accesos a grabaciones (solo ADMIN)
  server.get('/audit', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { page = '1', limit = '50' } = request.query as { page?: string; limit?: string }

    const logs = await server.prisma.auditLog.findMany({
      where: {
        action: { in: ['VIEW_RECORDING', 'SEARCH_RECORDINGS'] },
      },
      include: { user: { select: { username: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
    })

    const total = await server.prisma.auditLog.count({
      where: { action: { in: ['VIEW_RECORDING', 'SEARCH_RECORDINGS'] } },
    })

    return reply.send({ logs, total, page: parseInt(page), limit: parseInt(limit) })
  })
}
