// Diagnóstico de salud de cámara (ADMIN) — TASK 8. Reúne, SANITIZADO, todo lo que
// hace falta para entender por qué una cámara aparece "offline": estado en DB,
// señal física InputProxy, RTSP main/sub, path de MediaMTX, readiness HLS, alerta
// activa y contadores de debounce. Nunca expone contraseñas, RTSP con credenciales
// ni JWT.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { getNvrChannelHealth } from '../services/hikvision'
import {
  getStreamPath, getTranscodedStreamPath, getHlsUrl, listRegisteredConfigPaths,
  getMediaMtxRuntimePaths, probeHlsManifest,
} from '../services/stream'
import { decryptNvrPasswordOrNull as decryptPass } from '../services/credentials'
import { getActiveSessions } from '../services/stream-manager'
import { getCameraDebounceSnapshot } from '../jobs/healthWorker'

export const diagnosticsRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/diagnostics/camera-health/:cameraId — ADMIN.
  server.get('/camera-health/:cameraId', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { cameraId } = z.object({ cameraId: z.string().min(1) }).parse(request.params)
    const camera = await server.prisma.camera.findUnique({ where: { id: cameraId }, include: { nvr: true } })
    if (!camera?.nvr) return reply.status(404).send({ message: 'Cámara no encontrada' })
    const c = camera as any

    // ── Señal física InputProxy (en vivo) ──
    let inputProxy: { status: string; source?: string; chanDetectResult?: string; passwordStatus?: string; ipAddress?: string } | null = null
    const plainPass = decryptPass(camera.nvr.password)
    if (plainPass) {
      try {
        const health = await getNvrChannelHealth({ ...camera.nvr, password: plainPass } as any)
        const h = health.find((x) => x.channel === camera.channel)
        if (h) inputProxy = { status: h.status, source: h.source, chanDetectResult: h.chanDetectResult, passwordStatus: h.passwordStatus, ipAddress: h.ipAddress }
      } catch (e: any) {
        server.log.warn(`[diagnostics] camera-health inputproxy error cameraId=${cameraId}: ${e?.code || e?.message}`)
      }
    }

    // ── MediaMTX path: config + estado RUNTIME REAL + sonda HLS activa ──
    // (Antes sólo se miraba la config → "SOURCE_NOT_READY" era un artefacto: el
    // runtime nunca se consultaba. Ahora se consulta /v3/paths/list y se sondea el
    // manifest HLS de verdad — en paths on-demand la sonda dispara el source.)
    const subPath   = getStreamPath(camera.nvr as any, camera as any, 'sub')
    const mainPath   = getStreamPath(camera.nvr as any, camera as any, 'main')
    const h264Path  = getTranscodedStreamPath(camera.nvr as any, camera as any)
    const configured = await listRegisteredConfigPaths().catch(() => null)
    const runtimeMap = await getMediaMtxRuntimePaths()
    const runtime    = runtimeMap?.get(subPath) ?? null
    const subConfigured = configured ? configured.has(subPath) : null
    const mediaMtxReady = runtime?.ready === true
    const hlsProbe = await probeHlsManifest(subPath, 5000)
    const mediaMtxState = runtimeMap === null ? 'UNKNOWN'
      : mediaMtxReady ? (hlsProbe.playable ? 'READY' : 'HLS_NOT_READY')
      : subConfigured === false ? 'PATH_MISSING'
      : hlsProbe.playable ? 'READY' : 'SOURCE_NOT_READY'
    if (hlsProbe.playable) {
      await server.prisma.camera.update({ where: { id: cameraId }, data: { lastHlsSuccessAt: new Date() } as any }).catch(() => {})
    }
    // Sesiones COMPLETAS de esta cámara (paths efectivamente demandados): la
    // observación de salud evalúa ESTOS paths, no sólo el _sub calculado.
    const camSessions = getActiveSessions()
      .filter((s) => s.cameraId === cameraId)
      .map((s) => ({ userId: s.userId, viewId: s.viewId, streamType: s.streamType, streamPath: s.streamPath, heartbeatAgeMs: Date.now() - s.lastHeartbeat.getTime() }))
    const activeSessions = camSessions.length

    // ── Alerta activa (una no resuelta por tipo) ──
    const activeOffline = await server.prisma.alert.findFirst({ where: { cameraId, type: 'CAMERA_OFFLINE', resolved: false }, orderBy: { createdAt: 'desc' } })
    const activeStream  = await server.prisma.alert.findFirst({ where: { cameraId, type: 'CAMERA_STREAM_ERROR' as any, resolved: false }, orderBy: { createdAt: 'desc' } })

    const debounce = getCameraDebounceSnapshot(cameraId)
    const now = Date.now()

    server.log.info(
      `[diagnostics] camera_health_report cameraId=${cameraId} nvrId=${camera.nvr.id} channel=${camera.channel}` +
      ` inputProxy=${inputProxy?.status ?? 'n/a'} online=${camera.online} onlineInNvr=${c.onlineInNvr}` +
      ` mediaMtxReady=${mediaMtxReady} hlsReachable=${hlsProbe.playable} mediaMtx=${mediaMtxState}`
    )

    return reply.send({
      cameraId, nvrId: camera.nvr.id, nvrName: camera.nvr.name, channel: camera.channel, cameraName: camera.name,
      // Señal FÍSICA (InputProxy) — la fuente de CAMERA_OFFLINE.
      physicalStatus: inputProxy?.status ?? 'UNKNOWN',
      db: {
        active: camera.active,
        online: camera.online,                 // RTSP-validator-owned
        onlineInNvr: c.onlineInNvr,             // InputProxy-owned
        lastCheck: camera.lastCheck,
        streamHealthStatus: c.streamHealthStatus,
        rtspMainOk: c.rtspMainOk, rtspSubOk: c.rtspSubOk,
        lastRtspError: c.lastRtspError ?? null, consecutiveFailures: c.consecutiveFailures ?? 0,
        offlineAlertEnabled: c.offlineAlertEnabled, streamErrorAlertEnabled: c.streamErrorAlertEnabled,
        maintenanceMode: c.maintenanceMode, maintenanceUntil: c.maintenanceUntil,
        inMaintenance: c.maintenanceMode === true || (c.maintenanceUntil && new Date(c.maintenanceUntil).getTime() > now),
      },
      inputProxy,                               // status / chanDetectResult / passwordStatus / ipAddress
      // Pipeline de streaming: config + RUNTIME real + sonda HLS activa.
      mediaMtx: {
        subPath, mainPath, h264Path,
        mediaMtxConfigured: subConfigured,
        mediaMtxReady,
        runtime: runtime ? { ready: runtime.ready, bytesReceived: runtime.bytesReceived, readers: runtime.readers } : null,
        hlsReachable: hlsProbe.playable,
        hlsProbeStatus: hlsProbe.status,
        state: mediaMtxState,
        hlsUrl: getHlsUrl(subPath),
        activeSessions,
        // legado (consumidores previos del endpoint)
        subConfigured,
      },
      // Evidencia persistida del pipeline (migración 0023).
      streamEvidence: {
        lastStreamSuccessAt: c.lastStreamSuccessAt ?? null,
        lastStreamFailureAt: c.lastStreamFailureAt ?? null,
        lastMediaMtxReadyAt: c.lastMediaMtxReadyAt ?? null,
        lastHlsSuccessAt:    hlsProbe.playable ? new Date(now).toISOString() : (c.lastHlsSuccessAt ?? null),
        lastStreamErrorCode: c.lastStreamErrorCode ?? null,
      },
      activeAlerts: {
        offline: activeOffline ? { id: activeOffline.id, severity: activeOffline.severity, createdAt: activeOffline.createdAt } : null,
        streamError: activeStream ? { id: activeStream.id, severity: activeStream.severity, createdAt: activeStream.createdAt } : null,
      },
      debounce: {
        offline: debounce.offline,
        stream: debounce.stream,
        streamDebounce: debounce.stream,   // alias del contrato pedido
      },
    })
  })
}
