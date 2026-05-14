// Stream Manager — controla sesiones de viewers y libera streams sin uso
// Los streams en MediaMTX ya tienen sourceOnDemand: true (se conectan solos cuando hay requests HLS)
// Este manager trackea quién está mirando para informar al frontend y aplicar límites.
import type { FastifyInstance } from 'fastify'
import { getStreamPath, getHlsUrl, getWebRtcUrl, publishStream, removeStream, getStreamStatus } from './stream'
import type { NVR, Camera } from '@prisma/client'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// Límites configurables
const MAX_STREAMS_PER_USER = Number(process.env.MAX_STREAMS_PER_USER || 16)
const MAX_STREAMS_GLOBAL   = Number(process.env.MAX_STREAMS_GLOBAL   || 50)
const STREAM_IDLE_TIMEOUT  = Number(process.env.STREAM_IDLE_TIMEOUT  || 90)  // segundos

interface StreamSession {
  cameraId: string
  userId: string
  streamPath: string
  startedAt: Date
  lastSeenAt: Date
}

// En memoria — se pierde al reiniciar (intencional: el frontend reconecta)
const sessions = new Map<string, StreamSession>() // key: `${userId}:${cameraId}`

function sessionKey(userId: string, cameraId: string) {
  return `${userId}:${cameraId}`
}

export function getActiveSessions(): StreamSession[] {
  return Array.from(sessions.values())
}

export function getSessionsForUser(userId: string): StreamSession[] {
  return Array.from(sessions.values()).filter(s => s.userId === userId)
}

export function touchSession(userId: string, cameraId: string) {
  const key = sessionKey(userId, cameraId)
  const s = sessions.get(key)
  if (s) s.lastSeenAt = new Date()
}

// Iniciar stream para un usuario
export async function startStream(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
): Promise<{ hlsUrl: string; webrtcUrl: string; streamPath: string; error?: string }> {
  // Buscar cámara en DB con NVR
  const camera = await server.prisma.camera.findUnique({
    where: { id: cameraId },
    include: { nvr: true },
  })

  if (!camera || !camera.nvr) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: 'Cámara no encontrada' }
  }

  if (!camera.active) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: 'Cámara desactivada' }
  }

  // Verificar límites
  const userSessions = getSessionsForUser(userId)
  if (userSessions.length >= MAX_STREAMS_PER_USER && !userSessions.some(s => s.cameraId === cameraId)) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: `Límite de ${MAX_STREAMS_PER_USER} streams por usuario alcanzado` }
  }

  const totalSessions = sessions.size
  if (totalSessions >= MAX_STREAMS_GLOBAL && !sessions.has(sessionKey(userId, cameraId))) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: `Límite global de ${MAX_STREAMS_GLOBAL} streams alcanzado` }
  }

  const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
  const streamPath = getStreamPath(nvr as NVR, camera as Camera)

  // Registrar en MediaMTX si no existe
  await publishStream(nvr as NVR, camera as Camera)

  // Registrar sesión
  const key = sessionKey(userId, cameraId)
  sessions.set(key, {
    cameraId,
    userId,
    streamPath,
    startedAt: sessions.get(key)?.startedAt || new Date(),
    lastSeenAt: new Date(),
  })

  return {
    hlsUrl: getHlsUrl(streamPath),
    webrtcUrl: getWebRtcUrl(streamPath),
    streamPath,
  }
}

// Detener stream para un usuario
export async function stopStream(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
): Promise<void> {
  const key = sessionKey(userId, cameraId)
  sessions.delete(key)

  // Si nadie más está mirando, verificar viewers en MediaMTX
  const othersWatching = Array.from(sessions.values()).some(s => s.cameraId === cameraId)
  if (!othersWatching) {
    // MediaMTX con sourceOnDemand cierra el RTSP automáticamente cuando no hay readers HLS
    // No hace falta hacer nada más aquí — el cierre es gestionado por sourceOnDemandCloseAfter
    server.log.info(`[stream-manager] Todos los viewers salieron de cámara ${cameraId}`)
  }
}

// Limpiar sesiones inactivas (llamar desde un cron)
export async function cleanupIdleSessions(server: FastifyInstance): Promise<number> {
  const cutoff = new Date(Date.now() - STREAM_IDLE_TIMEOUT * 1000)
  let removed = 0

  for (const [key, session] of sessions.entries()) {
    if (session.lastSeenAt < cutoff) {
      sessions.delete(key)
      removed++
      server.log.info(`[stream-manager] Sesión idle eliminada: ${key}`)
    }
  }

  return removed
}

// Estado global de streams (para panel admin)
export async function getStreamManagerStatus(server: FastifyInstance) {
  const activeSessions = getActiveSessions()
  const uniqueCameras = new Set(activeSessions.map(s => s.cameraId))

  // Obtener viewers reales de MediaMTX para las cámaras activas
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
    maxPerUser: MAX_STREAMS_PER_USER,
    maxGlobal: MAX_STREAMS_GLOBAL,
    sessions: activeSessions.map(s => ({
      cameraId: s.cameraId,
      userId: s.userId,
      streamPath: s.streamPath,
      startedAt: s.startedAt,
      lastSeenAt: s.lastSeenAt,
      mediaStatus: cameraStatuses[s.cameraId],
    })),
  }
}
