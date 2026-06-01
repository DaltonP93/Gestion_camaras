// Stream Manager — controla sesiones de viewers y libera streams sin uso
// Los streams en MediaMTX ya tienen sourceOnDemand: true (se conectan solos cuando hay requests HLS)
// Este manager trackea quién está mirando para informar al frontend y aplicar límites.
import type { FastifyInstance } from 'fastify'
import { getStreamPath, getHlsUrl, getWebRtcUrl, publishStream, removeStream, getStreamStatus, publishTranscodedStream, getTranscodedStreamPath, isTranscodingEnabled, getFfmpegCapabilities, waitForHlsReady } from './stream'
import type { NVR, Camera } from '@prisma/client'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// Límites configurables
const MAX_STREAMS_PER_USER   = Number(process.env.MAX_STREAMS_PER_USER   || 32)
const MAX_STREAMS_GLOBAL     = Number(process.env.MAX_STREAMS_GLOBAL     || 50)
const STREAM_IDLE_TIMEOUT    = Number(process.env.STREAM_IDLE_TIMEOUT    || 90)  // segundos
export const MAX_TRANSCODE_SESSIONS = Number(process.env.MAX_TRANSCODE_SESSIONS || 2)

// Health statuses that unconditionally block all stream requests
// (USING_MAIN_STREAM and CODEC_UNSUPPORTED_HEVC are handled by codec redirect logic instead)
const BLOCKED_HEALTH_STATUSES = new Set([
  'RTSP_SUB_NOT_FOUND',
  'AUTH_FAILED',
  'OFFLINE',
])

function getActiveTranscodeSessions(): number {
  return Array.from(sessions.values()).filter(s => s.streamType === 'main_h264').length
}

interface StreamSession {
  cameraId: string
  userId: string
  viewId: string                  // identificador de pestaña/view del navegador
  streamType: 'sub' | 'main' | 'main_h264'  // sub=grid H264, main=HD (puede HEVC), main_h264=transcodificado
  streamPath: string
  startedAt: Date
  lastHeartbeat: Date             // actualizado por touchSession o touchView
}

// En memoria — se pierde al reiniciar (intencional: el frontend reconecta)
// key: `${userId}:${cameraId}:${streamType}` — permite sub y main simultáneos
const sessions = new Map<string, StreamSession>()

// Per-view tracking: qué cámaras pertenecen a qué view (solo sub streams — main es explícito)
const viewCameras   = new Map<string, Set<string>>() // key: `${userId}:${viewId}`
const viewHeartbeat = new Map<string, Date>()         // key: `${userId}:${viewId}` → last heartbeat

function sessionKey(userId: string, cameraId: string, streamType: 'sub' | 'main' | 'main_h264' = 'sub') {
  return `${userId}:${cameraId}:${streamType}`
}

function vKey(userId: string, viewId: string) {
  return `${userId}:${viewId}`
}

export function getActiveSessions(): StreamSession[] {
  return Array.from(sessions.values())
}

export function getSessionsForUser(userId: string): StreamSession[] {
  return Array.from(sessions.values()).filter(s => s.userId === userId)
}

// Tocar una sola sesión (backward compat para touch-stream endpoint individual)
export function touchSession(userId: string, cameraId: string, streamType: 'sub' | 'main' | 'main_h264' = 'sub') {
  const key = sessionKey(userId, cameraId, streamType)
  const s = sessions.get(key)
  if (s) s.lastHeartbeat = new Date()
}

// Tocar todas las sesiones de un view de una vez (solo sub streams del heartbeat)
export function touchView(userId: string, viewId: string) {
  const vk = vKey(userId, viewId)
  viewHeartbeat.set(vk, new Date())
  const vCams = viewCameras.get(vk)
  if (!vCams) return
  const now = new Date()
  for (const cameraId of vCams) {
    const s = sessions.get(sessionKey(userId, cameraId, 'sub'))
    if (s) s.lastHeartbeat = now
  }
}

// Iniciar stream para un usuario
interface StreamError {
  code: string
  message: string
  details?: string
}

const HEALTH_STATUS_ERRORS: Record<string, StreamError> = {
  RTSP_SUB_NOT_FOUND:    { code: 'RTSP_SUB_NOT_FOUND',    message: 'Substream RTSP no disponible' },
  CODEC_UNSUPPORTED_HEVC:{ code: 'CODEC_UNSUPPORTED_HEVC', message: 'Codec HEVC/H.265 no compatible para reproducción web' },
  AUTH_FAILED:           { code: 'AUTH_FAILED',            message: 'Credenciales inválidas en cámara' },
  OFFLINE:               { code: 'OFFLINE',                message: 'Cámara offline' },
  RTSP_MAIN_NOT_FOUND:   { code: 'RTSP_MAIN_NOT_FOUND',   message: 'Stream RTSP principal no disponible' },
  USING_MAIN_STREAM:     { code: 'RTSP_SUB_NOT_FOUND',    message: 'Substream no disponible — doble clic para ver en pantalla completa' },
}

export async function startStream(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
  viewId?: string,
  streamType: 'sub' | 'main' | 'main_h264' = 'sub',
): Promise<{ hlsUrl: string; webrtcUrl: string; streamPath: string; transcoded?: boolean; error?: StreamError; warning?: StreamError }> {
  // Buscar cámara en DB con NVR
  const camera = await server.prisma.camera.findUnique({
    where: { id: cameraId },
    include: { nvr: true },
  })

  if (!camera || !camera.nvr) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_NOT_FOUND', message: 'Cámara no encontrada' } }
  }

  if (!camera.active) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_DISABLED', message: 'Cámara desactivada' } }
  }

  if ((camera as any).online === false) {
    console.info(`[startStream] skip offline cameraId=${cameraId} reason=camera_online_false`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_OFFLINE', message: 'Cámara offline' } }
  }

  const rtspSubOk  = (camera as any).rtspSubOk  as boolean | null
  const rtspMainOk = (camera as any).rtspMainOk as boolean | null
  if (rtspSubOk === false && rtspMainOk === false) {
    console.info(`[startStream] skip offline cameraId=${cameraId} reason=rtsp_both_down`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_OFFLINE', message: 'Cámara offline — sin RTSP disponible' } }
  }

  const healthStatus = (camera as any).streamHealthStatus as string | undefined
  const mainCodecStr = ((camera as any).mainCodec || '').toLowerCase()
  const subCodecStr  = ((camera as any).subCodec  || '').toLowerCase()
  const mainIsH264   = !!(mainCodecStr && (mainCodecStr.includes('h264') || mainCodecStr.includes('avc') || mainCodecStr.includes('h.264')))
  const mainIsHevc   = !!(mainCodecStr && (mainCodecStr.includes('hevc') || mainCodecStr.includes('h265') || mainCodecStr.includes('h.265') || mainCodecStr.includes('hvc1')))
  const subIsHevc    = !!(subCodecStr  && (subCodecStr.includes('hevc')  || subCodecStr.includes('h265')  || subCodecStr.includes('h.265')  || subCodecStr.includes('hvc1')))
  const ch = (camera as any).channel

  // ── Determine effective stream type ─────────────────────────────────────
  let effectiveType: 'sub' | 'main' | 'main_h264' = streamType

  if (streamType === 'main') {
    if (mainIsHevc) {
      if (!isTranscodingEnabled()) {
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'CODEC_UNSUPPORTED_HEVC', message: 'El flujo principal es H.265/HEVC. Configura ENABLE_HEVC_TRANSCODING=true para habilitar transcodificación.' } }
      }
      console.info(`[transcode] requested cameraId=${cameraId} ch=${ch} streamType=main codec=${mainCodecStr}`)
      effectiveType = 'main_h264'
    }
  } else if (streamType === 'sub') {
    // Sub HEVC: redirect to main H264 if available, otherwise transcode, otherwise error
    if (subIsHevc) {
      if (mainIsH264 && rtspMainOk !== false) {
        effectiveType = 'main'
        console.info(`[stream] sub HEVC redirect → main cameraId=${cameraId} ch=${ch} subCodec=${subCodecStr} mainCodec=${mainCodecStr}`)
      } else if (isTranscodingEnabled()) {
        console.info(`[transcode] requested cameraId=${cameraId} ch=${ch} streamType=sub reason=sub_hevc`)
        effectiveType = 'main_h264'
      } else {
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'CODEC_UNSUPPORTED_HEVC', message: 'Sub stream en H.265/HEVC. Habilita ENABLE_HEVC_TRANSCODING=true para transcodificar.' } }
      }
    }
    // Sub failed but main H264 works (USING_MAIN_STREAM status) — redirect to main
    else if (healthStatus === 'USING_MAIN_STREAM' && mainIsH264 && rtspMainOk !== false) {
      effectiveType = 'main'
      console.info(`[stream] USING_MAIN_STREAM redirect → main cameraId=${cameraId} ch=${ch} mainCodec=${mainCodecStr}`)
    }
  }

  // ── Transcoded stream (main_h264) ──────────────────────────────────────
  if (effectiveType === 'main_h264') {
    if (!isTranscodingEnabled()) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=HEVC_DISABLED`)
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'TRANSCODING_DISABLED', message: 'La transcodificación HEVC no está habilitada. Configura ENABLE_HEVC_TRANSCODING=true.' } }
    }
    if (!getFfmpegCapabilities().available) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=FFMPEG_NOT_AVAILABLE`)
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'MEDIA_SERVER_ERROR', message: 'FFmpeg no disponible en el servidor.' } }
    }
    const activeTrans = getActiveTranscodeSessions()
    if (activeTrans >= MAX_TRANSCODE_SESSIONS) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=MAX_TRANSCODE_SESSIONS active=${activeTrans}/${MAX_TRANSCODE_SESSIONS}`)
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'TRANSCODE_LIMIT_REACHED', message: `Límite de transcodificaciones alcanzado (máx ${MAX_TRANSCODE_SESSIONS})` } }
    }
    const transcodeKey = sessionKey(userId, cameraId, 'main_h264')
    const existingTranscode = sessions.get(transcodeKey)
    if (existingTranscode) {
      existingTranscode.lastHeartbeat = new Date()
      if (viewId) existingTranscode.viewId = viewId
      console.info(`[userLimit] reuse existing cameraId=${cameraId} streamType=main_h264`)
      return { hlsUrl: getHlsUrl(existingTranscode.streamPath), webrtcUrl: getWebRtcUrl(existingTranscode.streamPath), streamPath: existingTranscode.streamPath, transcoded: true }
    }
    if (sessions.size >= MAX_STREAMS_GLOBAL) {
      return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'STREAM_LIMIT_GLOBAL', message: 'Límite global de streams alcanzado' } }
    }
    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const streamPath = getTranscodedStreamPath(nvr as any, camera as any)
    const published = await publishTranscodedStream(nvr as any, camera as any)
    if (!published) {
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'MEDIA_SERVER_ERROR', message: 'Error al registrar stream transcodificado en el servidor de medios' } }
    }
    // Poll internal HLS endpoint — this also triggers runOnDemand (starts FFmpeg).
    // Only register the session and return the URL once HLS is confirmed ready.
    const hlsReady = await waitForHlsReady(streamPath)
    if (!hlsReady) {
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'TRANSCODE_NOT_READY', message: 'El stream transcodificado no pudo iniciar a tiempo. Intenta de nuevo.' } }
    }
    const effectiveViewId = viewId || 'default'
    sessions.set(transcodeKey, {
      cameraId, userId, viewId: effectiveViewId, streamType: 'main_h264',
      streamPath, startedAt: new Date(), lastHeartbeat: new Date(),
    })
    console.info(`[transcode] ready cameraId=${cameraId} ch=${ch} path=${streamPath}`)
    return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
  }

  // ── Sub early exit if confirmed down ──────────────────────────────────
  if (effectiveType === 'sub' && rtspSubOk === false) {
    console.info(`[startStream] skip cameraId=${cameraId} reason=rtsp_sub_down`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'RTSP_SUB_NOT_FOUND', message: 'Substream RTSP no disponible' } }
  }

  // ── Health status blocking (hard failures only) ───────────────────────
  if (healthStatus && BLOCKED_HEALTH_STATUSES.has(healthStatus)) {
    const knownError = HEALTH_STATUS_ERRORS[healthStatus]
    return { hlsUrl: '', webrtcUrl: '', streamPath: '',
      error: knownError ?? { code: healthStatus, message: `Stream no disponible: ${healthStatus}` } }
  }

  // ── Session reuse: return existing session without counting toward limit ─
  const key = sessionKey(userId, cameraId, effectiveType as 'sub' | 'main')
  const existingSession = sessions.get(key)
  if (existingSession) {
    existingSession.lastHeartbeat = new Date()
    if (viewId) existingSession.viewId = viewId
    console.info(`[userLimit] reuse existing cameraId=${cameraId} streamType=${effectiveType}`)
    return { hlsUrl: getHlsUrl(existingSession.streamPath), webrtcUrl: getWebRtcUrl(existingSession.streamPath), streamPath: existingSession.streamPath }
  }

  // ── Stream limits (only sub counts toward per-user limit) ─────────────
  const userSessions = getSessionsForUser(userId)
  const userSubSessions = userSessions.filter(s => s.streamType === 'sub')
  if (effectiveType === 'sub' && userSubSessions.length >= MAX_STREAMS_PER_USER) {
    console.info(`[userLimit] reject reason=limit cameraId=${cameraId} current=${userSubSessions.length} max=${MAX_STREAMS_PER_USER}`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'STREAM_LIMIT_REACHED', message: 'Límite de streams por usuario alcanzado', current: userSubSessions.length, max: MAX_STREAMS_PER_USER } as any }
  }
  if (sessions.size >= MAX_STREAMS_GLOBAL) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'STREAM_LIMIT_GLOBAL', message: 'Límite global de streams alcanzado' } }
  }

  // ── Publish to MediaMTX ───────────────────────────────────────────────
  const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
  const streamPath = getStreamPath(nvr as NVR, camera as Camera, effectiveType as 'sub' | 'main')
  const published = await publishStream(nvr as NVR, camera as Camera, effectiveType as 'sub' | 'main')
  if (!published) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '',
      error: { code: 'MEDIA_SERVER_ERROR', message: 'Error al registrar stream en el servidor de medios' } }
  }

  // ── Register session ──────────────────────────────────────────────────
  const effectiveViewId = viewId || 'default'
  sessions.set(key, {
    cameraId, userId, viewId: effectiveViewId, streamType: effectiveType as 'sub' | 'main',
    streamPath, startedAt: new Date(), lastHeartbeat: new Date(),
  })
  if (effectiveType === 'sub') {
    const vk = vKey(userId, effectiveViewId)
    if (!viewCameras.has(vk)) viewCameras.set(vk, new Set())
    viewCameras.get(vk)!.add(cameraId)
    viewHeartbeat.set(vk, new Date())
  }
  return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath }
}

// Detener stream para un usuario
export async function stopStream(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
  streamType: 'sub' | 'main' | 'main_h264' = 'sub',
): Promise<void> {
  const key = sessionKey(userId, cameraId, streamType)
  const session = sessions.get(key)
  if (session) {
    // Quitar de viewCameras (solo relevante para sub streams)
    if (streamType === 'sub') {
      const vk = vKey(userId, session.viewId)
      viewCameras.get(vk)?.delete(cameraId)
    }
    sessions.delete(key)
  }

  // Si nadie más está mirando, MediaMTX cerrará automáticamente vía sourceOnDemandCloseAfter
  const othersWatching = Array.from(sessions.values()).some(s => s.cameraId === cameraId)
  if (!othersWatching) {
    server.log.info(`[stream-manager] Todos los viewers salieron de cámara ${cameraId}`)
  }
}

// ─── Heartbeat de viewport: reconciliar cámaras visibles ────
// Recibe el set de cámaras visibles para un viewId.
// - Detiene cámaras que ese view ya no necesita
// - Inicia cámaras que ese view necesita pero no tienen sesión
// - Toca todas las sesiones existentes (keepalive)
// - Devuelve URLs para todas las cámaras visibles
export interface ReconcileResult {
  streams: Record<string, { hls: string; webrtc: string; streamPath: string; channel?: number; nvrName?: string; warning?: { code: string; message: string } }>
  errors: Record<string, { code: string; message: string }>
  startedIds: string[]  // cámaras que se iniciaron ahora (necesitan nuevo player)
  stoppedIds: string[]  // cámaras que se detuvieron
}

export async function reconcileView(
  server: FastifyInstance,
  userId: string,
  viewId: string,
  visibleCameraIds: string[],
): Promise<ReconcileResult> {
  const visibleSet = new Set(visibleCameraIds)
  const vk = vKey(userId, viewId)

  // Actualizar heartbeat del view
  viewHeartbeat.set(vk, new Date())

  const streams: ReconcileResult['streams'] = {}
  const errors: ReconcileResult['errors']  = {}
  const startedIds: string[] = []
  const stoppedIds: string[] = []

  // Determinar qué cámaras tenía este view antes
  const previousCams = viewCameras.get(vk) || new Set<string>()

  // Detener cámaras que ya no son visibles en este view
  const toStop = Array.from(previousCams).filter(id => !visibleSet.has(id))
  for (const cameraId of toStop) {
    await stopStream(server, userId, cameraId)
    stoppedIds.push(cameraId)
  }

  // Para cada cámara visible: iniciar si no tiene sesión sub, o tocar si ya existe
  for (const cameraId of visibleCameraIds) {
    const key = sessionKey(userId, cameraId, 'sub')
    const existing = sessions.get(key)

    if (existing) {
      // Ya está corriendo — tocar y devolver URL
      existing.lastHeartbeat = new Date()
      existing.viewId = viewId  // actualizar viewId por si cambió
      streams[cameraId] = {
        hls: getHlsUrl(existing.streamPath),
        webrtc: getWebRtcUrl(existing.streamPath),
        streamPath: existing.streamPath,
      }
    } else {
      // No tiene sesión — iniciar
      const result = await startStream(server, userId, cameraId, viewId)
      if (result.error) {
        errors[cameraId] = result.error
      } else {
        // Lookup channel + nvrName for complete StreamInfo
        const cam = await server.prisma.camera.findUnique({
          where: { id: cameraId },
          select: { channel: true, nvr: { select: { name: true } } },
        })
        streams[cameraId] = {
          hls: result.hlsUrl,
          webrtc: result.webrtcUrl,
          streamPath: result.streamPath,
          channel: cam?.channel,
          nvrName: cam?.nvr?.name,
          warning: result.warning,
        }
        startedIds.push(cameraId)
      }
    }
  }

  // Actualizar viewCameras con el nuevo conjunto visible
  viewCameras.set(vk, new Set(visibleCameraIds.filter(id => streams[id])))

  return { streams, errors, startedIds, stoppedIds }
}

// Limpiar todas las sesiones de un usuario y liberar streams sin otros viewers
export async function cleanupUserSessions(
  server: FastifyInstance,
  userId: string,
): Promise<number> {
  const userSessions = getSessionsForUser(userId)
  let removed = 0

  for (const session of userSessions) {
    const key = sessionKey(userId, session.cameraId)
    sessions.delete(key)
    removed++

    const othersWatching = Array.from(sessions.values()).some(s => s.cameraId === session.cameraId)
    if (!othersWatching) {
      const camera = await server.prisma.camera.findUnique({
        where: { id: session.cameraId },
        include: { nvr: true },
      })
      if (camera?.nvr) {
        removeStream(camera.nvr, camera).catch(() => {})
      }
    }
  }

  // Limpiar view maps para este usuario
  for (const key of viewCameras.keys()) {
    if (key.startsWith(`${userId}:`)) {
      viewCameras.delete(key)
      viewHeartbeat.delete(key)
    }
  }

  return removed
}

// Limpiar sesiones inactivas (llamar desde un cron)
// Una sesión es idle si su view no ha hecho heartbeat en STREAM_IDLE_TIMEOUT segundos
export async function cleanupIdleSessions(server: FastifyInstance): Promise<number> {
  const cutoff = new Date(Date.now() - STREAM_IDLE_TIMEOUT * 1000)
  let removed = 0

  // Detectar views con heartbeat expirado
  const staleViews = new Set<string>()
  for (const [vk, lastBeat] of viewHeartbeat.entries()) {
    if (lastBeat < cutoff) {
      staleViews.add(vk)
    }
  }

  // Eliminar sesiones de views expirados o con lastHeartbeat expirado
  for (const [key, session] of sessions.entries()) {
    const vk = vKey(session.userId, session.viewId)
    if (staleViews.has(vk) || session.lastHeartbeat < cutoff) {
      sessions.delete(key)
      removed++
      server.log.info(`[stream-manager] Sesión idle eliminada: ${key} (view: ${session.viewId})`)
    }
  }

  // Limpiar view maps para views expirados
  for (const vk of staleViews) {
    viewCameras.delete(vk)
    viewHeartbeat.delete(vk)
  }

  return removed
}

// Resumen de todas las sesiones activas (para panel admin)
export function getAdminSessionsSummary(): Array<{
  cameraId: string
  userId: string
  viewId: string
  streamPath: string
  startedAt: Date
  lastHeartbeat: Date
}> {
  return Array.from(sessions.values()).map(s => ({
    cameraId:      s.cameraId,
    userId:        s.userId,
    viewId:        s.viewId,
    streamPath:    s.streamPath,
    startedAt:     s.startedAt,
    lastHeartbeat: s.lastHeartbeat,
  }))
}

// Estado global de streams (para panel admin)
export async function getStreamManagerStatus(server: FastifyInstance) {
  const activeSessions = getActiveSessions()
  const uniqueCameras = new Set(activeSessions.map(s => s.cameraId))

  const cameraStatuses: Record<string, { readers: number; ready: boolean }> = {}
  for (const camId of uniqueCameras) {
    const session = activeSessions.find(s => s.cameraId === camId)
    if (session) {
      const st = await getStreamStatus(session.streamPath).catch(() => ({ active: false, readers: 0, bytesReceived: 0 }))
      cameraStatuses[camId] = { readers: st.readers, ready: st.active }
    }
  }

  return {
    totalSessions: activeSessions.length,
    uniqueCameras: uniqueCameras.size,
    activeViews: viewHeartbeat.size,
    maxPerUser: MAX_STREAMS_PER_USER,
    maxGlobal: MAX_STREAMS_GLOBAL,
    sessions: activeSessions.map(s => ({
      cameraId:     s.cameraId,
      userId:       s.userId,
      viewId:       s.viewId,
      streamPath:   s.streamPath,
      startedAt:    s.startedAt,
      lastHeartbeat: s.lastHeartbeat,
      mediaStatus:  cameraStatuses[s.cameraId],
    })),
  }
}
