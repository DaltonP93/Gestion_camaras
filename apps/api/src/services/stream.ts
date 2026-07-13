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

// ─── Refcount de consumidores por path (Analytics ⇄ Live View) ──────
// MediaMTX ya cuenta lectores para el pull RTSP (sourceOnDemand), pero el
// stream-manager de Node puede BORRAR el path (removeStream) cuando el último
// viewer de live sale — eso rompería a Analytics si está leyendo el mismo
// restream. El StreamConsumerRegistry (Redis + memoria) lleva la cuenta de
// consumidores por path/tipo con leases TTL; removeStream lo consulta y no
// borra un path que aún tenga consumidores vigentes.
import { getStreamConsumerRegistry } from './stream-consumer-registry'

// Un solo consumidor analytics por path → id estable derivado del path.
const analyticsConsumerId = (streamPath: string) => `analytics:${streamPath}`

/** Analytics declara/renueva que está consumiendo este path (poll ~60s). */
export async function markAnalyticsConsumer(streamPath: string, ttlMs: number): Promise<void> {
  await getStreamConsumerRegistry().acquire(streamPath, 'analytics', analyticsConsumerId(streamPath), ttlMs)
}

/** Libera explícitamente el lease de Analytics sobre un path. */
export async function clearAnalyticsConsumer(streamPath: string): Promise<void> {
  await getStreamConsumerRegistry().release(streamPath, analyticsConsumerId(streamPath))
}

/** ¿Hay algún consumidor vigente sobre este path (cualquier tipo)? */
export async function hasActiveConsumers(streamPath: string): Promise<boolean> {
  return (await getStreamConsumerRegistry().count(streamPath)) > 0
}

// Transcoding config — read once at module load, no runtime overhead
// Accept both ENABLE_HEVC_TRANSCODING and the legacy alias ENABLE_HEVC_TRANSCODE
const ENABLE_HEVC_TRANSCODING  = process.env.ENABLE_HEVC_TRANSCODING === 'true' || process.env.ENABLE_HEVC_TRANSCODE === 'true'
const HEVC_TRANSCODE_PRESET    = process.env.HEVC_TRANSCODE_PRESET    || 'ultrafast'
// TRANSCODE_WIDTH takes priority; 'source' means no scaling
const HEVC_TRANSCODE_WIDTH     = process.env.TRANSCODE_WIDTH || process.env.HEVC_TRANSCODE_WIDTH || '1280'
// TRANSCODE_FPS / TRANSCODE_BITRATE are the canonical names; HEVC_ names kept for compat
const HEVC_TRANSCODE_FPS       = process.env.TRANSCODE_FPS     || process.env.HEVC_TRANSCODE_FPS     || '15'
const HEVC_TRANSCODE_BITRATE   = process.env.TRANSCODE_BITRATE || process.env.HEVC_TRANSCODE_BITRATE || '1500k'
// Optional overrides — default to computed values when unset
const TRANSCODE_MAXRATE        = process.env.TRANSCODE_MAXRATE  || HEVC_TRANSCODE_BITRATE
const TRANSCODE_BUFSIZE_ENV    = process.env.TRANSCODE_BUFSIZE  || ''  // empty → auto (2×bitrate)
const TRANSCODE_GOP_SECONDS    = Number(process.env.TRANSCODE_GOP_SECONDS || '2')
const MEDIAMTX_RTSP_PORT       = process.env.MEDIAMTX_RTSP_PORT || '8554'
const TRANSCODE_ENCODER        = process.env.TRANSCODE_ENCODER  || 'libx264'

// Derive MediaMTX hostname from MEDIAMTX_URL so FFmpeg publishes to the right host
const MEDIAMTX_HOST = (() => {
  try { return new URL(process.env.MEDIAMTX_URL || 'http://mediamtx:9997').hostname }
  catch { return 'mediamtx' }
})()

// Log all transcoding config at module load — confirms env vars are being read
console.info(
  `[transcode] config_loaded` +
  ` ENABLE_HEVC_TRANSCODING=${ENABLE_HEVC_TRANSCODING}` +
  ` ENCODER=${TRANSCODE_ENCODER}` +
  ` PRESET=${HEVC_TRANSCODE_PRESET}` +
  ` WIDTH=${HEVC_TRANSCODE_WIDTH}` +
  ` FPS=${HEVC_TRANSCODE_FPS}` +
  ` BITRATE=${HEVC_TRANSCODE_BITRATE}` +
  ` MAXRATE=${TRANSCODE_MAXRATE}` +
  ` BUFSIZE=${TRANSCODE_BUFSIZE_ENV || '(auto)'}` +
  ` GOP_SECONDS=${TRANSCODE_GOP_SECONDS}` +
  ` MEDIAMTX_HOST=${MEDIAMTX_HOST}` +
  ` RTSP_PORT=${MEDIAMTX_RTSP_PORT}`
)

const transcodeProcesses  = new Map<string, ChildProcess>()
const transcodeStderr     = new Map<string, string>()
// First ~1 KB of stderr captured separately — shows codec errors, file-not-found, etc.
// The rolling buffer captures the end; the start buffer captures startup messages.
const transcodeStderrStart = new Map<string, string>()
// Masked RTSP source URL per path — for diagnostic endpoint (no credentials)
const transcodeRtspMasked  = new Map<string, string>()
// Wall-clock timestamp when the process was spawned — used to detect very early exits
const transcodeSpawnTime   = new Map<string, number>()

// Mask RTSP credentials in any string before writing to logs or API responses
function sanitizeRtsp(s: string): string {
  return s.replace(/rtsp:\/\/([^:@\s]+):([^@\s]+)@/gi, 'rtsp://$1:***@')
}

// ─── RTSP timeout option detection ──────────────────────────
// Different FFmpeg builds expose different timeout options for the RTSP demuxer.
// Alpine FFmpeg 8.0.1 (this container): supports -timeout but NOT -rw_timeout.
// Detect once at first spawn and cache for the process lifetime.
type RtspTimeoutOpt = '-rw_timeout' | '-timeout' | null
let _rtspTimeoutOpt: RtspTimeoutOpt | undefined = undefined  // undefined = not yet detected

export function getRtspTimeoutOption(): RtspTimeoutOpt {
  if (_rtspTimeoutOpt !== undefined) return _rtspTimeoutOpt
  try {
    const out = execSync('ffmpeg -hide_banner -h demuxer=rtsp 2>&1', { timeout: 5000, stdio: 'pipe' }).toString()
    if (/^\s*-rw_timeout\b/m.test(out)) {
      _rtspTimeoutOpt = '-rw_timeout'
    } else if (/^\s*-timeout\b/m.test(out)) {
      _rtspTimeoutOpt = '-timeout'
    } else {
      _rtspTimeoutOpt = null
      console.warn('[transcode] rtsp_timeout_detect — neither rw_timeout nor timeout found in ffmpeg -h demuxer=rtsp; RTSP I/O timeout disabled')
    }
  } catch (err: any) {
    _rtspTimeoutOpt = null
    console.warn(`[transcode] rtsp_timeout_detect failed: ${err.message} — RTSP I/O timeout disabled`)
  }
  console.info(`[transcode] rtsp_timeout_detect opt=${_rtspTimeoutOpt ?? 'none'}`)
  return _rtspTimeoutOpt
}

export function spawnTranscodeProcess(nvr: NVR, camera: Camera, streamPath: string): ChildProcess | null {
  const pass: string = (nvr as any).password ?? ''
  if (!pass) {
    console.error(`[transcode] spawn_abort path=${streamPath} reason=PASSWORD_EMPTY (decryptPass returned empty — check NVR_CREDENTIAL_KEY)`)
    return null
  }

  const rtspInput = buildRtspUrl(nvr, camera.channel, false)  // main (HEVC) stream
  if (/:@/.test(rtspInput)) {
    const masked = rtspInput.replace(/rtsp:\/\/([^:@]+):([^@]+)@/gi, 'rtsp://$1:***@')
    console.error(`[transcode] spawn_abort path=${streamPath} reason=RTSP_EMPTY_CREDENTIALS url=${masked}`)
    return null  // empty password guard
  }

  const rtspOutput = `rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_RTSP_PORT}/${streamPath}`

  // GOP: force keyframe every TRANSCODE_GOP_SECONDS (default 2s) so HLS segments stay short
  const fps       = Number(HEVC_TRANSCODE_FPS) || 15
  const gopFrames = Math.max(1, Math.round(fps * TRANSCODE_GOP_SECONDS))

  // Bitrate / maxrate / bufsize
  const bitrateNum  = parseInt(HEVC_TRANSCODE_BITRATE) || 1500
  const bitrateUnit = HEVC_TRANSCODE_BITRATE.replace(/^\d+/, '') || 'k'
  const bufsize     = TRANSCODE_BUFSIZE_ENV || `${bitrateNum * 2}${bitrateUnit}`

  // Detect which RTSP I/O timeout option this FFmpeg build supports.
  // Alpine FFmpeg 8.0.1: -timeout (not -rw_timeout). Detection is cached after first call.
  const rtspTimeoutOpt = getRtspTimeoutOption()

  const args: string[] = [
    '-rtsp_transport', 'tcp',
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',
    ...(rtspTimeoutOpt ? [rtspTimeoutOpt, '15000000'] : []),  // 15s RTSP I/O timeout (microseconds)
    '-reorder_queue_size', '0',
    '-i', rtspInput,
    '-an',
  ]

  // Scale — skip if TRANSCODE_WIDTH=source
  if (HEVC_TRANSCODE_WIDTH !== 'source') {
    args.push('-vf', `scale=${HEVC_TRANSCODE_WIDTH}:-2`)
  }

  args.push(
    '-r', HEVC_TRANSCODE_FPS,
    '-c:v', TRANSCODE_ENCODER,
    '-preset', HEVC_TRANSCODE_PRESET,
  )

  // -tune zerolatency only valid for libx264/libx265
  if (TRANSCODE_ENCODER === 'libx264' || TRANSCODE_ENCODER === 'libx265') {
    args.push('-tune', 'zerolatency')
  }

  // Browser-compatibility + short GOP for live view
  args.push(
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-level', '4.1',
    '-bf', '0',               // no B-frames (already implied by zerolatency but explicit)
    '-sc_threshold', '0',     // disable scene-change detection to keep GOP regular
    '-g', String(gopFrames),
    '-keyint_min', String(gopFrames),
    // force_key_frames guarantees keyframes every TRANSCODE_GOP_SECONDS regardless of encoder
    '-force_key_frames', `expr:gte(t,n_forced*${TRANSCODE_GOP_SECONDS})`,
  )

  args.push(
    '-b:v', HEVC_TRANSCODE_BITRATE,
    '-maxrate', TRANSCODE_MAXRATE,
    '-bufsize', bufsize,
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    rtspOutput,
  )

  // Kill any stale process for this path before spawning a new one
  stopTranscodeProcess(streamPath)

  const inputMasked = rtspInput.replace(/rtsp:\/\/([^:@]+):([^@]+)@/gi, 'rtsp://$1:***@')
  console.info(`[transcode] spawn_start path=${streamPath} source=${inputMasked}`)
  console.info(
    `[transcode] spawn_ffmpeg path=${streamPath} encoder=${TRANSCODE_ENCODER}` +
    ` fps=${HEVC_TRANSCODE_FPS} width=${HEVC_TRANSCODE_WIDTH} gopFrames=${gopFrames}` +
    ` bitrate=${HEVC_TRANSCODE_BITRATE} maxrate=${TRANSCODE_MAXRATE} bufsize=${bufsize}` +
    ` input=${inputMasked}`
  )
  // Log full command for diagnosis (mask password)
  const maskedArgs = args.map(a => a === rtspInput ? inputMasked : a)
  console.info(`[transcode] spawn_ffmpeg_cmd path=${streamPath} cmd=ffmpeg ${maskedArgs.join(' ')}`)

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  transcodeProcesses.set(streamPath, proc)
  transcodeStderr.set(streamPath, '')
  transcodeStderrStart.set(streamPath, '')
  transcodeRtspMasked.set(streamPath, inputMasked)
  transcodeSpawnTime.set(streamPath, Date.now())

  proc.on('spawn', () => {
    console.info(`[transcode] ffmpeg_started path=${streamPath} pid=${proc.pid}`)
    // Verify FFmpeg is still alive 2s after spawn — catches immediate crashes
    // (e.g. invalid arguments, codec not found) before waitForHlsReady starts polling.
    setTimeout(() => {
      const alive = !!(proc.exitCode === null && !proc.killed)
      console.info(
        `[transcode] ffmpeg_alive_check path=${streamPath} pid=${proc.pid}` +
        ` alive=${alive} exitCode=${proc.exitCode ?? 'null'} killed=${proc.killed}`
      )
    }, 2000)
  })

  proc.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString()
    // Save first ~1KB for startup/error diagnosis (codec errors, file-not-found, etc.)
    const startBuf = transcodeStderrStart.get(streamPath) || ''
    if (startBuf.length < 1200) {
      transcodeStderrStart.set(streamPath, (startBuf + chunk).slice(0, 1200))
    }
    // 20 KB rolling buffer for the tail (encoding stats, last error lines)
    let s = (transcodeStderr.get(streamPath) || '') + chunk
    if (s.length > 20_000) s = s.slice(-20_000)
    transcodeStderr.set(streamPath, s)
  })

  proc.on('exit', (code, signal) => {
    // Sanitize before any logging — FFmpeg echoes the input URL (with credentials) in stderr
    const fullStderr  = sanitizeRtsp(transcodeStderr.get(streamPath) || '')
    const startBuf    = sanitizeRtsp(transcodeStderrStart.get(streamPath) || '')
    const spawnedAt   = transcodeSpawnTime.get(streamPath) ?? Date.now()
    const uptime      = Date.now() - spawnedAt
    const isEarlyExit = uptime < 3_000
    const exitLabel   = code !== null ? `code=${code}` : `signal=${signal}`
    const isEof       = fullStderr.includes('End of file') || fullStderr.includes('Failed reading RTSP data')
    const exitReason  = isEof              ? 'RTSP_INPUT_EOF'
      : (code === 8 && isEarlyExit)       ? 'FFMPEG_INVALID_OPTION'
      : code !== null                      ? `exit_${code}`
      : `sig_${signal}`
    console.warn(`[transcode] ffmpeg_exit path=${streamPath} ${exitLabel} reason=${exitReason} uptime=${uptime}ms stderrBytes=${fullStderr.length}`)

    if (isEarlyExit) {
      // Very early exit — likely an invalid argument. Extract option-error lines explicitly.
      const combined    = startBuf + '\n' + fullStderr
      const optErrors   = combined.split('\n')
        .filter(l => /unrecognized option|option .* not found|invalid argument|error splitting the argument|unknown encoder|no such (file|codec)/i.test(l))
        .slice(0, 5).join(' | ')
      if (optErrors) {
        console.error(`[transcode] ffmpeg_option_error path=${streamPath} uptime=${uptime}ms | ${optErrors}`)
      }
      const startLog = startBuf.slice(0, 1200).replace(/\n/g, ' | ')
      console.error(`[transcode] ffmpeg_early_exit path=${streamPath} uptime=${uptime}ms code=${code} | ${startLog || '(empty stderr — FFmpeg may not have started)'}`)
    } else if (fullStderr.length > 0) {
      const startLog = startBuf.slice(0, 800).replace(/\n/g, ' | ')
      console.warn(`[transcode] ffmpeg_stderr_start path=${streamPath} | ${startLog}`)
      const endLog = fullStderr.slice(-1500).replace(/\n/g, ' | ')
      console.warn(`[transcode] ffmpeg_stderr_end   path=${streamPath} | ${endLog}`)
    } else {
      console.warn(`[transcode] ffmpeg_exit_no_stderr path=${streamPath} — FFmpeg may not have started (binary missing or EPERM)`)
    }
    transcodeProcesses.delete(streamPath)
    transcodeSpawnTime.delete(streamPath)
    transcodeStderrStart.delete(streamPath)
  })

  proc.on('error', (err: NodeJS.ErrnoException) => {
    // 'error' event fires when spawn itself fails (ENOENT=binary not found, EACCES=no exec permission)
    console.error(`[transcode] ffmpeg_spawn_error path=${streamPath} err=${err.message} code=${err.code ?? 'n/a'}`)
    if (err.code === 'ENOENT') {
      console.error(`[transcode] ffmpeg_not_found — 'ffmpeg' binary not in PATH inside API container. Check Dockerfile.`)
    }
    transcodeProcesses.delete(streamPath)
    transcodeStderrStart.delete(streamPath)
  })

  return proc
}

export function stopTranscodeProcess(streamPath: string): void {
  const proc = transcodeProcesses.get(streamPath)
  if (!proc) return
  try { proc.kill('SIGTERM') } catch {}
  transcodeProcesses.delete(streamPath)
  transcodeRtspMasked.delete(streamPath)
  console.info(`[transcode] ffmpeg_killed path=${streamPath}`)
}

// ─── Spawn FFmpeg transcode from an explicit RTSP URL ────────
// Used for recording playback: takes the full RTSP playbackURI from the NVR
// rather than deriving it from NVR/Camera objects (as spawnTranscodeProcess does).
// mode='recording': adds -re to process at native framerate so HLS segments are
// generated before FFmpeg finishes the clip. Without -re, FFmpeg transcodes a
// 15s clip in ~1s and exits before MediaMTX creates any HLS segments.
export function spawnTranscodeFromRtsp(
  rtspUrl:   string,
  maskedUrl: string,
  streamPath: string,
  opts?: { mode?: 'live' | 'recording' },
): ChildProcess | null {
  const mode = opts?.mode ?? 'live'
  const rtspOutput = `rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_RTSP_PORT}/${streamPath}`

  const fps         = Number(HEVC_TRANSCODE_FPS) || 15
  const gopFrames   = Math.max(1, Math.round(fps * TRANSCODE_GOP_SECONDS))
  const bitrateNum  = parseInt(HEVC_TRANSCODE_BITRATE) || 1500
  const bitrateUnit = HEVC_TRANSCODE_BITRATE.replace(/^\d+/, '') || 'k'
  const bufsize     = TRANSCODE_BUFSIZE_ENV || `${bitrateNum * 2}${bitrateUnit}`
  const rtspTimeoutOpt = getRtspTimeoutOption()
  // Recording RTSP sessions may take longer to initialize (NVR seek + segment locate).
  const rtspTimeoutUs  = mode === 'recording' ? 60_000_000 : 15_000_000

  const args: string[] = []

  if (mode === 'recording') args.push('-re')   // real-time rate for short clips

  args.push(
    '-rtsp_transport', 'tcp',
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',
    ...(rtspTimeoutOpt ? [rtspTimeoutOpt, String(rtspTimeoutUs)] : []),
    '-reorder_queue_size', '0',
    '-i', rtspUrl,
    '-an',
  )

  if (HEVC_TRANSCODE_WIDTH !== 'source') {
    args.push('-vf', `scale=${HEVC_TRANSCODE_WIDTH}:-2`)
  }

  args.push(
    '-r', HEVC_TRANSCODE_FPS,
    '-c:v', TRANSCODE_ENCODER,
    '-preset', HEVC_TRANSCODE_PRESET,
  )

  if (TRANSCODE_ENCODER === 'libx264' || TRANSCODE_ENCODER === 'libx265') {
    args.push('-tune', 'zerolatency')
  }

  args.push(
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-level', '4.1',
    '-bf', '0',
    '-sc_threshold', '0',
    '-g', String(gopFrames),
    '-keyint_min', String(gopFrames),
    '-force_key_frames', `expr:gte(t,n_forced*${TRANSCODE_GOP_SECONDS})`,
    '-b:v', HEVC_TRANSCODE_BITRATE,
    '-maxrate', TRANSCODE_MAXRATE,
    '-bufsize', bufsize,
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    rtspOutput,
  )

  stopTranscodeProcess(streamPath)

  console.info(`[transcode] spawn_recording path=${streamPath} mode=${mode} source=${maskedUrl}`)
  const maskedArgs = args.map(a => a === rtspUrl ? maskedUrl : a)
  console.info(`[transcode] spawn_ffmpeg_cmd path=${streamPath} cmd=ffmpeg ${maskedArgs.join(' ')}`)

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  transcodeProcesses.set(streamPath, proc)
  transcodeStderr.set(streamPath, '')
  transcodeStderrStart.set(streamPath, '')
  transcodeRtspMasked.set(streamPath, maskedUrl)
  transcodeSpawnTime.set(streamPath, Date.now())

  proc.on('spawn', () => {
    console.info(`[transcode] ffmpeg_started path=${streamPath} pid=${proc.pid} mode=${mode}`)
  })

  proc.stderr?.on('data', (data: Buffer) => {
    const chunk   = data.toString()
    const startBuf = transcodeStderrStart.get(streamPath) || ''
    if (startBuf.length < 1200) {
      transcodeStderrStart.set(streamPath, (startBuf + chunk).slice(0, 1200))
    }
    let s = (transcodeStderr.get(streamPath) || '') + chunk
    if (s.length > 20_000) s = s.slice(-20_000)
    transcodeStderr.set(streamPath, s)
  })

  proc.on('exit', (code, signal) => {
    const fullStderr  = sanitizeRtsp(transcodeStderr.get(streamPath) || '')
    const startBuf    = sanitizeRtsp(transcodeStderrStart.get(streamPath) || '')
    const spawnedAt   = transcodeSpawnTime.get(streamPath) ?? Date.now()
    const uptime      = Date.now() - spawnedAt
    const isEarlyExit = uptime < 3_000
    const exitLabel   = code !== null ? `code=${code}` : `signal=${signal}`
    const isEof       = fullStderr.includes('End of file') || fullStderr.includes('Failed reading RTSP data')
    const exitReason  = isEof && mode === 'recording' ? 'RECORDING_EOF'
      : isEof                                         ? 'RTSP_INPUT_EOF'
      : (code === 8 && isEarlyExit)                  ? 'FFMPEG_INVALID_OPTION'
      : code !== null                                 ? `exit_${code}`
      : `sig_${signal}`

    console.warn(
      `[transcode] ffmpeg_exit path=${streamPath} mode=${mode} ${exitLabel}` +
      ` reason=${exitReason} uptime=${uptime}ms stderrBytes=${fullStderr.length}`
    )

    if (isEarlyExit) {
      const combined  = startBuf + '\n' + fullStderr
      const optErrors = combined.split('\n')
        .filter(l => /unrecognized option|option .* not found|invalid argument|error splitting|unknown encoder|no such (file|codec)/i.test(l))
        .slice(0, 5).join(' | ')
      if (optErrors) console.error(`[transcode] ffmpeg_option_error path=${streamPath} | ${optErrors}`)
      const startLog = startBuf.slice(0, 1200).replace(/\n/g, ' | ')
      console.error(`[transcode] ffmpeg_early_exit path=${streamPath} mode=${mode} uptime=${uptime}ms | ${startLog || '(empty)'}`)
    } else if (fullStderr.length > 0) {
      // Always log stderr for recordings — essential for diagnosing RTSP/codec errors
      const endLog = fullStderr.slice(-1500).replace(/\n/g, ' | ')
      console.info(`[transcode] ffmpeg_stderr_end path=${streamPath} mode=${mode} | ${endLog}`)
    }

    transcodeProcesses.delete(streamPath)
    transcodeSpawnTime.delete(streamPath)
    transcodeStderrStart.delete(streamPath)
    // transcodeStderr is kept for post-exit diagnostic access by getTranscodeStderr
  })

  proc.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[transcode] ffmpeg_spawn_error path=${streamPath} err=${err.message}`)
    if (err.code === 'ENOENT') console.error('[transcode] ffmpeg_not_found — check Dockerfile')
    transcodeProcesses.delete(streamPath)
    transcodeStderrStart.delete(streamPath)
  })

  return proc
}

export function isTranscodeProcessAlive(streamPath: string): boolean {
  const proc = transcodeProcesses.get(streamPath)
  return !!(proc && proc.exitCode === null && !proc.killed)
}

export function getTranscodeStderr(streamPath: string): string {
  const start = sanitizeRtsp((transcodeStderrStart.get(streamPath) || '').slice(0, 600))
  const end   = sanitizeRtsp((transcodeStderr.get(streamPath) || '').slice(-1200))
  if (start && !end.startsWith(start.slice(0, 40))) {
    return `[inicio]\n${start}\n[final]\n${end}`
  }
  return end
}

export function isTranscodingEnabled(): boolean { return ENABLE_HEVC_TRANSCODING }

// List all active FFmpeg transcoding processes — for diagnostic endpoint and health checks
export function getActiveTranscodesList(): Array<{
  streamPath: string
  pid:        number | undefined
  alive:      boolean
  stderrBytes: number
}> {
  return Array.from(transcodeProcesses.entries()).map(([path, proc]) => ({
    streamPath:  path,
    pid:         proc.pid,
    alive:       proc.exitCode === null && !proc.killed,
    stderrBytes: (transcodeStderr.get(path) || '').length,
  }))
}

// Full 20 KB rolling stderr buffer — used by supervisor to classify exit reason and
// by the diagnostic endpoint. Credentials are masked before returning.
export function getTranscodeRawStderr(streamPath: string): string {
  return sanitizeRtsp(transcodeStderr.get(streamPath) || '')
}

// Masked RTSP source URL — credentials replaced with *** for diagnostic endpoint
export function getTranscodeRtspMasked(streamPath: string): string | undefined {
  return transcodeRtspMasked.get(streamPath)
}

// Check if MediaMTX has an active RTSP publisher on this path (i.e. FFmpeg is connected
// and pushing frames). This is reliable BEFORE the HLS muxer creates its first segment —
// the muxer may not exist yet while the RTSP path is already live.
// Uses the live /v3/paths/get/{name} endpoint (not config).
async function isRtspPublisherActive(streamPath: string): Promise<boolean> {
  try {
    const res = await mediamtxApi.get('/v3/paths/get/' + streamPath, {
      timeout: 2000,
      validateStatus: () => true,
    })
    // ready=true means the path has an active source (RTSP publisher connected)
    return res.status === 200 && res.data?.ready === true
  } catch {
    return false
  }
}

// Returns true if a media playlist body has any indicator that it is a valid,
// playable HLS media playlist (not just a bare #EXTM3U stub).
function isMediaPlaylistReady(body: string): boolean {
  return (
    body.includes('#EXTINF')                ||
    body.includes('#EXT-X-PART')            ||
    body.includes('#EXT-X-MAP')             ||
    body.includes('#EXT-X-TARGETDURATION')  ||
    body.includes('#EXT-X-MEDIA-SEQUENCE')  ||
    body.includes('.ts')                    ||
    body.includes('.m4s')                   ||
    body.includes('.mp4')
  )
}

// Extract the first variant stream URI from a master playlist body.
function extractFirstVariantUri(masterBody: string): string | null {
  const lines = masterBody.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim().startsWith('#EXT-X-STREAM-INF')) {
      const uri = lines[i + 1]?.trim()
      if (uri && !uri.startsWith('#') && uri.length > 0) return uri
    }
  }
  return null
}

// ─── Cookie-aware HTTP fetch with manual redirect following ──
// Axios in Node does not maintain a cookie jar. MediaMTX HLS requires:
//   1. GET index.m3u8  → 302 + Set-Cookie: cookieCheck=1
//   2. Follow redirect → 200 + Set-Cookie: hlsSession=<uuid>
//   3. GET variant     → send both cookies → 200 + segments
// This helper follows redirects manually and accumulates Set-Cookie headers
// into the provided jar (Map<name,value>) so subsequent requests reuse them.
async function fetchWithCookieJar(
  url: string,
  jar: Map<string, string>,
  timeoutMs = 3000,
): Promise<{ status: number; body: string }> {
  let currentUrl = url

  for (let hop = 0; hop < 6; hop++) {
    const cookieHeader = jar.size > 0
      ? Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
      : undefined

    const res = await axios.get(currentUrl, {
      timeout: timeoutMs,
      validateStatus: () => true,
      responseType: 'text',
      maxRedirects: 0,   // manual redirect — we need to capture Set-Cookie on 302 too
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    })

    // Accumulate all Set-Cookie headers into the jar
    const setCookies = res.headers['set-cookie']
    if (setCookies) {
      const list = Array.isArray(setCookies) ? setCookies : [setCookies]
      for (const c of list) {
        const eqIdx = c.indexOf('=')
        const semi  = c.indexOf(';')
        if (eqIdx > 0) {
          const name  = c.slice(0, eqIdx).trim()
          const value = c.slice(eqIdx + 1, semi > eqIdx ? semi : undefined).trim()
          jar.set(name, value)
        }
      }
    }

    if (res.status >= 300 && res.status < 400) {
      const location = (res.headers['location'] as string | undefined) || ''
      if (location) {
        try {
          currentUrl = new URL(location, currentUrl).href
        } catch {
          currentUrl = location.startsWith('/') ? `${MEDIAMTX_HLS_INTERNAL}${location}` : location
        }
        continue
      }
    }

    return { status: res.status, body: typeof res.data === 'string' ? res.data : '' }
  }

  return { status: 0, body: '' }
}

// ─── Wait for HLS manifest with real segment data ───────────
// Polls internal MediaMTX HLS port waiting for FFmpeg to start publishing.
//
// MediaMTX HLS flow:
//   GET index.m3u8 → 302 (Set-Cookie: cookieCheck=1) → 200 (Set-Cookie: hlsSession=uuid)
//   index.m3u8 body is a MASTER PLAYLIST with #EXT-X-STREAM-INF → video1_stream.m3u8
//   GET video1_stream.m3u8 with Cookie: cookieCheck=1; hlsSession=uuid → 200 + #EXTINF
//
// We use a cookie jar that persists across all polling iterations so the
// 302→200 handshake happens once and subsequent polls reuse the same session.
//
// Returns { ready, lastStatus, elapsedMs, processExited, manifestVisible }.
// manifestVisible=true → master or media playlist was seen at 200; caller must NOT
// kill FFmpeg on timeout (the stream IS live, it's a cookie/timing issue).
export async function waitForHlsReady(
  streamPath: string,
  maxWaitMs = 60_000,
  intervalMs = 300,
  isAlive?: () => boolean,
): Promise<{ ready: boolean; lastStatus: number; elapsedMs: number; processExited: boolean; manifestVisible: boolean }> {
  const masterUrl       = `${MEDIAMTX_HLS_INTERNAL}/${streamPath}/index.m3u8`
  const startMs         = Date.now()
  const deadline        = startMs + maxWaitMs
  let lastStatus        = 0
  let lastLoggedAt      = 0
  let manifestVisible   = false
  let bodyLoggedOnce    = false
  let consecutiveAuth   = 0   // consecutive auth errors on variant — clear jar after threshold
  const cookieJar       = new Map<string, string>()  // persists across all iterations

  console.info(`[transcode] waiting_hls path=${streamPath} maxWaitMs=${maxWaitMs}`)

  for (let i = 0; ; i++) {
    const now       = Date.now()
    const remaining = deadline - now
    if (remaining <= 0) break

    if (isAlive && !isAlive()) {
      const elapsed = now - startMs
      const rem = deadline - now
      if (rem > 2600) {
        // Give the supervisor (2s backoff) time to restart FFmpeg before aborting.
        console.warn(`[transcode] waiting_hls process_exited path=${streamPath} elapsedMs=${elapsed} — waiting 2.5s for supervisor restart`)
        await new Promise(r => setTimeout(r, 2500))
        if (!isAlive()) {
          const elapsed2 = Date.now() - startMs
          console.warn(`[transcode] waiting_hls aborted path=${streamPath} reason=process_exited elapsedMs=${elapsed2}`)
          return { ready: false, lastStatus, elapsedMs: elapsed2, processExited: true, manifestVisible }
        }
        console.info(`[transcode] waiting_hls process_restarted path=${streamPath} — supervisor restarted FFmpeg, continuing poll`)
        continue
      } else {
        console.warn(`[transcode] waiting_hls aborted path=${streamPath} reason=process_exited elapsedMs=${elapsed}`)
        return { ready: false, lastStatus, elapsedMs: elapsed, processExited: true, manifestVisible }
      }
    }

    // Every 5 iterations (~1.5s), check if RTSP publisher is active in MediaMTX.
    // The HLS muxer may not exist yet while FFmpeg is already connected and sending frames.
    // If publisher is active, set manifestVisible=true so FFmpeg won't be killed on timeout.
    if (i > 0 && i % 5 === 0 && !manifestVisible) {
      const pubActive = await isRtspPublisherActive(streamPath)
      if (pubActive) {
        manifestVisible = true
        console.info(
          `[transcode] waiting_hls path=${streamPath} attempt=${i + 1}` +
          ` rtsp_publisher_active=true hls_not_ready_yet elapsedMs=${Date.now() - startMs}`
        )
      }
    }

    // Per-request timeout: min(3s, remaining) so we don't overshoot the deadline
    const perReqMs = Math.min(3000, Math.max(500, remaining))

    try {
      const { status, body } = await fetchWithCookieJar(masterUrl, cookieJar, perReqMs)
      lastStatus = status
      const hasHeader = body.includes('#EXTM3U')
      const isMaster  = body.includes('#EXT-X-STREAM-INF')

      if (hasHeader) manifestVisible = true

      // ── Case A: direct media playlist ─────────────────────────────────────
      if (status === 200 && hasHeader && !isMaster && isMediaPlaylistReady(body)) {
        const elapsed = Date.now() - startMs
        console.info(`[transcode] hls_ready path=${streamPath} type=media_playlist attempt=${i + 1} elapsedMs=${elapsed}`)
        return { ready: true, lastStatus, elapsedMs: elapsed, processExited: false, manifestVisible: true }
      }

      // ── Case B: master playlist — follow variant with same cookie jar ──────
      if (status === 200 && hasHeader && isMaster) {
        const variantUri = extractFirstVariantUri(body)
        if (variantUri) {
          const base       = `${MEDIAMTX_HLS_INTERNAL}/${streamPath}/`
          const variantUrl = variantUri.startsWith('http') ? variantUri : `${base}${variantUri}`
          const cookieHdr  = cookieJar.size > 0
            ? Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
            : '(none)'

          const rem2      = deadline - Date.now()
          if (rem2 <= 0) break
          const varReqMs  = Math.min(3000, Math.max(500, rem2))

          const { status: varStatus, body: varBody } = await fetchWithCookieJar(variantUrl, cookieJar, varReqMs)

          if (varStatus === 200 && varBody.includes('#EXTM3U') && isMediaPlaylistReady(varBody)) {
            const elapsed   = Date.now() - startMs
            const mediaSeq  = varBody.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? '-'
            const targetDur = varBody.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] ?? '-'
            console.info(
              `[transcode] hls_ready path=${streamPath} type=master+variant` +
              ` attempt=${i + 1} elapsedMs=${elapsed} variant=${variantUri.split('?')[0]}` +
              ` targetDuration=${targetDur} mediaSequence=${mediaSeq}`
            )
            return { ready: true, lastStatus, elapsedMs: elapsed, processExited: false, manifestVisible: true }
          }

          const isAuthError = varStatus === 401 || varBody.includes('"authentication error"')
          if (isAuthError) {
            consecutiveAuth++
            // Only clear the jar after 5 consecutive auth failures — avoids creating new
            // MediaMTX HLS sessions on every attempt (each new hlsSession = new muxer reader).
            const shouldClear = consecutiveAuth >= 5
            if (Date.now() - lastLoggedAt >= 500 || shouldClear) {
              console.warn(
                `[transcode] waiting_hls child_auth_error path=${streamPath}` +
                ` attempt=${i + 1} variantStatus=${varStatus} consecutiveAuth=${consecutiveAuth}` +
                ` clearing=${shouldClear} cookieHdr=${cookieHdr}` +
                ` varBodyFirst100=${varBody.slice(0, 100).replace(/\n/g, '\\n')}`
              )
              lastLoggedAt = Date.now()
            }
            if (shouldClear) {
              cookieJar.clear()
              consecutiveAuth = 0
            }
          } else {
            consecutiveAuth = 0
            if (Date.now() - lastLoggedAt >= 1000) {
              const targetDur = varBody.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] ?? '-'
              const mediaSeq  = varBody.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? '-'
              console.info(
                `[transcode] waiting_hls path=${streamPath} attempt=${i + 1}` +
                ` master_ok variant_not_ready variantStatus=${varStatus}` +
                ` varBodyLen=${varBody.length} varHdr=${varBody.includes('#EXTM3U')}` +
                ` varSegs=${isMediaPlaylistReady(varBody)} targetDuration=${targetDur}` +
                ` mediaSequence=${mediaSeq} extinf=${varBody.includes('#EXTINF')}` +
                ` map=${varBody.includes('#EXT-X-MAP')} cookies=${cookieJar.size}` +
                ` elapsedMs=${Date.now() - startMs} remainingMs=${deadline - Date.now()}`
              )
              lastLoggedAt = Date.now()
            }
          }
        } else if (Date.now() - lastLoggedAt >= 1000) {
          console.info(`[transcode] waiting_hls path=${streamPath} attempt=${i + 1} master_no_variant_uri bodyLen=${body.length}`)
          lastLoggedAt = Date.now()
        }
        // Master is visible — FFmpeg is alive; don't kill on timeout
        manifestVisible = true
      } else if (status === 200 && hasHeader && !isMediaPlaylistReady(body) && !bodyLoggedOnce) {
        bodyLoggedOnce = true
        console.warn(
          `[transcode] waiting_hls manifest_no_segment path=${streamPath}` +
          ` isMaster=${isMaster} bodyLen=${body.length}` +
          ` first500=${body.slice(0, 500).replace(/\n/g, '\\n')}`
        )
      } else if (Date.now() - lastLoggedAt >= 1000) {
        console.info(
          `[transcode] waiting_hls path=${streamPath} attempt=${i + 1} status=${status}` +
          ` header=${hasHeader} isMaster=${isMaster} bodyLen=${body.length}` +
          ` cookies=${cookieJar.size} elapsedMs=${Date.now() - startMs}` +
          ` remainingMs=${deadline - Date.now()}`
        )
        lastLoggedAt = Date.now()
      }
    } catch (err: any) {
      if (Date.now() - lastLoggedAt >= 2000) {
        console.info(
          `[transcode] waiting_hls path=${streamPath} attempt=${i + 1}` +
          ` fetch_error=${err.message} elapsedMs=${Date.now() - startMs}`
        )
        lastLoggedAt = Date.now()
      }
    }

    const rem3 = deadline - Date.now()
    if (rem3 <= 0) break
    await new Promise(r => setTimeout(r, Math.min(intervalMs, rem3)))
  }

  const elapsed = Date.now() - startMs

  // Final publisher check: if we never saw the HLS manifest but RTSP publisher is active,
  // FFmpeg IS alive and connected — don't kill it on timeout.
  if (!manifestVisible) {
    const pubActive = await isRtspPublisherActive(streamPath)
    if (pubActive) {
      manifestVisible = true
      console.warn(
        `[transcode] hls_timeout path=${streamPath} elapsedMs=${elapsed}` +
        ` rtsp_publisher_active=true → setting manifestVisible=true (HLS muxer slow to start)`
      )
    }
  }

  console.warn(
    `[transcode] hls_timeout path=${streamPath} lastStatus=${lastStatus}` +
    ` elapsedMs=${elapsed} manifestVisible=${manifestVisible} cookies=${cookieJar.size}`
  )
  return { ready: false, lastStatus, elapsedMs: elapsed, processExited: false, manifestVisible }
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
    console.error(`[transcode] register_path_error path=${streamPath} reason=PASSWORD_EMPTY`)
    return false
  }

  if (inFlightPaths.has(streamPath)) {
    console.info(`[transcode] register_path_skip path=${streamPath} reason=in_flight`)
    return true
  }

  // Minimal passive receiver config — NO empty-string fields (MediaMTX validates
  // field types; an empty string for source/runOnDemand causes a 400 rejection).
  const pathConfig = {
    record:            false,
    overridePublisher: true,
  }

  const fp = `passive_receiver_v3|${streamPath}`
  if (registeredPaths.get(streamPath) === fp) {
    console.info(`[transcode] register_path_skip path=${streamPath} reason=already_registered`)
    return true
  }

  const encodedPath = encodeURIComponent(streamPath)
  const addUrl      = `/v3/config/paths/add/${encodedPath}`
  const delUrl      = `/v3/config/paths/delete/${encodedPath}`

  console.info(`[transcode] register_path_start path=${streamPath} encoder=${TRANSCODE_ENCODER}`)

  inFlightPaths.add(streamPath)
  try {
    // ── Step 1: POST (optimistic create) ────────────────────
    console.info(`[transcode] register_path request method=POST url=${addUrl} body=${sanitizeRtsp(JSON.stringify(pathConfig))}`)
    try {
      const res = await mediamtxApi.post(addUrl, pathConfig)
      console.info(`[transcode] register_path response status=${res.status} body=${JSON.stringify(res.data)}`)
      registeredPaths.set(streamPath, fp)
      console.info(`[transcode] register_path_ok path=${streamPath} method=POST`)
      return true
    } catch (postErr: any) {
      const postStatus = postErr.response?.status
      const postBody   = JSON.stringify(postErr.response?.data ?? postErr.message)
      console.warn(`[transcode] register_path response status=${postStatus} body=${postBody} path=${streamPath}`)

      if (postStatus !== 400 && postStatus !== 409) {
        console.error(`[transcode] register_path_error path=${streamPath} method=POST status=${postStatus}`)
        return false
      }

      // ── Step 2: DELETE existing path, then POST again ──────
      console.info(`[transcode] register_path request method=DELETE url=${delUrl} path=${streamPath}`)
      try {
        const delRes = await mediamtxApi.delete(delUrl)
        console.info(`[transcode] register_path response status=${delRes.status} method=DELETE path=${streamPath}`)
      } catch (delErr: any) {
        const delStatus = delErr.response?.status
        const delBody   = JSON.stringify(delErr.response?.data ?? delErr.message)
        console.warn(`[transcode] register_path response status=${delStatus} body=${delBody} method=DELETE path=${streamPath}`)
        // 404 on DELETE is fine — path may not exist yet; continue to re-POST
        if (delStatus !== 404) {
          console.error(`[transcode] register_path_error path=${streamPath} method=DELETE status=${delStatus}`)
          return false
        }
      }

      // ── Step 3: POST after DELETE ─────────────────────────
      console.info(`[transcode] register_path request method=POST url=${addUrl} body=${sanitizeRtsp(JSON.stringify(pathConfig))} (after delete)`)
      try {
        const res2 = await mediamtxApi.post(addUrl, pathConfig)
        console.info(`[transcode] register_path response status=${res2.status} body=${JSON.stringify(res2.data)}`)
        registeredPaths.set(streamPath, fp)
        console.info(`[transcode] register_path_ok path=${streamPath} method=POST_after_DELETE`)
        return true
      } catch (post2Err: any) {
        const p2Status = post2Err.response?.status
        const p2Body   = JSON.stringify(post2Err.response?.data ?? post2Err.message)
        console.error(`[transcode] register_path_error path=${streamPath} method=POST_after_DELETE status=${p2Status} body=${p2Body}`)
        return false
      }
    }
  } catch (unexpectedErr: any) {
    console.error(`[transcode] register_path_error path=${streamPath} unexpected=${unexpectedErr.message}`)
    return false
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
      // Refcount: no borrar el path si aún tiene consumidores vigentes
      // (analytics/recording/diagnostic). Solo se fue el viewer de live.
      if (await hasActiveConsumers(streamPath)) {
        console.info(`[stream] mediamtx_path_kept path=${streamPath} reason=active_consumers`)
        continue
      }
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
