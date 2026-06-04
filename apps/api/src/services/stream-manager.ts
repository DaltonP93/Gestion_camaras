// Stream Manager — controla sesiones de viewers y libera streams sin uso
// Los streams en MediaMTX ya tienen sourceOnDemand: true (se conectan solos cuando hay requests HLS)
// Este manager trackea quién está mirando para informar al frontend y aplicar límites.
import type { FastifyInstance } from 'fastify'
import type { ChildProcess } from 'child_process'
import { getStreamPath, getHlsUrl, getWebRtcUrl, publishStream, removeStream, getStreamStatus, publishTranscodedStream, getTranscodedStreamPath, isTranscodingEnabled, getFfmpegCapabilities, waitForHlsReady, spawnTranscodeProcess, stopTranscodeProcess, isTranscodeProcessAlive, getTranscodeStderr, getStreamDetails, getActiveTranscodesList, getTranscodeRawStderr, getTranscodeRtspMasked } from './stream'
import type { NVR, Camera } from '@prisma/client'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// Límites configurables
const MAX_STREAMS_PER_USER   = Number(process.env.MAX_STREAMS_PER_USER   || 32)
const MAX_STREAMS_GLOBAL     = Number(process.env.MAX_STREAMS_GLOBAL     || 50)
const STREAM_IDLE_TIMEOUT    = Number(process.env.STREAM_IDLE_TIMEOUT    || 90)  // segundos
export const MAX_TRANSCODE_SESSIONS = Number(process.env.MAX_TRANSCODE_SESSIONS || 2)
// How long to wait for HLS manifest after FFmpeg starts (default 60s to allow first segment)
const TRANSCODE_HLS_READY_TIMEOUT_MS = Number(process.env.TRANSCODE_HLS_READY_TIMEOUT_MS || 60_000)

// Health statuses that unconditionally block all stream requests
// (USING_MAIN_STREAM and CODEC_UNSUPPORTED_HEVC are handled by codec redirect logic instead)
const BLOCKED_HEALTH_STATUSES = new Set([
  'RTSP_SUB_NOT_FOUND',
  'AUTH_FAILED',
  'OFFLINE',
])

// Per-path in-flight transcode state — prevents duplicate FFmpeg startups
// during the waitForHlsReady window (heartbeat can fire multiple times during 10s wait).
// Key: streamPath (e.g. nvr_xxx_ch09_main_h264)
interface TranscodeInFlight {
  state: 'starting' | 'ready' | 'failed'
  promise: Promise<boolean>        // resolves true=ready, false=failed
  resolve: (v: boolean) => void    // called by the starter when done
}
const transcodeInFlight = new Map<string, TranscodeInFlight>()

// ─── Auto-restart supervisor state ──────────────────────────────────────────
// Tracks restart history per stream path and source info needed to re-spawn FFmpeg.

interface TranscodeRestartInfo {
  count:          number       // restarts performed within current window
  windowStart:    number       // ms — window resets if >2 min has passed since last restart
  lastExitCode:   number | null
  lastExitReason: string       // e.g. 'RTSP_INPUT_EOF', 'exit_224', 'sig_SIGKILL'
  lastExitAt:     number       // ms timestamp
}

interface TranscodeSourceRef {
  nvr:      any               // NVR with decrypted password — needed for FFmpeg restart
  camera:   any
  userId:   string
  cameraId: string
}

const transcodeRestarts   = new Map<string, TranscodeRestartInfo>()
const transcodeSourceInfo = new Map<string, TranscodeSourceRef>()
const transcodeLastActivity  = new Map<string, number>()  // ms — last viewer heartbeat for this path
const SUPERVISOR_GRACE_MS    = 60_000  // restart if viewer was active within this window

const SUPERVISOR_MAX_RESTARTS = 3
const SUPERVISOR_WINDOW_MS    = 2 * 60_000          // 2 minutes
const SUPERVISOR_BACKOFFS     = [2_000, 5_000, 10_000] as const

// Reasons that explicitly allow FFmpeg to be killed when stopping a main_h264 session.
// Any other reason (e.g. 'retry', 'hls_error') keeps FFmpeg alive so the next startStream
// call can detect the live process via isTranscodeProcessAlive and reuse it.
const TRANSCODE_KILL_REASONS = new Set([
  'exit_focus', 'switch_to_sub', 'cleanup_unmount', 'idle_timeout',
  'force_stop', 'logout', 'session_cleanup', 'viewport_change',
  'layout_change', 'nvr_change', 'page_change', 'stop_all',
  'exit_fullscreen',
])

function getActiveTranscodeCount(): number {
  // Count registered sessions + paths currently starting (not yet registered)
  const registered = Array.from(sessions.values()).filter(s => s.streamType === 'main_h264').length
  const starting   = Array.from(transcodeInFlight.values()).filter(f => f.state === 'starting').length
  return registered + starting
}

interface StreamSession {
  cameraId: string
  userId: string
  viewId: string                  // identificador de pestaña/view del navegador
  streamType: 'sub' | 'main' | 'main_h264'  // sub=grid H264, main=HD (puede HEVC), main_h264=transcodificado
  streamPath: string
  startedAt: Date
  lastHeartbeat: Date             // actualizado por touchSession o touchView
}

// En memoria — se pierde al reiniciar (intencional: el frontend reconecta)
// key: `${userId}:${cameraId}:${streamType}` — permite sub y main simultáneos
const sessions = new Map<string, StreamSession>()

// Per-view tracking: qué cámaras pertenecen a qué view (solo sub streams — main es explícito)
const viewCameras   = new Map<string, Set<string>>() // key: `${userId}:${viewId}`
const viewHeartbeat = new Map<string, Date>()         // key: `${userId}:${viewId}` → last heartbeat

function sessionKey(userId: string, cameraId: string, streamType: 'sub' | 'main' | 'main_h264' = 'sub') {
  return `${userId}:${cameraId}:${streamType}`
}

function vKey(userId: string, viewId: string) {
  return `${userId}:${viewId}`
}

export function getActiveSessions(): StreamSession[] {
  return Array.from(sessions.values())
}

export function getSessionsForUser(userId: string): StreamSession[] {
  return Array.from(sessions.values()).filter(s => s.userId === userId)
}

// Tocar una sola sesión (backward compat para touch-stream endpoint individual)
export function touchSession(userId: string, cameraId: string, streamType: 'sub' | 'main' | 'main_h264' = 'sub') {
  const key = sessionKey(userId, cameraId, streamType)
  const s = sessions.get(key)
  if (s) {
    s.lastHeartbeat = new Date()
    if (streamType === 'main_h264') transcodeLastActivity.set(s.streamPath, Date.now())
  }
}

// Tocar todas las sesiones de un view de una vez — toca sub, main y main_h264
// para evitar que el idle cleanup mate streams HD/transcodificados durante heartbeat
export function touchView(userId: string, viewId: string) {
  const vk = vKey(userId, viewId)
  viewHeartbeat.set(vk, new Date())
  const vCams = viewCameras.get(vk)
  if (!vCams) return
  const now = new Date()
  for (const cameraId of vCams) {
    for (const st of ['sub', 'main', 'main_h264'] as const) {
      const s = sessions.get(sessionKey(userId, cameraId, st))
      if (s) {
        s.lastHeartbeat = now
        if (st === 'main_h264') transcodeLastActivity.set(s.streamPath, Date.now())
      }
    }
  }
}

// ─── Transcode supervisor ────────────────────────────────────────────────────
// When FFmpeg exits unexpectedly and a session is still active, this supervisor
// automatically restarts it with exponential backoff (2s/5s/10s).
// After SUPERVISOR_MAX_RESTARTS in a 2-minute window it gives up and marks the
// session failed so the frontend shows a permanent error instead of looping.

function attachTranscodeSupervisor(
  streamPath: string,
  proc: ChildProcess,
  sourceRef: TranscodeSourceRef,
): void {
  proc.once('exit', (code, signal) => {
    const stderr     = getTranscodeRawStderr(streamPath)
    const isEof      = stderr.includes('End of file') || stderr.includes('Failed reading RTSP data')
    const exitReason = isEof ? 'RTSP_INPUT_EOF'
      : code !== null ? `exit_${code}`
      : `sig_${signal}`
    void runTranscodeSupervisor(streamPath, sourceRef, code, signal, exitReason)
  })
}

async function runTranscodeSupervisor(
  streamPath: string,
  sourceRef: TranscodeSourceRef,
  exitCode: number | null,
  _exitSignal: NodeJS.Signals | null,
  exitReason: string,
): Promise<void> {
  const transcodeKey = sessionKey(sourceRef.userId, sourceRef.cameraId, 'main_h264')

  const hasSession    = !!sessions.get(transcodeKey)
  const inFlightState = transcodeInFlight.get(streamPath)?.state
  const lastActivity  = transcodeLastActivity.get(streamPath) ?? 0
  const recentViewer  = (Date.now() - lastActivity) < SUPERVISOR_GRACE_MS
  if (!hasSession && inFlightState !== 'starting' && !recentViewer) {
    console.info(
      `[supervisor] skip path=${streamPath} reason=no_active_session` +
      ` inFlight=${inFlightState ?? 'none'} lastActivityMsAgo=${Date.now() - lastActivity}`
    )
    transcodeRestarts.delete(streamPath)
    return
  }

  const now  = Date.now()
  let info   = transcodeRestarts.get(streamPath)

  if (!info || (now - info.windowStart) > SUPERVISOR_WINDOW_MS) {
    info = { count: 0, windowStart: now, lastExitCode: exitCode, lastExitReason: exitReason, lastExitAt: now }
  } else {
    info.lastExitCode   = exitCode
    info.lastExitReason = exitReason
    info.lastExitAt     = now
  }
  transcodeRestarts.set(streamPath, info)

  if (info.count >= SUPERVISOR_MAX_RESTARTS) {
    console.warn(
      `[supervisor] exhausted path=${streamPath} count=${info.count}/${SUPERVISOR_MAX_RESTARTS}` +
      ` reason=${exitReason} — dropping session`
    )
    sessions.delete(transcodeKey)
    transcodeInFlight.set(streamPath, { state: 'failed', promise: Promise.resolve(false), resolve: () => {} })
    return
  }

  const backoffMs = SUPERVISOR_BACKOFFS[info.count] ?? 10_000
  info.count++
  transcodeRestarts.set(streamPath, info)

  console.info(
    `[supervisor] restart_pending path=${streamPath} reason=${exitReason}` +
    ` attempt=${info.count}/${SUPERVISOR_MAX_RESTARTS} backoffMs=${backoffMs}`
  )

  await new Promise(r => setTimeout(r, backoffMs))

  const hasSessionAfter    = !!sessions.get(transcodeKey)
  const inFlightStateAfter = transcodeInFlight.get(streamPath)?.state
  const lastActivityAfter  = transcodeLastActivity.get(streamPath) ?? 0
  const recentViewerAfter  = (Date.now() - lastActivityAfter) < SUPERVISOR_GRACE_MS
  if (!hasSessionAfter && inFlightStateAfter !== 'starting' && !recentViewerAfter) {
    console.info(
      `[supervisor] restart_cancelled path=${streamPath} reason=session_gone_after_backoff` +
      ` inFlight=${inFlightStateAfter ?? 'none'} lastActivityMsAgo=${Date.now() - lastActivityAfter}`
    )
    return
  }

  if (isTranscodeProcessAlive(streamPath)) {
    console.info(`[supervisor] restart_skipped path=${streamPath} reason=process_already_alive`)
    return
  }

  const proc = spawnTranscodeProcess(sourceRef.nvr, sourceRef.camera, streamPath)
  if (!proc) {
    console.error(`[supervisor] restart_spawn_failed path=${streamPath} attempt=${info.count}`)
    sessions.delete(transcodeKey)
    transcodeInFlight.set(streamPath, { state: 'failed', promise: Promise.resolve(false), resolve: () => {} })
    return
  }

  console.info(`[supervisor] restarted path=${streamPath} pid=${proc.pid ?? 'pending'} attempt=${info.count}`)
  transcodeLastActivity.set(streamPath, Date.now())

  const existing = transcodeInFlight.get(streamPath)
  if (existing && existing.state !== 'ready') {
    existing.state = 'ready'
  } else if (!existing) {
    transcodeInFlight.set(streamPath, { state: 'ready', promise: Promise.resolve(true), resolve: () => {} })
  }

  attachTranscodeSupervisor(streamPath, proc, sourceRef)
}

// Iniciar stream para un usuario
interface StreamError {
  code: string
  message: string
  details?: string
}

const HEALTH_STATUS_ERRORS: Record<string, StreamError> = {
  RTSP_SUB_NOT_FOUND:    { code: 'RTSP_SUB_NOT_FOUND',    message: 'Substream RTSP no disponible' },
  CODEC_UNSUPPORTED_HEVC:{ code: 'CODEC_UNSUPPORTED_HEVC', message: 'Codec HEVC/H.265 no compatible para reproducción web' },
  AUTH_FAILED:           { code: 'AUTH_FAILED',            message: 'Credenciales inválidas en cámara' },
  OFFLINE:               { code: 'OFFLINE',                message: 'Cámara offline' },
  RTSP_MAIN_NOT_FOUND:   { code: 'RTSP_MAIN_NOT_FOUND',   message: 'Stream RTSP principal no disponible' },
  USING_MAIN_STREAM:     { code: 'RTSP_SUB_NOT_FOUND',    message: 'Substream no disponible — doble clic para ver en pantalla completa' },
}

export async function startStream(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
  viewId?: string,
  streamType: 'sub' | 'main' | 'main_h264' = 'sub',
): Promise<{ hlsUrl: string; webrtcUrl: string; streamPath: string; transcoded?: boolean; error?: StreamError; warning?: StreamError }> {
  // Buscar cámara en DB con NVR
  const camera = await server.prisma.camera.findUnique({
    where: { id: cameraId },
    include: { nvr: true },
  })

  if (!camera || !camera.nvr) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_NOT_FOUND', message: 'Cámara no encontrada' } }
  }

  if (!camera.active) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_DISABLED', message: 'Cámara desactivada' } }
  }

  if ((camera as any).online === false) {
    console.info(`[startStream] skip offline cameraId=${cameraId} reason=camera_online_false`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_OFFLINE', message: 'Cámara offline' } }
  }

  const rtspSubOk  = (camera as any).rtspSubOk  as boolean | null
  const rtspMainOk = (camera as any).rtspMainOk as boolean | null
  if (rtspSubOk === false && rtspMainOk === false) {
    console.info(`[startStream] skip offline cameraId=${cameraId} reason=rtsp_both_down`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'CAMERA_OFFLINE', message: 'Cámara offline — sin RTSP disponible' } }
  }

  const healthStatus = (camera as any).streamHealthStatus as string | undefined
  const mainCodecStr = ((camera as any).mainCodec || '').toLowerCase()
  const subCodecStr  = ((camera as any).subCodec  || '').toLowerCase()
  const mainIsH264   = !!(mainCodecStr && (mainCodecStr.includes('h264') || mainCodecStr.includes('avc') || mainCodecStr.includes('h.264')))
  const mainIsHevc   = !!(mainCodecStr && (mainCodecStr.includes('hevc') || mainCodecStr.includes('h265') || mainCodecStr.includes('h.265') || mainCodecStr.includes('hvc1')))
  const subIsHevc    = !!(subCodecStr  && (subCodecStr.includes('hevc')  || subCodecStr.includes('h265')  || subCodecStr.includes('h.265')  || subCodecStr.includes('hvc1')))
  const ch = (camera as any).channel

  // ── Determine effective stream type ─────────────────────────────────────
  let effectiveType: 'sub' | 'main' | 'main_h264' = streamType

  if (streamType === 'main') {
    if (mainIsHevc) {
      if (!isTranscodingEnabled()) {
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'CODEC_UNSUPPORTED_HEVC', message: 'El flujo principal es H.265/HEVC. Configura ENABLE_HEVC_TRANSCODING=true para habilitar transcodificación.' } }
      }
      console.info(`[transcode] requested cameraId=${cameraId} ch=${ch} streamType=main codec=${mainCodecStr}`)
      effectiveType = 'main_h264'
    }
  } else if (streamType === 'sub') {
    // Sub HEVC: redirect to main H264 if available, otherwise transcode, otherwise error
    if (subIsHevc) {
      if (mainIsH264 && rtspMainOk !== false) {
        effectiveType = 'main'
        console.info(`[stream] sub HEVC redirect → main cameraId=${cameraId} ch=${ch} subCodec=${subCodecStr} mainCodec=${mainCodecStr}`)
      } else if (isTranscodingEnabled()) {
        console.info(`[transcode] requested cameraId=${cameraId} ch=${ch} streamType=sub reason=sub_hevc`)
        effectiveType = 'main_h264'
      } else {
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'CODEC_UNSUPPORTED_HEVC', message: 'Sub stream en H.265/HEVC. Habilita ENABLE_HEVC_TRANSCODING=true para transcodificar.' } }
      }
    }
    // Sub failed but main H264 works (USING_MAIN_STREAM status) — redirect to main
    else if (healthStatus === 'USING_MAIN_STREAM' && mainIsH264 && rtspMainOk !== false) {
      effectiveType = 'main'
      console.info(`[stream] USING_MAIN_STREAM redirect → main cameraId=${cameraId} ch=${ch} mainCodec=${mainCodecStr}`)
    }
  }

  // ── Transcoded stream (main_h264) ──────────────────────────────────────
  if (effectiveType === 'main_h264') {
    if (!isTranscodingEnabled()) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=HEVC_DISABLED`)
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'TRANSCODING_DISABLED', message: 'La transcodificación HEVC no está habilitada. Configura ENABLE_HEVC_TRANSCODING=true.' } }
    }
    if (!getFfmpegCapabilities().available) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=FFMPEG_NOT_AVAILABLE`)
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'MEDIA_SERVER_ERROR', message: 'FFmpeg no disponible en el servidor.' } }
    }

    const transcodeKey = sessionKey(userId, cameraId, 'main_h264')
    const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
    const streamPath = getTranscodedStreamPath(nvr as any, camera as any)

    // ── 1. Reuse already-registered session ──────────────────
    const existingSession = sessions.get(transcodeKey)
    if (existingSession) {
      existingSession.lastHeartbeat = new Date()
      if (viewId) existingSession.viewId = viewId
      transcodeLastActivity.set(existingSession.streamPath, Date.now())
      console.info(`[userLimit] reuse existing cameraId=${cameraId} streamType=main_h264`)
      return { hlsUrl: getHlsUrl(existingSession.streamPath), webrtcUrl: getWebRtcUrl(existingSession.streamPath), streamPath: existingSession.streamPath, transcoded: true }
    }

    // ── 2. If this path is already starting, await it ────────
    // Prevents duplicate FFmpeg processes when heartbeat fires during
    // the 10-12s waitForHlsReady window.
    const inFlight = transcodeInFlight.get(streamPath)
    if (inFlight?.state === 'starting') {
      console.info(`[transcode] awaiting in-progress cameraId=${cameraId} path=${streamPath}`)
      const ready = await inFlight.promise
      if (ready) {
        const s = sessions.get(transcodeKey)
        if (s) {
          s.lastHeartbeat = new Date()
          return { hlsUrl: getHlsUrl(s.streamPath), webrtcUrl: getWebRtcUrl(s.streamPath), streamPath: s.streamPath, transcoded: true }
        }
      }
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'TRANSCODE_NOT_READY', message: 'El stream transcodificado no pudo iniciar. Intenta de nuevo.' } }
    }

    // Clear failed state so the caller can retry
    if (inFlight?.state === 'failed') transcodeInFlight.delete(streamPath)

    // ── 2b. Reuse live FFmpeg even if session was cleared ────────
    // Happens when stopStream was called with a non-kill reason (e.g. 'retry', 'hls_error')
    // which removed the session but kept FFmpeg running. Re-register the session and return
    // the existing URL immediately without spawning a new process.
    if (isTranscodeProcessAlive(streamPath)) {
      console.info(`[transcode] reuse_live_process path=${streamPath} cameraId=${cameraId} — session cleared but FFmpeg alive`)
      const effectiveViewId0 = viewId || 'default'
      sessions.set(transcodeKey, {
        cameraId, userId, viewId: effectiveViewId0, streamType: 'main_h264',
        streamPath, startedAt: new Date(), lastHeartbeat: new Date(),
      })
      transcodeLastActivity.set(streamPath, Date.now())
      // Supervisor is still attached from the original spawn — no need to re-attach.
      transcodeInFlight.set(streamPath, { state: 'ready', promise: Promise.resolve(true), resolve: () => {} })
      return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
    }

    // ── 3. Check limits (count starting + registered) ────────
    const activeTrans = getActiveTranscodeCount()
    if (activeTrans >= MAX_TRANSCODE_SESSIONS) {
      console.warn(`[transcode] reject cameraId=${cameraId} reason=MAX_TRANSCODE_SESSIONS active=${activeTrans}/${MAX_TRANSCODE_SESSIONS}`)
      return { hlsUrl: '', webrtcUrl: '', streamPath: '',
        error: { code: 'TRANSCODE_LIMIT_REACHED', message: `Límite de transcodificaciones alcanzado (máx ${MAX_TRANSCODE_SESSIONS})` } }
    }
    if (sessions.size >= MAX_STREAMS_GLOBAL) {
      return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'STREAM_LIMIT_GLOBAL', message: 'Límite global de streams alcanzado' } }
    }

    // ── 4. Start new transcode with in-flight guard ──────────
    let resolveInFlight!: (v: boolean) => void
    const readyPromise = new Promise<boolean>(r => { resolveInFlight = r })
    transcodeInFlight.set(streamPath, { state: 'starting', promise: readyPromise, resolve: resolveInFlight })

    try {
      // Register passive RTSP receiver path in MediaMTX (no runOnDemand)
      const published = await publishTranscodedStream(nvr as any, camera as any)
      if (!published) {
        transcodeInFlight.set(streamPath, { state: 'failed', promise: readyPromise, resolve: resolveInFlight })
        resolveInFlight(false)
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'MEDIA_SERVER_ERROR', message: 'Error al registrar path transcodificado en MediaMTX' } }
      }

      // Spawn FFmpeg in the API container — MediaMTX container doesn't have FFmpeg
      // spawnTranscodeProcess returns null if password is empty or RTSP URL is invalid.
      // The spawn_abort log in stream.ts explains the reason; show it in the error detail too.
      const proc = spawnTranscodeProcess(nvr as any, camera as any, streamPath)
      if (!proc) {
        transcodeInFlight.set(streamPath, { state: 'failed', promise: readyPromise, resolve: resolveInFlight })
        resolveInFlight(false)
        console.error(`[transcode] spawn_null cameraId=${cameraId} ch=${ch} path=${streamPath} — spawnTranscodeProcess returned null (see spawn_abort log above)`)
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'TRANSCODE_PROCESS_EXITED',
            message: 'FFmpeg no pudo iniciarse. Verifica credenciales NVR y que FFmpeg esté instalado en el contenedor API.',
            details: `path=${streamPath} — ver logs [transcode] spawn_abort para causa exacta` } }
      }
      console.info(`[transcode] spawn_ok cameraId=${cameraId} ch=${ch} path=${streamPath} pid=${proc.pid ?? 'pending'}`)

      // Store source info for supervisor restarts and attach the supervisor
      const sourceRef: TranscodeSourceRef = { nvr: nvr as any, camera: camera as any, userId, cameraId }
      transcodeSourceInfo.set(streamPath, sourceRef)
      attachTranscodeSupervisor(streamPath, proc, sourceRef)

      // Poll HLS manifest — abort early if FFmpeg exits before producing segments.
      // manifestVisible=true means status=200+#EXTM3U was seen; FFmpeg is alive
      // and MediaMTX is muxing — don't kill FFmpeg on timeout in that case.
      const { ready, lastStatus, elapsedMs, processExited, manifestVisible } = await waitForHlsReady(
        streamPath, TRANSCODE_HLS_READY_TIMEOUT_MS, 300,
        () => isTranscodeProcessAlive(streamPath),
      )

      if (!ready) {
        const stderrSnippet = getTranscodeStderr(streamPath)
        if (processExited) {
          stopTranscodeProcess(streamPath)
          transcodeInFlight.set(streamPath, { state: 'failed', promise: readyPromise, resolve: resolveInFlight })
          resolveInFlight(false)
          console.error(`[transcode] process_exited_early path=${streamPath} stderr=${stderrSnippet}`)
          return { hlsUrl: '', webrtcUrl: '', streamPath: '',
            error: { code: 'TRANSCODE_PROCESS_EXITED',
              message: 'FFmpeg finalizó antes de que HLS estuviese listo. Verifica la conexión RTSP al NVR.',
              details: stderrSnippet.slice(-200) } }
        }
        if (manifestVisible) {
          // MediaMTX is serving a manifest (status=200 + #EXTM3U) but segment
          // indicators were not detected — likely fMP4/LL-HLS format or master playlist.
          // FFmpeg IS alive and MediaMTX IS muxing; return the URL and let VideoPlayer retry.
          console.warn(`[transcode] hls_partial_ready path=${streamPath} manifestVisible=true elapsedMs=${elapsedMs} — returning url for VideoPlayer retry`)
          const effectiveViewId2 = viewId || 'default'
          sessions.set(transcodeKey, {
            cameraId, userId, viewId: effectiveViewId2, streamType: 'main_h264',
            streamPath, startedAt: new Date(), lastHeartbeat: new Date(),
          })
          transcodeLastActivity.set(streamPath, Date.now())
          transcodeInFlight.set(streamPath, { state: 'ready', promise: readyPromise, resolve: resolveInFlight })
          resolveInFlight(true)
          return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
        }
        // Final safety net: even without HLS manifest evidence, check if MediaMTX
        // actually has the RTSP publisher live (FFmpeg connected and pushing frames).
        // waitForHlsReady already does this check, but we do it once more here as a
        // last resort before killing FFmpeg.
        const liveDetails = await getStreamDetails(streamPath).catch(() => null)
        const rtspActive  = liveDetails?.sourceType === 'rtspSession' || liveDetails?.active === true
        if (rtspActive) {
          console.warn(
            `[transcode] hls_partial_ready path=${streamPath} elapsedMs=${elapsedMs}` +
            ` sourceType=${liveDetails?.sourceType} active=${liveDetails?.active}` +
            ` — publisher active, HLS muxer slow; returning URL for VideoPlayer retry`
          )
          const effectiveViewId3 = viewId || 'default'
          sessions.set(transcodeKey, {
            cameraId, userId, viewId: effectiveViewId3, streamType: 'main_h264',
            streamPath, startedAt: new Date(), lastHeartbeat: new Date(),
          })
          transcodeLastActivity.set(streamPath, Date.now())
          transcodeInFlight.set(streamPath, { state: 'ready', promise: readyPromise, resolve: resolveInFlight })
          resolveInFlight(true)
          return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
        }
        stopTranscodeProcess(streamPath)
        transcodeInFlight.set(streamPath, { state: 'failed', promise: readyPromise, resolve: resolveInFlight })
        resolveInFlight(false)
        console.error(`[transcode] hls_not_ready_killing path=${streamPath} elapsedMs=${elapsedMs} lastStatus=${lastStatus} rtspActive=${rtspActive}`)
        return { hlsUrl: '', webrtcUrl: '', streamPath: '',
          error: { code: 'TRANSCODE_NOT_READY',
            message: 'El stream transcodificado no pudo iniciar a tiempo. Intenta de nuevo.',
            details: `lastStatus=${lastStatus} elapsed=${elapsedMs}ms` } }
      }

      const effectiveViewId = viewId || 'default'
      sessions.set(transcodeKey, {
        cameraId, userId, viewId: effectiveViewId, streamType: 'main_h264',
        streamPath, startedAt: new Date(), lastHeartbeat: new Date(),
      })
      transcodeLastActivity.set(streamPath, Date.now())
      transcodeInFlight.set(streamPath, { state: 'ready', promise: readyPromise, resolve: resolveInFlight })
      resolveInFlight(true)
      console.info(`[transcode] ready cameraId=${cameraId} ch=${ch} path=${streamPath}`)
      return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath, transcoded: true }
    } catch (err) {
      stopTranscodeProcess(streamPath)
      transcodeInFlight.delete(streamPath)
      resolveInFlight(false)
      throw err
    }
  }

  // ── Sub early exit if confirmed down ──────────────────────────────────
  if (effectiveType === 'sub' && rtspSubOk === false) {
    console.info(`[startStream] skip cameraId=${cameraId} reason=rtsp_sub_down`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'RTSP_SUB_NOT_FOUND', message: 'Substream RTSP no disponible' } }
  }

  // ── Health status blocking (hard failures only) ───────────────────────
  if (healthStatus && BLOCKED_HEALTH_STATUSES.has(healthStatus)) {
    const knownError = HEALTH_STATUS_ERRORS[healthStatus]
    return { hlsUrl: '', webrtcUrl: '', streamPath: '',
      error: knownError ?? { code: healthStatus, message: `Stream no disponible: ${healthStatus}` } }
  }

  // ── Session reuse: return existing session without counting toward limit ─
  const key = sessionKey(userId, cameraId, effectiveType as 'sub' | 'main')
  const existingSession = sessions.get(key)
  if (existingSession) {
    existingSession.lastHeartbeat = new Date()
    if (viewId) existingSession.viewId = viewId
    console.info(`[userLimit] reuse existing cameraId=${cameraId} streamType=${effectiveType}`)
    return { hlsUrl: getHlsUrl(existingSession.streamPath), webrtcUrl: getWebRtcUrl(existingSession.streamPath), streamPath: existingSession.streamPath }
  }

  // ── Stream limits (only sub counts toward per-user limit) ─────────────
  const userSessions = getSessionsForUser(userId)
  const userSubSessions = userSessions.filter(s => s.streamType === 'sub')
  if (effectiveType === 'sub' && userSubSessions.length >= MAX_STREAMS_PER_USER) {
    console.info(`[userLimit] reject reason=limit cameraId=${cameraId} current=${userSubSessions.length} max=${MAX_STREAMS_PER_USER}`)
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'STREAM_LIMIT_REACHED', message: 'Límite de streams por usuario alcanzado', current: userSubSessions.length, max: MAX_STREAMS_PER_USER } as any }
  }
  if (sessions.size >= MAX_STREAMS_GLOBAL) {
    return { hlsUrl: '', webrtcUrl: '', streamPath: '', error: { code: 'STREAM_LIMIT_GLOBAL', message: 'Límite global de streams alcanzado' } }
  }

  // ── Publish to MediaMTX ───────────────────────────────────────────────
  const nvr = { ...camera.nvr, password: decryptPass(camera.nvr.password) }
  const streamPath = getStreamPath(nvr as NVR, camera as Camera, effectiveType as 'sub' | 'main')
  const rtspMasked = `rtsp://${nvr.username}:***@${nvr.ipAddress}:${nvr.rtspPort}/...`
  console.info(
    `[startStream] publish cameraId=${cameraId} nvrId=${camera.nvr.id} ch=${camera.channel}` +
    ` streamType=${effectiveType} path=${streamPath} rtsp=${rtspMasked}`
  )
  const published = await publishStream(nvr as NVR, camera as Camera, effectiveType as 'sub' | 'main')
  if (!published) {
    console.error(
      `[startStream] publish_failed cameraId=${cameraId} nvrId=${camera.nvr.id} ch=${camera.channel} path=${streamPath}`
    )
    return { hlsUrl: '', webrtcUrl: '', streamPath: '',
      error: { code: 'MEDIA_SERVER_ERROR', message: 'Error al registrar stream en el servidor de medios' } }
  }

  // ── Register session ──────────────────────────────────────────────────
  const effectiveViewId = viewId || 'default'
  sessions.set(key, {
    cameraId, userId, viewId: effectiveViewId, streamType: effectiveType as 'sub' | 'main',
    streamPath, startedAt: new Date(), lastHeartbeat: new Date(),
  })
  if (effectiveType === 'sub') {
    const vk = vKey(userId, effectiveViewId)
    if (!viewCameras.has(vk)) viewCameras.set(vk, new Set())
    viewCameras.get(vk)!.add(cameraId)
    viewHeartbeat.set(vk, new Date())
  }
  return { hlsUrl: getHlsUrl(streamPath), webrtcUrl: getWebRtcUrl(streamPath), streamPath }
}

// Detener stream para un usuario
export async function stopStream(
  server: FastifyInstance,
  userId: string,
  cameraId: string,
  streamType: 'sub' | 'main' | 'main_h264' = 'sub',
  reason?: string,
): Promise<void> {
  const key = sessionKey(userId, cameraId, streamType)
  const session = sessions.get(key)
  let killedFfmpeg = false
  let clearedInFlight = false

  if (session) {
    if (streamType === 'sub') {
      const vk = vKey(userId, session.viewId)
      viewCameras.get(vk)?.delete(cameraId)
    }
    sessions.delete(key)
    if (streamType === 'main_h264') {
      // Only kill FFmpeg when the reason explicitly permits it.
      // Non-kill reasons (retry, hls_error, etc.) keep FFmpeg alive so the next
      // startStream call can detect the live process and reuse it without re-spawning.
      const shouldKill = !reason || TRANSCODE_KILL_REASONS.has(reason)
      if (shouldKill) {
        stopTranscodeProcess(session.streamPath)
        transcodeRestarts.delete(session.streamPath)
        transcodeSourceInfo.delete(session.streamPath)
        transcodeLastActivity.delete(session.streamPath)
        killedFfmpeg = true
      } else {
        console.info(`[stopStream] skip_kill_active_main_h264 path=${session.streamPath} reason=${reason}`)
      }
      // Always clear inFlight — next startStream will re-register via isTranscodeProcessAlive check
      transcodeInFlight.delete(session.streamPath)
      clearedInFlight = true
    }
  }

  console.info(
    `[stopStream] cameraId=${cameraId} streamType=${streamType} key=${key}` +
    ` sessionFound=${!!session} path=${session?.streamPath || 'n/a'}` +
    ` killedFfmpeg=${killedFfmpeg} clearedInFlight=${clearedInFlight}` +
    (reason ? ` reason=${reason}` : '')
  )

  const othersWatching = Array.from(sessions.values()).some(s => s.cameraId === cameraId)
  if (!othersWatching) {
    server.log.info(`[stream-manager] Todos los viewers salieron de cámara ${cameraId}`)
  }
}

// ─── Heartbeat de viewport: reconciliar cámaras visibles ────
// Recibe el set de cámaras visibles para un viewId.
// - Detiene cámaras que ese view ya no necesita
// - Inicia cámaras que ese view necesita pero no tienen sesión
// - Toca todas las sesiones existentes (keepalive)
// - Devuelve URLs para todas las cámaras visibles
export interface ReconcileResult {
  streams: Record<string, { hls: string; webrtc: string; streamPath: string; channel?: number; nvrName?: string; warning?: { code: string; message: string } }>
  errors: Record<string, { code: string; message: string }>
  startedIds: string[]  // cámaras que se iniciaron ahora (necesitan nuevo player)
  stoppedIds: string[]  // cámaras que se detuvieron
}

export async function reconcileView(
  server: FastifyInstance,
  userId: string,
  viewId: string,
  visibleCameraIds: string[],
): Promise<ReconcileResult> {
  const visibleSet = new Set(visibleCameraIds)
  const vk = vKey(userId, viewId)

  // Actualizar heartbeat del view
  viewHeartbeat.set(vk, new Date())

  const streams: ReconcileResult['streams'] = {}
  const errors: ReconcileResult['errors']  = {}
  const startedIds: string[] = []
  const stoppedIds: string[] = []

  // Determinar qué cámaras tenía este view antes
  const previousCams = viewCameras.get(vk) || new Set<string>()

  // Detener cámaras que ya no son visibles en este view (solo sub — main/main_h264 tienen lifecycle explícito)
  const toStop = Array.from(previousCams).filter(id => !visibleSet.has(id))
  for (const cameraId of toStop) {
    await stopStream(server, userId, cameraId, 'sub', 'viewport_reconcile')
    stoppedIds.push(cameraId)
  }

  // Para cada cámara visible: iniciar si no tiene sesión sub, o tocar si ya existe
  for (const cameraId of visibleCameraIds) {
    const key = sessionKey(userId, cameraId, 'sub')
    const existing = sessions.get(key)

    if (existing) {
      // Ya está corriendo — tocar y devolver URL
      const now2 = new Date()
      existing.lastHeartbeat = now2
      existing.viewId = viewId
      // Touch co-located main/main_h264 sessions so idle cleanup doesn't kill active focus streams
      for (const st of ['main', 'main_h264'] as const) {
        const sOther = sessions.get(sessionKey(userId, cameraId, st))
        if (sOther) {
          sOther.lastHeartbeat = now2
          if (st === 'main_h264') transcodeLastActivity.set(sOther.streamPath, Date.now())
          console.info(`[reconcileView] touch ${st} cameraId=${cameraId} path=${sOther.streamPath}`)
        }
      }
      streams[cameraId] = {
        hls: getHlsUrl(existing.streamPath),
        webrtc: getWebRtcUrl(existing.streamPath),
        streamPath: existing.streamPath,
      }
    } else {
      // No tiene sesión — iniciar
      const result = await startStream(server, userId, cameraId, viewId)
      if (result.error) {
        errors[cameraId] = result.error
      } else {
        // Lookup channel + nvrName for complete StreamInfo
        const cam = await server.prisma.camera.findUnique({
          where: { id: cameraId },
          select: { channel: true, nvr: { select: { name: true } } },
        })
        streams[cameraId] = {
          hls: result.hlsUrl,
          webrtc: result.webrtcUrl,
          streamPath: result.streamPath,
          channel: cam?.channel,
          nvrName: cam?.nvr?.name,
          warning: result.warning,
        }
        startedIds.push(cameraId)
      }
    }
  }

  // Actualizar viewCameras con el nuevo conjunto visible
  viewCameras.set(vk, new Set(visibleCameraIds.filter(id => streams[id])))

  return { streams, errors, startedIds, stoppedIds }
}

// Limpiar todas las sesiones de un usuario y liberar streams sin otros viewers
export async function cleanupUserSessions(
  server: FastifyInstance,
  userId: string,
): Promise<number> {
  const userSessions = getSessionsForUser(userId)
  let removed = 0

  for (const session of userSessions) {
    const key = sessionKey(userId, session.cameraId, session.streamType)
    sessions.delete(key)
    removed++

    if (session.streamType === 'main_h264') {
      stopTranscodeProcess(session.streamPath)
      transcodeInFlight.delete(session.streamPath)
      transcodeRestarts.delete(session.streamPath)
      transcodeSourceInfo.delete(session.streamPath)
      transcodeLastActivity.delete(session.streamPath)
    }

    const othersWatching = Array.from(sessions.values()).some(s => s.cameraId === session.cameraId)
    if (!othersWatching) {
      const camera = await server.prisma.camera.findUnique({
        where: { id: session.cameraId },
        include: { nvr: true },
      })
      if (camera?.nvr) {
        removeStream(camera.nvr, camera).catch(() => {})
      }
    }
  }

  // Limpiar view maps para este usuario
  for (const key of viewCameras.keys()) {
    if (key.startsWith(`${userId}:`)) {
      viewCameras.delete(key)
      viewHeartbeat.delete(key)
    }
  }

  return removed
}

// Limpiar sesiones inactivas (llamar desde un cron)
// Una sesión es idle si su view no ha hecho heartbeat en STREAM_IDLE_TIMEOUT segundos
export async function cleanupIdleSessions(server: FastifyInstance): Promise<number> {
  const cutoff = new Date(Date.now() - STREAM_IDLE_TIMEOUT * 1000)
  let removed = 0

  // Detectar views con heartbeat expirado
  const staleViews = new Set<string>()
  for (const [vk, lastBeat] of viewHeartbeat.entries()) {
    if (lastBeat < cutoff) {
      staleViews.add(vk)
    }
  }

  // Eliminar sesiones de views expirados o con lastHeartbeat expirado
  for (const [key, session] of sessions.entries()) {
    const vk = vKey(session.userId, session.viewId)
    const isStale = staleViews.has(vk) || session.lastHeartbeat < cutoff
    if (!isStale) continue

    if (session.streamType === 'main_h264') {
      const ffmpegAlive     = isTranscodeProcessAlive(session.streamPath)
      const lastActivity    = transcodeLastActivity.get(session.streamPath) ?? 0
      const activityAgeMs   = Date.now() - lastActivity
      const recentActivity  = activityAgeMs < SUPERVISOR_GRACE_MS
      const heartbeatAgeMs  = Date.now() - session.lastHeartbeat.getTime()

      console.info(
        `[cleanupIdle] main_h264 check key=${key} view=${session.viewId}` +
        ` heartbeatAgeMs=${heartbeatAgeMs} activityAgeMs=${activityAgeMs}` +
        ` ffmpegAlive=${ffmpegAlive} recentActivity=${recentActivity}`
      )

      // Keep alive if FFmpeg is running — prevents tab-throttled heartbeats from killing active transcodes.
      if (ffmpegAlive) {
        session.lastHeartbeat = new Date()
        console.info(`[cleanupIdle] skip path=${session.streamPath} reason=ffmpeg_alive — bumped lastHeartbeat`)
        continue
      }

      // Keep alive if viewer was recently active (transcodeLastActivity updated by touch-stream / heartbeat).
      if (recentActivity) {
        session.lastHeartbeat = new Date()
        console.info(`[cleanupIdle] skip path=${session.streamPath} reason=recent_activity activityAgeMs=${activityAgeMs}`)
        continue
      }
    }

    sessions.delete(key)
    removed++
    if (session.streamType === 'main_h264') {
      stopTranscodeProcess(session.streamPath)
      transcodeInFlight.delete(session.streamPath)
      transcodeRestarts.delete(session.streamPath)
      transcodeSourceInfo.delete(session.streamPath)
      transcodeLastActivity.delete(session.streamPath)
    }
    server.log.info(`[stream-manager] idle_removed key=${key} streamType=${session.streamType} view=${session.viewId}`)
  }

  // Limpiar view maps para views expirados
  for (const vk of staleViews) {
    viewCameras.delete(vk)
    viewHeartbeat.delete(vk)
  }

  return removed
}

// Resumen de todas las sesiones activas (para panel admin)
export function getAdminSessionsSummary(): Array<{
  cameraId: string
  userId: string
  viewId: string
  streamPath: string
  startedAt: Date
  lastHeartbeat: Date
}> {
  return Array.from(sessions.values()).map(s => ({
    cameraId:      s.cameraId,
    userId:        s.userId,
    viewId:        s.viewId,
    streamPath:    s.streamPath,
    startedAt:     s.startedAt,
    lastHeartbeat: s.lastHeartbeat,
  }))
}

// Enhanced diagnostic for /api/live-view/transcodes — one entry per active FFmpeg process
export async function getTranscodesDiagnostic(): Promise<Array<{
  streamPath:              string
  pid:                     number | undefined
  alive:                   boolean
  restartCount:            number
  lastExitCode:            number | null
  lastExitReason:          string
  stderrLast20k:           string
  sourceRtspMasked:        string | undefined
  mediaMtxPublisherActive: boolean
}>> {
  const procs = getActiveTranscodesList()
  return Promise.all(procs.map(async (p) => {
    const restartInfo = transcodeRestarts.get(p.streamPath)
    const details     = await getStreamDetails(p.streamPath).catch(() => null)
    return {
      streamPath:              p.streamPath,
      pid:                     p.pid,
      alive:                   p.alive,
      restartCount:            restartInfo?.count ?? 0,
      lastExitCode:            restartInfo?.lastExitCode ?? null,
      lastExitReason:          restartInfo?.lastExitReason ?? '',
      stderrLast20k:           getTranscodeRawStderr(p.streamPath),
      sourceRtspMasked:        getTranscodeRtspMasked(p.streamPath),
      mediaMtxPublisherActive: details?.active === true,
    }
  }))
}

// Estado global de streams (para panel admin)
export async function getStreamManagerStatus(server: FastifyInstance) {
  const activeSessions = getActiveSessions()
  const uniqueCameras = new Set(activeSessions.map(s => s.cameraId))

  const cameraStatuses: Record<string, { readers: number; ready: boolean }> = {}
  for (const camId of uniqueCameras) {
    const session = activeSessions.find(s => s.cameraId === camId)
    if (session) {
      const st = await getStreamStatus(session.streamPath).catch(() => ({ active: false, readers: 0, bytesReceived: 0 }))
      cameraStatuses[camId] = { readers: st.readers, ready: st.active }
    }
  }

  return {
    totalSessions: activeSessions.length,
    uniqueCameras: uniqueCameras.size,
    activeViews: viewHeartbeat.size,
    maxPerUser: MAX_STREAMS_PER_USER,
    maxGlobal: MAX_STREAMS_GLOBAL,
    sessions: activeSessions.map(s => ({
      cameraId:     s.cameraId,
      userId:       s.userId,
      viewId:       s.viewId,
      streamPath:   s.streamPath,
      startedAt:    s.startedAt,
      lastHeartbeat: s.lastHeartbeat,
      mediaStatus:  cameraStatuses[s.cameraId],
    })),
  }
}
