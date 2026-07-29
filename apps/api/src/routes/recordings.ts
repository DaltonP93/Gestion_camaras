// apps/api/src/routes/recordings.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { searchRecordings, getRecordingDailyDistribution } from '../services/hikvision'
import { AuditAction } from '../services/audit'
import { probeRtspStream } from '../services/rtsp-probe'
import { getRtspTimeoutOption } from '../services/stream'
import crypto from 'crypto'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'

import { decryptNvrPassword as decryptPass } from '../services/credentials'
import { MemorySessionStore, RedisSessionStore, type SessionStore } from '../services/session-store'
import { shouldAcceptFirstByte, errorStatusForCategory, isCancellation, resolveStreamTakeover } from './recordings-preview-state'
import {
  maskUrlCredentials, classifyRtspError,
  buildVariantChain as buildVariantChainPure,
  injectCredentialsIntoPlaybackUri, rewritePlaybackUriStart,
  buildFallbackRecordingRtspUrl, buildPlaybackAttemptPlan,
  extractRtspPlaybackTimes, urlFingerprint, hikTimestampToIso,
  classifyStageFailure, type StageEvidence, pickFinalPlaybackError,
  type PlaybackVariant, type PlaybackAttempt, type PlaybackBaseStrategy,
} from '../services/recordings/rtsp-url'
import { planStartupBudget } from '../services/recordings/preview-budget'
import {
  isProblematicPreviewAudio, shouldRestartVideoOnly, isAudioSyncOrMuxFailure,
} from '../services/recordings/preview-audio-policy'
import { stageProbe, stageDecode, stageEncodeMux, type RtspTransport } from '../services/recordings/staged-diagnostics'
import { parseFfmpegProgress, parseStreamInfoFromStderr } from '../services/recordings/ffmpeg-progress'
import { PreviewProcessRegistry, type AttemptRecord } from '../services/recordings/preview-process-registry'
import { getNvrSystemTime } from '../services/hikvision'

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

function determinePreviewStrategy(opts: {
  detectedCodec:  string
  canPlayHevcMp4: boolean
  forceTranscode: boolean
}): PreviewStrategy {
  const { detectedCodec, canPlayHevcMp4, forceTranscode } = opts
  if (forceTranscode) return 'preview_transcode_h264'
  // Unknown codec → always transcode to avoid DEMUXER_ERROR_NO_SUPPORTED_STREAMS
  if (!detectedCodec || detectedCodec === 'unknown') return 'preview_transcode_h264'
  if (!isHevcCodec(detectedCodec)) return 'preview_copy_h264'
  return canPlayHevcMp4 ? 'preview_copy_hevc' : 'preview_transcode_h264'
}

// Audio in preview: NVRs record G.711 (alaw/mulaw) which browsers can't play
// in MP4 — transcode to AAC. `0:a?` makes the audio map optional so recordings
// without an audio track keep working. RECORDINGS_PREVIEW_AUDIO=0 disables.
const PREVIEW_AUDIO_ENABLED = process.env.RECORDINGS_PREVIEW_AUDIO !== '0'
const PREVIEW_AUDIO_ARGS = PREVIEW_AUDIO_ENABLED
  ? ['-map', '0:v:0', '-map', '0:a?', '-c:a', 'aac', '-b:a', '64k', '-ac', '1']
  : ['-an']

// videoOnly=true fuerza `-an` (sin audio) reutilizando la MISMA URI. Se usa cuando
// el audio G.711 rompe el mux A/V (causa raíz confirmada) — la ruta video-only
// produce fMP4 en ~5,5s. NO afecta la descarga MP4 (VOD), que va por otro camino.
function buildPreviewCodecArgs(strategy: PreviewStrategy, videoOnly = false): string[] {
  const audioArgs = videoOnly ? ['-an'] : PREVIEW_AUDIO_ARGS
  if (strategy === 'preview_copy_h264' || strategy === 'preview_copy_hevc') {
    return [...audioArgs, '-c:v', 'copy']
  }
  // preview_transcode_h264 — baseline profile + fixed keyframe interval for reliable fMP4 seek
  return [
    ...audioArgs,
    '-c:v',             'libx264',
    '-preset',          'ultrafast',
    '-tune',            'zerolatency',
    '-crf',             '30',
    '-maxrate',         '1500k',
    '-bufsize',         '3000k',
    '-pix_fmt',         'yuv420p',
    '-profile:v',       'baseline',
    '-level',           '3.1',
    '-g',               '25',
    '-keyint_min',      '25',
    '-sc_threshold',    '0',
    '-reset_timestamps','1',
    '-avoid_negative_ts','make_zero',
    '-vf',              "scale='min(1280,iw)':-2:flags=fast_bilinear",
  ]
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
// Store con TTL: Redis cuando está disponible (los links de descarga
// sobreviven reinicios del API y funcionan con múltiples workers), memoria
// como fallback. Se promociona a Redis al registrar el plugin.
let downloadTokenStore: SessionStore<DownloadToken> = new MemorySessionStore<DownloadToken>()

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
  void downloadTokenStore.set(token, {
    token, filePath: opts.filePath, filename: opts.filename,
    expiresAt: issuedAt + DOWNLOAD_TOKEN_TTL_MS,
    sessionId: opts.sessionId,
    issuedAt,
  }, DOWNLOAD_TOKEN_TTL_MS)
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
  // downloadTokenStore expira solo (TTL de Redis / sweep interno en memoria)
}, 5 * 60 * 1000)

// ─── Preview sessions (instant streaming — fMP4 over HTTP) ───────
type PreviewStrategy = 'preview_copy_h264' | 'preview_copy_hevc' | 'preview_transcode_h264'

interface PreviewSession {
  streamToken: string     // short-lived token for unauthenticated /stream URL
  userId:      string
  createdAt:   number
  expiresAt:   number     // 30 min TTL
  rtspUrl:     string
  rtspMasked:  string
  cameraId:    string
  nvrId:       string
  slotIndex:   number
  startTime:   string
  endTime:     string
  forceTranscode:  boolean
  strategy:        PreviewStrategy
  detectedCodec:   string
  canPlayHevcMp4:  boolean
  // Proceso ACTIVO (el que alimenta al consumidor actual). El registro de TODOS
  // los hijos vive en `procRegistry` — vodProcess es sólo el "actual" para los
  // guards de identidad. Nunca es la única referencia (bug P1: FFmpeg huérfano).
  vodProcess?: ChildProcess
  // Registro de TODOS los FFmpeg de la sesión (req 11): alta al spawn, baja al
  // close. Permite terminar/recolectar cada hijo aunque un takeover lo supere.
  procRegistry?: PreviewProcessRegistry
  // Generación del stream: se incrementa en cada GET /stream. Identifica al dueño
  // actual; un GET más nuevo gana y el viejo cede sin tocar refs del nuevo (req 13).
  streamGeneration?: number
  // Cierre en curso: bloquea nuevos GET /stream y marca el teardown ordenado (12).
  closing?:        boolean
  // ¿Hay un consumidor (GET /stream) adjunto ahora? Para el reaper de sesiones sin
  // consumidor (req 15). lastStreamAt = último momento con consumidor.
  streamAttached?: boolean
  lastStreamAt?:   number
  // Cleanups del handler de stream activo (timers + listeners), para poder
  // eliminarlos desde el teardown de la sesión (DELETE / sweep) — req 12d.
  disposers?:      Set<() => void>
  stderrTail?:     string[]
  errorCategory?:  string
  errorDetail?:    string
  hadFirstByte?:   boolean
  // Plan ordenado de estrategias de URL base a intentar (A→E). Reemplaza el
  // toggle main/sub × name/size sobre una única base.
  attemptPlan?:    PlaybackAttempt[]
  channel?:        number
}

// Perfil de compatibilidad aprendido POR NVR (en memoria). Una estrategia que
// funciona queda preferida para ese NVR; un 400 en substream marca que no soporta
// playback sub — así no se re-gasta tiempo probándolo en cada reproducción.
interface NvrPlaybackProfile {
  preferredBaseStrategy?:   PlaybackBaseStrategy
  preferredTransport?:      'tcp' | 'udp'   // TASK 5 — transporte que funcionó en el diagnóstico
  supportsPlaybackSubstream?: boolean
  lastVerifiedAt?:          number
  // Timestamp DEDICADO del rechazo de substream — separado de lastVerifiedAt (que
  // lo pisaría cada preview main exitoso, impidiendo que el TTL venza nunca).
  substreamRejectedAt?:     number
}
const nvrPlaybackProfiles = new Map<string, NvrPlaybackProfile>()
// Cámaras cuyo audio (G.711 μ-law/A-law) rompe el mux A/V del preview: una vez
// detectado, los previews siguientes arrancan directo en video-only. En memoria
// (se pierde al reiniciar el API — se vuelve a aprender en el 1er bloque).
const cameraAudioProblematic = new Set<string>()
// TTL del marcaje "sin soporte de substream": tras este tiempo se vuelve a probar
// (evita bloquear sub permanentemente por un 400 puntual). En memoria: se pierde
// al reiniciar el API.
const NVR_SUBSTREAM_UNSUPPORTED_TTL_MS = Number(process.env.RECORDINGS_NVR_SUBSTREAM_TTL_MS || 6 * 60 * 60 * 1000)
function nvrSubstreamAllowed(p: NvrPlaybackProfile): boolean {
  if (p.supportsPlaybackSubstream !== false) return true
  // marcado sin soporte: permitir reintento si venció el TTL, medido desde el
  // MOMENTO DEL RECHAZO (substreamRejectedAt), no desde lastVerifiedAt.
  return !!p.substreamRejectedAt && (Date.now() - p.substreamRejectedAt) > NVR_SUBSTREAM_UNSUPPORTED_TTL_MS
}

// Caché en memoria del reloj del NVR (/ISAPI/System/time) — para auditar el
// desfase horario SIN pegarle al NVR en cada preview. TTL corto: el reloj cambia
// poco pero queremos detectar drift/NTP. Se refresca en background (no bloquea).
interface NvrClockCacheEntry { localTime: string; timeZone: string; timeMode: string; utcTime: string | null; fetchedAt: number }
const nvrClockCache = new Map<string, NvrClockCacheEntry>()
const NVR_CLOCK_CACHE_TTL_MS = Number(process.env.RECORDINGS_NVR_CLOCK_TTL_MS || 5 * 60 * 1000)
const nvrClockInFlight = new Set<string>()

// Deriva la hora UTC del NVR a partir de su localTime cuando éste trae offset
// (p.ej. '2026-07-21T07:06:00-04:00'). Si no trae offset, no se puede afirmar el
// UTC — se devuelve null (NO asumir el desfase). Nunca concatena 'Z' a mano.
function deriveNvrUtc(localTime: string): string | null {
  if (!localTime) return null
  // Sólo si el string ya declara zona (offset ±HH:MM o Z): Date lo interpreta bien.
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(localTime.trim())) return null
  const ms = Date.parse(localTime.trim())
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** Reloj del NVR desde caché; refresca en background si venció el TTL. Best-effort:
 *  nunca lanza ni bloquea el preview (una llamada ISAPI colgada no debe demorar el
 *  arranque del video). Devuelve null si aún no hay dato cacheado. */
function getNvrClockCached(nvr: { id: string } & Record<string, any>, log: (m: string) => void): NvrClockCacheEntry | null {
  const cached = nvrClockCache.get(nvr.id)
  const fresh = cached && (Date.now() - cached.fetchedAt) < NVR_CLOCK_CACHE_TTL_MS
  if (!fresh && !nvrClockInFlight.has(nvr.id)) {
    nvrClockInFlight.add(nvr.id)
    getNvrSystemTime(nvr as any)
      .then(t => {
        if (t) {
          const entry: NvrClockCacheEntry = {
            localTime: t.localTime, timeZone: t.timeZone, timeMode: t.timeMode,
            utcTime: deriveNvrUtc(t.localTime), fetchedAt: Date.now(),
          }
          nvrClockCache.set(nvr.id, entry)
          log(
            `[recordings-time] nvr_clock nvrId=${nvr.id} timeMode=${entry.timeMode}` +
            ` nvrLocalTime=${entry.localTime} nvrTimezone=${entry.timeZone}` +
            ` nvrUtcTime=${entry.utcTime ?? 'unknown(no offset in localTime)'}`
          )
        }
      })
      .catch(() => {})
      .finally(() => { nvrClockInFlight.delete(nvr.id) })
  }
  return cached ?? null
}

// El diagnóstico por etapas vive en services/recordings/staged-diagnostics.ts
// (stageProbe / stageDecode / stageEncodeMux). Reemplazó al antiguo diagnoseStrategy
// (que sólo miraba el primer byte del MP4 y no distinguía la etapa de detención).

// Failed previews are retained here after the session is deleted so the
// frontend can still fetch the error category (the slot cleanup often
// DELETEs the session before the status query lands).
interface FailedPreviewInfo {
  userId:       string
  slotIndex:    number
  category:     string
  detail:       string
  stderrTail:   string
  hadFirstByte: boolean
  expiresAt:    number
}
const failedPreviewSessions = new Map<string, FailedPreviewInfo>()
const FAILED_PREVIEW_TTL_MS = 60_000

function retainFailedPreview(sessionId: string, session: PreviewSession, log: (msg: string) => void) {
  if (!session.errorCategory) return
  failedPreviewSessions.set(sessionId, {
    userId:       session.userId,
    slotIndex:    session.slotIndex,
    category:     session.errorCategory,
    detail:       session.errorDetail ?? '',
    stderrTail:   (session.stderrTail ?? []).slice(-10).join(' | ').slice(0, 600),
    hadFirstByte: session.hadFirstByte ?? false,
    expiresAt:    Date.now() + FAILED_PREVIEW_TTL_MS,
  })
  log(`[recordings-preview] failed_session_retained sessionId=${sessionId} ttlMs=${FAILED_PREVIEW_TTL_MS} category=${session.errorCategory}`)
}

// maskUrlCredentials y classifyRtspError viven en services/recordings/rtsp-url.ts

const previewSessions = new Map<string, PreviewSession>()

// ── Ciclo de vida de los FFmpeg de preview (P1: un solo FFmpeg por sesión) ──────
// El registro por sesión es la fuente de verdad de TODOS los hijos; vodProcess es
// sólo el "actual". Estas funciones centralizan la terminación y el teardown para
// que ninguna ruta (DELETE, cierre de socket, request_error, sweep) deje huérfanos.

// Hooks de log para la secuencia idempotente SIGTERM→gracia→SIGKILL del registro.
function terminateHooks(log: (m: string) => void) {
  return {
    onSigterm: (rec: AttemptRecord) =>
      log(`[recordings-preview] attempt_terminate attemptId=${rec.attemptId} pid=${rec.pid ?? 'none'} reason=${rec.terminationReason ?? 'none'}`),
    onSigkill: (rec: AttemptRecord) =>
      log(`[recordings-preview] sigkill_orphan attemptId=${rec.attemptId} pid=${rec.pid ?? 'none'} — ignoró SIGTERM`),
  }
}

// Termina TODOS los hijos vivos de la sesión (req 11/14). La secuencia y el timer de
// SIGKILL los posee el registro (idempotente por attempt). Devuelve cuántos siguen
// SIN confirmar salida real (exit/close) — pendientes de reaping.
function terminateAllPreviewChildren(session: PreviewSession, reason: string, log: (m: string) => void): number {
  const reg = session.procRegistry
  if (!reg) return 0
  void reg.terminateAll(reason, terminateHooks(log))
  session.vodProcess = undefined
  return reg.aliveCount()
}

// Teardown ORDENADO de una sesión (req 12): closing → bloquear GET → disposers →
// terminar attempts → confirmar sin vivos (o cleanup_pending).
function terminatePreviewSession(sessionId: string, session: PreviewSession, reason: string, log: (m: string) => void) {
  const already = session.closing
  session.closing = true                       // (12a) marcar closing (bloquea GET)
  previewSessions.delete(sessionId)            // (12b) impedir nuevos GET (lookup falla)
  if (session.disposers) {                     // (12d) eliminar timers y listeners
    for (const d of [...session.disposers]) { try { d() } catch { /* noop */ } }
    session.disposers.clear()
  }
  const pending = terminateAllPreviewChildren(session, reason, log)  // (12c)
  if (pending > 0) {                           // (12e) confirmar, o marcar pendiente
    log(`[recordings-preview] cleanup_pending sessionId=${sessionId} reason=${reason} pendingChildren=${pending}`)
  } else if (!already) {
    log(`[recordings-preview] session_deleted sessionId=${sessionId} slotIndex=${session.slotIndex} reason=${reason}`)
  }
}

// Métricas para /metrics (Prometheus) — solo conteos, sin datos sensibles.
export function getRecordingsMetrics(): { previewSessions: number; vodSessions: number } {
  return { previewSessions: previewSessions.size, vodSessions: recordingSessions.size }
}

// ─── Per-NVR preview concurrency ──────────────────────────────────
// Hikvision NVRs cap simultaneous playback sessions/bandwidth and answer
// "453 Not Enough Bandwidth" when exceeded. Serialize preview starts per NVR
// and stagger them so 2x2 grids don't burst-open sessions.
// ffprobe before preview costs one extra RTSP DESCRIBE per start — disabled
// by default to minimize 453 Not Enough Bandwidth on session-limited NVRs.
const PREVIEW_PROBE_ENABLED = process.env.RECORDINGS_PREVIEW_PROBE === 'true'

const MAX_PREVIEW_PER_NVR = Math.max(1, parseInt(process.env.RECORDINGS_MAX_PREVIEW_PER_NVR || '1', 10) || 1)
const PREVIEW_START_STAGGER_MS = Math.max(0, parseInt(process.env.RECORDINGS_PREVIEW_START_STAGGER_MS || '1200', 10) || 1200)
const PREVIEW_QUEUE_WAIT_MAX_MS = 30_000
// Watchdog de PRIMER BYTE por variante RTSP. Si FFmpeg no produce stdout dentro
// de este plazo (el NVR aceptó el socket pero no envía video ni cierra), se lo
// mata y se avanza a la siguiente variante. Sin esto, un FFmpeg colgado bloquea
// toda la cadena de fallback y la request queda pendiente para siempre.
// 25s por defecto: la evidencia de producción muestra que ciertos NVR Hikvision
// tardan 13,2–14,4 s en entregar el primer byte (apertura RTSP + primer keyframe +
// demux + transcode H.264 + header fMP4). 13s cortaba streams válidos justo antes
// de arrancar. FFmpeg mismo espera ~60s a nivel RTSP; Node no debe cortar antes.
const PREVIEW_FIRST_BYTE_TIMEOUT_MS = Math.max(3_000, parseInt(process.env.RECORDINGS_PREVIEW_FIRST_BYTE_TIMEOUT_MS || '25000', 10) || 25_000)
// Gracia tras SIGTERM antes de SIGKILL a un FFmpeg que ignora la señal.
const PREVIEW_KILL_GRACE_MS = Math.max(500, parseInt(process.env.RECORDINGS_PREVIEW_KILL_GRACE_MS || '2000', 10) || 2000)
// Edad a partir de la cual el sweep mata un FFmpeg huérfano (vivo pero superado
// por un takeover, ya no es el proceso activo de la sesión). Red de seguridad
// independiente del JWT y del ciclo de la request (req 15).
const PREVIEW_ORPHAN_REAP_MS = Math.max(5_000, parseInt(process.env.RECORDINGS_PREVIEW_ORPHAN_REAP_MS || '30000', 10) || 30_000)
// Presupuesto TOTAL de arranque (todas las variantes juntas). Si se supera, se
// deja de intentar y se responde error — cota superior dura al peor caso.
const PREVIEW_TOTAL_STARTUP_MS = Math.max(10_000, parseInt(process.env.RECORDINGS_PREVIEW_TOTAL_STARTUP_MS || '60000', 10) || 60_000)
// Tope duro del presupuesto total (el presupuesto efectivo escala con el nº de
// intentos: cada uno merece FIRST_BYTE_TIMEOUT completo, pero acotado a esto).
const PREVIEW_STARTUP_HARD_CAP_MS = Math.max(30_000, parseInt(process.env.RECORDINGS_PREVIEW_STARTUP_HARD_CAP_MS || '120000', 10) || 120_000)
// Retardo entre el fallo de una variante y el arranque de la siguiente. El
// presupuesto total DEBE contarlo: si no, el overhead acumulado comprime los
// últimos intentos por debajo del watchdog completo (bug de producción).
const PREVIEW_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.RECORDINGS_PREVIEW_RETRY_DELAY_MS || '800', 10) || 800)
// Margen de seguridad del presupuesto total para overhead no modelado (spawn de
// FFmpeg, demux, GC) — evita cortar el último intento por unos ms de más.
const PREVIEW_BUDGET_SAFETY_MARGIN_MS = Math.max(0, parseInt(process.env.RECORDINGS_PREVIEW_BUDGET_SAFETY_MARGIN_MS || '3000', 10) || 3000)

// Config del presupuesto reunida en un solo lugar (para el log de arranque y el
// per-sesión). RAW = valor crudo del env (o null), para detectar overrides viejos.
const PREVIEW_TOTAL_STARTUP_RAW = process.env.RECORDINGS_PREVIEW_TOTAL_STARTUP_MS ?? null
function previewBudgetConfig() {
  return {
    firstByteTimeoutMs: PREVIEW_FIRST_BYTE_TIMEOUT_MS,
    killGraceMs:        PREVIEW_KILL_GRACE_MS,
    retryDelayMs:       PREVIEW_RETRY_DELAY_MS,
    safetyMarginMs:     PREVIEW_BUDGET_SAFETY_MARGIN_MS,
    hardCapMs:          PREVIEW_STARTUP_HARD_CAP_MS,
    minTotalMs:         PREVIEW_TOTAL_STARTUP_MS,
  }
}

// TASK 1 — Log de arranque de la config efectiva del preview. Verifica QUÉ código
// y QUÉ presupuesto corren realmente (evidencia de producción mostraba
// total_budget_ms=75000 con el último intento comprimido: un override viejo por
// debajo del presupuesto calculado). Se calcula para un plan típico de 4 intentos.
export function logPreviewStartupConfig(log: (msg: string) => void, gitCommit: string) {
  const cfg = previewBudgetConfig()
  const TYPICAL_ATTEMPTS = 4
  const calc = planStartupBudget(TYPICAL_ATTEMPTS, cfg)
  const override = PREVIEW_TOTAL_STARTUP_RAW
  log(
    `[recordings-config] preview_startup_config gitCommit=${gitCommit}` +
    ` firstByteTimeoutMs=${cfg.firstByteTimeoutMs} killGraceMs=${cfg.killGraceMs}` +
    ` retryDelayMs=${cfg.retryDelayMs} safetyMarginMs=${cfg.safetyMarginMs}` +
    ` maxStartupBudgetMs=${cfg.hardCapMs} minStartupBudgetMs=${cfg.minTotalMs}` +
    ` configuredStartupBudgetOverride=${override ?? 'none'}` +
    ` calculatedStartupBudgetMs(${TYPICAL_ATTEMPTS}attempts)=${calc.effectiveTotalBudgetMs}` +
    ` perAttemptCostMs=${calc.perAttemptCostMs}`
  )
  // Override viejo por debajo del presupuesto calculado → los últimos intentos se
  // comprimirían. Advertir explícitamente (esto explica el 19.322s de producción).
  if (override != null) {
    const overrideMs = parseInt(override, 10)
    if (!Number.isNaN(overrideMs) && overrideMs < calc.effectiveTotalBudgetMs) {
      log(
        `[recordings-config] WARN stale_startup_budget_override override=${overrideMs}` +
        ` calculated=${calc.effectiveTotalBudgetMs} — el override recorta el presupuesto` +
        ` por debajo del necesario para dar ${cfg.firstByteTimeoutMs}ms a cada intento.` +
        ` Subilo o quitá RECORDINGS_PREVIEW_TOTAL_STARTUP_MS (ahora es sólo el PISO).`
      )
    }
  }
}

interface NvrPreviewState { active: number; lastStartAt: number; queue: Array<() => void> }
const nvrPreviewStates = new Map<string, NvrPreviewState>()

function getNvrPreviewState(nvrId: string): NvrPreviewState {
  let st = nvrPreviewStates.get(nvrId)
  if (!st) { st = { active: 0, lastStartAt: 0, queue: [] }; nvrPreviewStates.set(nvrId, st) }
  return st
}

/** Wait for a free preview slot on this NVR (bounded), enforce stagger, and
 *  return a release function — or null when the wait cap expires with the
 *  slot still busy. Returning null (instead of opening an extra FFmpeg)
 *  guarantees MAX_PREVIEW_PER_NVR is a hard limit. */
async function acquireNvrPreviewSlot(
  nvrId: string, slotIndex: number, log: (msg: string) => void
): Promise<(() => void) | null> {
  const st = getNvrPreviewState(nvrId)
  const waitStart = Date.now()

  while (st.active >= MAX_PREVIEW_PER_NVR) {
    if (Date.now() - waitStart >= PREVIEW_QUEUE_WAIT_MAX_MS) {
      log(`[recordings-preview] nvr_preview_queue_timeout nvrId=${nvrId} slot=${slotIndex} active=${st.active} waitedMs=${Date.now() - waitStart}`)
      return null
    }
    log(`[recordings-preview] nvr_preview_queue nvrId=${nvrId} slot=${slotIndex} queued=${st.queue.length + 1} active=${st.active}`)
    await new Promise<void>(resolve => {
      st.queue.push(resolve)
      // Safety: also wake up periodically in case a release was missed
      setTimeout(resolve, 2_000)
    })
  }

  // Stagger consecutive starts against the same NVR
  const sinceLast = Date.now() - st.lastStartAt
  if (sinceLast < PREVIEW_START_STAGGER_MS) {
    await new Promise(r => setTimeout(r, PREVIEW_START_STAGGER_MS - sinceLast))
  }

  st.active++
  st.lastStartAt = Date.now()
  log(`[recordings-preview] nvr_preview_acquired nvrId=${nvrId} slot=${slotIndex} active=${st.active}`)

  let released = false
  return () => {
    if (released) return
    released = true
    st.active = Math.max(0, st.active - 1)
    log(`[recordings-preview] nvr_preview_released nvrId=${nvrId} active=${st.active}`)
    const next = st.queue.shift()
    if (next) next()
  }
}

// ─── Playback RTSP variants (main/sub × with/without name-size) ──────
// Hikvision playback tracks: channel N main = N*100+1 (401, 501…),
// substream = N*100+2 (402, 502…). Substream playback uses far less NVR
// bandwidth, so it's worth trying before declaring 453.
// (PlaybackVariant se importa desde services/recordings/rtsp-url.ts)

const PLAYBACK_STREAM_MODE = (['main', 'sub', 'auto'].includes(process.env.RECORDINGS_PLAYBACK_STREAM || '')
  ? process.env.RECORDINGS_PLAYBACK_STREAM
  : 'auto') as 'main' | 'sub' | 'auto'

// Camera → variant that reached first_byte last time; next previews start
// directly with it (no failed RTSP attempts spent re-discovering).
const previewVariantPreferenceByCamera = new Map<string, PlaybackVariant>()

// Wrapper: la versión pura vive en services/recordings/rtsp-url.ts; aquí solo
// se resuelven el modo (env) y la preferencia por cámara (estado del módulo)
function buildVariantChain(baseUrl: string, cameraId: string): Array<{ variant: PlaybackVariant; url: string }> {
  return buildVariantChainPure(baseUrl, {
    mode: PLAYBACK_STREAM_MODE,
    preferred: previewVariantPreferenceByCamera.get(cameraId),
  })
}

// Per-camera override: when forceTranscode=true succeeds, persist transcode requirement
// so subsequent previews of the same camera skip the probe and go straight to transcode.
const cameraPreviewStrategyOverride = new Map<string, PreviewStrategy>()

// Periodic cleanup of stale preview sessions + expired failure records.
// (15) Además del TTL, es la RED DE SEGURIDAD independiente del JWT: reapea FFmpeg
// huérfanos (vivos pero superados por un takeover) y sesiones sin consumidor.
setInterval(() => {
  const now = Date.now()
  for (const [sid, session] of previewSessions.entries()) {
    if (now > session.expiresAt) {
      // Teardown ordenado: termina TODOS los hijos (no sólo vodProcess).
      terminatePreviewSession(sid, session, 'ttl_expired', (m) => console.info(m))
      continue
    }
    const reg = session.procRegistry
    if (!reg) continue
    // Reaper de huérfanos: un FFmpeg vivo que ya no es el proceso activo y lleva
    // demasiado tiempo → terminación idempotente (esto es EXACTAMENTE el bug de
    // producción: el primer FFmpeg de una sessionId con dos GET, que quedó sin dueño).
    reg.reapOrphans(session.vodProcess, now, PREVIEW_ORPHAN_REAP_MS, 'orphan_sweep', {
      onSigterm: (rec) =>
        console.warn(`[recordings-preview] orphan_ffmpeg_reaped sessionId=${sid} attemptId=${rec.attemptId} pid=${rec.pid ?? 'none'} ageMs=${now - rec.spawnedAt}`),
      onSigkill: (rec) =>
        console.warn(`[recordings-preview] orphan_ffmpeg_sigkill sessionId=${sid} attemptId=${rec.attemptId} pid=${rec.pid ?? 'none'}`),
    })
    // Sesión con hijos vivos pero SIN consumidor adjunto por un tiempo → terminar
    // (nadie está leyendo ese MP4; el FFmpeg sólo consume RTSP del NVR).
    if (!session.streamAttached && reg.aliveCount() > 0 &&
        session.lastStreamAt !== undefined && now - session.lastStreamAt > PREVIEW_ORPHAN_REAP_MS) {
      console.warn(`[recordings-preview] session_no_consumer_reaped sessionId=${sid} slotIndex=${session.slotIndex} idleMs=${now - session.lastStreamAt}`)
      terminatePreviewSession(sid, session, 'no_consumer', (m) => console.info(m))
    }
  }
  for (const [sid, info] of failedPreviewSessions.entries()) {
    if (now > info.expiresAt) failedPreviewSessions.delete(sid)
  }
  // Prune expired cache entries and cap per-camera preference maps so the
  // process doesn't accumulate memory across months of navigation
  for (const [key, entry] of calendarCache.entries()) {
    if (now > entry.expiresAt) calendarCache.delete(key)
  }
  for (const [key, entry] of nvrCapabilityCache.entries()) {
    if (now > entry.expiresAt) nvrCapabilityCache.delete(key)
  }
  const MAX_PREF_ENTRIES = 1000
  for (const map of [previewVariantPreferenceByCamera, cameraPreviewStrategyOverride] as Map<string, unknown>[]) {
    while (map.size > MAX_PREF_ENTRIES) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
}, 60 * 1000)

// ─── RTSP URL helpers → services/recordings/rtsp-url.ts ──────────

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

// ─── Recording-days calendar cache ────────────────────────────────
// key: cameraId|year|month → days with recordings. Short TTL — the current
// month gains new days as the NVR records.
const calendarCache = new Map<string, { days: number[]; supported: boolean; expiresAt: number }>()
const CALENDAR_TTL_MS = 5 * 60 * 1000

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

const previewStartSchema = z.object({
  cameraId:       z.string().min(1),
  slotIndex:      z.number().int().min(0),
  startTime:      z.string().datetime(),
  endTime:        z.string().datetime(),
  playbackURI:    z.string().startsWith('/').optional(),
  forceTranscode: z.boolean().optional(),
  canPlayHevcMp4: z.boolean().optional(),
  // Instrumentación de zona horaria (opcional, retrocompatible): lo que el
  // navegador tenía en pantalla y su offset UTC, para auditar el desfase de punta
  // a punta SIN asumir todavía cuál es el correcto. No afecta la conversión.
  browserLocal:          z.string().optional(),   // ej. "2026-07-21T07:06:00" (datetime-local)
  browserTimezoneOffset: z.number().int().optional(),  // minutos, como Date.getTimezoneOffset()
})

export const recordingRoutes: FastifyPluginAsync = async (server) => {
  // Promocionar los download tokens a Redis: los links de "Descargar MP4"
  // sobreviven reinicios del API (los archivos viven en el volumen de cache)
  if ((server as any).redis) {
    downloadTokenStore = new RedisSessionStore((server as any).redis, 'vc:dltoken:')
    server.log.info('[recordings] download_token_store backend=redis')
  } else {
    server.log.info('[recordings] download_token_store backend=memory')
  }

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

  // GET /api/recordings/calendar — Days of a month with recordings (iVMS-style
  // calendar marks). Uses ISAPI dailyDistribution; short-cached per camera+month.
  server.get('/calendar', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const q = z.object({
      cameraId: z.string().min(1),
      year:     z.coerce.number().int().min(2000).max(2100),
      month:    z.coerce.number().int().min(1).max(12),
    }).parse(request.query)

    const camera = await server.prisma.camera.findUnique({
      where: { id: q.cameraId }, include: { nvr: true },
    })
    if (!camera) return reply.status(404).send({ message: 'Cámara no encontrada' })

    if (user.role === 'AUDITOR') {
      const perm = await server.prisma.userPermission.findFirst({
        where: { userId: user.sub, cameraId: q.cameraId, canPlayback: true },
      })
      if (!perm) return reply.status(403).send({ message: 'Sin permiso para grabaciones de esta cámara' })
    }

    const cacheKey = `${q.cameraId}|${q.year}|${q.month}`
    const cached   = calendarCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      return reply.send({ days: cached.days, supported: cached.supported, cached: true })
    }

    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    try {
      const days = await getRecordingDailyDistribution(nvr as any, camera.channel, q.year, q.month)
      calendarCache.set(cacheKey, { days, supported: true, expiresAt: Date.now() + CALENDAR_TTL_MS })
      server.log.info(`[recordings] calendar cameraId=${q.cameraId} ch=${camera.channel} ${q.year}-${q.month} days=${days.length}`)
      return reply.send({ days, supported: true })
    } catch (err: any) {
      if (err?.unsupported) {
        calendarCache.set(cacheKey, { days: [], supported: false, expiresAt: Date.now() + CALENDAR_TTL_MS })
        return reply.send({ days: [], supported: false })
      }
      if (err?.authError) return reply.status(502).send({ code: 'NVR_AUTH_ERROR', message: 'Error de autenticación con el NVR' })
      server.log.warn(`[recordings] calendar_error cameraId=${q.cameraId} err=${err?.message}`)
      return reply.status(502).send({ code: 'NVR_ERROR', message: 'No se pudo consultar el NVR' })
    }
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

    const dt = await downloadTokenStore.get(t)
    if (!dt) {
      server.log.warn(`[recordings] download_token_invalid reason=not_found token=${t.slice(0, 8)}…`)
      return reply.status(403).type('text/plain').send('Acceso denegado')
    }
    if (Date.now() > dt.expiresAt) {
      void downloadTokenStore.delete(t)
      server.log.warn(`[recordings] download_token_invalid reason=expired filename=${dt.filename}`)
      return reply.status(403).type('text/plain').send('Token expirado')
    }

    // Path-traversal guard: the resolved path must live inside one of the
    // directories this module writes MP4s to (cache dir or temp dir)
    const resolvedPath = path.resolve(dt.filePath)
    const allowedDirs = [VOD_TEMP_DIR, CACHE_DIR].filter(Boolean).map(d => path.resolve(d) + path.sep)
    if (!allowedDirs.some(dir => resolvedPath.startsWith(dir))) {
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

  // ── Preview streaming endpoints ────────────────────────────────────────────

  // POST /api/recordings/preview/start — Create session, return streamUrl immediately.
  // No FFmpeg spawned here — FFmpeg only starts when browser GETs /stream.
  server.post('/preview/start', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    if (user.role === 'OPERATOR') return reply.status(403).send({ message: 'Sin acceso a grabaciones' })

    const body = previewStartSchema.parse(request.body)

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
    if (!plainPass) return reply.status(422).send({ message: 'No se pueden descifrar las credenciales del NVR' })

    let rtspUrl:    string
    let rtspMasked: string
    let urlStrategy: string

    if (body.playbackURI) {
      // Rewrite starttime so preview begins at the requested playhead, not at
      // the start of the recorded block the NVR embedded in playbackURI.
      const rewrite = rewritePlaybackUriStart(body.playbackURI, new Date(body.startTime))
      if (rewrite.rewritten) {
        server.log.info(
          `[recordings-time] playback_uri_rewritten cameraId=${body.cameraId}` +
          ` originalStart=${rewrite.originalStart} effectiveStart=${body.startTime}` +
          ` finalUri=${rewrite.uri.slice(0, 140)}`
        )
      }
      const injected = injectCredentialsIntoPlaybackUri({
        playbackURI: rewrite.uri, username: camera.nvr.username,
        password: plainPass, ipAddress: camera.nvr.ipAddress, rtspPort: camera.nvr.rtspPort,
      })
      rtspUrl     = injected.url
      rtspMasked  = injected.masked
      urlStrategy = rewrite.rewritten ? 'nvr_playbackURI_rewritten' : 'nvr_playbackURI'
    } else {
      const built = buildFallbackRecordingRtspUrl({
        username: camera.nvr.username, password: plainPass,
        ipAddress: camera.nvr.ipAddress, rtspPort: camera.nvr.rtspPort,
        channel: camera.channel, start: new Date(body.startTime), end: new Date(body.endTime),
      })
      rtspUrl     = built.url
      rtspMasked  = built.masked
      urlStrategy = 'fallback_timestamps'
    }

    const forceTranscode   = body.forceTranscode ?? false
    const canPlayHevcMp4   = body.canPlayHevcMp4 ?? false
    let detectedCodec      = 'unknown'
    let probeElapsedMs     = 0
    let probeErrorCategory: string | undefined
    let probeErrorDetail:   string | undefined

    // Check per-camera override first (set when a previous forceTranscode retry succeeded)
    const overrideStrategy = cameraPreviewStrategyOverride.get(body.cameraId)

    if (forceTranscode) {
      // Save override so future requests for this camera skip the probe
      cameraPreviewStrategyOverride.set(body.cameraId, 'preview_transcode_h264')
      server.log.info(`[recordings-preview] strategy_override_saved cameraId=${body.cameraId} strategy=preview_transcode_h264`)
    } else if (overrideStrategy) {
      server.log.info(`[recordings-preview] strategy_override_hit cameraId=${body.cameraId} strategy=${overrideStrategy}`)
    } else if (!PREVIEW_PROBE_ENABLED) {
      // No probe by default: every ffprobe costs an extra RTSP DESCRIBE
      // against the NVR, raising the chance of 453 on session-limited
      // Hikvision units. Without codec knowledge we always transcode —
      // safe for any browser, no DESCRIBE spent.
      server.log.info(`[recordings-preview] probe_skipped reason=disabled strategy=preview_transcode_h264 cameraId=${body.cameraId}`)
    } else {
      // RECORDINGS_PREVIEW_PROBE=true — probe to allow copy strategies
      const probeStart = Date.now()
      try {
        const probeResult = await Promise.race([
          probeRtspStream(rtspUrl),
          new Promise<{ ok: false; error: string; latencyMs: number }>(resolve =>
            setTimeout(() => resolve({ ok: false, error: 'probe_timeout_5s', latencyMs: 5000 }), 5000)
          ),
        ])
        probeElapsedMs = Date.now() - probeStart
        server.log.info(
          `[recordings-preview] probe_result sessionId=pending ok=${probeResult.ok}` +
          ` codec=${probeResult.ok ? probeResult.codec : 'n/a'}` +
          ` error=${!probeResult.ok ? probeResult.error : 'none'}` +
          ` elapsedMs=${probeElapsedMs}`
        )
        if (probeResult.ok && probeResult.codec) {
          detectedCodec = probeResult.codec
        } else if (!probeResult.ok && probeResult.error) {
          probeErrorCategory = classifyRtspError(probeResult.error)
          probeErrorDetail   = maskUrlCredentials(probeResult.error).slice(0, 300)
        }
      } catch {
        probeElapsedMs = Date.now() - probeStart
        server.log.warn(`[recordings-preview] probe_failed elapsedMs=${probeElapsedMs}`)
      }
    }

    const strategy = overrideStrategy && !forceTranscode
      ? overrideStrategy
      : !PREVIEW_PROBE_ENABLED && !forceTranscode
        ? 'preview_transcode_h264'
        : determinePreviewStrategy({ detectedCodec, canPlayHevcMp4, forceTranscode })

    server.log.info(
      `[recordings-time] preview_time_mapping cameraId=${body.cameraId} ch=${camera.channel}` +
      ` startTime=${body.startTime} endTime=${body.endTime}` +
      ` startTime_utc=${new Date(body.startTime).toUTCString()}` +
      ` urlStrategy=${urlStrategy} rtsp_masked=${rtspMasked.substring(0, 100)}`
    )
    server.log.info(
      `[recordings-preview] preview_strategy codec=${detectedCodec}` +
      ` canPlayHevcMp4=${canPlayHevcMp4} forceTranscode=${forceTranscode}` +
      ` overrideHit=${!!overrideStrategy} strategy=${strategy}`
    )
    server.log.info(`[recordings-preview] encoder_selected strategy=${strategy} forceTranscode=${forceTranscode}`)

    const sessionId   = crypto.randomBytes(8).toString('hex')
    const streamToken = crypto.randomBytes(24).toString('hex')
    const expiresAt   = Date.now() + RECORDING_SESSION_TTL_MS

    server.log.info(
      `[recordings-preview] session_init sessionId=${sessionId} slotIndex=${body.slotIndex}` +
      ` cameraId=${body.cameraId} ch=${camera.channel}` +
      ` urlStrategy=${urlStrategy} startTime=${body.startTime} endTime=${body.endTime}` +
      ` strategy=${strategy} source=${rtspMasked}`
    )

    // Plan de estrategias de URL base, respetando el perfil aprendido del NVR
    // (estrategia preferida primero si respeta el playhead; sub omitido si el NVR
    // lo rechazó y el marcaje aún está dentro del TTL). PLAYBACK_STREAM_MODE decide
    // main/sub/auto.
    const nvrProfile = nvrPlaybackProfiles.get(camera.nvr.id) ?? {}
    const dedupSink: Array<{ strategy: PlaybackBaseStrategy; duplicateOf: PlaybackBaseStrategy; urlFingerprint: string }> = []
    const attemptPlan = buildPlaybackAttemptPlan({
      playbackURI: body.playbackURI ?? null,
      channel: camera.channel,
      effectiveStart: new Date(body.startTime),
      end: new Date(body.endTime),
      creds: { username: camera.nvr.username, password: plainPass, ipAddress: camera.nvr.ipAddress, rtspPort: camera.nvr.rtspPort },
      mode: PLAYBACK_STREAM_MODE,
      includeSubstream: nvrSubstreamAllowed(nvrProfile),
      preferred: nvrProfile.preferredBaseStrategy ?? null,
      dedupSink,
    })
    server.log.info(
      `[recordings-preview] attempt_plan sessionId=${sessionId} nvrId=${camera.nvr.id} mode=${PLAYBACK_STREAM_MODE}` +
      ` strategies=[${attemptPlan.map(a => `${a.strategy}(t${a.track}${a.respectsPlayhead ? '' : ',!playhead'})`).join(',')}]` +
      ` preferred=${nvrProfile.preferredBaseStrategy ?? 'none'} subSupported=${nvrProfile.supportsPlaybackSubstream ?? 'unknown'}`
    )
    // P2: estrategias omitidas por dedup (misma URL final que otra anterior) — antes
    // desaparecían sin dejar rastro (p.ej. generated_main colapsando en nvr_rewritten).
    for (const d of dedupSink) {
      server.log.info(
        `[recordings-preview] strategy_dedup sessionId=${sessionId} strategy=${d.strategy}` +
        ` duplicateOf=${d.duplicateOf} urlFingerprint=${d.urlFingerprint}`
      )
    }

    // ── Auditoría de zona horaria de PUNTA A PUNTA (P1) ─────────────────────
    // Se registra TODA la cadena para diagnosticar el desfase SIN asumir aún cuál
    // es el correcto. No se cambia ninguna conversión ni se concatena 'Z' a mano:
    // sólo se observa qué se manda y con qué offset. rtspStart/rtspEnd es lo que
    // realmente viaja en la URL RTSP (la fuente de verdad de lo que ve el NVR).
    const rtspTimes = extractRtspPlaybackTimes(rtspMasked)
    const reqStartDate = new Date(body.startTime)
    const reqEndDate   = new Date(body.endTime)
    // recordingStart/End = ventana que el NVR incrustó en la playbackURI (si vino).
    const recTimes = body.playbackURI ? extractRtspPlaybackTimes(body.playbackURI) : { starttime: null, endtime: null }
    const nvrClock = getNvrClockCached({ ...camera.nvr, password: plainPass }, (m) => server.log.info(m))
    server.log.info(
      `[recordings-time] timezone_audit sessionId=${sessionId} nvrId=${camera.nvr.id} cameraId=${body.cameraId}` +
      ` browserLocal=${body.browserLocal ?? 'n/a'}` +
      ` browserTimezoneOffsetMin=${body.browserTimezoneOffset ?? 'n/a'}` +
      ` requestStartUtc=${reqStartDate.toISOString()} requestEndUtc=${reqEndDate.toISOString()}` +
      ` recordingBlockStart=${recTimes.starttime ?? 'n/a'} recordingBlockEnd=${recTimes.endtime ?? 'n/a'}` +
      ` effectiveStartUtc=${reqStartDate.toISOString()} effectiveEndUtc=${reqEndDate.toISOString()}` +
      ` rtspStart=${rtspTimes.starttime ?? 'n/a'} rtspEnd=${rtspTimes.endtime ?? 'n/a'}` +
      ` nvrLocalTime=${nvrClock?.localTime ?? 'pending'} nvrTimezone=${nvrClock?.timeZone ?? 'pending'}` +
      ` nvrUtcTime=${nvrClock?.utcTime ?? 'pending'} nvrTimeMode=${nvrClock?.timeMode ?? 'pending'}` +
      ` urlFingerprint=${urlFingerprint(rtspMasked)}`
    )

    previewSessions.set(sessionId, {
      streamToken, userId: user.sub, createdAt: Date.now(), expiresAt,
      rtspUrl, rtspMasked, cameraId: body.cameraId, nvrId: camera.nvr.id, slotIndex: body.slotIndex,
      startTime: body.startTime, endTime: body.endTime,
      forceTranscode, strategy, detectedCodec, canPlayHevcMp4,
      attemptPlan, channel: camera.channel,
      // Probe failure (e.g. 401 on the playback track) — pre-seed the category
      // so the frontend can show the real cause if the stream also fails
      errorCategory: probeErrorCategory,
      errorDetail:   probeErrorDetail,
    })

    AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
      startTime: body.startTime, endTime: body.endTime, sessionId, mode: 'preview',
    }).catch(() => {})

    return reply.send({
      sessionId,
      streamUrl: `/api/recordings/preview/${sessionId}/stream?token=${streamToken}`,
      expiresAt: new Date(expiresAt).toISOString(),
    })
  })

  // GET /api/recordings/preview/:sessionId/stream — Spawn FFmpeg, pipe fMP4 stdout to client.
  // Uses reply.hijack() to take raw control of the TCP connection.
  server.get('/preview/:sessionId/stream', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const { token }     = request.query as { token?: string }
    const session       = previewSessions.get(sessionId)

    if (!session || !session.streamToken || !token || token !== session.streamToken) {
      server.log.warn(`[recordings-preview] token_invalid sessionId=${sessionId} hasSession=${!!session}`)
      return reply.status(401).send({ message: 'Token de stream inválido o expirado' })
    }
    if (Date.now() > session.expiresAt) {
      terminatePreviewSession(sessionId, session, 'expired_on_stream', (m) => server.log.info(m))
      return reply.status(401).send({ message: 'Sesión de preview expirada' })
    }
    // (12) La sesión está en cierre → no aceptar nuevos GET /stream.
    if (session.closing) {
      server.log.warn(`[recordings-preview] stream_rejected_closing sessionId=${sessionId}`)
      return reply.status(409).send({ message: 'Sesión de preview en cierre' })
    }

    // ── (10) UN SOLO consumidor / un solo FFmpeg por sesión ──────────────────
    // Cada GET incrementa la generación del stream: el más nuevo es el dueño. En
    // vez de arrancar un FFmpeg PARALELO (bug P1), se TOMA EL CONTROL: terminar el
    // intento anterior y esperar su salida antes de spawnar el nuevo. Nunca dos
    // FFmpeg vivos para la misma sessionId.
    if (!session.procRegistry) session.procRegistry = new PreviewProcessRegistry({ graceMs: PREVIEW_KILL_GRACE_MS })
    const myGen = (session.streamGeneration = (session.streamGeneration ?? 0) + 1)
    // ── Takeover (req 1/2/6/10): terminar el intento anterior y NO spawnear otro
    // FFmpeg hasta confirmar su SALIDA REAL (exit/close). El route usa la misma
    // función pura que cubren los tests (resolveStreamTakeover) — sin reimplementar.
    session.vodProcess = undefined
    const takeover = await resolveStreamTakeover(session.procRegistry, {
      reason: 'stream_takeover',
      deadlineMs: PREVIEW_KILL_GRACE_MS + 500,
      hooks: terminateHooks((m) => server.log.info(m)),
      onTakeoverStart: (alive) =>
        server.log.info(`[recordings-preview] stream_takeover sessionId=${sessionId} gen=${myGen} priorAlive=${alive}`),
    })
    // Otro GET aún más nuevo llegó mientras esperábamos → ceder sin spawnar.
    if (session.streamGeneration !== myGen) {
      return reply.status(409).send({ message: 'Stream reemplazado por una solicitud más reciente' })
    }
    // La sesión pudo eliminarse (DELETE) o expirar (TTL) durante la espera del
    // takeover. Esto tiene PRIORIDAD sobre el 503 retriable: no tiene sentido pedir
    // reintentar una sesión que ya no existe — responder 410 (review Codex #125).
    if (session.closing || !previewSessions.has(sessionId)) {
      return reply.status(410).send({ message: 'Sesión de preview cancelada' })
    }
    if (!takeover.proceed) {
      // HARD GATE: el anterior no confirmó salida al vencer el deadline. NO adquirir
      // slot, NO hijack, NO spawn — así nunca hay dos FFmpeg vivos para la misma
      // sessionId, ni transitoriamente.
      server.log.error(
        `[recordings-preview] takeover_previous_not_reaped sessionId=${sessionId} gen=${myGen}` +
        ` stillAlive=${session.procRegistry.aliveCount()} — no se spawnea otro FFmpeg`
      )
      return reply.status(takeover.status).send({
        code: takeover.code,
        message: 'El proceso de reproducción anterior aún no terminó — reintentá en unos segundos',
      })
    }

    const { rtspUrl, rtspMasked, strategy } = session
    const rtspTimeoutOpt = getRtspTimeoutOption()
    const rtspTimeoutUs  = 60_000_000 // 60s for NVR seek + locate

    // TASK 5 — transporte aprendido por el diagnóstico (sólo se setea cuando una
    // combinación funcionó). No cambia el transporte GLOBAL: es por-NVR y verificado.
    const previewTransport: RtspTransport = nvrPlaybackProfiles.get(session.nvrId)?.preferredTransport ?? 'tcp'

    // TASK 3 — -progress en un fd dedicado (pipe:3) para instrumentar por etapas.
    // videoOnly (`-an`): se usa cuando el audio G.711 rompe el mux A/V (causa raíz
    // confirmada). La MISMA URI RTSP se reintenta sin audio; el video-only produce
    // fMP4 en ~5,5s. La descarga MP4 (VOD) NO se ve afectada.
    const buildFfmpegArgs = (inputUrl: string, videoOnly: boolean) => [
      '-rtsp_transport', previewTransport,
      '-fflags', '+genpts+discardcorrupt',
      ...(rtspTimeoutOpt ? [rtspTimeoutOpt, String(rtspTimeoutUs)] : []),
      '-reorder_queue_size', '0',
      '-i', inputUrl,
      ...buildPreviewCodecArgs(strategy, videoOnly),
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      '-progress', 'pipe:3',
      'pipe:1',
    ]

    // Per-NVR concurrency: wait for a free playback slot + stagger before
    // opening another RTSP playback session against the same NVR
    const releaseNvrSlot = await acquireNvrPreviewSlot(
      session.nvrId, session.slotIndex, (msg) => server.log.info(msg)
    )

    if (!releaseNvrSlot) {
      // Hard limit: never open an extra FFmpeg against a saturated NVR.
      // Record the category so the frontend shows the session-limit message.
      session.errorCategory = 'NVR_BANDWIDTH_OR_SESSION_LIMIT'
      session.errorDetail   = `Cola de previews del NVR llena (max=${MAX_PREVIEW_PER_NVR}) — timeout de ${PREVIEW_QUEUE_WAIT_MAX_MS}ms`
      session.hadFirstByte  = false
      retainFailedPreview(sessionId, session, (m) => server.log.info(m))
      server.log.warn(
        `[recordings-preview] nvr_preview_rejected_453 nvrId=${session.nvrId}` +
        ` cameraId=${session.cameraId} slot=${session.slotIndex} reason=queue_timeout`
      )
      return reply.status(503).send({ message: 'El NVR no tiene sesiones de reproducción libres' })
    }

    // Session may have been deleted while waiting in the queue
    if (!previewSessions.has(sessionId)) {
      releaseNvrSlot()
      return reply.status(410).send({ message: 'Sesión de preview cancelada' })
    }
    // (10/13) Revalidar la propiedad DESPUÉS del await de acquireNvrPreviewSlot:
    // otro GET pudo tomar el control (bump de streamGeneration) o la sesión pudo
    // entrar en cierre mientras esperábamos el slot del NVR. Sin esto, un handler
    // obsoleto haría hijack + spawn igual (con MAX_PREVIEW_PER_NVR>1, DOS FFmpeg
    // para la misma sesión; con el default, ocuparía el único slot). Liberar el
    // slot recién adquirido antes de ceder (review Codex #124).
    if (session.streamGeneration !== myGen || session.closing) {
      releaseNvrSlot()
      server.log.info(`[recordings-preview] stream_superseded_after_slot sessionId=${sessionId} gen=${myGen} current=${session.streamGeneration ?? 'none'} closing=${!!session.closing}`)
      return reply.status(409).send({ message: 'Stream reemplazado por una solicitud más reciente' })
    }

    // Hijack the raw TCP connection — bypass Fastify serialization entirely
    reply.hijack()
    const res = reply.raw
    // Consumidor adjunto (para el reaper de sesiones sin consumidor, req 15).
    session.streamAttached = true
    session.lastStreamAt   = Date.now()

    const streamStartMs = Date.now()
    let firstByteSent = false
    let headersSent   = false
    let clientGone    = false
    let responseEnded = false
    // El presupuesto total ya terminó la sesión (mató FFmpeg + respondió error):
    // el 'exit' del proceso NO debe reclasificar la causa ni avanzar la cadena,
    // para no pisar la categoría FIRST_BYTE_TIMEOUT con UNKNOWN (que dispararía un
    // retry H.264 indebido en el frontend).
    let deadlineTerminated = false
    // Audio G.711 rompe el mux A/V (causa raíz confirmada): una vez detectado en
    // esta sesión, TODOS los intentos siguientes arrancan video-only (no re-gastar
    // un intento A/V que ya se sabe incompatible). Optimización codec-aware: si YA
    // se detectó audio problemático en esta cámara (bloque anterior), arrancar el
    // primer intento directo en video-only (primer byte ~5,5s en vez de 25s).
    let sessionVideoOnly = cameraAudioProblematic.has(session.cameraId)
    if (sessionVideoOnly) {
      server.log.info(`[recordings-preview] preview_video_only_known sessionId=${sessionId} cameraId=${session.cameraId} — audio G.711 conocido, arranque video-only`)
    }
    let currentProc: ChildProcess | null = null
    // Limpieza del intento activo (timers + estado terminal), invocable desde
    // onClientGone / presupuesto total para no dejar watchdogs vivos tras cerrar.
    let currentAttemptCleanup: (() => void) | null = null
    // Disposer registrado en la sesión (timers + listeners de ESTE handler), para
    // que el teardown de la sesión (DELETE / sweep) pueda limpiarlo (req 12d).
    let ownerDispose: (() => void) | null = null
    // Presupuesto TOTAL de arranque: un único timer por sesión (no basta con
    // chequear elapsed al iniciar cada variante).
    let totalStartupTimer: NodeJS.Timeout | null = null
    const clearTotalStartupTimer = () => { if (totalStartupTimer) { clearTimeout(totalStartupTimer); totalStartupTimer = null } }

    // Dueño actual del stream: sólo ESTA generación puede avanzar la cadena o
    // re-spawnar. Si un GET más nuevo tomó el control (bump de generación) o la
    // sesión entró en cierre, este handler ya no es dueño y no debe tocar el
    // intento nuevo ni arrancar otro FFmpeg (req 13).
    const isOwner     = () => session.streamGeneration === myGen && !session.closing
    const canContinue = () => !clientGone && isOwner() && previewSessions.has(sessionId)

    // Los headers 200 se envían RECIÉN cuando FFmpeg produce el primer byte de
    // MP4 — no antes. Así, si todas las variantes RTSP fallan, el cliente recibe
    // un error real (5xx) en vez de un 200 con cuerpo vacío que lo dejaría con el
    // spinner en 0:00 indefinidamente.
    const sendHeadersOnce = () => {
      if (headersSent) return
      headersSent = true
      res.writeHead(200, {
        'Content-Type':  'video/mp4',
        'Cache-Control': 'no-cache, no-store',
        'Connection':    'keep-alive',
        'X-Session-Id':  sessionId,
      })
    }
    // Termina la respuesta con un estado de error si aún no se enviaron headers
    // (ninguna variante llegó al primer byte). Mapea la causa a un status HTTP.
    const endWithError = (category: string, detail: string) => {
      if (headersSent) return
      headersSent = true
      const status = errorStatusForCategory(category)
      try {
        res.writeHead(status, { 'Content-Type': 'application/json', 'X-Session-Id': sessionId })
        res.end(JSON.stringify({ code: category, message: 'El origen no entregó video', detail: detail.slice(0, 300) }))
      } catch { /* conexión ya cerrada */ }
    }

    const stderrTail: string[] = []
    session.stderrTail = stderrTail

    const finish = (reason: string) => {
      if (responseEnded) return
      responseEnded = true
      clearTotalStartupTimer()
      const elapsedMs = Date.now() - streamStartMs
      server.log.info(
        `[recordings-preview] stream_closed sessionId=${sessionId}` +
        ` reason=${reason} elapsedMs=${elapsedMs} hadFirstByte=${firstByteSent}`
      )
      releaseNvrSlot()
      // Este consumidor se va: soltar la marca SÓLO si seguimos siendo el dueño
      // (un GET más nuevo puede haberla re-tomado). Deregistrar el disposer propio.
      if (session.streamGeneration === myGen) session.streamAttached = false
      if (ownerDispose) session.disposers?.delete(ownerDispose)
      // Red de seguridad: si nunca se enviaron headers y el cliente sigue ahí,
      // no cerrar con un 200 vacío (spinner infinito) — enviar 502.
      if (!headersSent && !clientGone) endWithError('STREAM_ENDED_NO_OUTPUT', reason)
      try { res.end() } catch {}
    }

    // Plan de intentos: estrategias de URL BASE desde la sesión. Se distingue
    // "sin plan" (undefined → ruta legacy) de "plan intencionalmente VACÍO"
    // (length 0, p.ej. mode=sub con substream no soportado): en ese caso NO se
    // cae al legacy (que reintentaría el sub rechazado) — se responde error.
    const attemptChain: PlaybackAttempt[] = session.attemptPlan !== undefined
      ? session.attemptPlan
      : buildVariantChain(rtspUrl, session.cameraId).map(v => ({
          strategy: v.variant as unknown as PlaybackBaseStrategy, url: v.url,
          masked: maskUrlCredentials(v.url), track: (session.channel ?? 0) * 100 + 1,
          respectsPlayhead: true,  // ruta legacy: la base ya trae el start correcto
        }))
    if (attemptChain.length === 0) {
      server.log.warn(`[recordings-preview] empty_attempt_plan sessionId=${sessionId} — sin estrategia compatible (mode/perfil)`)
      session.errorCategory = 'RTSP_PLAYBACK_URI_REJECTED'
      session.errorDetail   = 'No hay estrategia de reproducción compatible para este NVR/modo (substream no soportado).'
      retainFailedPreview(sessionId, session, (m) => server.log.info(m))
      endWithError(session.errorCategory, session.errorDetail)
      finish('empty_attempt_plan')
      return
    }
    const attemptErrors: Array<{ variant: string; category: string; detail: string }> = []

    // Presupuesto TOTAL efectivo (lógica pura, testeable con reloj simulado):
    // cada intento merece el watchdog COMPLETO (el Hikvision puede tardar 13-15s
    // en el primer byte; comprimir por debajo mataría streams válidos). El
    // presupuesto global reserva el overhead REAL entre intentos (gracia de
    // SIGKILL + retardo de reintento + margen), que antes NO se contaba y
    // comprimía los últimos intentos (evidencia: 16,484s / 19,322s en vez de 25s).
    // Si el plan no cabe bajo el tope duro, se recortan las variantes de menor
    // prioridad y se registran (nunca se comprime un intento por debajo del piso).
    const budgetPlan = planStartupBudget(attemptChain.length, {
      firstByteTimeoutMs: PREVIEW_FIRST_BYTE_TIMEOUT_MS,
      killGraceMs:        PREVIEW_KILL_GRACE_MS,
      retryDelayMs:       PREVIEW_RETRY_DELAY_MS,
      safetyMarginMs:     PREVIEW_BUDGET_SAFETY_MARGIN_MS,
      hardCapMs:          PREVIEW_STARTUP_HARD_CAP_MS,
      minTotalMs:         PREVIEW_TOTAL_STARTUP_MS,
    })
    const effectiveTotalBudget = budgetPlan.effectiveTotalBudgetMs
    // Recorte por presupuesto: conservar las de MAYOR prioridad (van al frente del
    // plan). Las descartadas se registran EXPLÍCITAMENTE (nunca truncado silencioso).
    if (budgetPlan.skippedAttempts > 0) {
      for (let i = budgetPlan.keptAttempts; i < attemptChain.length; i++) {
        const sk = attemptChain[i]
        // requiredMs = lo que costaría ejecutar hasta este intento inclusive;
        // remainingMs = lo que el tope duro deja disponible. Nunca se ejecuta un
        // intento con timeout reducido en silencio: se OMITE y se registra.
        const requiredMs  = (i + 1) * budgetPlan.perAttemptCostMs - PREVIEW_RETRY_DELAY_MS + PREVIEW_BUDGET_SAFETY_MARGIN_MS
        const remainingMs = Math.max(0, PREVIEW_STARTUP_HARD_CAP_MS - budgetPlan.effectiveTotalBudgetMs)
        server.log.warn(
          `[recordings-preview] attempt_skipped sessionId=${sessionId} reason=insufficient_budget` +
          ` strategy=${sk.strategy} track=${sk.track} attempt_index=${i}` +
          ` kept=${budgetPlan.keptAttempts} total=${attemptChain.length}` +
          ` requiredMs=${requiredMs} remainingMs=${remainingMs}` +
          ` per_attempt_cost_ms=${budgetPlan.perAttemptCostMs} hard_cap_ms=${PREVIEW_STARTUP_HARD_CAP_MS}`
        )
      }
      attemptChain.length = budgetPlan.keptAttempts
    }
    // TASK 1 — presupuesto EFECTIVO por sesión + detección de override viejo.
    const calcOverride = PREVIEW_TOTAL_STARTUP_RAW != null ? parseInt(PREVIEW_TOTAL_STARTUP_RAW, 10) : null
    server.log.info(
      `[recordings-preview] budget_plan sessionId=${sessionId}` +
      ` attempts=${attemptChain.length} per_attempt_timeout_ms=${budgetPlan.perAttemptTimeoutMs}` +
      ` per_attempt_cost_ms=${budgetPlan.perAttemptCostMs}` +
      ` calculatedStartupBudgetMs=${effectiveTotalBudget} maxStartupBudgetMs=${PREVIEW_STARTUP_HARD_CAP_MS}` +
      ` configuredStartupBudgetOverride=${calcOverride ?? 'none'} skipped=${budgetPlan.skippedAttempts}`
    )
    if (calcOverride != null && calcOverride < effectiveTotalBudget) {
      server.log.warn(
        `[recordings-preview] WARN stale_startup_budget_override sessionId=${sessionId}` +
        ` override=${calcOverride} calculated=${effectiveTotalBudget} — el override recorta el presupuesto` +
        ` (ahora RECORDINGS_PREVIEW_TOTAL_STARTUP_MS es sólo el PISO; el efectivo escala con los intentos)`
      )
    }

    const startAttempt = (chainIndex: number, videoOnlyOverride = false) => {
      const attemptVideoOnly = videoOnlyOverride || sessionVideoOnly
      // Presupuesto total agotado → no iniciar otra variante; responder error.
      const totalElapsed = Date.now() - streamStartMs
      if (totalElapsed > effectiveTotalBudget && !firstByteSent) {
        server.log.warn(`[recordings-preview] startup_budget_exceeded sessionId=${sessionId} elapsedMs=${totalElapsed}`)
        const prev = attemptErrors[attemptErrors.length - 1]
        session.errorCategory = prev?.category ?? 'FIRST_BYTE_TIMEOUT'
        session.errorDetail   = prev?.detail ?? 'presupuesto de arranque agotado'
        session.hadFirstByte  = false
        retainFailedPreview(sessionId, session, (m) => server.log.info(m))
        endWithError(session.errorCategory, session.errorDetail ?? '')
        finish('startup_budget_exceeded')
        return
      }
      const attempt = attemptChain[chainIndex]
      const { strategy: variant, url: inputUrl, track } = attempt
      const maskedUrl = maskUrlCredentials(inputUrl)
      let firstByteTimer: NodeJS.Timeout | null = null
      // Cada intento recibe el watchdog COMPLETO como deadline individual FIJA — ya
      // NO se comprime por "presupuesto restante". El presupuesto global se
      // dimensionó (planStartupBudget) para que todos los intentos conservados
      // quepan a tiempo completo contando el overhead, así que ningún intento —
      // ni el último — se queda por debajo del watchdog real del NVR (~13-15s).
      const remainingBudget = effectiveTotalBudget - totalElapsed
      const attemptTimeout  = budgetPlan.perAttemptTimeoutMs
      server.log.info(
        `[recordings-preview] attempt_budget sessionId=${sessionId} attempt_index=${chainIndex}` +
        ` baseStrategy=${variant} remaining_budget_ms=${remainingBudget} total_budget_ms=${effectiveTotalBudget}` +
        ` timeout_for_attempt_ms=${attemptTimeout}`
      )
      server.log.info(`[recordings-preview] base_strategy_try sessionId=${sessionId} baseStrategy=${variant} track=${track}`)
      server.log.info(`[recordings-preview] rtsp_variant_try sessionId=${sessionId} variant=${variant}`)
      server.log.info(
        `[recordings-preview] stream_start sessionId=${sessionId}` +
        ` slotIndex=${session.slotIndex} cameraId=${session.cameraId}` +
        ` strategy=${strategy} codec=${session.detectedCodec} baseStrategy=${variant} track=${track} url=${maskedUrl.slice(0, 160)}`
      )

      // stdio: [ignore, stdout(mp4), stderr, progress(pipe:3)] — el 4º fd es -progress.
      const proc = spawn('ffmpeg', buildFfmpegArgs(inputUrl, attemptVideoOnly), { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
      currentProc = proc
      session.vodProcess = proc
      // (9/11) Alta en el registro de la sesión: attemptId único + pid. La baja va
      // en el `close` de ESTE proc (drenado definitivo). Así el teardown, el
      // takeover y el reaper alcanzan a TODOS los hijos, no sólo al actual.
      const attemptRec = session.procRegistry!.register(proc, Date.now())
      server.log.info(
        `[recordings-preview] ffmpeg_spawn sessionId=${sessionId} attemptId=${attemptRec.attemptId}` +
        ` pid=${proc.pid ?? 'none'} gen=${myGen} variant=${variant} videoOnly=${attemptVideoOnly}`
      )
      server.log.info(`[recordings-preview] ffmpeg_transport sessionId=${sessionId} variant=${variant} transport=${previewTransport} videoOnly=${attemptVideoOnly}`)

      // ── Máquina de estado del intento + watchdog de primer byte ─────────
      // Estados: waiting_first_byte → streaming → (exited) ; o → timed_out /
      // cancelled. Los bytes de stdout SÓLO se aceptan en waiting_first_byte. Un
      // NVR lento puede vaciar bytes durante el cierre (tras SIGTERM); aceptarlos
      // marcaba éxito y enviaba un MP4 truncado → aquí se ignoran (late byte).
      let attemptState: 'waiting_first_byte' | 'streaming' | 'terminal' = 'waiting_first_byte'
      let variantTimedOut = false
      let procExited = false   // se setea en el handler 'exit' (salida REAL)
      let killGraceTimer: NodeJS.Timeout | null = null
      // TASK 4 — 'exit' no garantiza stdout drenado; la finalización definitiva va
      // en 'close'. Estos registran la salida y si hubo bytes (incluso tardíos).
      let exitCode: number | null = null
      let exitSignal: string | null = null
      let closeHandled = false
      let sawStdoutByte = false           // ¿llegó ALGÚN byte por stdout? (aun tardío)
      let lateByteAfterKill = false       // el 1er byte llegó tras timeout/kill (drain race)
      let firstMuxedByteMs: number | null = null
      // TASK 3 — instrumentación -progress / etapas de FFmpeg.
      let sawInputOpened = false
      let firstEncodedFrameLogged = false
      let progressBuf = ''
      // ── Fallback video-only por audio G.711 (causa raíz confirmada) ──
      let detectedAudioCodec: string | null = null
      let detectedVideoCodec: string | null = null
      let detectedWidth:  number | null = null
      let detectedHeight: number | null = null
      let audioFallbackTried = false      // ya se reintentó esta URI en video-only
      let audioRestartPending = false     // el 'close' debe re-lanzar el MISMO índice video-only
      const clearFirstByteWatchdog = () => {
        if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
        if (killGraceTimer) { clearTimeout(killGraceTimer); killGraceTimer = null }
      }
      // Marca el intento como terminal y detiene toda entrada de datos al cliente.
      const finalizeAttempt = () => {
        attemptState = 'terminal'
        clearFirstByteWatchdog()
        try { proc.stdout?.unpipe(res) } catch {}
      }
      currentAttemptCleanup = finalizeAttempt
      firstByteTimer = setTimeout(() => {
        if (firstByteSent || attemptState !== 'waiting_first_byte') return
        variantTimedOut = true
        attemptState = 'terminal'
        session.errorCategory = 'FIRST_BYTE_TIMEOUT'
        // Cortar cualquier byte tardío antes de matar: si FFmpeg vacía datos
        // durante el cierre, NO deben llegar al navegador (MP4 truncado).
        try { proc.stdout?.unpipe(res) } catch {}
        server.log.warn(
          `[recordings-preview] first_byte_timeout sessionId=${sessionId} variant=${variant}` +
          ` timeoutMs=${attemptTimeout} — killing ffmpeg to advance chain`
        )
        try { proc.kill('SIGTERM') } catch {}
        // Si ignora SIGTERM, forzar SIGKILL tras la gracia. Se comprueba procExited
        // (salida REAL vía el evento 'exit'), NO proc.killed: en Node proc.killed
        // se vuelve true apenas se ENVÍA la señal, no cuando el proceso termina —
        // usarlo dejaría vivo a un FFmpeg que ignora SIGTERM y la cadena colgada.
        killGraceTimer = setTimeout(() => {
          if (procExited) return
          server.log.warn(`[recordings-preview] sigkill sessionId=${sessionId} variant=${variant} — ffmpeg ignored SIGTERM`)
          try { proc.kill('SIGKILL') } catch {}
        }, PREVIEW_KILL_GRACE_MS)
      }, attemptTimeout)

      proc.stderr?.on('data', (chunk: Buffer) => {
        for (const raw of chunk.toString().split('\n')) {
          const line = maskUrlCredentials(raw.trim())
          if (!line) continue
          stderrTail.push(line)
          if (stderrTail.length > 30) stderrTail.shift()
          // ── Detección de codecs por LÍNEA ACTUAL (no sobre el head capado a 15) ──
          // El banner de FFmpeg (versión + configuración + libs) suele superar 15
          // líneas ANTES de las líneas "Stream #0:N: Audio/Video", así que parsear
          // stderrHead nunca vería el audio y el fallback quedaría inhabilitado
          // (review Codex #120). Parseamos cada línea directamente, sin tope.
          if (detectedAudioCodec == null || detectedVideoCodec == null) {
            const info = parseStreamInfoFromStderr(line)
            if (info.audioCodec) detectedAudioCodec = info.audioCodec
            if (info.videoCodec) detectedVideoCodec = info.videoCodec
            if (info.width  != null) detectedWidth  = info.width
            if (info.height != null) detectedHeight = info.height
          }
          // TASK 3 — marcar input_opened y el primer stream de video/audio detectado.
          if (!sawInputOpened && /Input #\d+|Stream #\d+:\d+/.test(line)) {
            sawInputOpened = true
            server.log.info(
              `[recordings-preview] input_opened sessionId=${sessionId} variant=${variant}` +
              ` elapsedMs=${Date.now() - streamStartMs} video=${detectedVideoCodec ?? 'pending'}` +
              ` audio=${detectedAudioCodec ?? 'none'} ${detectedWidth ?? '?'}x${detectedHeight ?? '?'}`
            )
          }
          // ── Fallback video-only por audio G.711 sobre la MISMA URI ──
          // El stderr revela el codec de audio (~1-2s), MUCHO antes del atasco de
          // encode/mux (~6-8s) y del watchdog (25s). Si es pcm_mulaw/pcm_alaw y el
          // intento A/V aún no produjo primer byte, se mata y se re-lanza la misma
          // URI sin audio — NO se avanza a otra estrategia RTSP (la URI es válida).
          if (shouldRestartVideoOnly({
            audioCodec: detectedAudioCodec, alreadyVideoOnly: attemptVideoOnly,
            firstByteSent, audioFallbackTried,
          })) {
            audioFallbackTried  = true
            audioRestartPending = true
            sessionVideoOnly    = true   // los intentos siguientes ya arrancan video-only
            cameraAudioProblematic.add(session.cameraId)  // y los próximos previews de esta cámara
            attemptState        = 'terminal'
            clearFirstByteWatchdog()
            try { proc.stdout?.unpipe(res) } catch {}
            server.log.warn(
              `[recordings-preview] audio_fallback_video_only sessionId=${sessionId} variant=${variant}` +
              ` audioCodec=${detectedAudioCodec} — reintentando MISMA URI sin audio (G.711 rompe el mux A/V)`
            )
            try { proc.kill('SIGTERM') } catch {}
            killGraceTimer = setTimeout(() => {
              if (procExited) return
              try { proc.kill('SIGKILL') } catch {}
            }, PREVIEW_KILL_GRACE_MS)
          }
          server.log.debug(`[recordings-preview] ffmpeg_stderr sessionId=${sessionId} line=${line.slice(0, 200)}`)
        }
      })

      // TASK 3 — -progress (fd 3): primer frame codificado + progreso periódico.
      const progressPipe = (proc.stdio as any)[3]
      progressPipe?.on('data', (chunk: Buffer) => {
        progressBuf += chunk.toString()
        if (progressBuf.length > 8192) progressBuf = progressBuf.slice(-4096)
        const snap = parseFfmpegProgress(progressBuf)
        if (!firstEncodedFrameLogged && snap.frame != null && snap.frame >= 1) {
          firstEncodedFrameLogged = true
          server.log.info(
            `[recordings-preview] first_encoded_frame sessionId=${sessionId} variant=${variant}` +
            ` elapsedMs=${Date.now() - streamStartMs} frame=${snap.frame} outTimeMs=${snap.outTimeMs ?? 0}`
          )
        }
        if (snap.progress === 'end') {
          server.log.info(
            `[recordings-preview] progress_end sessionId=${sessionId} variant=${variant}` +
            ` frames=${snap.frame ?? 0} outTimeMs=${snap.outTimeMs ?? 0} totalSize=${snap.totalSize ?? 0}`
          )
        }
      })

      proc.stdout?.once('data', (chunk: Buffer) => {
        // Registrar SIEMPRE que hubo salida (aun tardía): prueba que FFmpeg produjo
        // bytes muxeados. firstMuxedByteMs alimenta el diagnóstico y distingue un
        // MUXER_NO_OUTPUT real de una carrera de drenaje (OUTPUT_PIPE_DRAIN_RACE).
        sawStdoutByte = true
        if (firstMuxedByteMs == null) firstMuxedByteMs = Date.now() - streamStartMs
        // Sólo el primer byte que llega en 'waiting_first_byte' (y con el cliente
        // presente) cuenta como éxito. Un byte tardío tras timeout/kill/cierre se
        // ignora — nunca envía headers, marca éxito ni escribe al navegador.
        if (!shouldAcceptFirstByte({ state: attemptState, variantTimedOut, procExited, clientGone, responseEnded })) {
          lateByteAfterKill = variantTimedOut || procExited
          server.log.info(
            `[recordings-preview] late_first_byte_ignored sessionId=${sessionId} variant=${variant}` +
            ` state=${attemptState} timedOut=${variantTimedOut} exited=${procExited} clientGone=${clientGone}` +
            ` firstMuxedByteMs=${firstMuxedByteMs} — FFmpeg SÍ produjo salida (drain race), no rechazo del NVR`
          )
          return
        }
        attemptState = 'streaming'
        // Primer byte real de FFmpeg → cancelar el watchdog y recién ahora enviar
        // el 200. Debe correr ANTES de que el pipe escriba el chunk (este listener
        // se registró antes).
        clearFirstByteWatchdog()
        clearTotalStartupTimer()
        sendHeadersOnce()
        firstByteSent = true
        session.hadFirstByte  = true
        // A working variant wipes any error state from earlier attempts
        session.errorCategory = undefined
        session.errorDetail   = undefined
        failedPreviewSessions.delete(sessionId)
        // Perfil aprendido del NVR: preferir esta estrategia la próxima SÓLO si
        // respetó el playhead solicitado (no promover una que reproduce desde el
        // inicio equivocado del bloque). Si fue substream, confirma soporte de sub.
        const prof = nvrPlaybackProfiles.get(session.nvrId) ?? {}
        if (attempt.respectsPlayhead) {
          prof.preferredBaseStrategy = variant as PlaybackBaseStrategy
        } else {
          server.log.warn(`[recordings-preview] success_wrong_playhead nvrId=${session.nvrId} baseStrategy=${variant} — no se marca como preferida (start del bloque, no el playhead)`)
        }
        if (variant.startsWith('sub')) prof.supportsPlaybackSubstream = true
        prof.lastVerifiedAt = Date.now()
        nvrPlaybackProfiles.set(session.nvrId, prof)
        server.log.info(`[recordings-preview] base_strategy_preferred nvrId=${session.nvrId} baseStrategy=${variant} track=${track} respectsPlayhead=${attempt.respectsPlayhead}`)
        server.log.info(
          `[recordings-preview] rtsp_variant_success cameraId=${session.cameraId} sessionId=${sessionId}` +
          ` variant=${variant} firstByteMs=${Date.now() - streamStartMs}`
        )
        server.log.info(
          `[recordings-preview] first_byte sessionId=${sessionId}` +
          ` variant=${variant} elapsedMs=${Date.now() - streamStartMs} bytes=${chunk.length}`
        )
      })

      // end:false — on a failed variant we reuse the same response for the next one
      proc.stdout?.pipe(res, { end: false })

      proc.on('exit', (code, signal) => {
        // TASK 4 — 'exit' NO garantiza que stdout esté drenado. Aquí SÓLO se
        // registra la salida real (necesaria para la gracia de SIGKILL y el
        // diagnóstico) y se marca terminal si aún esperaba primer byte. La
        // finalización DEFINITIVA (avanzar la cadena / all_variants_failed /
        // finish) ocurre en 'close', tras drenar stdout — así no se pierden bytes
        // tardíos ni se sirve un MP4 truncado de un proceso ya terminado.
        procExited = true
        exitCode   = code
        exitSignal = signal ?? null
        clearFirstByteWatchdog()
        if (attemptState === 'waiting_first_byte') attemptState = 'terminal'
        // (4) SALIDA REAL confirmada por el evento del proceso — resuelve la espera
        // del takeover y cancela cualquier SIGKILL de gracia pendiente. Es lo ÚNICO
        // que baja aliveCount() (nunca la señal enviada).
        session.procRegistry?.markExited(attemptRec.attemptId)
        server.log.info(
          `[recordings-preview] ffmpeg_exit sessionId=${sessionId}` +
          ` code=${code} signal=${signal ?? 'none'} variant=${variant} elapsedMs=${Date.now() - streamStartMs}` +
          ` hadFirstByte=${firstByteSent} timedOut=${variantTimedOut} sawStdoutByte=${sawStdoutByte}`
        )
      })

      // 'close' = todos los stdio del proceso cerrados → stdout DRENADO. Ésta es la
      // finalización definitiva del intento (TASK 4).
      proc.on('close', () => {
        if (closeHandled) return
        closeHandled = true
        const code = exitCode
        const elapsedMs = Date.now() - streamStartMs
        server.log.info(
          `[recordings-preview] ffmpeg_close sessionId=${sessionId}` +
          ` code=${code} signal=${exitSignal ?? 'none'} variant=${variant} elapsedMs=${elapsedMs}` +
          ` hadFirstByte=${firstByteSent} timedOut=${variantTimedOut}` +
          ` firstMuxedByteMs=${firstMuxedByteMs ?? 'none'} lateByteAfterKill=${lateByteAfterKill}`
        )
        if (session.vodProcess === proc) session.vodProcess = undefined
        // (11/13) Baja de ESTE intento del registro (por attemptId — no toca al
        // intento nuevo si hubo takeover). Si la sesión está en cierre y ya no
        // quedan hijos vivos, confirmar la limpieza completa.
        session.procRegistry?.unregister(attemptRec.attemptId)
        if (session.closing && (session.procRegistry?.aliveCount() ?? 0) === 0) {
          server.log.info(`[recordings-preview] session_cleanup_complete sessionId=${sessionId} slotIndex=${session.slotIndex}`)
        }

        // ── Reinicio por audio G.711: re-lanzar el MISMO índice en video-only ──
        // NO avanzar la cadena (la URI es válida: abrió RTSP y trae video). El
        // guard attemptVideoOnly evita el bucle en el re-intento.
        if (audioRestartPending) {
          audioRestartPending = false
          server.log.info(`[recordings-preview] audio_fallback_restart sessionId=${sessionId} chainIndex=${chainIndex} — misma URI, video-only`)
          // (13) Sólo re-spawnar si SEGUIMOS siendo el dueño: un takeover o el
          // cierre de la sesión invalidan este handler → no arrancar otro FFmpeg.
          if (canContinue()) startAttempt(chainIndex, true)
          else finish('audio_fallback_cancelled')
          return
        }

        // El presupuesto total ya terminó la sesión (mató el proceso + respondió
        // error): no reclasificar ni avanzar la cadena — pisaría la categoría
        // FIRST_BYTE_TIMEOUT con UNKNOWN. Sólo cerrar.
        if (deadlineTerminated) {
          finish('deadline_terminated_close')
          return
        }

        // Red de seguridad (además de la detección temprana por stderr): si el
        // intento A/V se cerró SIN primer byte habiendo abierto RTSP con video, y
        // el audio es G.711, reintentar la MISMA URI en video-only en vez de
        // avanzar de estrategia (spec: la URI es válida; sólo falla el mux A/V).
        const videoDecoded = sawInputOpened && detectedVideoCodec != null
        const audioProblematic = isProblematicPreviewAudio(detectedAudioCodec)
        if (!firstByteSent && !attemptVideoOnly && canContinue()
            && videoDecoded && audioProblematic) {
          sessionVideoOnly = true
          cameraAudioProblematic.add(session.cameraId)
          server.log.warn(
            `[recordings-preview] audio_fallback_video_only sessionId=${sessionId} variant=${variant}` +
            ` audioCodec=${detectedAudioCodec} reason=post_close — misma URI, video-only`
          )
          startAttempt(chainIndex, true)
          return
        }

        // Cualquier cierre SIN primer byte aceptado es un fallo de esta variante
        // (incluye el kill del watchdog por timeout y una salida limpia sin datos)
        // → avanzar al siguiente variant.
        const failedBeforeOutput = !firstByteSent
        if (failedBeforeOutput) {
          // Bytes tardíos tras el kill PRUEBAN que FFmpeg producía salida muxeada:
          // es una carrera de drenaje del pipe, NO un rechazo del NVR. Se refleja
          // en el detalle para no mostrar "el NVR rechazó la URL" cuando en
          // realidad sólo se agotó el tiempo de SALIDA (track 101 real).
          const drainRace = variantTimedOut && lateByteAfterKill
          // Video decodificado pero sin salida y audio G.711 → causa audio/mux A/V
          // (no URI rechazada ni timeout de RTSP). Sólo si no se pudo reintentar
          // video-only (p.ej. cliente desconectado): categoría dedicada y veraz.
          const audioMuxFailure = isAudioSyncOrMuxFailure({ videoDecoded, firstByteSent, audioProblematic })
          const category = audioMuxFailure ? 'AUDIO_SYNC_OR_MUX_FAILURE'
            : variantTimedOut ? 'FIRST_BYTE_TIMEOUT'
            : classifyRtspError(stderrTail.join('\n'))
          const detail   = audioMuxFailure
            ? `video HEVC decodificado pero el mux A/V con audio ${detectedAudioCodec} no produjo salida — usar video-only`
            : variantTimedOut
            ? `sin primer byte aceptado en ${attemptTimeout}ms` +
              (drainRace ? ` (late byte muxeado a ${firstMuxedByteMs}ms tras kill — drain race, FFmpeg SÍ producía salida)` : '') +
              ` — ${stderrTail.slice(-3).join(' | ').slice(0, 300)}`
            : stderrTail.slice(-5).join(' | ').slice(0, 400)
          attemptErrors.push({ variant, category, detail })
          stderrTail.length = 0  // fresh tail for the next attempt
          // Substream rechazado por el NVR (400) → marcar el perfil para NO volver
          // a probar playback substream en este NVR (ahorra ~25s por intento).
          if (variant.startsWith('sub') && category === 'RTSP_PLAYBACK_URI_REJECTED') {
            const prof = nvrPlaybackProfiles.get(session.nvrId) ?? {}
            prof.supportsPlaybackSubstream = false
            prof.substreamRejectedAt = Date.now()   // timestamp dedicado (TTL se mide de acá)
            nvrPlaybackProfiles.set(session.nvrId, prof)
            server.log.info(`[recordings-preview] nvr_profile_no_substream nvrId=${session.nvrId} — 400 en ${variant}`)
          }
          server.log.warn(
            `[recordings-preview] ffmpeg_failed sessionId=${sessionId}` +
            ` code=${code} variant=${variant} category=${category} stderr_tail=${detail}`
          )
          server.log.info(`[recordings-preview] rtsp_variant_failed sessionId=${sessionId} variant=${variant}`)

          // Advance the chain — except on offline/timeout, where every
          // further attempt would just burn the 60 s RTSP timeout again
          const advance =
            chainIndex + 1 < attemptChain.length &&
            category !== 'NVR_OFFLINE_OR_TIMEOUT' &&
            !clientGone
          if (advance) {
            setTimeout(() => {
              // (13) Sólo avanzar la cadena si SEGUIMOS siendo el dueño del stream.
              if (canContinue()) {
                startAttempt(chainIndex + 1)
              } else {
                finish('cancelled_before_fallback')
              }
            }, PREVIEW_RETRY_DELAY_MS)
            return
          }

          // Cancelación (cliente desconectado / sesión eliminada): NO es un fallo
          // del NVR — no emitir all_variants_failed ni error al cliente.
          if (isCancellation({ clientGone, sessionAlive: previewSessions.has(sessionId) })) {
            server.log.info(
              `[recordings-preview] attempt_cancelled sessionId=${sessionId} variant=${variant}` +
              ` reason=${clientGone ? 'client_disconnect' : 'session_removed'}`
            )
            finish('attempt_cancelled')
            return
          }

          // All variants exhausted — persist the final error state. A 453 in
          // ANY attempt wins; otherwise the highest-priority MAIN attempt's
          // error wins over trailing sub (102) rejections, which are expected
          // on NVRs without playback substream and would mislead the operator.
          const { error: final, chosenFrom } = pickFinalPlaybackError(attemptErrors)
          session.errorCategory = final.category
          session.errorDetail   = final.detail
          session.hadFirstByte  = false
          retainFailedPreview(sessionId, session, (m) => server.log.info(m))
          server.log.warn(
            `[recordings-preview] all_variants_failed sessionId=${sessionId}` +
            ` category=${final.category} chosen_from=${chosenFrom} chosen_variant=${final.variant}` +
            ` attempts=${attemptErrors.map(e => `${e.variant}:${e.category}`).join(',')}`
          )
          if (final.category === 'NVR_BANDWIDTH_OR_SESSION_LIMIT') {
            server.log.warn(
              `[recordings-preview] nvr_preview_rejected_453 nvrId=${session.nvrId}` +
              ` cameraId=${session.cameraId} slot=${session.slotIndex}`
            )
          }
          // Ninguna variante llegó al primer byte → responder error real (no un
          // 200 vacío). Si ya se habían enviado headers (variante previa OK y
          // luego cortó), esto es no-op y finish() cierra normalmente.
          endWithError(final.category, final.detail)
        }

        finish(failedBeforeOutput ? 'ffmpeg_failed' : 'ffmpeg_close')
      })

      proc.on('error', (err: Error) => {
        finalizeAttempt()
        server.log.warn(`[recordings-preview] ffmpeg_error sessionId=${sessionId} err=${err.message}`)
        try { proc.kill('SIGTERM') } catch {}
        finish('ffmpeg_error')
      })
    }

    // (14) request_error / cierre de socket NO puede limitarse a cerrar la
    // respuesta HTTP: debe terminar FFmpeg server-side, UNA sola vez, y alcanzar a
    // TODOS los hijos de esta sesión (no sólo currentProc) — red independiente del
    // JWT (el DELETE puede fallar por token expirado, pero el socket igual limpia).
    const onClose = () => onClientGone('client_disconnect')
    const onErr   = () => onClientGone('request_error')
    const onClientGone = (reason: string) => {
      if (clientGone) return
      clientGone = true
      // Detener el intento activo (timers + unpipe) y el presupuesto total antes
      // de matar FFmpeg, para que ningún watchdog dispare tras el cierre.
      currentAttemptCleanup?.()
      clearTotalStartupTimer()
      // Terminar TODOS los FFmpeg de la sesión de la que somos dueños (no sólo el
      // actual): un intento en vuelo o superado también debe morir server-side.
      if (isOwner()) terminateAllPreviewChildren(session, reason, (m) => server.log.info(m))
      else if (currentProc) { try { currentProc.kill('SIGTERM') } catch {} }
      if (session.vodProcess === currentProc) session.vodProcess = undefined
      finish(reason)
    }
    request.raw.on('close', onClose)
    request.raw.on('error', onErr)
    // request 'aborted' (deprecado en Node moderno pero aún emitido en algunos
    // paths) → mismo tratamiento que un cierre de socket.
    request.raw.on('aborted', onClose)
    // (12d) Disposer registrado en la sesión: el teardown (DELETE / sweep) limpia
    // timers + listeners de este handler sin depender de la request.
    ownerDispose = () => {
      clearTotalStartupTimer()
      currentAttemptCleanup?.()
      request.raw.removeListener('close', onClose)
      request.raw.removeListener('error', onErr)
      request.raw.removeListener('aborted', onClose)
    }
    if (!session.disposers) session.disposers = new Set()
    session.disposers.add(ownerDispose)

    server.log.info(
      `[recordings-preview] variant_chain sessionId=${sessionId} mode=${PLAYBACK_STREAM_MODE}` +
      ` chain=${attemptChain.map(a => a.strategy).join('→')}`
    )

    // Presupuesto TOTAL de arranque como timer independiente (una vez por sesión):
    // aunque una variante quede colgada más allá del budget, esto corta y responde
    // error. Se cancela al primer byte (clearTotalStartupTimer) y en finish().
    totalStartupTimer = setTimeout(() => {
      if (firstByteSent || clientGone || responseEnded) return
      deadlineTerminated = true   // el 'exit' del proceso ya no debe reclasificar
      server.log.warn(`[recordings-preview] startup_budget_exceeded sessionId=${sessionId} totalMs=${effectiveTotalBudget}`)
      currentAttemptCleanup?.()
      if (currentProc) { try { currentProc.kill('SIGKILL') } catch {} }
      const prev = attemptErrors[attemptErrors.length - 1]
      session.errorCategory = prev?.category ?? 'FIRST_BYTE_TIMEOUT'
      session.errorDetail   = prev?.detail ?? 'presupuesto de arranque agotado'
      session.hadFirstByte  = false
      retainFailedPreview(sessionId, session, (m) => server.log.info(m))
      endWithError(session.errorCategory, session.errorDetail ?? '')
      finish('startup_budget_exceeded')
    }, effectiveTotalBudget)

    startAttempt(0)
  })

  // GET /api/recordings/preview/:sessionId/status — Error category after a
  // failed stream, so the frontend can show the real cause. Falls back to
  // the retained failure record when the session was already deleted.
  server.get('/preview/:sessionId/status', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = previewSessions.get(sessionId)

    if (session) {
      if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
        return reply.status(403).send({ message: 'Sin permiso' })
      }
      if (session.errorCategory) {
        server.log.info(`[recordings-preview] status_error sessionId=${sessionId} category=${session.errorCategory}`)
      }
      return reply.send({
        ok:            !session.errorCategory,
        status:        session.errorCategory ? 'error' : 'active',
        category:      session.errorCategory ?? null,
        message:       session.errorCategory ?? null,
        detail:        session.errorDetail ?? null,
        stderrTail:    (session.stderrTail ?? []).slice(-10).join(' | ').slice(0, 600) || null,
        hadFirstByte:  session.hadFirstByte ?? null,
        // legacy fields
        errorCategory: session.errorCategory ?? null,
        errorDetail:   session.errorDetail ?? null,
        strategy:      session.strategy,
        detectedCodec: session.detectedCodec,
      })
    }

    const failed = failedPreviewSessions.get(sessionId)
    if (failed && Date.now() <= failed.expiresAt) {
      if (failed.userId !== request.user.sub && request.user.role !== 'ADMIN') {
        return reply.status(403).send({ message: 'Sin permiso' })
      }
      server.log.info(`[recordings-preview] status_error sessionId=${sessionId} category=${failed.category} source=retained`)
      return reply.send({
        ok:            false,
        status:        'error',
        category:      failed.category,
        message:       failed.category,
        detail:        failed.detail,
        stderrTail:    failed.stderrTail || null,
        hadFirstByte:  failed.hadFirstByte,
        // legacy fields
        errorCategory: failed.category,
        errorDetail:   failed.detail,
      })
    }

    server.log.info(`[recordings-preview] status_not_found sessionId=${sessionId}`)
    return reply.status(404).send({ message: 'Sesión de preview no encontrada' })
  })

  // POST /api/recordings/diagnostics/playback — ADMIN. Diagnóstico POR ETAPAS de
  // cada estrategia: RTSP/SDP → decode → encode → mux fMP4, con matriz de
  // transporte (tcp/udp), video-only y variantes de fragmentación. Localiza el
  // punto EXACTO donde se detiene el flujo (no sólo "abrió/no abrió"). Resultados
  // SANITIZADOS (sin credenciales). Acepta {cameraId, recordingId} o
  // {cameraId, playbackURI[, requestedStart, requestedEnd]}.
  server.post('/diagnostics/playback', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const user = request.user
    const body = z.object({
      cameraId:       z.string().min(1),
      recordingId:    z.string().optional(),
      playbackURI:    z.string().optional(),
      // Opcionales: si hay playbackURI, la ventana se deriva de sus starttime/endtime.
      requestedStart: z.string().datetime().optional(),
      requestedEnd:   z.string().datetime().optional(),
      mode:           z.enum(['main', 'sub', 'auto']).optional(),
      // Hasta 45s para distinguir "NVR lento" (main tarda 13-15s, a veces más) de
      // "URI inválida" (400 inmediato). Permite probar 25/35/45s explícitamente.
      perStrategyTimeoutMs: z.number().int().min(2000).max(45000).optional(),
      // TASK 5 — matriz de transporte. Por defecto sólo tcp (no cambia el global).
      transports:     z.array(z.enum(['tcp', 'udp'])).nonempty().optional(),
      // TASK 6/7 — comparaciones diagnósticas sobre la mejor estrategia.
      videoOnly:      z.boolean().optional(),
      fmp4Variants:   z.boolean().optional(),
    }).parse(request.body)

    // No exigir recordingId cuando ya hay playbackURI. Sólo se rechaza si no hay
    // NINGUNO (el diagnóstico sería incompleto: sólo generated_main/sub).
    if (!body.recordingId && !body.playbackURI) {
      return reply.status(400).send({
        code: 'DIAGNOSTICS_INCOMPLETE_INPUT',
        message: 'Enviá recordingId o playbackURI: sin ellos no se pueden diagnosticar las estrategias nvr_original/normalized/rewritten.',
      })
    }

    const camera = await server.prisma.camera.findUnique({ where: { id: body.cameraId }, include: { nvr: true } })
    if (!camera?.nvr) return reply.status(404).send({ message: 'Cámara no encontrada' })
    const plainPass = decryptPass(camera.nvr.password)
    if (!plainPass) return reply.status(422).send({ message: 'No se pueden descifrar las credenciales del NVR' })

    let playbackURI = body.playbackURI ?? null
    let playbackUriSource: 'body' | 'recordingId' | 'none' = body.playbackURI ? 'body' : 'none'

    // Ventana solicitada: fechas explícitas > horas incrustadas en la playbackURI.
    // Con playbackURI ya NO hacen falta fechas separadas (TASK 2, formato B relajado).
    const uriTimes = playbackURI ? extractRtspPlaybackTimes(playbackURI) : { starttime: null, endtime: null }
    const startIso = body.requestedStart ?? (uriTimes.starttime ? hikTimestampToIso(uriTimes.starttime) : null)
    const endIso   = body.requestedEnd   ?? (uriTimes.endtime   ? hikTimestampToIso(uriTimes.endtime)   : null)
    if (!startIso || !endIso) {
      // Sólo puede faltar la ventana si vino recordingId sin fechas y sin playbackURI:
      // no hay forma de buscar el bloque en el NVR sin un rango temporal.
      return reply.status(400).send({
        code: 'DIAGNOSTICS_MISSING_WINDOW',
        message: 'Falta la ventana temporal: enviá requestedStart/requestedEnd, o una playbackURI con starttime/endtime.',
      })
    }
    const requestedStart = new Date(startIso)
    const requestedEnd   = new Date(endIso)

    // Resolver la playbackURI real por recordingId (buscar el bloque en el NVR).
    if (!playbackURI && body.recordingId) {
      try {
        const nvrWithPass = { ...camera.nvr, password: plainPass }
        const recs = await searchRecordings(nvrWithPass as any, camera.channel, requestedStart, requestedEnd)
        const match = recs.find((r: any) => r.id === body.recordingId)
          ?? recs.find((r: any) => new Date(r.startTime).getTime() <= requestedStart.getTime() && new Date(r.endTime).getTime() > requestedStart.getTime())
        if (match?.playbackURI) { playbackURI = match.playbackURI; playbackUriSource = 'recordingId' }
      } catch (e: any) {
        server.log.warn(`[recordings-diag] search_failed cameraId=${body.cameraId} err=${e?.message ?? 'unknown'}`)
      }
    }

    const diagDedup: Array<{ strategy: PlaybackBaseStrategy; duplicateOf: PlaybackBaseStrategy; urlFingerprint: string }> = []
    const plan = buildPlaybackAttemptPlan({
      playbackURI,
      channel: camera.channel,
      effectiveStart: requestedStart,
      end: requestedEnd,
      creds: { username: camera.nvr.username, password: plainPass, ipAddress: camera.nvr.ipAddress, rtspPort: camera.nvr.rtspPort },
      mode: body.mode ?? PLAYBACK_STREAM_MODE,
      dedupSink: diagDedup,
    })

    // Cobertura: qué estrategias se probaron y cuáles quedaron fuera (sin playbackURI).
    const NVR_STRATEGIES: PlaybackBaseStrategy[] = ['nvr_original', 'nvr_original_normalized', 'nvr_rewritten', 'nvr_rewritten_no_metadata']
    const testedStrategies = plan.map(p => p.strategy)
    const skippedStrategies = playbackURI ? [] : NVR_STRATEGIES.filter(s => !testedStrategies.includes(s))
    const diagnosticsCoverage = {
      playbackUriUsed: !!playbackURI, playbackUriSource,
      testedStrategies, skippedStrategies,
      dedupedStrategies: diagDedup,   // estrategias que colapsaron en otra (misma URL)
      complete: !!playbackURI,
    }

    // Reloj del NVR (bloqueante acá — es un diagnóstico ADMIN, no el hot path del
    // preview) para correlacionar el desfase horario con las horas RTSP probadas.
    const nvrClock = await getNvrSystemTime({ ...camera.nvr, password: plainPass } as any).catch(() => null)
    const nvrClockSanitized = nvrClock
      ? { timeMode: nvrClock.timeMode, localTime: nvrClock.localTime, timeZone: nvrClock.timeZone, utcTime: deriveNvrUtc(nvrClock.localTime) }
      : null
    // Ventana solicitada y el bloque que el NVR incrustó en la playbackURI.
    const recBlock = playbackURI ? extractRtspPlaybackTimes(playbackURI) : { starttime: null, endtime: null }
    const timeContext = {
      requestedStartUtc: requestedStart.toISOString(),
      requestedEndUtc:   requestedEnd.toISOString(),
      effectiveStartUtc: requestedStart.toISOString(),
      effectiveEndUtc:   requestedEnd.toISOString(),
      recordingBlockStart: recBlock.starttime, recordingBlockEnd: recBlock.endtime,
      windowSource: body.requestedStart ? 'explicit' : (uriTimes.starttime ? 'playbackURI' : 'none'),
      nvrClock: nvrClockSanitized,
    }

    await AuditAction(server.prisma, user.sub, 'VIEW_RECORDING', body.cameraId, request, {
      action: 'diagnostics_playback', recordingId: body.recordingId ?? null, mode: body.mode ?? PLAYBACK_STREAM_MODE,
    }).catch(() => {})

    // Mismo límite de concurrencia por NVR que el preview normal; siempre se libera.
    const releaseNvrSlot = await acquireNvrPreviewSlot(camera.nvr.id, -1, (m) => server.log.info(m))
    if (!releaseNvrSlot) {
      return reply.status(503).send({ code: 'NVR_BUSY', message: 'El NVR no tiene sesiones de reproducción libres para diagnosticar ahora.' })
    }

    const timeoutMs   = body.perStrategyTimeoutMs ?? 25000
    const transports: RtspTransport[] = body.transports ?? ['tcp']
    const primaryTransport = transports[0]
    const results: Array<Record<string, unknown>> = []
    const extraProbes: Array<Record<string, unknown>> = []  // matriz transporte / video-only / fmp4
    let stopPoint: string | null = null   // la etapa donde se detiene la MEJOR estrategia
    let primaryPreferredTransport: RtspTransport | null = null  // transporte que funcionó (matriz)

    // Construye la evidencia por etapas y clasifica el punto EXACTO de detención.
    const buildEvidence = (
      probe: Awaited<ReturnType<typeof stageProbe>>,
      mux: Awaited<ReturnType<typeof stageEncodeMux>>,
      decode: Awaited<ReturnType<typeof stageDecode>> | null,
    ): StageEvidence => ({
      inputOpened: probe.rtspOpened || mux.inputOpened || (decode?.inputOpened ?? false),
      videoStreamPresent: (probe.videoCodec != null) || (mux.videoCodec != null),
      // Un frame decodificado implica que llegaron paquetes de video (proxy honesto).
      firstVideoPacketMs: decode?.firstDecodedFrameMs ?? mux.firstDecodedFrameMs ?? null,
      firstDecodedFrameMs: decode?.firstDecodedFrameMs ?? mux.firstDecodedFrameMs ?? null,
      firstEncodedFrameMs: mux.firstEncodedFrameMs,
      firstMuxedByteMs: mux.firstMuxedByteMs,
      bytesAfterKill: false,   // en el diagnóstico el byte se mide en vivo (no post-kill)
      timedOut: mux.timedOut,
      stderr: `${probe.stderrSample}\n${mux.stderrSample}`,
    })

    try {
      let winnerStrategy: PlaybackBaseStrategy | null = null
      let winnerAttempt: PlaybackAttempt | null = null
      for (const attempt of plan) {
        const rtspTimes = extractRtspPlaybackTimes(attempt.masked)
        // Etapa 1 — RTSP/SDP (ffprobe).
        const probe = await stageProbe(attempt.url, primaryTransport, Math.min(timeoutMs, 15000))
        // Etapas encode+mux (lo que hace el preview real).
        const mux = await stageEncodeMux(attempt.url, primaryTransport, timeoutMs)
        // Si el mux no produjo byte pero SÍ hay video en el SDP, correr decode-only
        // para separar "no llegan paquetes / no decodifica" de "no muxea".
        let decode: Awaited<ReturnType<typeof stageDecode>> | null = null
        if (mux.firstMuxedByteMs == null && (probe.videoCodec != null || mux.videoCodec != null)) {
          decode = await stageDecode(attempt.url, primaryTransport, Math.min(timeoutMs, 15000))
        }
        const evidence = buildEvidence(probe, mux, decode)
        const stageResult = classifyStageFailure(evidence)
        const ok = stageResult === 'STAGE_OK'
        results.push({
          strategy: attempt.strategy, track: attempt.track, respectsPlayhead: attempt.respectsPlayhead,
          transport: primaryTransport,
          sanitizedUri: attempt.masked, urlFingerprint: urlFingerprint(attempt.masked),
          rtspStart: rtspTimes.starttime, rtspEnd: rtspTimes.endtime,
          timeoutMs,
          // ── Evidencia por ETAPAS ──
          rtspOpened: probe.rtspOpened, streamsDetected: probe.streamsDetected,
          videoCodec: probe.videoCodec ?? mux.videoCodec, audioCodec: probe.audioCodec ?? mux.audioCodec,
          width: probe.width, height: probe.height, fps: probe.fps,
          firstVideoPacketMs: evidence.firstVideoPacketMs,
          firstDecodedFrameMs: evidence.firstDecodedFrameMs,
          firstEncodedFrameMs: evidence.firstEncodedFrameMs,
          firstMuxedByteMs: evidence.firstMuxedByteMs,
          producedBytes: mux.bytes, muxFrames: mux.frames, muxOutTimeMs: mux.outTimeMs,
          // ── Cómo terminó ──
          exitCode: mux.exitCode, signal: mux.signal, timedOut: mux.timedOut, durationMs: mux.elapsedMs,
          stopPoint: stageResult,            // categoría GRANULAR (TASK 11)
          result: ok ? 'success' : 'error',
          stderrSample: mux.stderrSample.slice(0, 800),
        })
        server.log.info(
          `[recordings-diag] staged_result cameraId=${body.cameraId} strategy=${attempt.strategy}` +
          ` transport=${primaryTransport} track=${attempt.track} timeoutMs=${timeoutMs}` +
          ` rtspOpened=${probe.rtspOpened} video=${probe.videoCodec ?? mux.videoCodec ?? 'none'}` +
          ` firstVideoPacketMs=${evidence.firstVideoPacketMs ?? 'none'} firstDecodedFrameMs=${evidence.firstDecodedFrameMs ?? 'none'}` +
          ` firstEncodedFrameMs=${evidence.firstEncodedFrameMs ?? 'none'} firstMuxedByteMs=${evidence.firstMuxedByteMs ?? 'none'}` +
          ` stopPoint=${stageResult} urlFingerprint=${urlFingerprint(attempt.masked)}`
        )
        if (ok) { winnerStrategy = attempt.strategy; winnerAttempt = attempt; break }
        if (!stopPoint) stopPoint = stageResult
      }

      // La MEJOR estrategia para las comparaciones extra: la ganadora, o la primera
      // que al menos abrió el RTSP (para no diagnosticar sobre una URI muerta).
      const bestAttempt = winnerAttempt
        ?? plan.find(a => (results.find(r => r.strategy === a.strategy) as any)?.rtspOpened)
        ?? plan[0]

      // TASK 5 — matriz de transporte: probar los transportes restantes sobre la
      // mejor estrategia (no cambia el transporte global; sólo diagnostica).
      if (bestAttempt) {
        for (const tr of transports.slice(1)) {
          const mux = await stageEncodeMux(bestAttempt.url, tr, timeoutMs)
          const ev = buildEvidence(await stageProbe(bestAttempt.url, tr, Math.min(timeoutMs, 15000)), mux, null)
          const sp = classifyStageFailure(ev)
          extraProbes.push({ kind: 'transport_matrix', transport: tr, strategy: bestAttempt.strategy,
            firstMuxedByteMs: mux.firstMuxedByteMs, firstEncodedFrameMs: mux.firstEncodedFrameMs,
            timedOut: mux.timedOut, exitCode: mux.exitCode, stopPoint: sp, result: sp === 'STAGE_OK' ? 'success' : 'error' })
          server.log.info(`[recordings-diag] transport_matrix cameraId=${body.cameraId} strategy=${bestAttempt.strategy} transport=${tr} firstMuxedByteMs=${mux.firstMuxedByteMs ?? 'none'} stopPoint=${sp}`)
          if (sp === 'STAGE_OK' && !winnerStrategy) { winnerStrategy = bestAttempt.strategy; primaryPreferredTransport = tr }
        }

        // TASK 6 — video-only H.264: aísla si el audio AAC/G.711 o la sync A/V bloquean.
        if (body.videoOnly) {
          const mux = await stageEncodeMux(bestAttempt.url, primaryTransport, timeoutMs, { videoOnly: true })
          extraProbes.push({ kind: 'video_only_h264', transport: primaryTransport, strategy: bestAttempt.strategy,
            firstMuxedByteMs: mux.firstMuxedByteMs, firstEncodedFrameMs: mux.firstEncodedFrameMs,
            timedOut: mux.timedOut, exitCode: mux.exitCode,
            producedBytes: mux.bytes, result: mux.firstMuxedByteMs != null ? 'success' : 'error',
            note: 'comparar con encode_mux_fmp4 (video+audio): si aquí SÍ sale byte, el problema es audio/sync A/V' })
          server.log.info(`[recordings-diag] video_only cameraId=${body.cameraId} strategy=${bestAttempt.strategy} firstMuxedByteMs=${mux.firstMuxedByteMs ?? 'none'} bytes=${mux.bytes}`)
        }

        // TASK 7 — variantes de fragmentación fMP4 (GOP corto / frag_duration).
        if (body.fmp4Variants) {
          const variants: Array<{ label: string; fragArgs: string[] }> = [
            { label: 'frag_default', fragArgs: ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'] },
            { label: 'frag_duration_500ms', fragArgs: ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-g', '25', '-flush_packets', '1'] },
            { label: 'frag_every_frame', fragArgs: ['-movflags', 'frag_keyframe+empty_moov+default_base_moof+frag_every_frame', '-flush_packets', '1'] },
          ]
          for (const v of variants) {
            const mux = await stageEncodeMux(bestAttempt.url, primaryTransport, timeoutMs, { fragArgs: v.fragArgs, label: v.label })
            extraProbes.push({ kind: 'fmp4_variant', variant: v.label, transport: primaryTransport, strategy: bestAttempt.strategy,
              firstMuxedByteMs: mux.firstMuxedByteMs, firstEncodedFrameMs: mux.firstEncodedFrameMs,
              producedBytes: mux.bytes, timedOut: mux.timedOut, exitCode: mux.exitCode,
              result: mux.firstMuxedByteMs != null ? 'success' : 'error' })
            server.log.info(`[recordings-diag] fmp4_variant cameraId=${body.cameraId} strategy=${bestAttempt.strategy} variant=${v.label} firstMuxedByteMs=${mux.firstMuxedByteMs ?? 'none'} bytes=${mux.bytes}`)
          }
        }
      }

      // TASK 5 — persistir preferencia (estrategia + transporte) si algo funcionó.
      if (winnerStrategy) {
        const prof = nvrPlaybackProfiles.get(camera.nvr.id) ?? {}
        const wAttempt = plan.find(a => a.strategy === winnerStrategy)
        if (wAttempt?.respectsPlayhead) prof.preferredBaseStrategy = winnerStrategy
        prof.preferredTransport = primaryPreferredTransport ?? primaryTransport
        prof.lastVerifiedAt = Date.now()
        nvrPlaybackProfiles.set(camera.nvr.id, prof)
        server.log.info(`[recordings-diag] profile_saved nvrId=${camera.nvr.id} preferredBaseStrategy=${prof.preferredBaseStrategy ?? 'none'} preferredTransport=${prof.preferredTransport}`)
      }
    } finally {
      releaseNvrSlot()
    }

    const winner = results.find(x => x.result === 'success')
    server.log.info(
      `[recordings-diag] playback cameraId=${body.cameraId} nvrId=${camera.nvr.id}` +
      ` winner=${winner ? winner.strategy : 'none'} stopPoint=${stopPoint ?? 'n/a'} tried=${results.length}` +
      ` coverageComplete=${diagnosticsCoverage.complete}` +
      ` nvrTimezone=${nvrClockSanitized?.timeZone ?? 'unknown'} nvrLocalTime=${nvrClockSanitized?.localTime ?? 'unknown'}`
    )
    return reply.send({
      cameraId: body.cameraId, nvrId: camera.nvr.id, channel: camera.channel,
      mode: body.mode ?? PLAYBACK_STREAM_MODE,
      stopPoint,                       // dónde se detiene la mejor estrategia (resumen)
      timeContext, diagnosticsCoverage, results, extraProbes,
    })
  })

  // GET /api/recordings/diagnostics/nvr-time — ADMIN. Reloj/zona del NVR
  // (/ISAPI/System/time) SANITIZADO. Para diagnosticar el desfase horario de
  // reproducción sin exponer credenciales ni tocar producción.
  server.get('/diagnostics/nvr-time', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const q = z.object({ cameraId: z.string().min(1) }).parse(request.query)
    const camera = await server.prisma.camera.findUnique({ where: { id: q.cameraId }, include: { nvr: true } })
    if (!camera?.nvr) return reply.status(404).send({ message: 'Cámara no encontrada' })
    const plainPass = decryptPass(camera.nvr.password)
    if (!plainPass) return reply.status(422).send({ message: 'No se pueden descifrar las credenciales del NVR' })

    const clock = await getNvrSystemTime({ ...camera.nvr, password: plainPass } as any).catch(() => null)
    if (!clock) {
      return reply.status(502).send({ code: 'NVR_TIME_UNAVAILABLE', message: 'El NVR no respondió /ISAPI/System/time.' })
    }
    const utcTime = deriveNvrUtc(clock.localTime)
    server.log.info(
      `[recordings-diag] nvr_time cameraId=${q.cameraId} nvrId=${camera.nvr.id}` +
      ` timeMode=${clock.timeMode} timeZone=${clock.timeZone} localTime=${clock.localTime}` +
      ` utcTime=${utcTime ?? 'unknown(no offset in localTime)'}`
    )
    await AuditAction(server.prisma, request.user.sub, 'VIEW_RECORDING', q.cameraId, request, {
      action: 'diagnostics_nvr_time',
    }).catch(() => {})
    return reply.send({
      cameraId: q.cameraId, nvrId: camera.nvr.id,
      timeMode: clock.timeMode, localTime: clock.localTime, timeZone: clock.timeZone,
      utcTime,   // null si el localTime del NVR no declara offset (no se asume)
      serverUtcTime: new Date(Date.now()).toISOString(),
    })
  })

  // DELETE /api/recordings/preview/:sessionId — Stop FFmpeg, remove session.
  // Idempotent: deleting an unknown/expired/already-deleted session is OK.
  server.delete('/preview/:sessionId', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = previewSessions.get(sessionId)
    if (!session) {
      return reply.send({ ok: true, alreadyDeleted: true })
    }
    if (session.userId !== request.user.sub && request.user.role !== 'ADMIN') {
      return reply.status(403).send({ message: 'Sin permiso' })
    }
    // Preserve failure info so a status query arriving after this DELETE
    // still gets the real category
    retainFailedPreview(sessionId, session, (m) => server.log.info(m))
    // (12) Teardown ORDENADO: closing → bloquear GET → disposers → terminar TODOS
    // los intentos → confirmar sin vivos (o cleanup_pending). No basta con matar
    // vodProcess (dejaba huérfanos los FFmpeg de intentos superados/en vuelo).
    terminatePreviewSession(sessionId, session, 'delete_endpoint', (m) => server.log.info(m))
    return reply.send({ ok: true })
  })
}
