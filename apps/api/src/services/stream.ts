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
  const useSub = (camera as any).preferredStream !== 'main'
  const rtspUrl = buildRtspUrl(nvr, camera.channel, useSub)
  const sourceMasked = rtspUrl.replace(/rtsp:\/\/([^:@]+):([^@]+)@/gi, 'rtsp://$1:***@')

  const pathConfig = {
    source: rtspUrl,
    sourceOnDemand: true,
    sourceOnDemandStartTimeout: '8s',
    sourceOnDemandCloseAfter: '10m',  // GC fallback — heartbeat/stop-stream limpian antes
    rtspTransport: 'tcp',             // forzar TCP en pull (evita pérdida RTP UDP)
    record: false,
    overridePublisher: true,
  }

  console.info(`[stream] publish path=${streamPath} stream=${useSub ? 'sub' : 'main'} codec=${useSub ? (camera as any).subCodec || '?' : (camera as any).mainCodec || '?'} source=${sourceMasked} closeAfter=10m transport=tcp`)

  try {
    // Intentar crear directamente (optimistic POST).
    // Si el path ya existe MediaMTX devuelve 400 → hacemos PATCH.
    // Evitar GET previo: causa ERR "path configuration not found" en logs de MediaMTX.
    await mediamtxApi.post('/v3/config/paths/add/' + streamPath, pathConfig)
    console.info(`[stream] path created: ${streamPath}`)
    return true
  } catch (err: any) {
    const status = err.response?.status

    // 400 = path ya existe — actualizar con PATCH para asegurar rtspTransport/closeAfter
    if (status === 400) {
      try {
        await mediamtxApi.patch('/v3/config/paths/patch/' + streamPath, pathConfig)
        console.info(`[stream] path updated: ${streamPath}`)
        return true
      } catch (patchErr: any) {
        // Si el PATCH falla porque el path desapareció entre el POST y el PATCH,
        // reintentar creando. Si falla de nuevo, logar y retornar false.
        if (patchErr.response?.status === 404) {
          try {
            await mediamtxApi.post('/v3/config/paths/add/' + streamPath, pathConfig)
            console.info(`[stream] path re-created after race: ${streamPath}`)
            return true
          } catch {
            console.error(`[stream] failed to re-create path ${streamPath} after race`)
            return false
          }
        }
        console.error(`[stream] PATCH failed for ${streamPath}:`, patchErr.response?.status, patchErr.message)
        return false
      }
    }

    // 401/403 = problema de auth con la API de MediaMTX
    if (status === 401 || status === 403) {
      console.error(`[stream] MediaMTX auth error (${status}) para ${streamPath} — verificar mediamtx.yml`)
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
// Usa solo /v3/paths/list (live state) — no llama a /v3/config/paths/get
// porque ese endpoint genera ERR "path configuration not found" en los logs de MediaMTX.
export async function getStreamStatus(streamPath: string): Promise<{
  active: boolean
  routeExists: boolean
  readers: number
  bytesReceived: number
}> {
  try {
    const response = await mediamtxApi.get('/v3/paths/list')
    const paths: any[] = response.data?.items || []
    const path = paths.find((p) => p.name === streamPath)

    if (!path) {
      // Not in active list — assume path exists in config (registered at startup) but no readers yet
      return { active: false, routeExists: true, readers: 0, bytesReceived: 0 }
    }

    return {
      active: path.ready === true,
      routeExists: true,
      readers: path.readers?.length || 0,
      bytesReceived: path.bytesReceived || 0,
    }
  } catch {
    return { active: false, routeExists: false, readers: 0, bytesReceived: 0 }
  }
}

// ─── Detalles completos de un path en MediaMTX (para debug) ─
export async function getStreamDetails(streamPath: string): Promise<{
  active: boolean
  routeExists: boolean
  readers: number
  bytesReceived: number
  sourceType?: string
  sourceMasked?: string
  configSource?: string
}> {
  let livePath: any = null
  let configPath: any = null

  try {
    const liveRes = await mediamtxApi.get('/v3/paths/get/' + streamPath)
    livePath = liveRes.data
  } catch {
    // not active
  }

  try {
    const cfgRes = await mediamtxApi.get('/v3/config/paths/get/' + streamPath)
    configPath = cfgRes.data
  } catch {
    // not registered
  }

  const configSource: string = configPath?.source || ''
  const sourceMasked = configSource
    ? configSource.replace(/rtsp:\/\/([^:@]+):([^@]+)@/gi, 'rtsp://$1:***@')
    : undefined

  if (!livePath) {
    return {
      active: false,
      routeExists: !!configPath,
      readers: 0,
      bytesReceived: 0,
      sourceType: configPath ? 'rtspSource' : undefined,
      sourceMasked,
      configSource: sourceMasked,
    }
  }

  return {
    active: livePath.ready === true,
    routeExists: true,
    readers: livePath.readers?.length || 0,
    bytesReceived: livePath.bytesReceived || 0,
    sourceType: livePath.source?.type,
    sourceMasked,
    configSource: sourceMasked,
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
