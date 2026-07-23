// apps/api/src/routes/cameras.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { publishStream, removeStream, getStreamPath, getHlsUrl, getWebRtcUrl, getStreamStatus, getStreamDetails } from '../services/stream'
import { startStream, stopStream, touchSession, cleanupUserSessions, getAdminSessionsSummary } from '../services/stream-manager'
import { captureSnapshot, sendPTZCommand, buildRtspUrl, buildRtspUrlMasked, type PTZCommand } from '../services/hikvision'
import { probeRtspStream, probeBothStreams } from '../services/rtsp-probe'
import { validateAndUpdateCameraHealth } from '../services/stream-validator'
import { AuditAction } from '../services/audit'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

const sanitizeRtsp = (s: string | null | undefined): string | null => {
  if (!s) return s ?? null
  return s.replace(/rtsp:\/\/([^:@]+):([^@]+)@/gi, 'rtsp://$1:***@')
}

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

  // POST /api/cameras/batch — cargar múltiples cámaras por IDs (máx. 50)
  server.post('/batch', { preHandler: [server.authenticate] }, async (request, reply) => {
    const body = request.body as { ids?: unknown }
    if (!Array.isArray(body?.ids)) return reply.status(400).send({ message: 'ids debe ser un array' })
    const ids = (body.ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50)
    if (ids.length === 0) return reply.send([])

    const user = request.user
    let cameras
    if (['ADMIN', 'SUPERVISOR'].includes(user.role)) {
      cameras = await server.prisma.camera.findMany({
        where: { id: { in: ids } },
        include: { nvr: { select: { id: true, name: true, ipAddress: true } } },
      })
    } else {
      const perms = await server.prisma.userPermission.findMany({
        where: { userId: user.sub, cameraId: { in: ids }, canView: true },
        select: { cameraId: true },
      })
      const allowed = perms.map((p: any) => p.cameraId!).filter(Boolean)
      cameras = await server.prisma.camera.findMany({
        where: { id: { in: allowed } },
        include: { nvr: { select: { id: true, name: true, ipAddress: true } } },
      })
    }
    return reply.send(cameras)
  })

  // GET /api/cameras/:id — cámara individual con NVR
  server.get('/:id', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user
    const camera = await server.prisma.camera.findUnique({
      where: { id },
      include: { nvr: { select: { id: true, name: true, ipAddress: true } } },
    })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })
    if (!await userCanAccessCamera(server.prisma, user.sub, user.role, id)) {
      return reply.status(403).send({ message: 'Sin permiso para esta cámara' })
    }
    return reply.send(camera)
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

    // 2. Estado del stream en MediaMTX (getStreamDetails exposes sourceType + sourceMasked)
    const mediamtxStatus = await getStreamDetails(streamPath)

    // 3. Probe RTSP (ambos streams)
    const rtsp = await probeBothStreams(nvrDecrypted, camera.channel)

    // 4. Guardar resultado en DB
    await server.prisma.camera.update({
      where: { id },
      data: {
        rtspMainOk:     rtsp.main.ok,
        rtspSubOk:      rtsp.sub.ok,
        lastRtspCheckAt: new Date(),
        lastRtspError:  rtsp.sub.ok ? null : sanitizeRtsp(rtsp.sub.error || rtsp.main.error || null),
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
        onlineInNvr:      (camera as any).onlineInNvr ?? camera.online,
        preferredStream:  camera.preferredStream,
      },
      rtsp: {
        mainUrlMasked:  buildRtspUrlMasked(nvrDecrypted, camera.channel, false),
        subUrlMasked:   buildRtspUrlMasked(nvrDecrypted, camera.channel, true),
        mainOk:         rtsp.main.ok,
        subOk:          rtsp.sub.ok,
        mainError:      sanitizeRtsp(rtsp.main.error),
        subError:       sanitizeRtsp(rtsp.sub.error),
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
        provider:    'mediamtx',
        route:       streamPath,
        routeExists: mediamtxStatus.routeExists,
        ready:       mediamtxStatus.active,
        readers:     mediamtxStatus.readers,
        sourceType:  mediamtxStatus.sourceType,
        sourceMasked: mediamtxStatus.sourceMasked,
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

    const body = request.body as any
    const streamType: 'sub' | 'main' | 'main_h264' =
      body?.streamType === 'main'      ? 'main'      :
      body?.streamType === 'main_h264' ? 'main_h264' : 'sub'
    const viewId = typeof body?.viewId === 'string' && body.viewId.length > 0 ? body.viewId : undefined

    server.log.info(`[live] start_stream_requested cameraId=${id} streamType=${streamType} userId=${user.sub}`)

    const result = await startStream(server, user.sub, id, viewId, streamType)
    if (result.error) {
      if (result.error.code === 'TRANSCODE_LIMIT_REACHED') {
        server.log.warn(`[live] start_stream_failed cameraId=${id} code=TRANSCODE_LIMIT_REACHED streamType=${streamType}`)
      }
      // Si el error es del servidor de medios (no de límites ni de estado de salud),
      // marcar la cámara como MEDIA_SERVER_ERROR
      const isLimitError = result.error.code === 'STREAM_LIMIT_REACHED' || result.error.code === 'STREAM_LIMIT_GLOBAL'
      const isHealthError = Object.prototype.hasOwnProperty.call({ RTSP_SUB_NOT_FOUND: 1, CODEC_UNSUPPORTED_HEVC: 1, AUTH_FAILED: 1, OFFLINE: 1, RTSP_MAIN_NOT_FOUND: 1, TRANSCODING_DISABLED: 1, TRANSCODE_LIMIT_REACHED: 1, CAMERA_OFFLINE: 1, TRANSCODE_NOT_READY: 1, TRANSCODE_PROCESS_EXITED: 1 }, result.error.code)
      if (!isLimitError && !isHealthError) {
        await server.prisma.camera.update({
          where: { id },
          data: { streamHealthStatus: 'MEDIA_SERVER_ERROR' } as any,
        }).catch(() => {})
      }
      // Persist RTSP_SUB_NOT_FOUND to DB so future requests are blocked at the frontend
      if (result.error.code === 'RTSP_SUB_NOT_FOUND') {
        await server.prisma.camera.update({
          where: { id },
          data: { rtspSubOk: false, streamHealthStatus: 'RTSP_SUB_NOT_FOUND' } as any,
        }).catch(() => {})
      }
      // Límites de stream → 429 + Retry-After para que el frontend aplique backoff
      // en vez de reintentar el mismo stream en cada heartbeat.
      if (isLimitError || result.error.code === 'TRANSCODE_LIMIT_REACHED') {
        return reply.status(429).header('Retry-After', '10').send(result.error)
      }
      // Evidencia de DEMANDA INSATISFECHA para la detección de CAMERA_STREAM_ERROR:
      // un start-stream que falló por el PIPELINE (no por límites, ni por cámara
      // deshabilitada/offline físico, ni por capacidad/config permanente como HEVC
      // sin transcodificación — eso generaría demanda perpetua y falsos positivos)
      // deja timestamp + código. El healthWorker lo usa como prueba de que alguien
      // pidió video y el pipeline no lo entregó.
      const isPhysicalOrConfig = [
        'CAMERA_NOT_FOUND', 'CAMERA_DISABLED', 'CAMERA_OFFLINE', 'OFFLINE',
        'CODEC_UNSUPPORTED_HEVC', 'TRANSCODING_DISABLED',
      ].includes(result.error.code)
      if (!isLimitError && !isPhysicalOrConfig) {
        await server.prisma.camera.update({
          where: { id },
          data: { lastStreamFailureAt: new Date(), lastStreamErrorCode: result.error.code } as any,
        }).catch(() => {})
      }
      return reply.status(400).send(result.error)
    }

    // start-stream ACEPTADO: el API entregó una URL HLS. NO prueba frames — el
    // éxito real (lastStreamSuccessAt/lastHlsSuccessAt) lo verifica el healthWorker
    // con el runtime de MediaMTX y las sondas HLS (separación pedida: aceptación
    // vs entrega verificada).
    await server.prisma.camera.update({
      where: { id },
      data: { lastStreamStartAcceptedAt: new Date() } as any,
    }).catch(() => {})

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
  // viewId provided → only clean that view (safe unmount cleanup, won't kill newly started sessions).
  // no viewId → clean only orphaned sessions from stale/crashed tabs.
  server.post('/cleanup-my-sessions', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    const body = request.body as any
    const viewId = typeof body?.viewId === 'string' && body.viewId.length > 0 ? body.viewId : undefined
    const cleaned = await cleanupUserSessions(server, user.sub, viewId)
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
    const body = request.body as any
    const streamType: 'sub' | 'main' | 'main_h264' =
      body?.streamType === 'main'      ? 'main'      :
      body?.streamType === 'main_h264' ? 'main_h264' : 'sub'
    const reason = typeof body?.reason === 'string' ? body.reason : undefined
    await stopStream(server, user.sub, id, streamType, reason)
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

  // GET /api/cameras/:id/debug-stream — Estado completo del stream sin probar RTSP
  server.get('/:id/debug-stream', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const nvr = camera.nvr
    const streamPath = getStreamPath(nvr, camera)
    const details = await getStreamDetails(streamPath)

    return reply.send({
      cameraId:           id,
      name:               camera.name,
      channel:            camera.channel,
      channelCode:        (camera as any).channelCode || `D${camera.channel}`,
      active:             camera.active,
      online:             camera.online,
      onlineInNvr:        (camera as any).onlineInNvr ?? null,
      preferredStream:    (camera as any).preferredStream ?? null,
      streamHealthStatus: (camera as any).streamHealthStatus ?? null,
      rtspMainOk:         (camera as any).rtspMainOk ?? null,
      rtspSubOk:          (camera as any).rtspSubOk ?? null,
      mainCodec:          (camera as any).mainCodec ?? null,
      subCodec:           (camera as any).subCodec ?? null,
      mainResolution:     (camera as any).mainResolution ?? null,
      subResolution:      (camera as any).subResolution ?? null,
      mainFps:            (camera as any).mainFps ?? null,
      subFps:             (camera as any).subFps ?? null,
      lastRtspCheckAt:    (camera as any).lastRtspCheckAt ?? null,
      lastRtspError:      sanitizeRtsp((camera as any).lastRtspError),
      consecutiveFailures:(camera as any).consecutiveFailures ?? 0,
      subUrlMasked:       buildRtspUrlMasked({ ...nvr, password: '***' } as any, camera.channel, true),
      mainUrlMasked:      buildRtspUrlMasked({ ...nvr, password: '***' } as any, camera.channel, false),
      mediaServer: {
        streamPath,
        hlsUrl:       getHlsUrl(streamPath),
        webrtcUrl:    getWebRtcUrl(streamPath),
        routeExists:  details.routeExists,
        active:       details.active,
        readers:      details.readers,
        bytesReceived: details.bytesReceived,
        sourceType:   details.sourceType ?? null,
        sourceMasked: details.sourceMasked ?? null,
      },
      nvr: {
        id:         nvr.id,
        name:       nvr.name,
        ipAddress:  nvr.ipAddress,
        online:     nvr.online,
        lastSeen:   nvr.lastSeen,
      },
    })
  })

  // PUT /api/cameras/:id — Actualizar cámara
  server.put('/:id', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = cameraUpdateSchema.parse(request.body)
    const camera = await server.prisma.camera.update({ where: { id }, data })
    return reply.send(camera)
  })

  // PATCH /api/cameras/:id/name — Rename camera (local DB only)
  // Persists the name locally and audits the change.
  // A separate endpoint handles pushing the name to the NVR via ISAPI.
  server.patch('/:id/name', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user   = request.user
    const body   = request.body as { name?: unknown }

    const newName = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!newName || newName.length < 1 || newName.length > 100) {
      return reply.status(400).send({ message: 'El nombre debe tener entre 1 y 100 caracteres' })
    }

    const existing = await server.prisma.camera.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const prevName = existing.name
    if (prevName === newName) return reply.send(existing)

    const camera = await server.prisma.camera.update({
      where: { id },
      data:  { name: newName },
    })

    await AuditAction(server.prisma, user.sub, 'CAMERA_RENAME', id, request, {
      previousName: prevName,
      newName,
      nvrId: existing.nvrId,
    })

    return reply.send(camera)
  })

  // POST /api/cameras/:id/migrate — Mover cámara a otro NVR (ADMIN)
  // Actualiza nvrId + canal en la BD local. No toca la configuración del NVR:
  // es para reflejar un traslado físico/lógico ya realizado en los equipos.
  server.post('/:id/migrate', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = z.object({
      targetNvrId: z.string().min(1),
      channel:     z.number().int().min(1).max(128).optional(),
    }).parse(request.body)

    const camera = await server.prisma.camera.findUnique({ where: { id }, include: { nvr: true } })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    const targetNvr = await server.prisma.nVR.findUnique({ where: { id: body.targetNvrId } })
    if (!targetNvr) return reply.status(404).send({ message: 'NVR destino no encontrado' })

    if (targetNvr.id === camera.nvrId && (body.channel === undefined || body.channel === camera.channel)) {
      return reply.status(400).send({ message: 'La cámara ya está en ese NVR y canal' })
    }

    const newChannel = body.channel ?? camera.channel
    const occupied = await server.prisma.camera.findFirst({
      where: { nvrId: targetNvr.id, channel: newChannel, NOT: { id } },
      select: { id: true, name: true },
    })
    if (occupied) {
      return reply.status(409).send({
        message: `El canal ${newChannel} del NVR destino ya está ocupado por "${occupied.name}"`,
      })
    }

    // Remove any published stream before moving — RTSP paths point to the old NVR
    try { await removeStream(camera.nvr as any, camera as any) } catch {}

    const updated = await server.prisma.camera.update({
      where: { id },
      data: {
        nvrId:       targetNvr.id,
        channel:     newChannel,
        channelCode: `D${newChannel}`,
        // Codec/diagnostic info belongs to the old NVR connection — reset so
        // the next validation re-probes against the new NVR
        rtspMainOk: null, rtspSubOk: null, lastRtspError: null,
        streamHealthStatus: 'UNKNOWN', onlineInNvr: null,
      },
    })

    server.log.info(
      `[cameras] camera_migrated cameraId=${id} name=${camera.name}` +
      ` fromNvr=${camera.nvrId} toNvr=${targetNvr.id} fromCh=${camera.channel} toCh=${newChannel}`
    )
    await AuditAction(server.prisma, request.user.sub, 'CAMERA_MIGRATE', id, request, {
      fromNvrId: camera.nvrId, fromNvrName: camera.nvr.name, fromChannel: camera.channel,
      toNvrId: targetNvr.id, toNvrName: targetNvr.name, toChannel: newChannel,
    })

    return reply.send(updated)
  })
}

function user(request: any) { return request.user }
