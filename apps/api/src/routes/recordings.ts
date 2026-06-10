// apps/api/src/routes/recordings.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { searchRecordings } from '../services/hikvision'
import { AuditAction } from '../services/audit'
import {
  waitForHlsReady,
  spawnTranscodeFromRtsp,
  stopTranscodeProcess,
  isTranscodeProcessAlive,
} from '../services/stream'
import CryptoJS from 'crypto-js'
import axios from 'axios'
import crypto from 'crypto'
import { spawn } from 'child_process'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// ─── MediaMTX clients ─────────────────────────────────────────────
const mediamtxApi = axios.create({
  baseURL: process.env.MEDIAMTX_URL || 'http://mediamtx:9997',
  timeout: 8000,
})

// When true, all recordings are forced through FFmpeg/H.264 regardless of detected codec.
// Use this as a diagnostic override when ffprobe can't reach the RTSP URL.
const RECORDINGS_FORCE_TRANSCODE = process.env.RECORDINGS_FORCE_TRANSCODE === 'true'

// ─── In-memory recording playback sessions ────────────────────────
const RECORDING_SESSION_TTL_MS = 30 * 60 * 1000  // 30 minutes
interface RecordingSession {
  streamPath:    string
  expiresAt:     number
  userId:        string
  isTranscoded?: boolean  // true = FFmpeg transcoding active; cleanup kills the process
}
const recordingSessions = new Map<string, RecordingSession>()

/** Detect HEVC from a codec string (mainCodec DB field or CODECS= manifest attribute) */
function isHevcCodec(codec: string | null | undefined): boolean {
  if (!codec) return false
  const c = codec.toLowerCase()
  return c.includes('265') || c.includes('hevc') || c === 'hvc1' || c === 'hev1'
}

/** Probe the RTSP URL with ffprobe to detect the video codec BEFORE choosing playback mode.
 *  Returns the codec_name (e.g. "hevc", "h264") or null on failure/timeout.
 *  NEVER logs rtspUrl — only maskedUrl is safe for logs. */
async function probeRtspCodec(rtspUrl: string, maskedUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'v:0',
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
    ]

    let stdout = ''
    let settled = false
    const settle = (val: string | null) => {
      if (settled) return
      settled = true
      resolve(val)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (err: any) {
      console.warn(`[recordings] ffprobe_spawn_error maskedUrl=${maskedUrl} err=${err.message}`)
      return settle(null)
    }

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      console.warn(`[recordings] ffprobe_timeout maskedUrl=${maskedUrl}`)
      settle(null)
    }, 10_000)

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      try {
        const parsed = JSON.parse(stdout)
        const streams: any[] = parsed?.streams ?? []
        const video = streams.find((s: any) => s.codec_type === 'video')
        const codecName: string | null = video?.codec_name ?? null
        console.info(`[recordings] ffprobe_result maskedUrl=${maskedUrl} codec_name=${codecName ?? 'null'} code=${code}`)
        settle(codecName)
      } catch {
        console.warn(`[recordings] ffprobe_parse_failed maskedUrl=${maskedUrl} code=${code} stdoutLen=${stdout.length}`)
        settle(null)
      }
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timer)
      console.warn(`[recordings] ffprobe_error maskedUrl=${maskedUrl} err=${err.message}`)
      settle(null)
    })
  })
}

// Periodic cleanup of expired recording sessions
setInterval(async () => {
  const now = Date.now()
  for (const [sid, session] of recordingSessions.entries()) {
    if (now > session.expiresAt) {
      recordingSessions.delete(sid)
      if (session.isTranscoded) {
        stopTranscodeProcess(session.streamPath)
      } else {
        mediamtxApi.delete(`/v3/config/paths/delete/${session.streamPath}`).catch(() => {})
      }
    }
  }
}, 5 * 60 * 1000)

// ─── RTSP URL helpers ─────────────────────────────────────────────

/** Inject credentials+host into a path-only playbackURI from the NVR.
 *  The NVR's playbackURI contains the exact path+query needed to locate the recording
 *  (including name, size, and other NVR-internal params the NVR requires).
 *  We always use the DB-configured ipAddress:rtspPort — the NVR sometimes returns
 *  0.0.0.0 or an internal LAN IP that isn't reachable from MediaMTX.
 */
function injectCredentialsIntoPlaybackUri(opts: {
  playbackURI: string   // path+query only, e.g. /Streaming/tracks/101?starttime=...&name=...
  username:    string
  password:    string
  ipAddress:   string
  rtspPort:    number
}): { url: string; masked: string } {
  const { playbackURI, username, password, ipAddress, rtspPort } = opts
  const encodedPass = encodeURIComponent(password)
  const pathQuery   = playbackURI.startsWith('/') ? playbackURI : `/${playbackURI}`
  return {
    url:    `rtsp://${username}:${encodedPass}@${ipAddress}:${rtspPort}${pathQuery}`,
    masked: `rtsp://${username}:***@${ipAddress}:${rtspPort}${pathQuery}`,
  }
}

/** Fallback: construct RTSP URL from timestamps when playbackURI is not in search results.
 *  Uses track channel * 100 + 1 (same formula as searchRecordings / ISAPI trackID).
 *  NOTE: some NVRs reject this URL because it lacks the 'name' and 'size' params that
 *  uniquely identify the recording segment. Use the NVR's playbackURI when available. */
function buildFallbackRecordingRtspUrl(opts: {
  username:  string
  password:  string
  ipAddress: string
  rtspPort:  number
  channel:   number
  start:     Date
  end:       Date
}): { url: string; masked: string; trackId: number } {
  const { username, password, ipAddress, rtspPort, channel, start, end } = opts
  const trackId     = channel * 100 + 1
  const encodedPass = encodeURIComponent(password)
  const fmtTs       = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  const pathQuery   = `/Streaming/tracks/${trackId}?starttime=${fmtTs(start)}&endtime=${fmtTs(end)}`
  return {
    url:    `rtsp://${username}:${encodedPass}@${ipAddress}:${rtspPort}${pathQuery}`,
    masked: `rtsp://${username}:***@${ipAddress}:${rtspPort}${pathQuery}`,
    trackId,
  }
}

// ─── Register a recording path in MediaMTX ───────────────────────
// MediaMTX pulls the RTSP directly (source-pull, no FFmpeg).
async function createRecordingHlsPath(
  rtspUrl: string,
  maskedUrl: string,
  streamPath: string,
  log: (msg: string) => void,
): Promise<void> {
  const config = {
    source:            rtspUrl,
    sourceOnDemand:    false,   // pull immediately — recording is finite, not on-demand
    rtspTransport:     'tcp',
    record:            false,
    overridePublisher: true,
  }

  log(`[recordings] mediamtx_path_add path=${streamPath} source=${maskedUrl}`)
  try {
    await mediamtxApi.post(`/v3/config/paths/add/${streamPath}`, config)
    log(`[recordings] mediamtx_path_add ok path=${streamPath}`)
  } catch (err: any) {
    const status = err.response?.status
    if (status === 400) {
      // Path already exists — patch it with the new source
      log(`[recordings] mediamtx_path_patch path=${streamPath} (was 400 — already existed)`)
      await mediamtxApi.patch(`/v3/config/paths/patch/${streamPath}`, config)
      log(`[recordings] mediamtx_path_patch ok path=${streamPath}`)
    } else {
      const body = JSON.stringify(err.response?.data ?? {}).slice(0, 200)
      log(`[recordings] mediamtx_path_add FAILED path=${streamPath} status=${status} body=${body}`)
      throw err
    }
  }
}

// ─── Query live path status in MediaMTX ──────────────────────────
// /v3/paths/get/:name (live endpoint, not config) tells us if the source is connected.
async function getMediaMtxPathStatus(streamPath: string): Promise<{
  exists: boolean
  ready:  boolean
  tracks: number
  sourceState: string
}> {
  try {
    const res = await mediamtxApi.get(`/v3/paths/get/${streamPath}`, {
      timeout: 3000,
      validateStatus: () => true,
    })
    if (res.status === 404) {
      return { exists: false, ready: false, tracks: 0, sourceState: 'not_found' }
    }
    const d = res.data ?? {}
    return {
      exists:      true,
      ready:       d.ready === true,
      tracks:      (d.tracks ?? []).length,
      sourceState: d.ready === true ? 'connected' : 'connecting_or_failed',
    }
  } catch (err: any) {
    return { exists: false, ready: false, tracks: 0, sourceState: `error:${err.message}` }
  }
}

// In-memory capability cache: nvrId → 'isapi' | 'unsupported' | 'auth_error'
const nvrCapabilityCache = new Map<string, { result: string; expiresAt: number }>()
const CAPABILITY_TTL_MS = 15 * 60 * 1000  // 15 minutes

function getCachedCapability(nvrId: string): string | null {
  const entry = nvrCapabilityCache.get(nvrId)
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry.result
}
function setCachedCapability(nvrId: string, result: string) {
  nvrCapabilityCache.set(nvrId, { result, expiresAt: Date.now() + CAPABILITY_TTL_MS })
}

const searchSchema = z.object({
  cameraId:  z.string().min(1),
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
})

const batchSearchSchema = z.object({
  nvrId:     z.string().min(1),
  cameraIds: z.array(z.string().min(1)).min(1).max(128),
  from:      z.string().datetime(),
  to:        z.string().datetime(),
})

const playbackSchema = z.object({
  cameraId:    z.string().min(1),
  startTime:   z.string().datetime(),
  endTime:     z.string().datetime(),
  /** Path+query from the NVR's searchRecordings result — used directly for MediaMTX source-pull.
   *  Must start with / (e.g. /Streaming/tracks/101?starttime=...&name=...&size=...).
   *  When provided, avoids the NVR-404 caused by constructing the URL from timestamps alone. */
  playbackURI: z.string().startsWith('/').optional(),
})

export const recordingRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/recordings/search — Buscar grabaciones (single camera, legacy)
  server.get('/search', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user  = request.user
    const query = searchSchema.parse(request.query)

    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const camera = await server.prisma.camera.findUnique({
      where: { id: query.cameraId }, include: { nvr: true },
    })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    if (user.role === 'AUDITOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: query.cameraId, canPlayback: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso para grabaciones de esta cámara' })
    }

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }

    let recordings
    try {
      recordings = await searchRecordings(nvr as any, camera.channel, new Date(query.startTime), new Date(query.endTime))
    } catch (err: any) {
      if (err?.unsupported) return reply.status(422).send({ code: 'ISAPI_UNSUPPORTED', message: 'Este NVR no soporta búsqueda de grabaciones vía ISAPI', nvrModel: camera.nvr.model })
      if (err?.authError)   return reply.status(502).send({ code: 'NVR_AUTH_ERROR', message: 'Error de autenticación con el NVR' })
      return reply.status(502).send({ code: 'NVR_ERROR', message: 'No se pudo contactar el NVR' })
    }

    const withUri = recordings.filter(r => r.playbackURI).length
    server.log.info(
      `[recordings] search_complete nvrId=${camera.nvr.id} ch=${camera.channel}` +
      ` total=${recordings.length} withPlaybackUri=${withUri}` +
      (recordings.length > 0 && withUri === 0 ? ' WARN:no_playbackURI_in_results' : '')
    )

    await AuditAction(server.prisma, user.sub, 'SEARCH_RECORDINGS', query.cameraId, request, {
      startTime: query.startTime, endTime: query.endTime, resultsCount: recordings.length,
    })

    return reply.send({ recordings, source: 'nvr_isapi', camera: { id: camera.id, name: camera.name, channel: camera.channel }, nvrModel: camera.nvr.model })
  })

  // POST /api/recordings/batch-search — Buscar grabaciones para múltiples cámaras de un NVR
  // Evita N requests al frontend y comparte el check de capacidad del NVR
  server.post('/batch-search', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const body = batchSearchSchema.parse(request.body)
    const from  = new Date(body.from)
    const to    = new Date(body.to)

    if (from >= to) return reply.status(400).send({ message: 'La fecha "from" debe ser anterior a "to"' })

    // Load NVR
    const nvr = await server.prisma.nVR.findUnique({ where: { id: body.nvrId } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    // Load cameras filtering to those in the requested list
    const cameras = await server.prisma.camera.findMany({
      where: { id: { in: body.cameraIds }, nvrId: body.nvrId },
    })
    if (cameras.length === 0) return reply.status(404).send({ message: 'No se encontraron cámaras para este NVR' })

    // AUDITOR: filter to cameras they have canPlayback permission on
    let allowedIds = cameras.map(c => c.id)
    if (user.role === 'AUDITOR') {
      const perms = await server.prisma.userPermission.findMany({
        where: { userId: user.sub, cameraId: { in: allowedIds }, canPlayback: true },
      })
      const permSet = new Set(perms.map(p => p.cameraId).filter(Boolean) as string[])
      allowedIds = allowedIds.filter(id => permSet.has(id))
      if (allowedIds.length === 0) return reply.send({ results: [], unsupportedNvr: false, errors: [] })
    }

    const nvrWithPass = { ...nvr, password: decryptPass(nvr.password) }

    // Check capability cache before making any ISAPI calls
    const cachedCap = getCachedCapability(nvr.id)
    if (cachedCap === 'unsupported') {
      return reply.send({
        results: [],
        unsupportedNvr: true,
        nvrModel: nvr.model,
        nvrName: nvr.name,
        playbackWebUrl: (nvr as any).playbackWebUrl ?? null,
        errors: [],
        cameraCount: allowedIds.length,
      })
    }
    if (cachedCap === 'auth_error') {
      return reply.send({
        results: [],
        unsupportedNvr: false,
        authError: true,
        nvrModel: nvr.model,
        nvrName: nvr.name,
        errors: [{ code: 'NVR_AUTH_ERROR', message: 'Error de autenticación con el NVR' }],
        cameraCount: allowedIds.length,
      })
    }

    const allowedCameras = cameras.filter(c => allowedIds.includes(c.id))
    const results: Array<{ cameraId: string; cameraName: string; channel: number; recordings: any[] }> = []
    let unsupportedNvr = false

    // Search camera by camera — first failure for unsupported/auth short-circuits the rest
    for (const camera of allowedCameras) {
      if (unsupportedNvr) break
      try {
        const recs = await searchRecordings(nvrWithPass as any, camera.channel, from, to)
        const withUri = recs.filter(r => r.playbackURI).length
        server.log.info(
          `[recordings] batch_search nvrId=${nvr.id} ch=${camera.channel}` +
          ` total=${recs.length} withPlaybackUri=${withUri}` +
          (recs.length > 0 && withUri === 0 ? ' WARN:no_playbackURI_in_results' : '')
        )
        results.push({ cameraId: camera.id, cameraName: camera.name, channel: camera.channel, recordings: recs })
        setCachedCapability(nvr.id, 'isapi')  // at least one success
      } catch (err: any) {
        if (err?.unsupported) {
          setCachedCapability(nvr.id, 'unsupported')
          unsupportedNvr = true
          break
        }
        if (err?.authError) {
          setCachedCapability(nvr.id, 'auth_error')
          return reply.send({
            results,
            unsupportedNvr: false,
            authError: true,
            nvrModel: nvr.model,
            nvrName: nvr.name,
            errors: [{ code: 'NVR_AUTH_ERROR', message: 'Error de autenticación con el NVR', cameraId: camera.id }],
            cameraCount: allowedIds.length,
          })
        }
        results.push({ cameraId: camera.id, cameraName: camera.name, channel: camera.channel, recordings: [] })
      }
    }

    if (results.length > 0) {
      await AuditAction(server.prisma, user.sub, 'SEARCH_RECORDINGS', body.nvrId, request, {
        from: body.from, to: body.to, cameras: allowedIds.length,
        total: results.reduce((s, r) => s + r.recordings.length, 0),
      })
    }

    return reply.send({
      results,
      unsupportedNvr,
      nvrModel: nvr.model,
      nvrName:  nvr.name,
      playbackWebUrl: unsupportedNvr ? ((nvr as any).playbackWebUrl ?? null) : undefined,
      errors:   [],
      cameraCount: allowedIds.length,
    })
  })

  // POST /api/recordings/playback — Start recording playback via MediaMTX HLS proxy.
  // H.264 recordings: MediaMTX source-pull (direct, no FFmpeg).
  // H.265/HEVC recordings: FFmpeg transcodes → H.264 → MediaMTX RTSP publish → HLS.
  // Either way returns /hls/rec_<sessionId>/index.m3u8 — no RTSP or credentials to browser.
  server.post('/playback', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    const body = playbackSchema.parse(request.body)

    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const camera = await server.prisma.camera.findUnique({
      where: { id: body.cameraId }, include: { nvr: true },
    })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    if (user.role === 'AUDITOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: body.cameraId, canPlayback: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso de reproducción' })
    }

    const plainPass = decryptPass(camera.nvr.password)
    if (!plainPass) {
      return reply.status(422).send({ message: 'No se pueden descifrar las credenciales del NVR' })
    }

    // ── Build RTSP source URL ─────────────────────────────────────────────────
    // Strategy A (preferred): NVR's playbackURI from ISAPI search (includes name/size params)
    // Strategy B (fallback): construct from timestamps — may fail on NVRs needing name/size
    let rtspUrl: string
    let rtspMasked: string
    let trackId: number | undefined
    let urlStrategy: string

    if (body.playbackURI) {
      const injected = injectCredentialsIntoPlaybackUri({
        playbackURI: body.playbackURI,
        username:    camera.nvr.username,
        password:    plainPass,
        ipAddress:   camera.nvr.ipAddress,
        rtspPort:    camera.nvr.rtspPort,
      })
      rtspUrl     = injected.url
      rtspMasked  = injected.masked
      urlStrategy = 'nvr_playbackURI'
    } else {
      const built = buildFallbackRecordingRtspUrl({
        username:  camera.nvr.username,
        password:  plainPass,
        ipAddress: camera.nvr.ipAddress,
        rtspPort:  camera.nvr.rtspPort,
        channel:   camera.channel,
        start:     new Date(body.startTime),
        end:       new Date(body.endTime),
      })
      rtspUrl     = built.url
      rtspMasked  = built.masked
      trackId     = built.trackId
      urlStrategy = 'fallback_timestamps'
    }

    // ── Codec detection: ffprobe over the RTSP playbackURI BEFORE choosing mode ──
    // ffprobe probes the recording stream directly — more reliable than camera.mainCodec
    // (which may be null or stale) and avoids starting a MediaMTX path only to tear it
    // down 25s later after the HLS manifest reveals HEVC.
    const ffprobeCodec  = await probeRtspCodec(rtspUrl, rtspMasked)
    // Fallback cascade: ffprobe → DB field → unknown
    const detectedCodec = ffprobeCodec ?? camera.mainCodec ?? null
    // RECORDINGS_FORCE_TRANSCODE overrides detection — forces all recordings through FFmpeg
    const isHevc        = RECORDINGS_FORCE_TRANSCODE || isHevcCodec(detectedCodec)
    const playbackMode  = isHevc ? 'transcoded_h264' : 'direct_hls'

    const sessionId     = crypto.randomBytes(8).toString('hex')
    const directPath    = `rec_${sessionId}`
    const transcodePath = `rec_${sessionId}_h264`
    const finalPath     = isHevc ? transcodePath : directPath
    const expiresAt     = new Date(Date.now() + RECORDING_SESSION_TTL_MS).toISOString()

    server.log.info(
      `[recordings] playback_init sessionId=${sessionId}` +
      ` cameraId=${body.cameraId} ch=${camera.channel}` +
      ` camera.mainCodec=${camera.mainCodec ?? 'null'}` +
      ` camera.subCodec=${(camera as any).subCodec ?? 'null'}` +
      ` ffprobeCodec=${ffprobeCodec ?? 'null'}` +
      ` detectedCodec=${detectedCodec ?? 'unknown'}` +
      ` isHevc=${isHevc}` +
      ` forceTranscode=${RECORDINGS_FORCE_TRANSCODE}` +
      ` playbackMode=${playbackMode}` +
      ` finalPath=${finalPath}` +
      (trackId ? ` trackId=${trackId}` : '') +
      ` strategy=${urlStrategy} source=${rtspMasked}`
    )

    // ── Helper: spawn FFmpeg transcoding and wait for HLS ─────────────────────
    const runTranscoded = async (): Promise<{ hlsUrl: string; transcoded: true } | null> => {
      recordingSessions.set(sessionId, {
        streamPath: transcodePath, expiresAt: Date.now() + RECORDING_SESSION_TTL_MS,
        userId: user.sub, isTranscoded: true,
      })

      const proc = spawnTranscodeFromRtsp(rtspUrl, rtspMasked, transcodePath)
      if (!proc) {
        recordingSessions.delete(sessionId)
        return null
      }

      const isAlive = () => isTranscodeProcessAlive(transcodePath)
      const ready   = await waitForHlsReady(transcodePath, 40_000, 800, isAlive)

      if (!ready.ready) {
        recordingSessions.delete(sessionId)
        stopTranscodeProcess(transcodePath)

        const diagMsg = ready.processExited
          ? 'FFmpeg terminó antes de generar HLS (RTSP inaccesible o error de codec)'
          : 'FFmpeg no generó segmentos HLS en tiempo (NVR lento o grabación muy corta)'

        server.log.warn(
          `[recordings] hls_not_ready sessionId=${sessionId} mode=transcoded` +
          ` lastStatus=${ready.lastStatus} elapsedMs=${ready.elapsedMs}ms` +
          ` processExited=${ready.processExited} source=${rtspMasked}`
        )

        await reply.status(504).send({
          code:    'HLS_TIMEOUT',
          message: 'No se pudo transcodificar la grabación H.265',
          detail:  diagMsg,
          diagnostic: { playbackMode: 'transcoded_h264', lastHlsStatus: ready.lastStatus, elapsedMs: ready.elapsedMs },
        })
        return null
      }

      server.log.info(
        `[recordings] playback_started sessionId=${sessionId} path=${transcodePath}` +
        ` mode=transcoded_h264 hlsReady=${ready.elapsedMs}ms transcoded=true`
      )
      return { hlsUrl: `/hls/${transcodePath}/index.m3u8`, transcoded: true }
    }

    // ── Route: HEVC detected → FFmpeg transcoding ─────────────────────────────
    // ffprobe confirmed HEVC (or RECORDINGS_FORCE_TRANSCODE=true) — go directly to FFmpeg.
    // NEVER call mediamtx_path_add with a direct RTSP source for HEVC streams.
    if (isHevc) {
      const result = await runTranscoded()
      if (!result) {
        if (!reply.sent) {
          return reply.status(502).send({ code: 'FFMPEG_SPAWN_FAILED', message: 'No se pudo iniciar FFmpeg para H.265' })
        }
        return
      }
      await AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
        startTime: body.startTime, endTime: body.endTime, sessionId,
        playbackMode: 'transcoded_h264', transcoded: true, detectedCodec,
      })
      return reply.send({ url: result.hlsUrl, sessionId, expiresAt, transcoded: true })
    }

    // ── Route: H.264 detected → direct MediaMTX source-pull ──────────────────
    try {
      await createRecordingHlsPath(rtspUrl, rtspMasked, directPath, (msg) => server.log.info(msg))
    } catch (err: any) {
      server.log.error(`[recordings] mediamtx_path_create_failed sessionId=${sessionId} err=${err.message}`)
      return reply.status(502).send({
        code:    'MEDIAMTX_ERROR',
        message: 'No se pudo registrar el path en MediaMTX',
        detail:  err.response?.data?.error || err.message,
      })
    }

    recordingSessions.set(sessionId, {
      streamPath: directPath, expiresAt: Date.now() + RECORDING_SESSION_TTL_MS,
      userId: user.sub,
    })

    const directReady = await waitForHlsReady(directPath, 25_000, 800)

    if (!directReady.ready) {
      const pathStatus = await getMediaMtxPathStatus(directPath)
      recordingSessions.delete(sessionId)
      mediamtxApi.delete(`/v3/config/paths/delete/${directPath}`).catch(() => {})

      const diagMsg = !pathStatus.exists
        ? 'Path no encontrado en MediaMTX'
        : pathStatus.ready
          ? 'RTSP conectado pero HLS no generó segmentos en tiempo'
          : 'MediaMTX no pudo conectar al RTSP del NVR (URL incorrecta o NVR sin soporte playback)'

      server.log.warn(
        `[recordings] hls_not_ready sessionId=${sessionId} mode=direct` +
        ` lastStatus=${directReady.lastStatus} elapsedMs=${directReady.elapsedMs}ms` +
        ` pathExists=${pathStatus.exists} pathReady=${pathStatus.ready}` +
        ` sourceState=${pathStatus.sourceState} strategy=${urlStrategy}` +
        (trackId ? ` trackId=${trackId}` : '') + ` source=${rtspMasked}`
      )

      return reply.status(504).send({
        code:    'HLS_TIMEOUT',
        message: 'MediaMTX no publicó la grabación en tiempo',
        detail:  diagMsg,
        diagnostic: {
          trackId, pathExists: pathStatus.exists, pathReady: pathStatus.ready,
          sourceState: pathStatus.sourceState, lastHlsStatus: directReady.lastStatus,
          elapsedMs: directReady.elapsedMs, rtspSource: rtspMasked,
        },
      })
    }

    server.log.info(
      `[recordings] playback_started sessionId=${sessionId} path=${directPath}` +
      ` mode=direct_hls detectedCodec=${detectedCodec ?? 'null'} hlsReady=${directReady.elapsedMs}ms transcoded=false`
    )

    await AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
      startTime: body.startTime, endTime: body.endTime, sessionId,
      playbackMode: 'direct_hls', transcoded: false, detectedCodec,
    })

    return reply.send({ url: `/hls/${directPath}/index.m3u8`, sessionId, expiresAt, transcoded: false })
  })

  // DELETE /api/recordings/playback/:sessionId — Stop playback and release resources
  server.delete('/playback/:sessionId', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)
    if (!session) return reply.status(404).send({ message: 'Sesión no encontrada' })
    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }
    recordingSessions.delete(sessionId)
    if (session.isTranscoded) {
      stopTranscodeProcess(session.streamPath)
    } else {
      await mediamtxApi.delete(`/v3/config/paths/delete/${session.streamPath}`).catch(() => {})
    }
    server.log.info(
      `[recordings] playback_stopped sessionId=${sessionId} path=${session.streamPath}` +
      ` isTranscoded=${session.isTranscoded ?? false}`
    )
    return reply.send({ ok: true })
  })

  // GET /api/recordings/debug/path/:sessionId — Diagnóstico del path MediaMTX
  server.get('/debug/path/:sessionId', { preHandler: [server.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'ADMIN') return reply.status(403).send({ message: 'Solo ADMIN' })
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)
    if (!session) return reply.status(404).send({ message: 'Sesión no encontrada' })
    const status = await getMediaMtxPathStatus(session.streamPath)
    return reply.send({ sessionId, ...session, pathStatus: status })
  })

  // GET /api/recordings/audit — Log de accesos a grabaciones (solo ADMIN)
  server.get('/audit', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { page = '1', limit = '50' } = request.query as { page?: string; limit?: string }

    const logs = await server.prisma.auditLog.findMany({
      where: { action: { in: ['VIEW_RECORDING', 'SEARCH_RECORDINGS'] } },
      include: { user: { select: { username: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
    })
    const total = await server.prisma.auditLog.count({
      where: { action: { in: ['VIEW_RECORDING', 'SEARCH_RECORDINGS'] } },
    })

    return reply.send({ logs, total, page: parseInt(page), limit: parseInt(limit) })
  })
}
