// apps/api/src/routes/cameras.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { publishStream, removeStream, getStreamPath, getHlsUrl, getWebRtcUrl, getStreamStatus } from '../services/stream'
import { startStream, stopStream, touchSession, cleanupUserSessions, getAdminSessionsSummary } from '../services/stream-manager'
import { captureSnapshot, sendPTZCommand, buildRtspUrl, buildRtspUrlMasked, type PTZCommand } from '../services/hikvision'
import { probeRtspStream, probeBothStreams } from '../services/rtsp-probe'
import { validateAndUpdateCameraHealth } from '../services/stream-validator'
import { AuditAction } from '../services/audit'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

const cameraUpdateSchema = z.object({
  name:          z.string().min(1).max(100).optional(),
  location:      z.string().optional(),
  ptzEnabled:    z.boolean().optional(),
  active:        z.boolean().optional(),
  preferredStream: z.enum(['main', 'sub']).optional(),
})

const ptzSchema = z.object({
  command: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT', 'ZOOM_IN', 'ZOOM_OUT', 'STOP']),
  speed:   z.number().min(1).max(100).default(50),
})

async function userCanAccessCamera(
  prisma: any, userId: string, role: string, cameraId: string,
  permission: 'canView' | 'canPtz' | 'canPlayback' = 'canView'
): Promise<boolean> {
  if (role === 'ADMIN' || role === 'SUPERVISOR') return true
  const perm = await prisma.userPermission.findFirst({
    where: { userId, cameraId, [permission]: true },
    select: { id: true },
  })
  return !!perm
}

export const cameraRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/cameras — Listar cámaras
  server.get('/', { preHandler: [server.authenticate] }, async (request, reply) => {
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
      const cameraIds = perms.map((p: any) => p.cameraId!).filter(Boolean)
      cameras = await server.prisma.camera.findMany({
        where: { id: { in: cameraIds }, ...(nvrId ? { nvrId } : {}) },
        include: { nvr: { select: { id: true, name: true, ipAddress: true } } },
        orderBy: [{ nvrId: 'asc' }, { channel: 'asc' }],
      })
    }

    return reply.send(cameras)
  })

  // GET /api/cameras/:id/stream — Obtener URLs de streaming
  server.get('/:id/stream', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })
    if (user.role === 'AUDITOR') return reply.status(403).send({ message: 'Acceso denegado' })
    if (!await userCanAccessCamera(server.prisma, user.sub, user.role, id)) {
      return reply.status(403).send({ message: 'Sin permiso para esta cámara' })
    }

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    await publishStream(nvr as any, camera)

    const streamPath = getStreamPath(camera.nvr, camera)

    await AuditAction(server.prisma, user.sub, 'VIEW_CAMERA', id, request, {
      cameraName: camera.name, nvrName: camera.nvr.name,
    })

    return reply.send({
      cameraId:   id,
      streamPath,
      hls:        getHlsUrl(streamPath),
      webrtc:     getWebRtcUrl(streamPath),
      channel:    camera.channel,
      nvrName:    camera.nvr.name,
    })
  })

  // GET /api/cameras/:id/stream/status
  server.get('/:id/stream/status', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })
    if (!await userCanAccessCamera(server.prisma, user(request).sub, user(request).role, id)) {
      return reply.status(403).send({ message: 'Sin permiso' })
    }
    const streamPath = getStreamPath(camera.nvr, camera)
    const status = await getStreamStatus(streamPath)
    return reply.send({ ...status, streamPath })
  })

  // GET /api/cameras/:id/diagnostics — Diagnóstico completo por capas
  server.get('/:id/diagnostics', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })
    if (!await userCanAccessCamera(server.prisma, user.sub, user.role, id)) {
      return reply.status(403).send({ message: 'Sin permiso' })
    }

    const nvr = camera.nvr
    const plainPass = decryptPass(nvr.password)
    const nvrDecrypted = { ...nvr, password: plainPass }

    const streamPath = getStreamPath(nvr, camera)
    const hlsUrl     = getHlsUrl(streamPath)

    // 1. Estado HTTP del NVR (ya lo tenemos en DB)
    const nvrOnlineHttp = nvr.online

    // 2. Estado del stream en MediaMTX
    const mediamtxStatus = await getStreamStatus(streamPath)

    // 3. Probe RTSP (ambos streams)
    const rtsp = await probeBothStreams(nvrDecrypted, camera.channel)

    // 4. Guardar resultado en DB
    await server.prisma.camera.update({
      where: { id },
      data: {
        rtspMainOk:     rtsp.main.ok,
        rtspSubOk:      rtsp.sub.ok,
        lastRtspCheckAt: new Date(),
        lastRtspError:  rtsp.sub.ok ? null : (rtsp.sub.error || rtsp.main.error || null),
        mainCodec:      rtsp.main.codec || camera.mainCodec,
        subCodec:       rtsp.sub.codec  || camera.subCodec,
        mainResolution: rtsp.main.width ? `${rtsp.main.width}x${rtsp.main.height}` : camera.mainResolution,
        subResolution:  rtsp.sub.width  ? `${rtsp.sub.width}x${rtsp.sub.height}`   : camera.subResolution,
        mainFps:        rtsp.main.fps || camera.mainFps,
        subFps:         rtsp.sub.fps  || camera.subFps,
      },
    })

    return reply.send({
      cameraId:  id,
      cameraName: camera.name,
      channelCode: camera.channelCode || `D${camera.channel}`,
      nvr: {
        id:         nvr.id,
        name:       nvr.name,
        onlineHttp: nvrOnlineHttp,
        lastSeen:   nvr.lastSeen,
      },
      camera: {
        channelNumber:    camera.channel,
        name:             camera.name,
        ipAddress:        camera.ipAddress,
        protocol:         camera.protocol,
        onlineInNvr:      camera.online,
        preferredStream:  camera.preferredStream,
      },
      rtsp: {
        mainUrlMasked:  buildRtspUrlMasked(nvrDecrypted, camera.channel, false),
        subUrlMasked:   buildRtspUrlMasked(nvrDecrypted, camera.channel, true),
        mainOk:         rtsp.main.ok,
        subOk:          rtsp.sub.ok,
        mainError:      rtsp.main.error,
        subError:       rtsp.sub.error,
        preferred:      camera.preferredStream || 'sub',
        mainCodec:      rtsp.main.codec,
        subCodec:       rtsp.sub.codec,
        mainResolution: rtsp.main.width ? `${rtsp.main.width}x${rtsp.main.height}` : null,
        subResolution:  rtsp.sub.width  ? `${rtsp.sub.width}x${rtsp.sub.height}`   : null,
        mainFps:        rtsp.main.fps,
        subFps:         rtsp.sub.fps,
        mainLatencyMs:  rtsp.main.latencyMs,
        subLatencyMs:   rtsp.sub.latencyMs,
      },
      mediaServer: {
        provider:   'mediamtx',
        route:      streamPath,
        routeExists: true,
        ready:      mediamtxStatus.active,
        readers:    mediamtxStatus.readers,
      },
      frontend: {
        hlsUrl,
        webrtcUrl: getWebRtcUrl(streamPath),
      },
    })
  })

  // POST /api/cameras/:id/restart-stream — Reiniciar stream en MediaMTX
  server.post('/:id/restart-stream', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }

    // Eliminar y re-crear el path en MediaMTX
    await removeStream(camera.nvr, camera)
    await new Promise(r => setTimeout(r, 500))
    const ok = await publishStream(nvr as any, camera)

    return reply.send({ success: ok, streamPath: getStreamPath(camera.nvr, camera) })
  })

  // POST /api/cameras/:id/test-rtsp — Probar RTSP de una cámara específica
  server.post('/:id/test-rtsp', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { stream = 'sub' } = request.body as { stream?: 'main' | 'sub' }

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const rtspUrl = buildRtspUrl(nvr as any, camera.channel, stream === 'sub')
    const result  = await probeRtspStream(rtspUrl)

    return reply.send({
      ...result,
      stream,
      urlMasked: buildRtspUrlMasked(nvr as any, camera.channel, stream === 'sub'),
    })
  })

  // GET /api/cameras/:id/snapshot
  server.get('/:id/snapshot', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })
    if (user.role === 'AUDITOR') return reply.status(403).send({ message: 'Acceso denegado' })
    if (!await userCanAccessCamera(server.prisma, user.sub, user.role, id)) {
      return reply.status(403).send({ message: 'Sin permiso' })
    }

    const nvr      = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const snapshot = await captureSnapshot(nvr as any, camera.channel)
    if (!snapshot) return reply.status(503).send({ message: 'No se pudo capturar imagen' })

    await AuditAction(server.prisma, user.sub, 'SNAPSHOT', id, request, { cameraName: camera.name })
    reply.header('Content-Type', 'image/jpeg')
    return reply.send(snapshot)
  })

  // POST /api/cameras/:id/ptz
  server.post('/:id/ptz', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { command, speed } = ptzSchema.parse(request.body)
    const user = request.user

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })
    if (!camera.ptzEnabled) return reply.status(400).send({ message: 'PTZ no habilitado' })
    if (user.role === 'AUDITOR') return reply.status(403).send({ message: 'Acceso denegado' })
    if (!await userCanAccessCamera(server.prisma, user.sub, user.role, id, 'canPtz')) {
      return reply.status(403).send({ message: 'Sin permiso PTZ' })
    }

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const ok  = await sendPTZCommand(nvr as any, camera.channel, command as PTZCommand, speed)
    await AuditAction(server.prisma, user.sub, 'PTZ_COMMAND', id, request, { command, speed })
    return reply.send({ success: ok, command })
  })

  // POST /api/cameras/:id/start-stream — Iniciar stream (con session tracking)
  server.post('/:id/start-stream', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user

    if (!await userCanAccessCamera(server.prisma, user.sub, user.role, id)) {
      return reply.status(403).send({ message: 'Sin permiso para ver esta cámara' })
    }

    const result = await startStream(server, user.sub, id)
    if (result.error) {
      // Si el error es del servidor de medios (no de límites ni de estado de salud),
      // marcar la cámara como MEDIA_SERVER_ERROR
      const isLimitError = result.error.code === 'STREAM_LIMIT_REACHED' || result.error.code === 'STREAM_LIMIT_GLOBAL'
      const isHealthError = Object.prototype.hasOwnProperty.call({ RTSP_SUB_NOT_FOUND: 1, CODEC_UNSUPPORTED_HEVC: 1, AUTH_FAILED: 1, OFFLINE: 1, RTSP_MAIN_NOT_FOUND: 1 }, result.error.code)
      if (!isLimitError && !isHealthError) {
        await server.prisma.camera.update({
          where: { id },
          data: { streamHealthStatus: 'MEDIA_SERVER_ERROR' } as any,
        }).catch(() => {})
      }
      return reply.status(400).send(result.error)
    }

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    return reply.send({
      cameraId:   id,
      streamPath: result.streamPath,
      hls:        result.hlsUrl,
      webrtc:     result.webrtcUrl,
      channel:    camera?.channel ?? 0,
      nvrName:    camera?.nvr?.name ?? '',
    })
  })

  // POST /api/cameras/cleanup-my-sessions — Limpiar sesiones del usuario actual
  server.post('/cleanup-my-sessions', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    const cleaned = await cleanupUserSessions(server, user.sub)
    return reply.send({ cleaned })
  })

  // GET /api/cameras/stream-sessions — Resumen de sesiones activas (solo ADMIN)
  server.get('/stream-sessions', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const sessions = getAdminSessionsSummary()
    return reply.send(sessions)
  })

  // POST /api/cameras/:id/stop-stream — Notificar que el usuario dejó de ver
  server.post('/:id/stop-stream', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user
    await stopStream(server, user.sub, id)
    return reply.send({ ok: true })
  })

  // POST /api/cameras/:id/touch-stream — Heartbeat para evitar timeout
  server.post('/:id/touch-stream', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user
    touchSession(user.sub, id)
    return reply.send({ ok: true })
  })

  // POST /api/cameras/:id/validate-stream — Validar salud RTSP y actualizar streamHealthStatus
  server.post('/:id/validate-stream', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const healthStatus = await validateAndUpdateCameraHealth(server.prisma, camera.nvr as any, camera as any)

    const updated = await server.prisma.camera.findUnique({ where: { id } })

    return reply.send({
      cameraId: id,
      streamHealthStatus: healthStatus,
      rtspSubOk:    (updated as any)?.rtspSubOk ?? null,
      subCodec:     (updated as any)?.subCodec ?? null,
      subResolution:(updated as any)?.subResolution ?? null,
      lastRtspCheckAt: (updated as any)?.lastRtspCheckAt ?? null,
      lastRtspError:   (updated as any)?.lastRtspError ?? null,
    })
  })

  // PUT /api/cameras/:id — Actualizar cámara
  server.put('/:id', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = cameraUpdateSchema.parse(request.body)
    const camera = await server.prisma.camera.update({ where: { id }, data })
    return reply.send(camera)
  })
}

function user(request: any) { return request.user }
