// apps/api/src/services/stream.ts
// Gestión de streams via MediaMTX (RTSP → HLS/WebRTC)
import axios from 'axios'
import type { NVR, Camera } from '@prisma/client'
import { buildRtspUrl } from './hikvision'

const mediamtxApi = axios.create({
  baseURL: process.env.MEDIAMTX_URL || 'http://mediamtx:9997',
  timeout: 10000,
})

// Nombre del path en MediaMTX para una cámara
export function getStreamPath(nvr: NVR, camera: Camera): string {
  return `nvr_${nvr.id}_ch${String(camera.channel).padStart(2, '0')}`
}

// URL HLS relativa para el frontend (pasa por Nginx /hls/ → mediamtx:8888)
export function getHlsUrl(streamPath: string): string {
  return `/hls/${streamPath}/index.m3u8`
}

// URL WebRTC relativa para el frontend (pasa por Nginx /webrtc/ → mediamtx:8889)
export function getWebRtcUrl(streamPath: string): string {
  return `/webrtc/${streamPath}/whep`
}

// ─── Publicar stream desde NVR a MediaMTX ───────────────────
export async function publishStream(nvr: NVR, camera: Camera): Promise<boolean> {
  try {
    const streamPath = getStreamPath(nvr, camera)
    const rtspUrl = buildRtspUrl(nvr, camera.channel)

    // Crear path en MediaMTX con pull desde el NVR
    await mediamtxApi.post('/v3/config/paths/add/' + streamPath, {
      source: rtspUrl,
      sourceOnDemand: true,           // Solo conectar cuando haya viewers
      sourceOnDemandStartTimeout: '10s',
      sourceOnDemandCloseAfter: '10s',
      record: false,
    })

    return true
  } catch (err: any) {
    // Path ya existe, no es error
    if (err.response?.status === 400) return true
    return false
  }
}

// ─── Eliminar stream de MediaMTX ────────────────────────────
export async function removeStream(nvr: NVR, camera: Camera): Promise<void> {
  try {
    const streamPath = getStreamPath(nvr, camera)
    await mediamtxApi.delete('/v3/config/paths/delete/' + streamPath)
  } catch {
    // Ignorar errores al eliminar
  }
}

// ─── Publicar todos los streams de un NVR ───────────────────
export async function publishAllStreams(
  nvr: NVR,
  cameras: Camera[]
): Promise<{ success: number; failed: number }> {
  let success = 0
  let failed = 0

  for (const camera of cameras) {
    if (!camera.active) continue
    const ok = await publishStream(nvr, camera)
    ok ? success++ : failed++
  }

  return { success, failed }
}

// ─── Estado de un stream en MediaMTX ────────────────────────
export async function getStreamStatus(streamPath: string): Promise<{
  active: boolean
  readers: number
  bytesReceived: number
}> {
  try {
    const response = await mediamtxApi.get('/v3/paths/list')
    const paths: any[] = response.data?.items || []
    const path = paths.find((p) => p.name === streamPath)

    if (!path) {
      return { active: false, readers: 0, bytesReceived: 0 }
    }

    return {
      active: path.ready === true,
      readers: path.readers?.length || 0,
      bytesReceived: path.bytesReceived || 0,
    }
  } catch {
    return { active: false, readers: 0, bytesReceived: 0 }
  }
}

// ─── Listar todos los streams activos ───────────────────────
export async function listActiveStreams(): Promise<string[]> {
  try {
    const response = await mediamtxApi.get('/v3/paths/list')
    const paths: any[] = response.data?.items || []
    return paths.filter((p) => p.ready).map((p) => p.name)
  } catch {
    return []
  }
}
