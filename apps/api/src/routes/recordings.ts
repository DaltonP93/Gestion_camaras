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
const RECORDING_SESSION_TTL_MS  = 30 * 60 * 1000
const DOWNLOAD_TOKEN_TTL_MS     = 24 * 60 * 60 * 1000
const RECORDINGS_FORCE_TRANSCODE = process.env.RECORDINGS_FORCE_TRANSCODE === 'true'
const TRANSCODE_ENCODER          = process.env.TRANSCODE_ENCODER || 'libx264'
const VOD_TEMP_DIR               = process.env.VOD_TEMP_DIR || '/tmp/visioncore-recordings'
// Kill FFmpeg if out_time hasn't advanced for this long.
const STALL_TIMEOUT_MS           = 30_000
// Near-complete: send SIGINT instead of SIGTERM so FFmpeg writes the moov atom cleanly.
const NEAR_COMPLETE_IDLE_MS      = 20_000

// Per-recording transcode quality — env-configurable, no hardcoded high bitrate.
// Defaults produce ~8-15 MB for a 53s clip vs 48 MB with unthrottled libx264.
const TRANSCODE_PRESET    = process.env.RECORDINGS_TRANSCODE_PRESET    || 'ultrafast'
const TRANSCODE_CRF       = process.env.RECORDINGS_TRANSCODE_CRF       || '28'
const TRANSCODE_MAXRATE   = process.env.RECORDINGS_TRANSCODE_MAXRATE   || '2000k'
const TRANSCODE_BUFSIZE   = process.env.RECORDINGS_TRANSCODE_BUFSIZE   || '4000k'
const TRANSCODE_MAX_WIDTH = process.env.RECORDINGS_TRANSCODE_MAX_WIDTH || '1280'
const TRANSCODE_FPS       = process.env.RECORDINGS_TRANSCODE_FPS       || ''  // '' = keep source FPS

// Persistent MP4 cache — set RECORDINGS_CACHE_DIR to enable.
// Without it each session writes to VOD_TEMP_DIR and is deleted on session expiry.
const CACHE_DIR       = process.env.RECORDINGS_CACHE_DIR        || ''
const CACHE_MAX_GB    = parseFloat(process.env.RECORDINGS_CACHE_MAX_GB    || '20')
const CACHE_TTL_HOURS = parseFloat(process.env.RECORDINGS_CACHE_TTL_HOURS || '24')

// Progressive / fragmented MP4 — DISABLED by default.
// When true, uses -movflags frag_keyframe+empty_moov+default_base_moof so the browser
// can start rendering before the full file is written. May improve first-frame latency
// for long recordings. Keep OFF unless you verify Range requests + seek work correctly
// in your target browsers, since fragmented MP4 moov structure differs from regular MP4.
const PROGRESSIVE_MP4 = process.env.RECORDINGS_PROGRESSIVE_MP4 === 'true'

// ─── Strategy ─────────────────────────────────────────────────────
// copy_h264              – H.264 source → direct remux, fastest (< 5 s)
// hevc_copy              – HEVC source + browser supports HEVC → direct remux, fastest (< 5 s)
// hevc_transcode_preview – HEVC source + no browser HEVC support → libx264 transcode (~1 min CPU)
type VodStrategy = 'copy_h264' | 'hevc_copy' | 'hevc_transcode_preview'

function isHevcCodec(codec: string): boolean {
  return /hevc|h265|h\.265|hvc1|hev1/i.test(codec)
}

function determineStrategy(opts: {
  detectedCodec:  string
  canPlayHevcMp4: boolean
  forceTranscode: boolean
}): VodStrategy {
  const { detectedCodec, canPlayHevcMp4, forceTranscode } = opts
  if (forceTranscode || RECORDINGS_FORCE_TRANSCODE) return 'hevc_transcode_preview'
  if (!isHevcCodec(detectedCodec)) return 'copy_h264'
  return canPlayHevcMp4 ? 'hevc_copy' : 'hevc_transcode_preview'
}

function buildCodecArgs(strategy: VodStrategy): string[] {
  if (strategy === 'copy_h264' || strategy === 'hevc_copy') {
    return ['-an', '-c:v', 'copy']
  }
  // hevc_transcode_preview — CRF + maxrate keeps file small; scale keeps browser-compat resolution
  const vfParts: string[] = []
  if (TRANSCODE_MAX_WIDTH && TRANSCODE_MAX_WIDTH !== 'source') {
    vfParts.push(`scale='min(${TRANSCODE_MAX_WIDTH}\\,iw)':-2:flags=lanczos`)
  }
  if (TRANSCODE_FPS) {
    vfParts.push(`fps=${TRANSCODE_FPS}`)
  }
  const args: string[] = [
    '-an',
    '-c:v',     TRANSCODE_ENCODER,
    '-preset',  TRANSCODE_PRESET,
    '-crf',     TRANSCODE_CRF,
    '-maxrate', TRANSCODE_MAXRATE,
    '-bufsize',  TRANSCODE_BUFSIZE,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-level',   '4.1',
  ]
  if (vfParts.length > 0) {
    args.push('-vf', vfParts.join(','))
  }
  return args
}

// ─── Cache helpers ────────────────────────────────────────────────

function computeCacheKey(opts: {
  cameraId:       string
  startTime:      string
  endTime:        string
  playbackURI:    string
  canPlayHevcMp4: boolean
  forceTranscode: boolean
}): string {
  const raw = [
    opts.cameraId, opts.startTime, opts.endTime, opts.playbackURI,
    String(opts.canPlayHevcMp4), String(opts.forceTranscode),
    TRANSCODE_CRF, TRANSCODE_MAXRATE, TRANSCODE_MAX_WIDTH, TRANSCODE_FPS,
  ].join('|')
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40)
}

// ─── Cache sidecar helpers ────────────────────────────────────────
// Alongside each cached .mp4 file we write a tiny .json sidecar so
// that cache-hit log messages can report the strategy that generated
// the file, without needing to re-probe the stream.
interface VodSidecar {
  strategy:  VodStrategy
  codec:     string
  elapsedMs: number
  sizeBytes: number
  createdAt: number
}

function getSidecarPath(vodFile: string): string {
  return vodFile.replace(/\.mp4$/, '.json')
}

function writeSidecar(vodFile: string, data: VodSidecar): void {
  try { fs.writeFileSync(getSidecarPath(vodFile), JSON.stringify(data)) } catch {}
}

function readSidecar(vodFile: string): VodSidecar | null {
  try { return JSON.parse(fs.readFileSync(getSidecarPath(vodFile), 'utf-8')) } catch { return null }
}

// ─────────────────────────────────────────────────────────────────

function runCacheCleanup(log: (msg: string) => void): void {
  if (!CACHE_DIR) return
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.mp4'))
    const now   = Date.now()
    const ttlMs = CACHE_TTL_HOURS * 3600 * 1000
    const maxBytes = CACHE_MAX_GB * 1024 * 1024 * 1024

    const stats = files
      .map(f => {
        const fp = path.join(CACHE_DIR, f)
        try { const s = fs.statSync(fp); return { path: fp, size: s.size, mtime: s.mtimeMs } }
        catch { return null }
      })
      .filter(Boolean) as Array<{ path: string; size: number; mtime: number }>

    let totalBytes    = stats.reduce((s, f) => s + f.size, 0)
    let deletedFiles  = 0
    let freedBytes    = 0

    // TTL sweep
    for (const f of stats) {
      if (now - f.mtime > ttlMs) {
        try { fs.unlinkSync(f.path); deletedFiles++; freedBytes += f.size; totalBytes -= f.size } catch {}
        try { fs.unlinkSync(getSidecarPath(f.path)) } catch {}
      }
    }

    // Size cap (LRU by mtime)
    if (totalBytes > maxBytes) {
      const remaining = stats
        .filter(f => { try { fs.statSync(f.path); return true } catch { return false } })
        .sort((a, b) => a.mtime - b.mtime)
      for (const f of remaining) {
        if (totalBytes <= maxBytes) break
        try { fs.unlinkSync(f.path); deletedFiles++; freedBytes += f.size; totalBytes -= f.size } catch {}
        try { fs.unlinkSync(getSidecarPath(f.path)) } catch {}
      }
    }

    if (deletedFiles > 0) {
      log(`[recordings] vod_cache_cleanup deletedFiles=${deletedFiles} freedBytes=${freedBytes} cacheDir=${CACHE_DIR}`)
    }
  } catch (err: any) {
    log(`[recordings] vod_cache_cleanup_error err=${err?.message}`)
  }
}

// ─── Directory setup ──────────────────────────────────────────────

if (!fs.existsSync(VOD_TEMP_DIR)) {
  try { fs.mkdirSync(VOD_TEMP_DIR, { recursive: true }) } catch {}
}
if (CACHE_DIR && !fs.existsSync(CACHE_DIR)) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }) } catch {}
}
if (CACHE_DIR) {
  console.log(`[recordings] vod_cache_configured dir=${CACHE_DIR} maxGb=${CACHE_MAX_GB} ttlHours=${CACHE_TTL_HOURS} forceTranscode=${RECORDINGS_FORCE_TRANSCODE}`)
  console.log(`[recordings] transcode_config preset=${TRANSCODE_PRESET} crf=${TRANSCODE_CRF} maxrate=${TRANSCODE_MAXRATE} bufsize=${TRANSCODE_BUFSIZE} maxWidth=${TRANSCODE_MAX_WIDTH || 'source'} fps=${TRANSCODE_FPS || 'source'} progressiveMp4=${PROGRESSIVE_MP4}`)
  runCacheCleanup(console.log)
  setInterval(() => runCacheCleanup(console.log), 60 * 60 * 1000)
} else {
  console.log('[recordings] vod_cache_disabled — RECORDINGS_CACHE_DIR not set; MP4s deleted on session expiry (set env to enable persistent cache)')
  console.log(`[recordings] transcode_config preset=${TRANSCODE_PRESET} crf=${TRANSCODE_CRF} maxrate=${TRANSCODE_MAXRATE} bufsize=${TRANSCODE_BUFSIZE} maxWidth=${TRANSCODE_MAX_WIDTH || 'source'} fps=${TRANSCODE_FPS || 'source'} progressiveMp4=${PROGRESSIVE_MP4}`)
}

// ─── Download tokens (long-lived, independent of session lifetime) ────
interface DownloadToken {
  token:     string
  filePath:  string
  filename:  string
  expiresAt: number
  sessionId: string
  issuedAt:  number
}
const downloadTokens = new Map<string, DownloadToken>()

// ─── In-memory recording playback sessions ────────────────────────
interface RecordingSession {
  expiresAt:   number
  userId:      string
  startedAt:   number
  status:      'starting' | 'ready' | 'error'
  errorCode?:  string
  errorMsg?:   string
  jobKey?:     string
  fileToken?:  string     // token for unauthenticated file.mp4 download
  vodFile?:    string     // absolute path to generated MP4
  vodFileCached?: boolean // true if vodFile is in CACHE_DIR (do not delete on session cleanup)
  vodUrl?:     string     // /api/recordings/playback/:sessionId/file.mp4?token=<fileToken>
  downloadToken?: string  // long-lived token for /api/recordings/download?t=<token>
  downloadUrl?:  string   // /api/recordings/download?t=<downloadToken>
  mimeType?:   string
  vodProcess?: ChildProcess
  strategy?: VodStrategy   // strategy used to generate this session's file
  codec?: string           // codec detected by ffprobe
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
const recordingJobKeys  = new Map<string, string>()

function issueDownloadToken(opts: {
  sessionId: string
  filePath:  string
  filename:  string
  log:       (msg: string) => void
}): string {
  const token    = crypto.randomBytes(24).toString('hex')
  const issuedAt = Date.now()
  downloadTokens.set(token, {
    token, filePath: opts.filePath, filename: opts.filename,
    expiresAt: issuedAt + DOWNLOAD_TOKEN_TTL_MS,
    sessionId: opts.sessionId,
    issuedAt,
  })
  const sess = recordingSessions.get(opts.sessionId)
  if (sess) {
    sess.downloadToken = token
    sess.downloadUrl   = `/api/recordings/download?t=${token}`
  }
  const previewStrategy = sess?.strategy ?? 'unknown'
  opts.log(`[recordings] download_token_issued sessionId=${opts.sessionId} filename=${opts.filename}`)
  opts.log(`[recordings] download_strategy sessionId=${opts.sessionId} strategy=reuse_preview previewStrategy=${previewStrategy} filename=${opts.filename}`)
  return token
}

// Periodic cleanup of expired sessions and download tokens — does NOT delete cached files
setInterval(() => {
  const now = Date.now()
  for (const [sid, session] of recordingSessions.entries()) {
    if (now > session.expiresAt) {
      recordingSessions.delete(sid)
      if (session.jobKey) recordingJobKeys.delete(session.jobKey)
      if (session.vodProcess) {
        try { session.vodProcess.kill('SIGTERM') } catch {}
      }
      // Only delete session-scoped temp files, not cache files
      if (session.vodFile && !session.vodFileCached) {
        fs.unlink(session.vodFile, () => {})
      }
    }
  }
  for (const [tok, dt] of downloadTokens.entries()) {
    if (now > dt.expiresAt) downloadTokens.delete(tok)
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
  attempt:             string   // strategy name for logging
  expectedDurationSec: number
  log:                 (msg: string) => void
}): Promise<VodResult> {
  const { sessionId, vodFile, rtspUrl, rtspMasked, codecArgs, attempt, expectedDurationSec, log } = opts

  const rtspTimeoutOpt = getRtspTimeoutOption()
  const rtspTimeoutUs  = 60_000_000  // 60s for NVR seek + locate

  const args = [
    '-rtsp_transport', 'tcp',
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',
    ...(rtspTimeoutOpt ? [rtspTimeoutOpt, String(rtspTimeoutUs)] : []),
    '-reorder_queue_size', '0',
    '-i', rtspUrl,
    ...codecArgs,
    '-movflags', PROGRESSIVE_MP4
      ? 'frag_keyframe+empty_moov+default_base_moof'
      : '+faststart',
    '-progress', 'pipe:2',
    '-stats_period', '1',
    '-y',
    vodFile,
  ]

  const maskedArgs = args.map(a => a === rtspUrl ? rtspMasked : a)
  log(`[recordings] ffmpeg_command_sanitized sessionId=${sessionId} attempt=${attempt} cmd=ffmpeg ${maskedArgs.join(' ')}`)

  return new Promise<VodResult>((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const s = recordingSessions.get(sessionId)
    if (s) s.vodProcess = proc

    let stallTimer: ReturnType<typeof setInterval> | null = null
    let progressSeen = false
    let resolved = false
    let nearCompleteFinalize = false

    const finish = (result: VodResult) => {
      if (resolved) return
      resolved = true
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null }
      const sess = recordingSessions.get(sessionId)
      if (sess && sess.vodProcess === proc) sess.vodProcess = undefined
      resolve(result)
    }

    proc.stderr?.on('data', (data: Buffer) => {
      const text  = data.toString()
      const lines = text.split('\n')
      let frame = 0, fps = 0, outTimeSec = 0, speed = '', hasProgressLine = false

      for (const line of lines) {
        const eqIdx = line.indexOf('=')
        if (eqIdx < 0) continue
        const k = line.slice(0, eqIdx).trim()
        const v = line.slice(eqIdx + 1).trim()
        if (k === 'frame')           frame      = parseInt(v) || 0
        else if (k === 'fps')        fps        = parseFloat(v) || 0
        else if (k === 'out_time_ms') outTimeSec = (parseInt(v) || 0) / 1_000_000
        else if (k === 'speed')      speed      = v
        else if (k === 'progress')   hasProgressLine = true
      }

      if (hasProgressLine && frame > 0) {
        const sess = recordingSessions.get(sessionId)
        if (sess) {
          sess.progress = { outTimeSec, frame, fps, speed, lastProgressAt: Date.now() }
        }
        const pct = sess?.expectedDurationSec
          ? Math.min(99, Math.round(outTimeSec / sess.expectedDurationSec * 100))
          : 0
        log(`[recordings] ffmpeg_progress sessionId=${sessionId} out_time=${formatOutTime(outTimeSec)} frame=${frame} fps=${fps.toFixed(1)} speed=${speed} progress=${pct}%`)

        if (!progressSeen) {
          progressSeen = true
          stallTimer = setInterval(() => {
            const sess2 = recordingSessions.get(sessionId)
            if (!sess2 || sess2.status !== 'starting') { if (stallTimer) clearInterval(stallTimer); return }
            const sinceMs     = Date.now() - (sess2.progress?.lastProgressAt ?? 0)
            const outTimeSec2 = sess2.progress?.outTimeSec ?? 0
            const pct2        = sess2.expectedDurationSec && sess2.expectedDurationSec > 0
              ? Math.min(99, Math.round(outTimeSec2 / sess2.expectedDurationSec * 100))
              : 0
            const nearComplete = (sess2.expectedDurationSec != null && sess2.expectedDurationSec > 0 &&
              outTimeSec2 >= sess2.expectedDurationSec - 5) || pct2 >= 98

            if (nearComplete && sinceMs > NEAR_COMPLETE_IDLE_MS) {
              log(`[recordings] vod_near_complete_finalize sessionId=${sessionId} outTimeSec=${outTimeSec2} expectedDurationSec=${sess2.expectedDurationSec} pct=${pct2}% idleMs=${sinceMs}`)
              nearCompleteFinalize = true
              clearInterval(stallTimer!); stallTimer = null
              try { proc.kill('SIGINT') } catch {}
            } else if (!nearComplete && sinceMs > STALL_TIMEOUT_MS) {
              const stallSec = Math.round(outTimeSec2)
              log(`[recordings] ffmpeg_stall_detected sessionId=${sessionId} sinceMs=${sinceMs} outTimeSec=${stallSec} pct=${pct2}%`)
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
      if (sess?.errorCode === 'RECORDING_STREAM_STALLED') { finish('stall'); return }
      if (!sess) { finish('cancelled'); return }
      if (nearCompleteFinalize) { finish('success'); return }
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
  canPlayHevcMp4:      boolean
  forceTranscode:      boolean
  vodFile:             string   // caller decides cache vs temp path
  filename:            string   // suggested download filename without extension
  log:                 (msg: string) => void
}): Promise<void> {
  const { sessionId, rtspUrl, rtspMasked, expectedDurationSec, canPlayHevcMp4, forceTranscode, vodFile, filename, log } = opts

  const session = recordingSessions.get(sessionId)
  if (!session) return

  // ── Step 1: Detect codec ─────────────────────────────────────────
  let detectedCodec = 'unknown'
  if (!RECORDINGS_FORCE_TRANSCODE && !forceTranscode) {
    try {
      const probe = await probeRtspStream(rtspUrl)
      detectedCodec = probe.codec || 'unknown'
      log(`[recordings] ffprobe_result sessionId=${sessionId} codec=${detectedCodec} ok=${probe.ok}`)
    } catch (err: any) {
      log(`[recordings] ffprobe_error sessionId=${sessionId} err=${err?.message} — assuming h264, using copy`)
      detectedCodec = 'h264'
    }
  } else {
    detectedCodec = 'forced_transcode'
  }

  // ── Step 2: Determine strategy ───────────────────────────────────
  const strategy = determineStrategy({ detectedCodec, canPlayHevcMp4, forceTranscode })
  const encoder  = strategy === 'hevc_transcode_preview' ? TRANSCODE_ENCODER : 'copy'

  // Persist strategy + codec on session for download logs and sidecar
  const sessForStrategy = recordingSessions.get(sessionId)
  if (sessForStrategy) {
    sessForStrategy.strategy = strategy
    sessForStrategy.codec    = detectedCodec
  }

  log(`[recordings] vod_strategy sessionId=${sessionId} strategy=${strategy} codec=${detectedCodec} canPlayHevc=${canPlayHevcMp4} forceTranscode=${forceTranscode} expectedDurationSec=${expectedDurationSec}`)
  log(`[recordings] encoder_selected sessionId=${sessionId} encoder=${encoder} reason=${strategy}`)

  const codecArgs = buildCodecArgs(strategy)

  // ── Step 3: Run FFmpeg ───────────────────────────────────────────
  const result = await spawnVodFfmpeg({
    sessionId, vodFile, rtspUrl, rtspMasked, codecArgs,
    attempt: strategy, expectedDurationSec, log,
  })

  if (result === 'stall' || result === 'cancelled') return

  const finalSession = recordingSessions.get(sessionId)
  if (!finalSession) { fs.unlink(vodFile, () => {}); return }

  if (result === 'success') {
    try {
      const stat = fs.statSync(vodFile)
      if (stat.size > 512) {
        const elapsedMs = Date.now() - (finalSession.startedAt ?? Date.now())
        log(
          `[recordings] vod_ready sessionId=${sessionId} strategy=${strategy} sizeBytes=${stat.size}` +
          ` elapsedMs=${elapsedMs} expectedDurationSec=${expectedDurationSec}` +
          ` codec=${detectedCodec} encoder=${encoder}` +
          ` crf=${strategy === 'hevc_transcode_preview' ? TRANSCODE_CRF : 'n/a'}` +
          ` maxrate=${strategy === 'hevc_transcode_preview' ? TRANSCODE_MAXRATE : 'n/a'}`
        )
        finalSession.vodFile  = vodFile
        finalSession.vodUrl   = `/api/recordings/playback/${sessionId}/file.mp4?token=${finalSession.fileToken}`
        finalSession.mimeType = 'video/mp4'
        finalSession.status   = 'ready'
        // Write sidecar for cache-hit logs (only when file lives in CACHE_DIR)
        if (finalSession.vodFileCached && CACHE_DIR) {
          writeSidecar(vodFile, { strategy, codec: detectedCodec, elapsedMs, sizeBytes: stat.size, createdAt: Date.now() })
        }
        issueDownloadToken({ sessionId, filePath: vodFile, filename: `${filename}.mp4`, log })
        return
      }
      // File too small — copy produced a degenerate file
      log(`[recordings] vod_copy_empty sessionId=${sessionId} strategy=${strategy} size=${stat.size} — falling back to hevc_transcode_preview`)
    } catch {
      log(`[recordings] vod_stat_failed sessionId=${sessionId} strategy=${strategy} — falling back to hevc_transcode_preview`)
    }

    // Automatic fallback to transcode when copy produced an unusable file
    if (strategy !== 'hevc_transcode_preview') {
      log(`[recordings] vod_transcode_fallback sessionId=${sessionId} — retrying with ${TRANSCODE_ENCODER}`)
      // Update session strategy for the fallback attempt
      const sessForFallback = recordingSessions.get(sessionId)
      if (sessForFallback) { sessForFallback.strategy = 'hevc_transcode_preview'; sessForFallback.codec = detectedCodec }
      try { fs.unlinkSync(vodFile) } catch {}
      const fallbackResult = await spawnVodFfmpeg({
        sessionId, vodFile, rtspUrl, rtspMasked,
        codecArgs: buildCodecArgs('hevc_transcode_preview'),
        attempt: 'hevc_transcode_fallback', expectedDurationSec, log,
      })
      if (fallbackResult === 'stall' || fallbackResult === 'cancelled') return
      const sess2 = recordingSessions.get(sessionId)
      if (!sess2) { fs.unlink(vodFile, () => {}); return }
      if (fallbackResult === 'success') {
        try {
          const stat2     = fs.statSync(vodFile)
          const elapsedMs = Date.now() - (sess2.startedAt ?? Date.now())
          log(`[recordings] vod_ready sessionId=${sessionId} strategy=hevc_transcode_fallback sizeBytes=${stat2.size} elapsedMs=${elapsedMs} encoder=${TRANSCODE_ENCODER} crf=${TRANSCODE_CRF} maxrate=${TRANSCODE_MAXRATE}`)
          sess2.vodFile  = vodFile
          sess2.vodUrl   = `/api/recordings/playback/${sessionId}/file.mp4?token=${sess2.fileToken}`
          sess2.mimeType = 'video/mp4'
          sess2.status   = 'ready'
          if (sess2.vodFileCached && CACHE_DIR) {
            writeSidecar(vodFile, { strategy: 'hevc_transcode_preview', codec: detectedCodec, elapsedMs, sizeBytes: stat2.size, createdAt: Date.now() })
          }
          issueDownloadToken({ sessionId, filePath: vodFile, filename: `${filename}.mp4`, log })
        } catch {
          sess2.status    = 'error'
          sess2.errorCode = 'VOD_FILE_MISSING'
          sess2.errorMsg  = 'El archivo generado no se pudo leer'
        }
      } else {
        log(`[recordings] vod_error sessionId=${sessionId} strategy=hevc_transcode_fallback result=${fallbackResult}`)
        sess2.status    = 'error'
        sess2.errorCode = 'TRANSCODE_FAILED'
        sess2.errorMsg  = 'No se pudo generar el video. Verifica la conexión al NVR.'
      }
    } else {
      finalSession.status    = 'error'
      finalSession.errorCode = 'TRANSCODE_FAILED'
      finalSession.errorMsg  = 'No se pudo generar el video. Verifica la conexión al NVR.'
    }
  } else {
    log(`[recordings] vod_error sessionId=${sessionId} strategy=${strategy} result=${result} encoder=${encoder}`)
    finalSession.status    = 'error'
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
  cameraId:       z.string().min(1),
  startTime:      z.string().datetime(),
  endTime:        z.string().datetime(),
  playbackURI:    z.string().startsWith('/').optional(),
  canPlayHevcMp4: z.boolean().optional(),
  forceTranscode: z.boolean().optional(),
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
        results: [], unsupportedNvr: true, nvrModel: nvr.model, nvrName: nvr.name,
        playbackWebUrl: (nvr as any).playbackWebUrl ?? null, errors: [], cameraCount: allowedIds.length,
      })
    }
    if (cachedCap === 'auth_error') {
      return reply.send({
        results: [], unsupportedNvr: false, authError: true, nvrModel: nvr.model, nvrName: nvr.name,
        errors: [{ code: 'NVR_AUTH_ERROR', message: 'Error de autenticación con el NVR' }], cameraCount: allowedIds.length,
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
            results, unsupportedNvr: false, authError: true, nvrModel: nvr.model, nvrName: nvr.name,
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
      results, unsupportedNvr, nvrModel: nvr.model, nvrName: nvr.name,
      playbackWebUrl: unsupportedNvr ? ((nvr as any).playbackWebUrl ?? null) : undefined,
      errors: [], cameraCount: allowedIds.length,
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

    const canPlayHevcMp4 = body.canPlayHevcMp4 ?? false
    const forceTranscode = body.forceTranscode ?? false

    let rtspUrl: string
    let rtspMasked: string
    let trackId: number | undefined
    let urlStrategy: string

    if (body.playbackURI) {
      const injected = injectCredentialsIntoPlaybackUri({
        playbackURI: body.playbackURI, username: camera.nvr.username,
        password: plainPass, ipAddress: camera.nvr.ipAddress, rtspPort: camera.nvr.rtspPort,
      })
      rtspUrl     = injected.url
      rtspMasked  = injected.masked
      urlStrategy = 'nvr_playbackURI'
    } else {
      const built = buildFallbackRecordingRtspUrl({
        username: camera.nvr.username, password: plainPass,
        ipAddress: camera.nvr.ipAddress, rtspPort: camera.nvr.rtspPort,
        channel: camera.channel, start: new Date(body.startTime), end: new Date(body.endTime),
      })
      rtspUrl     = built.url
      rtspMasked  = built.masked
      trackId     = built.trackId
      urlStrategy = 'fallback_timestamps'
    }

    const expectedDurationSec = Math.round(
      (new Date(body.endTime).getTime() - new Date(body.startTime).getTime()) / 1000
    )

    // ── Timezone diagnostic ───────────────────────────────────────────
    // Log raw times from client, server interpretation, and the RTSP URL we'll use.
    // Compare recStart_client vs rtsp_url to find timezone desfase.
    server.log.info(
      `[recordings] playback_time_mapping cameraId=${body.cameraId} ch=${camera.channel}` +
      ` startTime_client=${body.startTime} endTime_client=${body.endTime}` +
      ` startTime_local=${new Date(body.startTime).toLocaleString('es-CL', { timeZone: 'America/Santiago' })}` +
      ` startTime_utc=${new Date(body.startTime).toUTCString()}` +
      ` urlStrategy=${urlStrategy}` +
      ` playbackURI=${body.playbackURI ?? 'none'}` +
      ` rtsp_masked=${rtspMasked.substring(0, 120)}` +
      ` expectedDurationSec=${expectedDurationSec}` +
      ` nodeTimezone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`
    )

    // ── Cache check ──────────────────────────────────────────────────
    const cacheKey  = computeCacheKey({
      cameraId: body.cameraId, startTime: body.startTime, endTime: body.endTime,
      playbackURI: body.playbackURI ?? '', canPlayHevcMp4, forceTranscode,
    })
    const cacheFile = CACHE_DIR ? path.join(CACHE_DIR, `${cacheKey}.mp4`) : null

    // Build suggested download filename from startTime + camera name
    const startDate    = new Date(body.startTime)
    const pad          = (n: number) => String(n).padStart(2, '0')
    const datePart     = `${startDate.getFullYear()}${pad(startDate.getMonth() + 1)}${pad(startDate.getDate())}`
    const timePart     = `${pad(startDate.getHours())}${pad(startDate.getMinutes())}${pad(startDate.getSeconds())}`
    const safeCamName  = camera.name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32)
    const downloadFilename = `grabacion-${datePart}-${timePart}-${safeCamName}.mp4`

    if (cacheFile) {
      try {
        const stat = fs.statSync(cacheFile)
        if (stat.size > 512) {
          // Cache hit — create a ready session immediately with a fresh fileToken
          const sessionId  = crypto.randomBytes(8).toString('hex')
          const fileToken  = crypto.randomBytes(24).toString('hex')
          const expiresAt  = Date.now() + RECORDING_SESSION_TTL_MS
          const sidecar = readSidecar(cacheFile)
          server.log.info(`[recordings] vod_cache_hit sessionId=${sessionId} cacheKey=${cacheKey} strategy=${sidecar?.strategy ?? 'unknown'} codec=${sidecar?.codec ?? 'unknown'} sizeBytes=${stat.size} cameraId=${body.cameraId} cacheFile=${cacheFile}`)
          recordingSessions.set(sessionId, {
            expiresAt, startedAt: Date.now(), userId: user.sub,
            status: 'ready', fileToken,
            vodFile: cacheFile, vodFileCached: true,
            vodUrl: `/api/recordings/playback/${sessionId}/file.mp4?token=${fileToken}`,
            mimeType: 'video/mp4', expectedDurationSec,
          })
          const dlToken = issueDownloadToken({
            sessionId, filePath: cacheFile, filename: downloadFilename,
            log: (msg) => server.log.info(msg),
          })
          return reply.send({
            status: 'ready', sessionId,
            pollUrl:     `/api/recordings/playback/${sessionId}/status`,
            expiresAt:   new Date(expiresAt).toISOString(),
            expectedDurationSec,
            url:         `/api/recordings/playback/${sessionId}/file.mp4?token=${fileToken}`,
            mimeType:    'video/mp4',
            downloadUrl: `/api/recordings/download?t=${dlToken}`,
          })
        }
      } catch { /* cache miss — file doesn't exist */ }
      server.log.info(`[recordings] vod_cache_miss cacheKey=${cacheKey} cameraId=${body.cameraId} cacheFile=${cacheFile}`)
    }

    // ── Job deduplication: reuse in-progress or ready session ────────
    const jobKey = `${body.cameraId}|${body.startTime}|${body.endTime}|${body.playbackURI ?? ''}|${canPlayHevcMp4}|${forceTranscode}`
    const existingSid = recordingJobKeys.get(jobKey)
    if (existingSid) {
      const existing = recordingSessions.get(existingSid)
      if (existing && existing.userId === user.sub && existing.status !== 'error') {
        server.log.info(`[recordings] vod_reuse_session sessionId=${existingSid} jobKey=${jobKey} status=${existing.status}`)
        existing.expiresAt = Date.now() + RECORDING_SESSION_TTL_MS
        return reply.send({
          status:              existing.status,
          sessionId:           existingSid,
          pollUrl:             `/api/recordings/playback/${existingSid}/status`,
          expiresAt:           new Date(existing.expiresAt).toISOString(),
          expectedDurationSec: existing.expectedDurationSec,
          url:                 existing.vodUrl,
          mimeType:            existing.mimeType,
          downloadUrl:         existing.downloadUrl,
        })
      }
      recordingJobKeys.delete(jobKey)
    }

    const sessionId = crypto.randomBytes(8).toString('hex')
    const fileToken = crypto.randomBytes(24).toString('hex')
    const expiresAt = new Date(Date.now() + RECORDING_SESSION_TTL_MS).toISOString()

    // Destination: use cache dir if configured, otherwise session-scoped temp file
    const vodFile       = cacheFile ?? path.join(VOD_TEMP_DIR, `rec_${sessionId}.mp4`)
    const vodFileCached = !!cacheFile

    server.log.info(
      `[recordings] playback_init sessionId=${sessionId} jobKey=${jobKey}` +
      ` cameraId=${body.cameraId} ch=${camera.channel}` +
      (trackId ? ` trackId=${trackId}` : '') +
      ` urlStrategy=${urlStrategy} expectedDurationSec=${expectedDurationSec}` +
      ` canPlayHevcMp4=${canPlayHevcMp4} forceTranscode=${forceTranscode}` +
      ` cacheKey=${cacheKey} source=${rtspMasked}`
    )

    recordingSessions.set(sessionId, {
      expiresAt:  Date.now() + RECORDING_SESSION_TTL_MS,
      startedAt:  Date.now(),
      userId:     user.sub,
      status:     'starting',
      fileToken,
      jobKey,
      vodFileCached,
      expectedDurationSec,
    })
    recordingJobKeys.set(jobKey, sessionId)

    runVodBackground({
      sessionId, rtspUrl, rtspMasked, trackId, urlStrategy,
      expectedDurationSec, canPlayHevcMp4, forceTranscode, vodFile,
      filename: downloadFilename.replace(/\.mp4$/, ''),
      log: (msg) => server.log.info(msg),
    }).catch((err) => {
      server.log.error(`[recordings] bg_unhandled_error sessionId=${sessionId} err=${err?.message}`)
      const s = recordingSessions.get(sessionId)
      if (s && s.status === 'starting') {
        s.status    = 'error'
        s.errorCode = 'INTERNAL'
        s.errorMsg  = 'Error interno en el proceso de reproducción'
      }
    })

    AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
      startTime: body.startTime, endTime: body.endTime, sessionId,
    }).catch(() => {})

    return reply.send({
      status: 'starting', sessionId,
      pollUrl: `/api/recordings/playback/${sessionId}/status`,
      expiresAt, expectedDurationSec,
    })
  })

  // GET /api/recordings/playback/:sessionId/status
  server.get('/playback/:sessionId/status', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)

    if (!session) {
      return reply.status(404).send({
        status: 'error', errorCode: 'SESSION_NOT_FOUND',
        error:  'Sesión de reproducción no encontrada o expirada',
      })
    }
    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }

    const outTimeSec      = session.progress?.outTimeSec ?? 0
    const progressPercent = session.expectedDurationSec && outTimeSec > 0
      ? Math.min(99, Math.round(outTimeSec / session.expectedDurationSec * 100))
      : 0
    const elapsedMs = Date.now() - (session.startedAt ?? Date.now())

    return reply.send({
      status:              session.status,
      url:                 session.vodUrl,
      mimeType:            session.mimeType,
      errorCode:           session.errorCode,
      error:               session.errorMsg,
      expectedDurationSec: session.expectedDurationSec,
      outTimeSec,
      frame:               session.progress?.frame,
      fps:                 session.progress?.fps,
      speed:               session.progress?.speed,
      progressPercent,
      lastProgressAt:      session.progress?.lastProgressAt,
      elapsedMs,
      downloadUrl:         session.downloadUrl,
    })
  })

  // GET /api/recordings/playback/:sessionId/file.mp4 — Serve VOD file (token-authenticated).
  // Uses a per-session fileToken in the query string so native <video src> requests work
  // without an Authorization header.
  server.get('/playback/:sessionId/file.mp4', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const { token }     = request.query as { token?: string }
    const session       = recordingSessions.get(sessionId)

    if (!session || !session.fileToken || !token || token !== session.fileToken) {
      server.log.warn(`[recordings] file_token_invalid sessionId=${sessionId} hasSession=${!!session}`)
      return reply.status(401).send({ message: 'Token de archivo inválido o expirado' })
    }
    if (session.status !== 'ready' || !session.vodFile) {
      return reply.status(404).send({ message: 'Archivo no disponible' })
    }
    if (Date.now() > session.expiresAt) {
      server.log.warn(`[recordings] file_session_expired sessionId=${sessionId}`)
      return reply.status(401).send({ message: 'Sesión expirada' })
    }

    let fileSize: number
    try {
      fileSize = fs.statSync(session.vodFile).size
    } catch {
      server.log.warn(`[recordings] file_missing sessionId=${sessionId}`)
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
        .header('Cache-Control',  'private, no-store')
      return reply.send(fs.createReadStream(session.vodFile, { start, end }))
    }

    reply
      .header('Content-Type',   'video/mp4')
      .header('Content-Length', String(fileSize))
      .header('Accept-Ranges',  'bytes')
      .header('Cache-Control',  'private, no-store')
    return reply.send(fs.createReadStream(session.vodFile))
  })

  // DELETE /api/recordings/playback/:sessionId
  server.delete('/playback/:sessionId', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = recordingSessions.get(sessionId)
    if (!session) return reply.status(404).send({ message: 'Sesión no encontrada' })
    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }
    recordingSessions.delete(sessionId)
    if (session.jobKey) recordingJobKeys.delete(session.jobKey)
    if (session.vodProcess) {
      try { session.vodProcess.kill('SIGTERM') } catch {}
    }
    // Only remove temp files, not cache files (cache is managed by runCacheCleanup)
    if (session.vodFile && !session.vodFileCached) {
      fs.unlink(session.vodFile, () => {})
    }
    server.log.info(`[recordings] playback_stopped sessionId=${sessionId}`)
    return reply.send({ ok: true })
  })

  // GET /api/recordings/download?t=<token> — Long-lived download endpoint.
  // Token is independent of session lifetime (24h TTL) so Chrome can download
  // after the playback session expires. No JWT auth — token IS the credential.
  server.get('/download', async (request, reply) => {
    const { t } = request.query as { t?: string }

    if (!t) {
      server.log.warn('[recordings] download_token_invalid reason=missing')
      return reply.status(403).type('text/plain').send('Acceso denegado')
    }

    const dt = downloadTokens.get(t)
    if (!dt) {
      server.log.warn(`[recordings] download_token_invalid reason=not_found token=${t.slice(0, 8)}…`)
      return reply.status(403).type('text/plain').send('Acceso denegado')
    }
    if (Date.now() > dt.expiresAt) {
      downloadTokens.delete(t)
      server.log.warn(`[recordings] download_token_invalid reason=expired filename=${dt.filename}`)
      return reply.status(403).type('text/plain').send('Token expirado')
    }

    // Path-traversal guard: filename must be a plain name with no separators
    if (path.basename(dt.filePath) !== path.basename(dt.filePath) || dt.filePath !== path.resolve(dt.filePath)) {
      server.log.warn(`[recordings] download_token_invalid reason=path_traversal filePath=${dt.filePath}`)
      return reply.status(403).type('text/plain').send('Acceso denegado')
    }

    let fileSize: number
    try {
      fileSize = fs.statSync(dt.filePath).size
    } catch {
      server.log.warn(`[recordings] download_file_missing filename=${dt.filename} filePath=${dt.filePath}`)
      return reply.status(404).type('text/plain').send('Archivo no encontrado')
    }

    const safeFilename = dt.filename.replace(/[^\w\-_.]/g, '_')
    const downloadElapsedMs = Date.now() - dt.issuedAt
    server.log.info(`[recordings] download_started filename=${safeFilename} sizeBytes=${fileSize}`)
    server.log.info(`[recordings] download_ready sessionId=${dt.sessionId} sizeBytes=${fileSize} elapsedMs=${downloadElapsedMs} filename=${safeFilename}`)

    const rangeHeader = request.headers.range as string | undefined

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      if (!match) return reply.status(416).type('text/plain').send('Invalid Range')
      const start = match[1] ? parseInt(match[1], 10) : 0
      const end   = match[2] ? parseInt(match[2], 10) : fileSize - 1
      if (start > end || end >= fileSize) {
        reply.header('Content-Range', `bytes */${fileSize}`)
        return reply.status(416).type('text/plain').send('Range Not Satisfiable')
      }
      const chunkSize = end - start + 1
      reply
        .status(206)
        .header('Content-Range',       `bytes ${start}-${end}/${fileSize}`)
        .header('Accept-Ranges',       'bytes')
        .header('Content-Length',      String(chunkSize))
        .header('Content-Type',        'video/mp4')
        .header('Content-Disposition', `attachment; filename="${safeFilename}"`)
        .header('Cache-Control',       'private, no-store')
      return reply.send(fs.createReadStream(dt.filePath, { start, end }))
    }

    reply
      .header('Content-Type',        'video/mp4')
      .header('Content-Length',      String(fileSize))
      .header('Accept-Ranges',       'bytes')
      .header('Content-Disposition', `attachment; filename="${safeFilename}"`)
      .header('Cache-Control',       'private, no-store')
    return reply.send(fs.createReadStream(dt.filePath))
  })

  // GET /api/recordings/audit
  server.get('/audit', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { page = '1', limit = '50' } = request.query as { page?: string; limit?: string }

    const logs = await server.prisma.auditLog.findMany({
      where:   { action: { in: ['VIEW_RECORDING', 'SEARCH_RECORDINGS'] } },
      include: { user: { select: { username: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip:    (parseInt(page) - 1) * parseInt(limit),
      take:    parseInt(limit),
    })
    const total = await server.prisma.auditLog.count({
      where: { action: { in: ['VIEW_RECORDING', 'SEARCH_RECORDINGS'] } },
    })

    return reply.send({ logs, total, page: parseInt(page), limit: parseInt(limit) })
  })
}
