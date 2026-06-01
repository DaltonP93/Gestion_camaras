// apps/api/src/services/stream.ts
// Gestión de streams via MediaMTX (RTSP → HLS/WebRTC)
import axios from 'axios'
import { execSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import type { NVR, Camera } from '@prisma/client'
import { buildRtspUrl } from './hikvision'

const mediamtxApi = axios.create({
  baseURL: process.env.MEDIAMTX_URL || 'http://mediamtx:9997',
  timeout: 10000,
})

// Internal HLS endpoint (port 8888, not proxied through Nginx)
// Used to health-check the manifest right after registering a path.
const MEDIAMTX_HLS_INTERNAL = process.env.MEDIAMTX_HLS_URL || 'http://mediamtx:8888'

// ─── Cache local de paths registrados ───────────────────────────
// Evita POST/PATCH repetitivos que generan spam en logs de MediaMTX.
// Clave: streamPath. Valor: fingerprint de la config (source|transport|closeAfter).
// Se limpia en removeStream (path eliminado) y cuando el health worker detecta
// que MediaMTX ya no tiene el path (e.g. después de reinicio de MediaMTX).
const registeredPaths = new Map<string, string>()
// Evita solicitudes concurrentes duplicadas para el mismo path
const inFlightPaths   = new Set<string>()

// Transcoding config — read once at module load, no runtime overhead
// Accept both ENABLE_HEVC_TRANSCODING and the legacy alias ENABLE_HEVC_TRANSCODE
const ENABLE_HEVC_TRANSCODING  = process.env.ENABLE_HEVC_TRANSCODING === 'true' || process.env.ENABLE_HEVC_TRANSCODE === 'true'
const HEVC_TRANSCODE_PRESET    = process.env.HEVC_TRANSCODE_PRESET    || 'ultrafast'
const HEVC_TRANSCODE_WIDTH     = process.env.HEVC_TRANSCODE_WIDTH     || '1280'
const HEVC_TRANSCODE_FPS       = process.env.HEVC_TRANSCODE_FPS       || '15'
const HEVC_TRANSCODE_BITRATE   = process.env.HEVC_TRANSCODE_BITRATE   || '1500k'
const MEDIAMTX_RTSP_PORT       = process.env.MEDIAMTX_RTSP_PORT       || '8554'
const TRANSCODE_ENCODER        = process.env.TRANSCODE_ENCODER        || 'libx264'

// Derive MediaMTX hostname from MEDIAMTX_URL so FFmpeg publishes to the right host
const MEDIAMTX_HOST = (() => {
  try { return new URL(process.env.MEDIAMTX_URL || 'http://mediamtx:9997').hostname }
  catch { return 'mediamtx' }
})()

// ─── API-owned FFmpeg processes for transcoded streams ───────
// runOnDemand in MediaMTX executes inside the MediaMTX container, which
// doesn't have FFmpeg. We spawn FFmpeg from the API container instead.
const transcodeProcesses = new Map<string, ChildProcess>()
const transcodeStderr    = new Map<string, string>()

export function spawnTranscodeProcess(nvr: NVR, camera: Camera, streamPath: string): ChildProcess | null {
  const pass: string = (nvr as any).password ?? ''
  if (!pass) return null

  const rtspInput = buildRtspUrl(nvr, camera.channel, false)  // main (HEVC) stream
  if (/:@/.test(rtspInput)) return null  // empty password guard

  const rtspOutput = `rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_RTSP_PORT}/${streamPath}`

  // Compute bufsize = 2× bitrate (handles "1500k" → "3000k")
  const bitrateNum  = parseInt(HEVC_TRANSCODE_BITRATE) || 1500
  const bitrateUnit = HEVC_TRANSCODE_BITRATE.replace(/^\d+/, '') || 'k'
  const bufsize     = `${bitrateNum * 2}${bitrateUnit}`

  const args: string[] = [
    '-rtsp_transport', 'tcp',
    '-i', rtspInput,
    '-an',
    '-vf', `scale=${HEVC_TRANSCODE_WIDTH}:-2`,
    '-r', HEVC_TRANSCODE_FPS,
    '-c:v', TRANSCODE_ENCODER,
    '-preset', HEVC_TRANSCODE_PRESET,
  ]
  // -tune zerolatency only valid for libx264/libx265
  if (TRANSCODE_ENCODER === 'libx264' || TRANSCODE_ENCODER === 'libx265') {
    args.push('-tune', 'zerolatency')
  }
  args.push(
    '-b:v', HEVC_TRANSCODE_BITRATE,
    '-maxrate', HEVC_TRANSCODE_BITRATE,
    '-bufsize', bufsize,
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    rtspOutput,
  )

  // Kill any stale process for this path before spawning a new one
  stopTranscodeProcess(streamPath)

  const inputMasked = rtspInput.replace(/rtsp:\/\/([^:@]+):([^@]+)@/gi, 'rtsp://$1:***@')
  console.info(`[transcode] spawn_ffmpeg path=${streamPath} encoder=${TRANSCODE_ENCODER} input=${inputMasked}`)

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  transcodeProcesses.set(streamPath, proc)
  transcodeStderr.set(streamPath, '')  // reset stderr buffer on each spawn

  proc.on('spawn', () => {
    console.info(`[transcode] ffmpeg_started path=${streamPath} pid=${proc.pid}`)
  })

  proc.stderr?.on('data', (data: Buffer) => {
    let s = (transcodeStderr.get(streamPath) || '') + data.toString()
    if (s.length > 3000) s = s.slice(-3000)
    transcodeStderr.set(streamPath, s)
  })

  proc.on('exit', (code, signal) => {
    const summary = (transcodeStderr.get(streamPath) || '').slice(-400).replace(/\n/g, ' ')
    console.warn(`[transcode] ffmpeg_exit path=${streamPath} code=${code ?? signal} stderr=${summary}`)
    transcodeProcesses.delete(streamPath)
  })

  proc.on('error', (err) => {
    console.error(`[transcode] ffmpeg_error path=${streamPath} err=${err.message}`)
    transcodeProcesses.delete(streamPath)
  })

  return proc
}

export function stopTranscodeProcess(streamPath: string): void {
  const proc = transcodeProcesses.get(streamPath)
  if (!proc) return
  try { proc.kill('SIGTERM') } catch {}
  transcodeProcesses.delete(streamPath)
  console.info(`[transcode] ffmpeg_killed path=${streamPath}`)
}

export function isTranscodeProcessAlive(streamPath: string): boolean {
  const proc = transcodeProcesses.get(streamPath)
  return !!(proc && proc.exitCode === null && !proc.killed)
}

export function getTranscodeStderr(streamPath: string): string {
  return (transcodeStderr.get(streamPath) || '').slice(-500)
}

export function isTranscodingEnabled(): boolean { return ENABLE_HEVC_TRANSCODING }

// ─── Wait for HLS manifest with real segment data ───────────
// Polls internal MediaMTX HLS port waiting for FFmpeg (spawned by API) to start
// publishing. Validates body — requires #EXTM3U + a segment reference (#EXTINF,
// .ts, .m4s) to avoid accepting a stub manifest MediaMTX emits before FFmpeg data.
// isAlive: optional callback checked each interval — if it returns false the
// wait aborts immediately (FFmpeg exited early) instead of waiting full timeout.
export async function waitForHlsReady(
  streamPath: string,
  maxWaitMs = 12_000,
  intervalMs = 300,
  isAlive?: () => boolean,
): Promise<{ ready: boolean; lastStatus: number; elapsedMs: number; processExited: boolean }> {
  const url      = `${MEDIAMTX_HLS_INTERNAL}/${streamPath}/index.m3u8`
  const startMs  = Date.now()
  const attempts = Math.ceil(maxWaitMs / intervalMs)
  let lastStatus   = 0
  let lastLoggedAt = 0

  console.info(`[transcode] waiting_hls path=${streamPath}`)

  for (let i = 0; i < attempts; i++) {
    const now = Date.now()

    // Early exit if FFmpeg process has died — no point waiting the full timeout
    if (isAlive && !isAlive()) {
      const elapsed = now - startMs
      console.warn(`[transcode] waiting_hls aborted path=${streamPath} reason=process_exited elapsedMs=${elapsed}`)
      return { ready: false, lastStatus, elapsedMs: elapsed, processExited: true }
    }

    try {
      const res = await axios.get(url, {
        timeout: 2000,
        validateStatus: () => true,
        responseType: 'text',
      })
      lastStatus = res.status
      const body = typeof res.data === 'string' ? res.data : ''

      // A valid, playable manifest must have the M3U8 header AND at least one
      // segment reference. MediaMTX emits #EXTM3U-only stubs before FFmpeg
      // data arrives; those cause immediate 500 on the first segment fetch.
      const hasHeader  = body.includes('#EXTM3U')
      const hasSegment = body.includes('#EXTINF') || body.includes('.ts') || body.includes('.m4s')

      if (res.status === 200 && hasHeader && hasSegment) {
        const elapsed = now - startMs
        console.info(`[transcode] hls_ready path=${streamPath} attempt=${i + 1} elapsedMs=${elapsed}`)
        return { ready: true, lastStatus, elapsedMs: elapsed, processExited: false }
      }

      // Throttle per-attempt logs to once per second
      if (now - lastLoggedAt >= 1000) {
        console.info(`[transcode] waiting_hls path=${streamPath} attempt=${i + 1} status=${res.status} header=${hasHeader} segment=${hasSegment}`)
        lastLoggedAt = now
      }
    } catch {
      // network/timeout — keep polling
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs))
  }

  const elapsed = Date.now() - startMs
  console.warn(`[transcode] hls_timeout path=${streamPath} lastStatus=${lastStatus} elapsedMs=${elapsed}`)
  return { ready: false, lastStatus, elapsedMs: elapsed, processExited: false }
}

// ─── FFmpeg capability detection ────────────────────────────
// Run once on first call; cached for the process lifetime.
interface FfmpegCaps { available: boolean; encoders: string[] }
let _ffmpegCaps: FfmpegCaps | null = null

export function getFfmpegCapabilities(): FfmpegCaps {
  if (_ffmpegCaps) return _ffmpegCaps
  try {
    execSync('which ffmpeg', { timeout: 3000, stdio: 'pipe' })
  } catch {
    _ffmpegCaps = { available: false, encoders: [] }
    console.warn('[stream] ffmpeg not found — HEVC transcoding unavailable')
    return _ffmpegCaps
  }
  const wantedEncoders = ['libx264', 'h264_nvenc', 'h264_vaapi', 'h264_qsv']
  const found: string[] = []
  try {
    const out = execSync('ffmpeg -encoders 2>&1', { timeout: 8000, stdio: 'pipe' }).toString()
    for (const enc of wantedEncoders) { if (out.includes(enc)) found.push(enc) }
  } catch {}
  _ffmpegCaps = { available: true, encoders: found }
  console.info(`[stream] ffmpeg available encoders=[${found.join(', ') || 'none-detected'}]`)
  return _ffmpegCaps
}

function configFingerprint(source: string, streamType: 'sub' | 'main'): string {
  return `${source}|tcp|10m|${streamType}`
}

export function clearRegisteredPath(streamPath: string): void {
  registeredPaths.delete(streamPath)
}

// Lista los paths configurados actualmente en MediaMTX.
// Retorna null si la API está caída (el llamador debe manejar este caso).
export async function listRegisteredConfigPaths(): Promise<Set<string> | null> {
  try {
    const res = await mediamtxApi.get('/v3/config/paths/list')
    const items: any[] = res.data?.items || []
    return new Set(items.map((p: any) => p.name).filter(Boolean))
  } catch {
    return null  // API no disponible — el llamador decide si reintenta
  }
}

// Nombre del path en MediaMTX para una cámara.
// streamType='sub' → Channels/102 (H264); 'main' → Channels/101 (puede ser HEVC)
export function getStreamPath(nvr: NVR, camera: Camera, streamType: 'sub' | 'main' = 'sub'): string {
  return `nvr_${nvr.id}_ch${String(camera.channel).padStart(2, '0')}_${streamType}`
}

// Path para stream transcodificado HEVC → H.264 via FFmpeg + MediaMTX runOnDemand
export function getTranscodedStreamPath(nvr: NVR, camera: Camera): string {
  return `nvr_${nvr.id}_ch${String(camera.channel).padStart(2, '0')}_main_h264`
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
export async function publishStream(nvr: NVR, camera: Camera, streamType: 'sub' | 'main' = 'sub'): Promise<boolean> {
  const streamPath = getStreamPath(nvr, camera, streamType)

  // Bloquear publicación si la contraseña está vacía (credencial no descifrada o no configurada)
  const pass: string = (nvr as any).password ?? ''
  if (!pass) {
    console.error(`[stream] PASSWORD_EMPTY — omitiendo path ${streamPath} (nvr=${nvr.id} ip=${nvr.ipAddress}). Verifica NVR_CREDENTIAL_KEY y vuelve a guardar las credenciales.`)
    return false
  }

  // Evitar solicitudes concurrentes duplicadas para el mismo path
  if (inFlightPaths.has(streamPath)) return true

  const useSub = streamType === 'sub'
  const rtspUrl = buildRtspUrl(nvr, camera.channel, useSub)

  // Guardia de seguridad: rechazar URLs con contraseña vacía (rtsp://user:@host)
  if (/:@/.test(rtspUrl)) {
    console.error(`[stream] RTSP_EMPTY_CREDENTIALS — URL contiene contraseña vacía para ${streamPath}. Abortando publicación.`)
    return false
  }

  const pathConfig = {
    source: rtspUrl,
    sourceOnDemand: true,
    sourceOnDemandStartTimeout: '8s',
    sourceOnDemandCloseAfter: '10m',
    rtspTransport: 'tcp',
    record: false,
    overridePublisher: true,
  }

  const fp = configFingerprint(rtspUrl, streamType)

  // Si el path ya fue registrado con la misma config, no repetir POST/PATCH.
  // Esto elimina el spam de "path already exists" y "reloading configuration".
  if (registeredPaths.get(streamPath) === fp) return true

  const sourceMasked = rtspUrl.replace(/rtsp:\/\/([^:@]+):([^@]+)@/gi, 'rtsp://$1:***@')
  console.info(`[stream] publish path=${streamPath} type=${streamType} codec=${useSub ? (camera as any).subCodec || '?' : (camera as any).mainCodec || '?'} source=${sourceMasked}`)

  inFlightPaths.add(streamPath)
  try {
    try {
      // Optimistic POST — si el path ya existe MediaMTX devuelve 400.
      await mediamtxApi.post('/v3/config/paths/add/' + streamPath, pathConfig)
      registeredPaths.set(streamPath, fp)
      console.info(`[stream] path created: ${streamPath}`)
      return true
    } catch (err: any) {
      const status = err.response?.status

      if (status === 400) {
        // Path ya existe. Si el fingerprint coincide con el caché, no hay nada que actualizar.
        // Si no coincide (cambió preferredStream, IP, etc.), hacer PATCH para actualizar.
        if (registeredPaths.get(streamPath) === fp) {
          // Config sin cambios — tratar como éxito sin PATCH (evita "reloading configuration")
          return true
        }
        try {
          await mediamtxApi.patch('/v3/config/paths/patch/' + streamPath, pathConfig)
          registeredPaths.set(streamPath, fp)
          console.info(`[stream] path updated: ${streamPath}`)
          return true
        } catch (patchErr: any) {
          if (patchErr.response?.status === 404) {
            try {
              await mediamtxApi.post('/v3/config/paths/add/' + streamPath, pathConfig)
              registeredPaths.set(streamPath, fp)
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

      if (status === 401 || status === 403) {
        console.error(`[stream] MediaMTX auth error (${status}) para ${streamPath} — verificar mediamtx.yml`)
        return false
      }

      console.error(`[stream] failed to register path ${streamPath}:`, status, err.message)
      return false
    }
  } finally {
    inFlightPaths.delete(streamPath)
  }
}

// ─── Publicar path receptor pasivo para stream transcodificado ──
// Registra el path en MediaMTX como receptor RTSP pasivo (sin runOnDemand).
// FFmpeg es iniciado por el API (spawnTranscodeProcess) y publica a este path.
// MediaMTX solo espera al publisher; no ejecuta FFmpeg por sí mismo.
export async function publishTranscodedStream(nvr: NVR, camera: Camera): Promise<boolean> {
  if (!ENABLE_HEVC_TRANSCODING) return false

  const streamPath = getTranscodedStreamPath(nvr, camera)
  const pass: string = (nvr as any).password ?? ''
  if (!pass) {
    console.error(`[stream] PASSWORD_EMPTY — skipping transcoded path ${streamPath}`)
    return false
  }

  if (inFlightPaths.has(streamPath)) return true

  // Passive RTSP receiver — no source, no runOnDemand.
  // Explicitly clear runOnDemand/source so paths previously registered with
  // runOnDemand (old config) get properly updated to passive receiver mode.
  const pathConfig = {
    source:               '',
    runOnDemand:          '',
    runOnDemandCloseAfter:'',
    record:               false,
    overridePublisher:    true,
  }

  const fp = `passive_receiver_v2|${streamPath}`
  if (registeredPaths.get(streamPath) === fp) return true

  console.info(`[stream] publish-transcoded path=${streamPath} type=passive_receiver encoder=${TRANSCODE_ENCODER}`)

  inFlightPaths.add(streamPath)
  try {
    try {
      await mediamtxApi.post('/v3/config/paths/add/' + streamPath, pathConfig)
      registeredPaths.set(streamPath, fp)
      console.info(`[stream] transcoded path created: ${streamPath}`)
      return true
    } catch (err: any) {
      if (err.response?.status === 400) {
        // Path exists — PATCH to ensure it's a passive receiver (clears old runOnDemand)
        try {
          await mediamtxApi.patch('/v3/config/paths/patch/' + streamPath, pathConfig)
          registeredPaths.set(streamPath, fp)
          console.info(`[stream] transcoded path updated to passive_receiver: ${streamPath}`)
          return true
        } catch {
          return false
        }
      }
      console.error(`[stream] transcoded path error: ${err.message}`)
      return false
    }
  } finally {
    inFlightPaths.delete(streamPath)
  }
}

// ─── Eliminar stream de MediaMTX ────────────────────────────
export async function removeStream(nvr: NVR, camera: Camera, streamType?: 'sub' | 'main'): Promise<void> {
  const typesToRemove: ('sub' | 'main')[] = streamType ? [streamType] : ['sub', 'main']
  for (const t of typesToRemove) {
    try {
      const streamPath = getStreamPath(nvr, camera, t)
      registeredPaths.delete(streamPath)
      await mediamtxApi.delete('/v3/config/paths/delete/' + streamPath)
    } catch {
      // Ignorar errores al eliminar
    }
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
