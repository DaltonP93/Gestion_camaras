// apps/api/src/routes/recordings.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { searchRecordings } from '../services/hikvision'
import { AuditAction } from '../services/audit'
import { probeRtspStream } from '../services/rtsp-probe'
import { getRtspTimeoutOption } from '../services/stream'
import CryptoJS from 'crypto-js'
import crypto from 'crypto'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// ─── VOD configuration ────────────────────────────────────────────
const RECORDING_SESSION_TTL_MS  = 30 * 60 * 1000  // 30 minutes
const RECORDINGS_FORCE_TRANSCODE = process.env.RECORDINGS_FORCE_TRANSCODE === 'true'
const TRANSCODE_ENCODER          = process.env.TRANSCODE_ENCODER || 'libx264'
const VOD_TEMP_DIR               = process.env.VOD_TEMP_DIR || '/tmp/visioncore-recordings'
const STALL_TIMEOUT_MS           = 12_000  // kill FFmpeg if no progress for 12s

// ─── In-memory recording playback sessions ────────────────────────
interface RecordingSession {
  expiresAt:   number
  userId:      string
  status:      'starting' | 'ready' | 'error'
  errorCode?:  string
  errorMsg?:   string
  // VOD fields
  vodFile?:    string         // /tmp path to generated MP4
  vodUrl?:     string         // served URL: /api/recordings/playback/:sessionId/file.mp4
  mimeType?:   string         // 'video/mp4'
  vodProcess?: ChildProcess   // FFmpeg process — killed on DELETE
  expectedDurationSec?: number
  progress?: {
    outTimeSec:     number
    frame:          number
    fps:            number
    speed:          string
    lastProgressAt: number
  }
}

const recordingSessions = new Map<string, RecordingSession>()

// Ensure temp directory exists
if (!fs.existsSync(VOD_TEMP_DIR)) {
  try { fs.mkdirSync(VOD_TEMP_DIR, { recursive: true }) } catch {}
}

// Periodic cleanup of expired sessions and their temp files
setInterval(() => {
  const now = Date.now()
  for (const [sid, session] of recordingSessions.entries()) {
    if (now > session.expiresAt) {
      recordingSessions.delete(sid)
      if (session.vodProcess) {
        try { session.vodProcess.kill('SIGTERM') } catch {}
      }
      if (session.vodFile) {
        fs.unlink(session.vodFile, () => {})
      }
    }
  }
}, 5 * 60 * 1000)

// ─── RTSP URL helpers ─────────────────────────────────────────────

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

// ─── VOD generation ───────────────────────────────────────────────

function formatOutTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = (sec % 60).toFixed(3).padStart(6, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s}`
}

type VodResult = 'success' | 'failure' | 'stall' | 'cancelled'

async function spawnVodFfmpeg(opts: {
  sessionId:           string
  vodFile:             string
  rtspUrl:             string
  rtspMasked:          string
  codecArgs:           string[]
  attempt:             'copy' | 'transcode'
  expectedDurationSec: number
  log:                 (msg: string) => void
}): Promise<VodResult> {
  const { sessionId, vodFile, rtspUrl, rtspMasked, codecArgs, attempt, expectedDurationSec, log } = opts

  const rtspTimeoutOpt = getRtspTimeoutOption()
  const rtspTimeoutUs  = 60_000_000  // 60s for recordings (NVR seek + locate)

  const args = [
    '-rtsp_transport', 'tcp',
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',
    ...(rtspTimeoutOpt ? [rtspTimeoutOpt, String(rtspTimeoutUs)] : []),
    '-reorder_queue_size', '0',
    '-i', rtspUrl,
    ...codecArgs,
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-stats_period', '1',
    '-y',
    vodFile,
  ]

  const maskedArgs = args.map(a => a === rtspUrl ? rtspMasked : a)
  log(`[recordings] vod_spawn sessionId=${sessionId} attempt=${attempt} cmd=ffmpeg ${maskedArgs.join(' ')}`)

  return new Promise<VodResult>((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const s = recordingSessions.get(sessionId)
    if (s) s.vodProcess = proc

    let stallTimer: ReturnType<typeof setInterval> | null = null
    let progressSeen = false
    let resolved = false

    const finish = (result: VodResult) => {
      if (resolved) return
      resolved = true
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null }
      const sess = recordingSessions.get(sessionId)
      if (sess && sess.vodProcess === proc) sess.vodProcess = undefined
      resolve(result)
    }

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      // Parse FFmpeg -progress key=value output
      const lines = text.split('\n')
      let frame = 0, fps = 0, outTimeSec = 0, speed = '', hasProgressLine = false

      for (const line of lines) {
        const eqIdx = line.indexOf('=')
        if (eqIdx < 0) continue
        const k = line.slice(0, eqIdx).trim()
        const v = line.slice(eqIdx + 1).trim()
        if (k === 'frame')        frame      = parseInt(v)  || 0
        else if (k === 'fps')     fps        = parseFloat(v) || 0
        else if (k === 'out_time_ms') outTimeSec = (parseInt(v) || 0) / 1_000_000
        else if (k === 'speed')   speed      = v
        else if (k === 'progress') hasProgressLine = true
      }

      if (hasProgressLine && frame > 0) {
        const sess = recordingSessions.get(sessionId)
        if (sess) {
          sess.progress = { outTimeSec, frame, fps, speed, lastProgressAt: Date.now() }
        }
        log(`[recordings] ffmpeg_progress sessionId=${sessionId} out_time=${formatOutTime(outTimeSec)} frame=${frame} fps=${fps.toFixed(1)} speed=${speed}`)

        if (!progressSeen) {
          progressSeen = true
          // Start stall watchdog once first real progress is seen
          stallTimer = setInterval(() => {
            const sess2 = recordingSessions.get(sessionId)
            if (!sess2 || sess2.status !== 'starting') {
              if (stallTimer) clearInterval(stallTimer)
              return
            }
            const sinceMs = Date.now() - (sess2.progress?.lastProgressAt ?? 0)
            if (sinceMs > STALL_TIMEOUT_MS) {
              const stallSec = Math.round(sess2.progress?.outTimeSec ?? 0)
              log(`[recordings] ffmpeg_stall_detected sessionId=${sessionId} sinceMs=${sinceMs} outTimeSec=${stallSec}`)
              try { proc.kill('SIGTERM') } catch {}
              sess2.status    = 'error'
              sess2.errorCode = 'RECORDING_STREAM_STALLED'
              sess2.errorMsg  = `El NVR dejó de entregar video después de ${stallSec} segundos`
              finish('stall')
            }
          }, 3_000)
        }
      }
    })

    proc.on('exit', (code) => {
      const sess = recordingSessions.get(sessionId)
      // If stall already resolved, don't double-resolve
      if (!sess || sess.errorCode === 'RECORDING_STREAM_STALLED') {
        finish('stall')
        return
      }
      // Session deleted by user (DELETE while generating)
      if (!sess) {
        finish('cancelled')
        return
      }
      finish(code === 0 ? 'success' : 'failure')
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      log(`[recordings] vod_ffmpeg_error sessionId=${sessionId} err=${err.message}`)
      finish('failure')
    })
  })
}

// ─── Background VOD generation ────────────────────────────────────
async function runVodBackground(opts: {
  sessionId:           string
  rtspUrl:             string
  rtspMasked:          string
  trackId?:            number
  urlStrategy:         string
  expectedDurationSec: number
  log:                 (msg: string) => void
}): Promise<void> {
  const { sessionId, rtspUrl, rtspMasked, expectedDurationSec, log } = opts

  const session = recordingSessions.get(sessionId)
  if (!session) return

  const vodFile = path.join(VOD_TEMP_DIR, `rec_${sessionId}.mp4`)

  // ── Step 1: Detect codec ─────────────────────────────────────────
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
      log(`[recordings] ffprobe_error sessionId=${sessionId} err=${err?.message} — assuming H264, trying copy`)
    }
  }

  log(
    `[recordings] vod_prepare sessionId=${sessionId} codec=${detectedCodec}` +
    ` useTranscode=${useTranscode} expectedDurationSec=${expectedDurationSec}` +
    ` source=${rtspMasked}`
  )

  // ── Step 2a: H264 — try copy first ───────────────────────────────
  if (!useTranscode) {
    const result = await spawnVodFfmpeg({
      sessionId,
      vodFile,
      rtspUrl,
      rtspMasked,
      codecArgs: ['-an', '-c:v', 'copy'],
      attempt: 'copy',
      expectedDurationSec,
      log,
    })

    if (result === 'stall' || result === 'cancelled') return  // session already marked

    if (result === 'success') {
      const finalSession = recordingSessions.get(sessionId)
      if (!finalSession) { fs.unlink(vodFile, () => {}); return }
      try {
        const stat = fs.statSync(vodFile)
        if (stat.size > 512) {  // valid file
          log(`[recordings] vod_ready sessionId=${sessionId} attempt=copy actualDurationSec=${Math.round(expectedDurationSec)} file=${vodFile} size=${stat.size}`)
          finalSession.vodFile  = vodFile
          finalSession.vodUrl   = `/api/recordings/playback/${sessionId}/file.mp4`
          finalSession.mimeType = 'video/mp4'
          finalSession.status   = 'ready'
          return
        }
        log(`[recordings] vod_copy_empty sessionId=${sessionId} size=${stat.size} — falling back to transcode`)
      } catch {
        log(`[recordings] vod_copy_stat_failed sessionId=${sessionId} — falling back to transcode`)
      }
    }

    // Copy failed or produced empty file — delete partial and transcode
    log(`[recordings] vod_copy_fallback sessionId=${sessionId} — retrying with ${TRANSCODE_ENCODER}`)
    try { fs.unlinkSync(vodFile) } catch {}
  }

  // ── Step 2b: Transcode (HEVC → H264, or copy fallback) ───────────
  const transcodeCodecArgs = [
    '-an',
    '-c:v', TRANSCODE_ENCODER,
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-level', '4.1',
  ]

  const result = await spawnVodFfmpeg({
    sessionId,
    vodFile,
    rtspUrl,
    rtspMasked,
    codecArgs: transcodeCodecArgs,
    attempt: 'transcode',
    expectedDurationSec,
    log,
  })

  if (result === 'stall' || result === 'cancelled') return

  const finalSession = recordingSessions.get(sessionId)
  if (!finalSession) { fs.unlink(vodFile, () => {}); return }

  if (result === 'success') {
    try {
      const stat = fs.statSync(vodFile)
      log(`[recordings] vod_ready sessionId=${sessionId} attempt=transcode file=${vodFile} size=${stat.size}`)
      finalSession.vodFile  = vodFile
      finalSession.vodUrl   = `/api/recordings/playback/${sessionId}/file.mp4`
      finalSession.mimeType = 'video/mp4'
      finalSession.status   = 'ready'
    } catch {
      finalSession.status   = 'error'
      finalSession.errorCode = 'VOD_FILE_MISSING'
      finalSession.errorMsg  = 'El archivo generado no se pudo leer'
    }
  } else {
    finalSession.status   = 'error'
    finalSession.errorCode = 'TRANSCODE_FAILED'
    finalSession.errorMsg  = 'No se pudo generar el video. Verifica la conexión al NVR.'
  }
}

// ─── Capability cache ─────────────────────────────────────────────
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

  // POST /api/recordings/batch-search
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

    const expectedDurationSec = Math.round(
      (new Date(body.endTime).getTime() - new Date(body.startTime).getTime()) / 1000
    )

    const sessionId  = crypto.randomBytes(8).toString('hex')
    const expiresAt  = new Date(Date.now() + RECORDING_SESSION_TTL_MS).toISOString()

    server.log.info(
      `[recordings] playback_init sessionId=${sessionId}` +
      ` cameraId=${body.cameraId} ch=${camera.channel}` +
      (trackId ? ` trackId=${trackId}` : '') +
      ` strategy=${urlStrategy} expectedDurationSec=${expectedDurationSec} source=${rtspMasked}`
    )

    recordingSessions.set(sessionId, {
      expiresAt:  Date.now() + RECORDING_SESSION_TTL_MS,
      userId:     user.sub,
      status:     'starting',
      expectedDurationSec,
    })

    runVodBackground({
      sessionId,
      rtspUrl,
      rtspMasked,
      trackId,
      urlStrategy,
      expectedDurationSec,
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

    AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
      startTime: body.startTime, endTime: body.endTime, sessionId,
    }).catch(() => {})

    return reply.send({
      status:    'starting',
      sessionId,
      pollUrl:   `/api/recordings/playback/${sessionId}/status`,
      expiresAt,
      expectedDurationSec,
    })
  })

  // GET /api/recordings/playback/:sessionId/status — Poll playback readiness
  server.get('/playback/:sessionId/status', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)

    if (!session) {
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
      status:               session.status,
      url:                  session.vodUrl,
      mimeType:             session.mimeType,
      errorCode:            session.errorCode,
      error:                session.errorMsg,
      expectedDurationSec:  session.expectedDurationSec,
      outTimeSec:           session.progress?.outTimeSec,
      frame:                session.progress?.frame,
      fps:                  session.progress?.fps,
      speed:                session.progress?.speed,
    })
  })

  // GET /api/recordings/playback/:sessionId/file.mp4 — Serve VOD file with Range support
  server.get('/playback/:sessionId/file.mp4', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)

    if (!session || session.status !== 'ready' || !session.vodFile) {
      return reply.status(404).send({ message: 'Archivo no disponible' })
    }
    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }

    let fileSize: number
    try {
      fileSize = fs.statSync(session.vodFile).size
    } catch {
      return reply.status(404).send({ message: 'Archivo no encontrado en disco' })
    }

    const rangeHeader = request.headers.range as string | undefined

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      if (!match) return reply.status(416).send({ message: 'Invalid Range header' })
      const start = match[1] ? parseInt(match[1], 10) : 0
      const end   = match[2] ? parseInt(match[2], 10) : fileSize - 1
      if (start > end || end >= fileSize) {
        reply.header('Content-Range', `bytes */${fileSize}`)
        return reply.status(416).send({ message: 'Range Not Satisfiable' })
      }
      const chunkSize = end - start + 1
      reply
        .status(206)
        .header('Content-Range',  `bytes ${start}-${end}/${fileSize}`)
        .header('Accept-Ranges',  'bytes')
        .header('Content-Length', String(chunkSize))
        .header('Content-Type',   'video/mp4')
      return reply.send(fs.createReadStream(session.vodFile, { start, end }))
    }

    reply
      .header('Content-Type',   'video/mp4')
      .header('Content-Length', String(fileSize))
      .header('Accept-Ranges',  'bytes')
    return reply.send(fs.createReadStream(session.vodFile))
  })

  // DELETE /api/recordings/playback/:sessionId — Stop/cancel playback
  server.delete('/playback/:sessionId', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)
    if (!session) return reply.status(404).send({ message: 'Sesión no encontrada' })
    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }
    recordingSessions.delete(sessionId)
    if (session.vodProcess) {
      try { session.vodProcess.kill('SIGTERM') } catch {}
    }
    if (session.vodFile) {
      fs.unlink(session.vodFile, () => {})
    }
    server.log.info(`[recordings] playback_stopped sessionId=${sessionId}`)
    return reply.send({ ok: true })
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
