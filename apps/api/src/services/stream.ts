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
  // Usar substream (H264) por defecto; main stream si preferredStream === 'main'
  const useSub = (camera as any).preferredStream !== 'main'
  const rtspUrl = buildRtspUrl(nvr, camera.channel, useSub)

  const pathConfig = {
    source: rtspUrl,
    sourceOnDemand: true,
    sourceOnDemandStartTimeout: '8s',
    sourceOnDemandCloseAfter: '5m',  // survive tab switches and PC lock/unlock
    record: false,
    overridePublisher: true,
  }

  try {
    // GET check: verify if path already exists
    let existingSource: string | undefined
    try {
      const existing = await mediamtxApi.get('/v3/config/paths/get/' + streamPath)
      existingSource = existing.data?.source
    } catch (getErr: any) {
      if (getErr.response?.status !== 404) {
        // Unexpected error on GET — proceed to POST anyway
      }
    }

    if (existingSource !== undefined) {
      // Path already exists
      if (existingSource === rtspUrl) {
        // Same source — nothing to do
        console.info(`[stream] path exists (same source), skipping: ${streamPath}`)
        return true
      }
      // Different source — update with PATCH
      await mediamtxApi.patch('/v3/config/paths/patch/' + streamPath, pathConfig)
      console.info(`[stream] path updated: ${streamPath}`)
      return true
    }

    // Path doesn't exist — create with POST
    await mediamtxApi.post('/v3/config/paths/add/' + streamPath, pathConfig)
    console.info(`[stream] path created: ${streamPath}`)
    return true
  } catch (err: any) {
    const status = err.response?.status

    // 400 on POST = race condition: path was created between our GET and POST → PATCH
    if (status === 400) {
      try {
        await mediamtxApi.patch('/v3/config/paths/patch/' + streamPath, pathConfig)
        console.info(`[stream] path updated (race condition): ${streamPath}`)
        return true
      } catch {
        console.info(`[stream] path exists (PATCH skipped): ${streamPath}`)
        return true // If PATCH fails, path likely exists and is already working
      }
    }

    // 401 or 403 = MediaMTX API auth problem
    if (status === 401 || status === 403) {
      console.error(`[stream] MediaMTX auth error (${status}) para ${streamPath}. Verificar configuración de auth en mediamtx.yml`)
      return false
    }

    console.error(`[stream] failed to register path ${streamPath}:`, status, err.message)
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

  const activeCameras = cameras.filter((c) => c.active)
  const CONCURRENCY = 5

  // Semaphore-based batching: max CONCURRENCY concurrent calls
  for (let i = 0; i < activeCameras.length; i += CONCURRENCY) {
    const batch = activeCameras.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map((camera) => publishStream(nvr, camera)))
    for (const ok of results) {
      ok ? success++ : failed++
    }
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
