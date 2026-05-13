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
  const streamPath = getStreamPath(nvr, camera)
  // Usar substream (H264) en lugar del main stream (que suele ser H265 incompatible con browsers)
  const rtspUrl = buildRtspUrl(nvr, camera.channel, true)

  const pathConfig = {
    source: rtspUrl,
    sourceOnDemand: true,
    sourceOnDemandStartTimeout: '8s',
    sourceOnDemandCloseAfter: '60s',
    record: false,
    overridePublisher: true,
  }

  try {
    // Intentar crear primero
    await mediamtxApi.post('/v3/config/paths/add/' + streamPath, pathConfig)
    return true
  } catch (err: any) {
    const status = err.response?.status

    // 400 = path ya existe con este nombre exacto → actualizar con PATCH
    if (status === 400) {
      try {
        await mediamtxApi.patch('/v3/config/paths/patch/' + streamPath, pathConfig)
        return true
      } catch {
        return true // Si PATCH falla, el path existe y probablemente ya funciona
      }
    }

    // 401 o 403 = problema de auth con MediaMTX API
    if (status === 401 || status === 403) {
      console.error(`[stream] MediaMTX auth error (${status}) para ${streamPath}. Verificar configuración de auth en mediamtx.yml`)
      return false
    }

    console.error(`[stream] Error registrando path ${streamPath}:`, status, err.message)
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
