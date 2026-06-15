// apps/api/src/routes/recordings.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { searchRecordings } from '../services/hikvision'
import { AuditAction } from '../services/audit'
import { waitForHlsReady, spawnTranscodeFromRtsp, stopTranscodeProcess } from '../services/stream'
import { probeRtspStream } from '../services/rtsp-probe'
import CryptoJS from 'crypto-js'
import axios from 'axios'
import crypto from 'crypto'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// ─── MediaMTX client (same pattern as stream.ts) ─────────────────
const mediamtxApi = axios.create({
  baseURL: process.env.MEDIAMTX_URL || 'http://mediamtx:9997',
  timeout: 8000,
})

// ─── In-memory recording playback sessions ────────────────────────
const RECORDING_SESSION_TTL_MS = 30 * 60 * 1000  // 30 minutes
// Force FFmpeg transcode for all recordings (use when NVR sends H265 without ffprobe detectable codec)
const RECORDINGS_FORCE_TRANSCODE = process.env.RECORDINGS_FORCE_TRANSCODE === 'true'

interface RecordingSession {
  streamPath:   string
  expiresAt:    number
  userId:       string
  // async playback status
  status:       'starting' | 'ready' | 'error'
  hlsUrl:       string
  transcoded:   boolean
  errorCode?:   string
  errorMsg?:    string
  stderrTail?:  string
}

const recordingSessions = new Map<string, RecordingSession>()

// Periodic cleanup of expired recording paths
setInterval(async () => {
  const now = Date.now()
  for (const [sid, session] of recordingSessions.entries()) {
    if (now > session.expiresAt) {
      recordingSessions.delete(sid)
      // Kill FFmpeg for transcoded recording sessions
      if (session.transcoded) {
        stopTranscodeProcess(session.streamPath)
      }
      mediamtxApi.delete(`/v3/config/paths/delete/${session.streamPath}`).catch(() => {})
    }
  }
}, 5 * 60 * 1000)

// ─── RTSP URL helpers ─────────────────────────────────────────────

/** Inject credentials+host into a path-only playbackURI from the NVR. */
function injectCredentialsIntoPlaybackUri(opts: {
  playbackURI: string
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

/** Fallback: construct RTSP URL from timestamps. */
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

// ─── Register a recording path in MediaMTX (source-pull, H264) ───
async function createRecordingHlsPath(
  rtspUrl: string,
  maskedUrl: string,
  streamPath: string,
  log: (msg: string) => void,
): Promise<void> {
  const config = {
    source:          rtspUrl,
    sourceOnDemand:  false,
    rtspTransport:   'tcp',
    record:          false,
    overridePublisher: true,
  }

  log(`[recordings] mediamtx_path_add path=${streamPath} source=${maskedUrl}`)
  try {
    await mediamtxApi.post(`/v3/config/paths/add/${streamPath}`, config)
    log(`[recordings] mediamtx_path_add ok path=${streamPath}`)
  } catch (err: any) {
    const status = err.response?.status
    if (status === 400) {
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

// ─── Background job: detect codec, optionally transcode, wait for HLS ───
// Runs fire-and-forget after POST /playback returns immediately.
// If codec is HEVC (or RECORDINGS_FORCE_TRANSCODE=true): creates an H264 transcode path.
// Otherwise: creates a direct RTSP-pull path in MediaMTX.
async function runPlaybackBackground(opts: {
  sessionId:   string
  streamPath:  string
  rtspUrl:     string
  rtspMasked:  string
  trackId?:    number
  urlStrategy: string
  log:         (msg: string) => void
}): Promise<void> {
  const { sessionId, streamPath, rtspUrl, rtspMasked, trackId, urlStrategy, log } = opts
  const session = recordingSessions.get(sessionId)
  if (!session) return

  // ── Step 1: Detect codec via ffprobe ────────────────────────────────
  let useTranscode = RECORDINGS_FORCE_TRANSCODE
  let detectedCodec = 'unknown'

  if (!useTranscode) {
    try {
      const probe = await probeRtspStream(rtspUrl)
      detectedCodec = probe.codec || 'unknown'
      log(`[recordings] ffprobe_result sessionId=${sessionId} codec=${detectedCodec} ok=${probe.ok}`)
      if (/hevc|h265|h\.265|hvc1|hev1/i.test(detectedCodec)) {
        useTranscode = true
      }
    } catch (err: any) {
      log(`[recordings] ffprobe_error sessionId=${sessionId} err=${err?.message} — using direct path`)
    }
  }

  // ── Step 2a: Transcoded path (HEVC → H264 via FFmpeg) ───────────────
  if (useTranscode) {
    const transcodePath   = `${streamPath}_h264`
    const transcodedHlsUrl = `/hls/${transcodePath}/index.m3u8`

    log(
      `[recordings] playback_init_transcoded sessionId=${sessionId} codec=${detectedCodec}` +
      ` path=${transcodePath} source=${rtspMasked}`
    )

    // Register publisher path in MediaMTX (FFmpeg pushes RTSP → MediaMTX → HLS)
    try {
      await mediamtxApi.post(`/v3/config/paths/add/${transcodePath}`, {
        source: 'publisher', record: false, overridePublisher: true,
      })
    } catch (err: any) {
      if (err?.response?.status === 400) {
        // Already exists — patch it
        await mediamtxApi.patch(`/v3/config/paths/patch/${transcodePath}`, {
          source: 'publisher', record: false, overridePublisher: true,
        }).catch(() => {})
      } else {
        log(`[recordings] mediamtx_transcode_path_failed sessionId=${sessionId} err=${err?.message}`)
        const s = recordingSessions.get(sessionId)
        if (s) { s.status = 'error'; s.errorCode = 'MEDIAMTX_ERROR'; s.errorMsg = 'No se pudo registrar path transcodificado' }
        return
      }
    }

    // Spawn FFmpeg (mode: 'recording' adds -re flag for real-time playback speed)
    const proc = spawnTranscodeFromRtsp(rtspUrl, rtspMasked, transcodePath, { mode: 'recording' })
    if (!proc) {
      log(`[recordings] ffmpeg_spawn_null sessionId=${sessionId} path=${transcodePath}`)
      const s = recordingSessions.get(sessionId)
      if (s) { s.status = 'error'; s.errorCode = 'TRANSCODE_PROCESS_EXITED'; s.errorMsg = 'FFmpeg no pudo iniciarse' }
      await mediamtxApi.delete(`/v3/config/paths/delete/${transcodePath}`).catch(() => {})
      return
    }
    log(`[transcode] spawn_recording path=${transcodePath} pid=${proc.pid ?? 'pending'}`)

    // Wait for HLS ready (no isAlive check so short clips don't abort)
    const ready = await waitForHlsReady(transcodePath, 60_000, 800)

    const s = recordingSessions.get(sessionId)
    if (!s) {
      // Session deleted while waiting (user cancelled)
      try { proc.kill('SIGTERM') } catch {}
      await mediamtxApi.delete(`/v3/config/paths/delete/${transcodePath}`).catch(() => {})
      return
    }

    if (ready.ready) {
      log(`[transcode] hls_ready path=${transcodePath} elapsedMs=${ready.elapsedMs}ms`)
      log(`[recordings] playback_started sessionId=${sessionId} url=${transcodedHlsUrl} transcoded=true`)
      s.streamPath = transcodePath
      s.hlsUrl     = transcodedHlsUrl
      s.transcoded = true
      s.status     = 'ready'
      return
    }

    // Timeout — kill FFmpeg and mark error
    try { proc.kill('SIGTERM') } catch {}
    await mediamtxApi.delete(`/v3/config/paths/delete/${transcodePath}`).catch(() => {})
    log(`[recordings] bg_transcode_timeout sessionId=${sessionId} path=${transcodePath} lastStatus=${ready.lastStatus} elapsedMs=${ready.elapsedMs}ms`)
    s.status   = 'error'
    s.errorCode = 'TRANSCODE_NOT_READY'
    s.errorMsg  = `Transcodificación no lista en 60s. Verifica conexión RTSP al NVR.`
    return
  }

  // ── Step 2b: Direct RTSP-pull path (H264 or unknown codec) ──────────
  try {
    await createRecordingHlsPath(rtspUrl, rtspMasked, streamPath, log)
  } catch (err: any) {
    log(`[recordings] bg_path_create_failed sessionId=${sessionId} err=${err.message}`)
    const s = recordingSessions.get(sessionId)
    if (s) {
      s.status   = 'error'
      s.errorCode = 'MEDIAMTX_ERROR'
      s.errorMsg  = 'No se pudo registrar el path en MediaMTX'
    }
    return
  }

  // Poll HLS — no isAlive check so short clips don't abort us
  const ready = await waitForHlsReady(streamPath, 60_000, 800)

  const s = recordingSessions.get(sessionId)
  if (!s) return  // session was deleted while we waited (user cancelled)

  if (ready.ready) {
    log(
      `[recordings] bg_hls_ready sessionId=${sessionId} path=${streamPath}` +
      ` elapsedMs=${ready.elapsedMs}ms`
    )
    s.hlsUrl = `/hls/${streamPath}/index.m3u8`
    s.status = 'ready'
    return
  }

  // HLS timed out — diagnose and mark error
  const pathStatus = await getMediaMtxPathStatus(streamPath)

  const diagMsg = !pathStatus.exists
    ? 'Path no encontrado en MediaMTX'
    : pathStatus.ready
      ? 'RTSP conectado pero HLS no generó segmentos en tiempo'
      : 'MediaMTX no pudo conectar al RTSP del NVR'

  log(
    `[recordings] bg_hls_timeout sessionId=${sessionId} lastStatus=${ready.lastStatus}` +
    ` elapsedMs=${ready.elapsedMs}ms pathExists=${pathStatus.exists}` +
    ` pathReady=${pathStatus.ready} sourceState=${pathStatus.sourceState}` +
    ` strategy=${urlStrategy}` + (trackId ? ` trackId=${trackId}` : '') +
    ` source=${rtspMasked}`
  )

  // Clean up useless path
  recordingSessions.delete(sessionId)
  mediamtxApi.delete(`/v3/config/paths/delete/${streamPath}`).catch(() => {})

  s.status    = 'error'
  s.errorCode = 'HLS_TIMEOUT'
  s.errorMsg  = diagMsg
}

// In-memory capability cache: nvrId → 'isapi' | 'unsupported' | 'auth_error'
const nvrCapabilityCache = new Map<string, { result: string; expiresAt: number }>()
const CAPABILITY_TTL_MS = 15 * 60 * 1000

function getCachedCapability(nvrId: string): string | null {
  const entry = nvrCapabilityCache.get(nvrId)
  if (!entry || Date.now() > entry.expiresAt) return null
  return entry.result
}
function setCachedCapability(nvrId: string, result: string) {
  nvrCapabilityCache.set(nvrId, { result, expiresAt: Date.now() + CAPABILITY_TTL_MS })
}

// ─── Schemas ──────────────────────────────────────────────────────
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
  /** Path+query from the NVR's searchRecordings result.
   *  Must start with / (e.g. /Streaming/tracks/101?starttime=...&name=...&size=...). */
  playbackURI: z.string().startsWith('/').optional(),
})

export const recordingRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/recordings/search
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
  server.post('/batch-search', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const body = batchSearchSchema.parse(request.body)
    const from  = new Date(body.from)
    const to    = new Date(body.to)

    if (from >= to) return reply.status(400).send({ message: 'La fecha "from" debe ser anterior a "to"' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id: body.nvrId } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const cameras = await server.prisma.camera.findMany({
      where: { id: { in: body.cameraIds }, nvrId: body.nvrId },
    })
    if (cameras.length === 0) return reply.status(404).send({ message: 'No se encontraron cámaras para este NVR' })

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
        setCachedCapability(nvr.id, 'isapi')
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

  // POST /api/recordings/playback — Start recording playback (async).
  // Returns immediately with status='starting'. Client polls GET /playback/:sessionId/status.
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

    const sessionId  = crypto.randomBytes(8).toString('hex')
    const streamPath = `rec_${sessionId}`
    const hlsUrl     = `/hls/${streamPath}/index.m3u8`
    const expiresAt  = new Date(Date.now() + RECORDING_SESSION_TTL_MS).toISOString()

    server.log.info(
      `[recordings] playback_init sessionId=${sessionId} path=${streamPath}` +
      ` cameraId=${body.cameraId} ch=${camera.channel}` +
      (trackId ? ` trackId=${trackId}` : '') +
      ` strategy=${urlStrategy} source=${rtspMasked}`
    )

    // Register session immediately so status polls can find it
    recordingSessions.set(sessionId, {
      streamPath,
      expiresAt:  Date.now() + RECORDING_SESSION_TTL_MS,
      userId:     user.sub,
      status:     'starting',
      hlsUrl,
      transcoded: false,
    })

    // Fire-and-forget background job
    runPlaybackBackground({
      sessionId,
      streamPath,
      rtspUrl,
      rtspMasked,
      trackId,
      urlStrategy,
      log: (msg) => server.log.info(msg),
    }).catch((err) => {
      server.log.error(`[recordings] bg_unhandled_error sessionId=${sessionId} err=${err?.message}`)
      const s = recordingSessions.get(sessionId)
      if (s && s.status === 'starting') {
        s.status   = 'error'
        s.errorCode = 'INTERNAL'
        s.errorMsg  = 'Error interno en el proceso de reproducción'
      }
    })

    // Audit asynchronously — don't wait
    AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
      startTime: body.startTime, endTime: body.endTime, sessionId,
    }).catch(() => {})

    return reply.send({
      status:    'starting',
      sessionId,
      url:       hlsUrl,
      pollUrl:   `/api/recordings/playback/${sessionId}/status`,
      transcoded: false,
      expiresAt,
    })
  })

  // GET /api/recordings/playback/:sessionId/status — Poll playback readiness
  server.get('/playback/:sessionId/status', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)

    if (!session) {
      // Session was cleaned up (error path cleans up before setting error status in some cases)
      // Return error so client stops polling
      return reply.status(404).send({
        status:    'error',
        errorCode: 'SESSION_NOT_FOUND',
        error:     'Sesión de reproducción no encontrada o expirada',
      })
    }

    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }

    return reply.send({
      status:     session.status,
      url:        session.hlsUrl,
      hlsReady:   session.status === 'ready',
      transcoded: session.transcoded,
      errorCode:  session.errorCode,
      error:      session.errorMsg,
      stderrTail: session.stderrTail,
    })
  })

  // DELETE /api/recordings/playback/:sessionId — Stop recording playback
  server.delete('/playback/:sessionId', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)
    if (!session) return reply.status(404).send({ message: 'Sesión no encontrada' })
    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }
    recordingSessions.delete(sessionId)
    if (session.transcoded) {
      stopTranscodeProcess(session.streamPath)
    }
    await mediamtxApi.delete(`/v3/config/paths/delete/${session.streamPath}`).catch(() => {})
    server.log.info(
      `[recordings] playback_stopped sessionId=${sessionId} path=${session.streamPath}` +
      ` transcoded=${session.transcoded}`
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

  // GET /api/recordings/audit
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
