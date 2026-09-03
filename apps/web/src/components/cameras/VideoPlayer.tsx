// src/components/cameras/VideoPlayer.tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import type { ErrorData } from 'hls.js'
import {
  Maximize2, Volume2, VolumeX, RefreshCw,
  Circle, AlertTriangle, Loader2, Stethoscope,
  WifiOff, Lock, Clock, Film, Server, Cpu,
} from 'lucide-react'
import { clsx } from 'clsx'
import { hlsRetryDecision } from './hlsRetryPolicy'
import { shouldShowCodecUnsupported } from './codecSupport'

export type CameraPlaybackErrorCode =
  | 'NVR_OFFLINE'
  | 'CAMERA_OFFLINE'
  | 'CAMERA_STREAM_ERROR'
  | 'AUTH_FAILED'
  | 'RTSP_TIMEOUT'
  | 'RTSP_UNAUTHORIZED'
  | 'RTSP_CHANNEL_NOT_FOUND'
  | 'SUBSTREAM_DISABLED'
  | 'CODEC_UNSUPPORTED'
  | 'MEDIAMTX_ROUTE_MISSING'
  | 'MEDIAMTX_NOT_READY'
  | 'HLS_MANIFEST_NOT_FOUND'
  | 'HLS_SESSION_EXPIRED'
  | 'TRANSCODE_NOT_READY'
  | 'TRANSCODE_PROCESS_EXITED'
  | 'TRANSCODE_LIMIT_REACHED'
  | 'STREAM_LIMIT_REACHED'
  | 'NO_PERMISSION'
  | 'PLAYER_TIMEOUT'
  | 'UNKNOWN'

export interface CameraPlaybackError {
  code: CameraPlaybackErrorCode
  message: string
  technicalDetail?: string
}

const ERROR_CONFIG: Record<CameraPlaybackErrorCode, { icon: React.ReactNode; label: string; color: string }> = {
  NVR_OFFLINE:             { icon: <WifiOff size={16} />,      label: 'NVR no disponible',           color: 'text-red-400' },
  CAMERA_OFFLINE:          { icon: <WifiOff size={16} />,      label: 'Sin señal de cámara',         color: 'text-red-400' },
  CAMERA_STREAM_ERROR:     { icon: <Server size={16} />,       label: 'Error del pipeline de streaming', color: 'text-orange-400' },
  AUTH_FAILED:             { icon: <Lock size={16} />,         label: 'Credenciales inválidas',      color: 'text-amber-400' },
  RTSP_TIMEOUT:            { icon: <Clock size={16} />,        label: 'RTSP timeout',                color: 'text-amber-400' },
  RTSP_UNAUTHORIZED:       { icon: <Lock size={16} />,         label: 'RTSP 401 Unauthorized',       color: 'text-amber-400' },
  RTSP_CHANNEL_NOT_FOUND:  { icon: <AlertTriangle size={16} />, label: 'Canal no encontrado',        color: 'text-amber-400' },
  SUBSTREAM_DISABLED:      { icon: <Film size={16} />,         label: 'Substream deshabilitado',     color: 'text-amber-400' },
  CODEC_UNSUPPORTED:       { icon: <Film size={16} />,         label: 'Codec H.265 no compatible',  color: 'text-amber-400' },
  MEDIAMTX_ROUTE_MISSING:  { icon: <Server size={16} />,       label: 'Ruta MediaMTX no existe',    color: 'text-orange-400' },
  MEDIAMTX_NOT_READY:      { icon: <Server size={16} />,       label: 'HLS preparando',              color: 'text-orange-400' },
  HLS_MANIFEST_NOT_FOUND:  { icon: <Film size={16} />,         label: 'HLS manifest no encontrado', color: 'text-orange-400' },
  HLS_SESSION_EXPIRED:        { icon: <Clock size={16} />,        label: 'Sesión HLS expirada',          color: 'text-amber-400' },
  TRANSCODE_NOT_READY:        { icon: <Cpu size={16} />,          label: 'Transcodificación no lista',   color: 'text-purple-400' },
  TRANSCODE_PROCESS_EXITED:   { icon: <Cpu size={16} />,          label: 'FFmpeg finalizó inesperadamente', color: 'text-purple-400' },
  TRANSCODE_LIMIT_REACHED:    { icon: <Cpu size={16} />,          label: 'Límite de transcodificaciones', color: 'text-amber-400' },
  STREAM_LIMIT_REACHED:       { icon: <Server size={16} />,       label: 'Límite de streams alcanzado',  color: 'text-amber-400' },
  NO_PERMISSION:              { icon: <Lock size={16} />,         label: 'Sin permiso para esta cámara', color: 'text-amber-400' },
  PLAYER_TIMEOUT:             { icon: <Clock size={16} />,        label: 'Sin frames (timeout)',         color: 'text-surface-400' },
  UNKNOWN:                    { icon: <AlertTriangle size={16} />, label: 'Error desconocido',           color: 'text-surface-400' },
}

function isHevcCodec(codec?: string): boolean {
  if (!codec) return false
  const c = codec.toLowerCase()
  return c.includes('hevc') || c.includes('h265') || c.includes('h.265') || c.includes('265')
}

function formatBadgeCodec(codec?: string): string {
  if (!codec) return ''
  const c = codec.toLowerCase()
  if (c.includes('hevc') || c.includes('h265') || c.includes('h.265')) return 'H.265'
  if (c.includes('h264') || c.includes('h.264') || c.includes('avc')) return 'H.264'
  return codec.toUpperCase()
}

function formatResolution(res?: string): string {
  return res ? res.replace(/x/i, '×') : ''
}

function classifyHlsError(data: ErrorData): CameraPlaybackErrorCode {
  if (data.response?.code === 401) return 'HLS_SESSION_EXPIRED'
  if (data.response?.code === 404) return 'HLS_MANIFEST_NOT_FOUND'
  if (data.response?.code === 500) return 'MEDIAMTX_NOT_READY'
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) return 'MEDIAMTX_NOT_READY'
  // HEVC codec not supported in browser (hvc1/hev1 — Chrome/Firefox without HW HEVC)
  const detail = data.details || ''
  const reason = (data.reason || '').toLowerCase()
  if (
    detail === 'manifestIncompatibleCodecsError' ||
    detail === 'bufferIncompatibleCodecsError' ||
    reason.includes('codec') ||
    reason.includes('hvc') ||
    reason.includes('hev')
  ) return 'CODEC_UNSUPPORTED'
  return 'UNKNOWN'
}

interface Props {
  hlsUrl: string
  cameraName: string
  cameraId?: string
  isRecording?: boolean
  onFullscreen?: () => void
  onDiagnostic?: (cameraId: string) => void
  onStreamError?: (cameraId: string, err: CameraPlaybackError) => void
  onPlaying?: (cameraId: string) => void
  onQualitySwitch?: (quality: 'sub' | 'main' | 'main_h264') => void
  onRetry?: (cameraId: string) => void
  className?: string
  error?: boolean
  playbackError?: CameraPlaybackError
  streamType?: 'sub' | 'main' | 'main_h264'
  streamCodec?: string        // e.g. "hevc", "h264"
  streamResolution?: string   // e.g. "1920×1080", "640×360"
  streamFps?: number | null       // fps real (transcodificado) — se muestra en el badge si existe
  streamBitrate?: string | null   // bitrate real (transcodificado) — se muestra en el badge si existe
  transcodingAvailable?: boolean
  qualitySwitchBusy?: boolean  // deshabilita Baja/Alta/Trans mientras hay un cambio en vuelo
  /** Estado externo (p. ej. el sub sigue visible mientras se prepara HD). */
  preparingMessage?: string | null
  objectFit?: 'cover' | 'contain'  // default: 'contain'
}

type Status = 'loading' | 'playing' | 'error' | 'offline'

export function VideoPlayer({
  hlsUrl,
  cameraName,
  cameraId,
  isRecording,
  onFullscreen,
  onDiagnostic,
  onStreamError,
  onPlaying,
  onQualitySwitch,
  onRetry,
  className,
  error,
  playbackError: externalError,
  streamType,
  streamCodec,
  streamResolution,
  streamFps,
  streamBitrate,
  transcodingAvailable,
  qualitySwitchBusy,
  preparingMessage,
  objectFit = 'contain',
}: Props) {
  // Whether the current stream is the transcoded (HEVC→H.264) variant
  const isTranscoded = streamType === 'main_h264'
  // Ref so the HLS error closure can read current streamType without stale closure issues
  const streamTypeRef = useRef(streamType)
  streamTypeRef.current = streamType
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const firstFrameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref mirrors playing state so firstFrameTimer closure reads current value, not stale snapshot
  const isPlayingRef   = useRef(false)
  // True once the first fragment was loaded in this mount — drives "Reconectando" vs "Preparando"
  const hasPlayedOnce  = useRef(false)
  // Track previous hlsUrl to detect URL changes for logging
  const prevHlsUrlRef  = useRef<string>('')
  const [status, setStatus] = useState<Status>('loading')
  const [internalError, setInternalError] = useState<CameraPlaybackError | null>(null)
  // Message shown in the loading overlay during transcoding startup (HLS 500 retry window)
  const [transcodeStartMsg, setTranscodeStartMsg] = useState<string | null>(null)
  const [muted, setMuted] = useState(true)
  const [showControls, setShowControls] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const displayError = externalError || internalError

  const initPlayer = useCallback(() => {
    if (!videoRef.current || !hlsUrl) return

    console.info(`[live-ui] hls_attach cameraId=${cameraId || 'unknown'} url=${hlsUrl}`)
    hlsRef.current?.destroy()
    if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
    isPlayingRef.current  = false
    hasPlayedOnce.current = false
    setStatus('loading')
    setInternalError(null)
    setTranscodeStartMsg(null)

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 60,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        fragLoadingTimeOut: 10000,
        manifestLoadingTimeOut: 10000,
        xhrSetup: (xhr) => {
          xhr.withCredentials = true
        },
      })

      hlsRef.current = hls
      hls.loadSource(hlsUrl)
      hls.attachMedia(videoRef.current)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoRef.current?.play().catch(() => {})
        // Transcoded streams (main_h264) need more time: GOP=2s → segments ~2s,
        // but startup (FFmpeg connect + first keyframe) can take up to 30-45s.
        const frameTimeoutMs = streamTypeRef.current === 'main_h264' ? 60_000 : 15_000
        firstFrameTimer.current = setTimeout(() => {
          if (!isPlayingRef.current) {
            const secs = frameTimeoutMs / 1000
            const err: CameraPlaybackError = { code: 'PLAYER_TIMEOUT', message: `Sin frames tras ${secs} segundos`, technicalDetail: hlsUrl }
            setStatus('error')
            setInternalError(err)
            if (cameraId) onStreamError?.(cameraId, err)
          }
        }, frameTimeoutMs)
      })

      hls.on(Hls.Events.FRAG_LOADED, () => {
        if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
        isPlayingRef.current  = true
        hasPlayedOnce.current = true
        setStatus('playing')
        setInternalError(null)
        setTranscodeStartMsg(null)
        if (cameraId) onPlaying?.(cameraId)
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          const rawCode   = classifyHlsError(data)
          // For transcoded streams, unclassified errors are almost always transient
          // encoding/buffering issues — show a more informative label than "Error desconocido".
          const errorCode: CameraPlaybackErrorCode =
            rawCode === 'UNKNOWN' && streamTypeRef.current === 'main_h264'
              ? 'TRANSCODE_NOT_READY'
              : rawCode

          const isStale = hlsRef.current !== hls
          console.warn(
            `[live-ui] hls_error cameraId=${cameraId || 'unknown'} status=${data.response?.code ?? 'n/a'}` +
            ` stale=${isStale} url=${data.url || hlsUrl} details=${data.details}`
          )
          // If this HLS instance is no longer current (stale), ignore the error entirely.
          // This happens when initPlayer was called again before the old HLS.js finished cleanup.
          if (isStale) return

          // 401 — MediaMTX HLS session expired (cookie expired or muxer destroyed)
          if (data.response?.code === 401) {
            const urlHint = (data.url || '').includes('index.m3u8') ? 'index'
              : (data.url || '').includes('video') ? 'variant' : 'segment'
            console.warn('[VideoPlayer] HLS 401', { cameraId, urlType: urlHint, url: data.url, detail: data.details })
            const err: CameraPlaybackError = {
              code: 'HLS_SESSION_EXPIRED',
              message: 'Sesión HLS expirada; reconectando...',
              technicalDetail: `URL: ${data.url || hlsUrl} (${urlHint})`,
            }
            // Keep loading state — parent (LiveView) handles auto-restart; avoid error flash
            setStatus('loading')
            setInternalError(null)
            if (cameraId) onStreamError?.(cameraId, err)
            return
          }

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // 500 on main_h264: FFmpeg may still be starting even after backend wait — retry briefly
            // 500 otherwise: MediaMTX source/muxer error → fail immediately
            // 404: stream still registering → 1 retry
            // other network errors: up to 5 retries with backoff
            const statusCode = data.response?.code
            const is500 = statusCode === 500
            const is404 = statusCode === 404
            const isTranscodedStream = streamTypeRef.current === 'main_h264'
            if (is500) console.warn('[VideoPlayer] HLS 500', { cameraId, isTranscoded: isTranscodedStream, details: data.details })
            // Un 500 del substream normal suele ser MediaMTX iniciando la fuente
            // (transitorio), NO un fallo definitivo. La política (pura, testeada en
            // hlsRetryPolicy.ts) concede una ventana de preparación con backoff antes
            // de declarar el fallo — evita el fallback prematuro a main_h264.
            setRetryCount((r) => {
              const decision = hlsRetryDecision(statusCode, isTranscodedStream, r)
              if (decision.preparing) {
                setTranscodeStartMsg(
                  isTranscodedStream
                    ? (hasPlayedOnce.current ? 'Reconectando transcodificación...' : 'Preparando transcodificación...')
                    : (hasPlayedOnce.current ? 'Reconectando stream…' : 'Preparando stream…')
                )
              }
              if (!decision.shouldRetry) {
                setTranscodeStartMsg(null)
                const err: CameraPlaybackError = {
                  code: errorCode,
                  message: is500 && isTranscodedStream
                    ? 'Transcodificación no disponible — el stream no pudo iniciarse a tiempo'
                    : is500 ? 'Stream no disponible'
                    : is404 ? 'Stream no disponible en el servidor'
                    :         'Sin respuesta del servidor de streaming',
                  technicalDetail: `HTTP ${statusCode ?? 'err'} ${data.details}. URL: ${hlsUrl}`,
                }
                setStatus('error')
                setInternalError(err)
                if (cameraId) onStreamError?.(cameraId, err)
                return r
              }
              setTimeout(() => { if (hlsRef.current === hls) hls.startLoad() }, decision.delayMs)
              return r + 1
            })
          } else {
            const message = errorCode === 'CODEC_UNSUPPORTED'
              ? 'H.265/HEVC no es compatible con este navegador'
              : data.reason || 'Error fatal del player'
            const err: CameraPlaybackError = {
              code: errorCode,
              message,
              technicalDetail: `${data.type} / ${data.details}`,
            }
            setStatus('error')
            setInternalError(err)
            if (cameraId) onStreamError?.(cameraId, err)
            // Destroy HLS immediately on codec error — no point retrying an unsupported codec
            if (errorCode === 'CODEC_UNSUPPORTED') {
              hls.destroy()
              hlsRef.current = null
            }
          }
        }
      })
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari nativo (no usa xhrSetup, las cookies se envían automáticamente)
      videoRef.current.src = hlsUrl
      videoRef.current.addEventListener('loadedmetadata', () => {
        videoRef.current?.play()
        setStatus('playing')
      })
      videoRef.current.addEventListener('error', () => {
        setStatus('error')
        setInternalError({ code: 'UNKNOWN', message: 'Error en player nativo (Safari)' })
      })
    } else {
      setStatus('error')
      setInternalError({ code: 'UNKNOWN', message: 'Navegador no soporta HLS' })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlsUrl])

  useEffect(() => {
    if (hlsUrl && prevHlsUrlRef.current && prevHlsUrlRef.current !== hlsUrl) {
      console.info(`[live-ui] stream_url_changed cameraId=${cameraId || 'unknown'} old=${prevHlsUrlRef.current} new=${hlsUrl}`)
    }
    prevHlsUrlRef.current = hlsUrl || ''

    if (error || externalError) {
      if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
      console.info(`[live-ui] hls_destroy cameraId=${cameraId || 'unknown'} reason=external_error`)
      hlsRef.current?.destroy()
      hlsRef.current = null
      setStatus('error')
      return
    }
    if (!hlsUrl) {
      // hlsUrl cleared (session stopped) — destroy HLS so it stops making requests
      if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
      console.info(`[live-ui] hls_destroy cameraId=${cameraId || 'unknown'} reason=url_cleared`)
      hlsRef.current?.destroy()
      hlsRef.current = null
      setStatus('loading')
      setInternalError(null)
      return
    }
    initPlayer()
    return () => {
      if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
      isPlayingRef.current = false
      console.info(`[live-ui] hls_destroy cameraId=${cameraId || 'unknown'} reason=effect_cleanup`)
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [hlsUrl, error, externalError, initPlayer])

  const handleRetry = () => {
    setRetryCount(0)
    setInternalError(null)
    initPlayer()
  }

  const handleRetrySmart = () => {
    if (onRetry && cameraId) {
      onRetry(cameraId)
    } else {
      setRetryCount(0)
      setInternalError(null)
      initPlayer()
    }
  }

  const activeError = displayError
  const errCfg = activeError ? ERROR_CONFIG[activeError.code] : null

  return (
    <div
      className={clsx('relative bg-black overflow-hidden group rounded-lg', className)}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
      onDoubleClick={(e) => { e.stopPropagation(); onFullscreen?.() }}
    >
      <video
        ref={videoRef}
        className={clsx('w-full h-full', objectFit === 'cover' ? 'object-cover' : 'object-contain')}
        muted={muted}
        autoPlay
        playsInline
      />

      {/* Loading */}
      {status === 'loading' && !activeError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-900/80">
          <Loader2 size={24} className="text-surface-400 animate-spin" />
          {transcodeStartMsg && (
            <p className="text-[10px] text-purple-300 text-center max-w-[160px] leading-snug">
              {transcodeStartMsg}
            </p>
          )}
        </div>
      )}

      {/* El stream actual puede seguir reproduciéndose mientras el padre abre
          HD. Mostrarlo como preparación evita que esos 5–7 s parezcan un cupo
          que todavía no se liberó o una pantalla congelada. */}
      {preparingMessage && !activeError && (
        <div
          className="absolute left-1/2 bottom-3 -translate-x-1/2 z-20 flex items-center gap-1.5 max-w-[90%] rounded-full bg-black/75 border border-purple-500/30 px-3 py-1.5 shadow-lg"
          role="status"
          aria-live="polite"
        >
          <Loader2 size={11} className="animate-spin text-purple-300" />
          <span className="text-[10px] text-purple-200 text-center leading-snug">{preparingMessage}</span>
        </div>
      )}

      {/* Error overlay — muestra causa técnica real */}
      {(status === 'error' || !!activeError || (error && status !== 'playing')) && (() => {
        // Sólo declaramos "H.265 no compatible" ante una señal REAL de códec (error
        // clasificado CODEC_UNSUPPORTED o detalle incompatible de hls.js), NUNCA por el
        // mero hecho de que streamCodec sea HEVC: un 404/500/timeout/manifest temporal
        // sobre un HEVC reproducible ya no dispara este overlay (P1).
        const hlsDetail = activeError?.technicalDetail?.split('/').pop()?.trim()
        const isHevcMain = shouldShowCodecUnsupported({
          streamType,
          errorCode: activeError?.code,
          hlsErrorDetail: hlsDetail,
        })
        const isLimitReached = activeError?.code === 'TRANSCODE_LIMIT_REACHED'
        return (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-900/95 gap-2 px-3">
            {isLimitReached ? (
              <>
                <Cpu size={18} className="text-amber-400" />
                <p className="text-xs font-medium text-amber-300 text-center">Límite de transcodificaciones</p>
                <p className="text-[10px] text-surface-400 text-center leading-snug max-w-[200px]">
                  {activeError?.message || 'Cupo máx. alcanzado. Cierra otra cámara HD o usa baja calidad.'}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-1 justify-center">
                  {onQualitySwitch && (
                    <button
                      onClick={() => onQualitySwitch('sub')}
                      className="btn-ghost text-[10px] px-2 py-1 text-brand-400 hover:text-brand-300"
                    >
                      Usar baja calidad
                    </button>
                  )}
                  {onRetry && cameraId && (
                    <button
                      onClick={() => onRetry!(cameraId!)}
                      className="btn-ghost text-[10px] px-2 py-1"
                    >
                      <RefreshCw size={10} /> Reintentar
                    </button>
                  )}
                </div>
              </>
            ) : isHevcMain ? (
              <>
                <Film size={18} className="text-amber-400" />
                <p className="text-xs font-medium text-amber-300 text-center">H.265/HEVC no compatible</p>
                <p className="text-[10px] text-surface-400 text-center leading-snug max-w-[200px]">
                  El flujo principal está en H.265/HEVC. Para alta calidad web se requiere H.264 o transcodificación.
                </p>
                <div className="flex flex-wrap gap-1.5 mt-1 justify-center">
                  {onQualitySwitch && (
                    <button
                      onClick={() => onQualitySwitch('sub')}
                      className="btn-ghost text-[10px] px-2 py-1 text-brand-400 hover:text-brand-300"
                    >
                      Usar baja calidad
                    </button>
                  )}
                  {onQualitySwitch && transcodingAvailable && (
                    <button
                      onClick={() => onQualitySwitch('main_h264')}
                      className="btn-ghost text-[10px] px-2 py-1 text-purple-400 hover:text-purple-300"
                      title="Transcodificar H.265→H.264 via FFmpeg"
                    >
                      <Cpu size={10} /> Transcodificar H.264
                    </button>
                  )}
                  <button
                    onClick={() => onQualitySwitch ? onQualitySwitch('main') : handleRetrySmart()}
                    className="btn-ghost text-[10px] px-2 py-1"
                  >
                    <RefreshCw size={10} /> Reintentar
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={clsx('flex items-center gap-1.5', errCfg?.color || 'text-surface-500')}>
                  {errCfg?.icon || <AlertTriangle size={16} />}
                  <span className="text-xs font-medium">{errCfg?.label || 'Sin señal'}</span>
                </div>
                {activeError?.message && (
                  <p className="text-[10px] text-surface-500 text-center leading-tight max-w-[180px]">
                    {activeError.message}
                  </p>
                )}
                <div className="flex gap-1.5 mt-1">
                  <button onClick={handleRetrySmart} className="btn-ghost text-[10px] px-2 py-1">
                    <RefreshCw size={10} /> Reintentar
                  </button>
                  {onDiagnostic && cameraId && (
                    <button
                      onClick={() => onDiagnostic(cameraId)}
                      className="btn-ghost text-[10px] px-2 py-1 text-brand-400 hover:text-brand-300"
                    >
                      <Stethoscope size={10} /> Diagnóstico
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )
      })()}

      {/* Top-right: quality badge + REC */}
      {(streamType || (isRecording && status === 'playing')) && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 px-1.5 py-0.5 rounded">
          {isRecording && status === 'playing' && (
            <>
              <Circle size={6} className="fill-brand-500 text-brand-500 rec-indicator" />
              <span className="text-xs text-brand-400 font-medium">REC</span>
            </>
          )}
          {streamType && status === 'playing' && (
            <span className={clsx('text-[9px] font-medium leading-none', isTranscoded ? 'text-purple-300' : 'text-surface-300')}>
              {isTranscoded ? 'Trans' : streamType === 'main' ? 'Main' : 'Sub'}
              {streamResolution && ` ${formatResolution(streamResolution)}`}
              {isTranscoded ? ' H.264' : streamCodec ? ` ${formatBadgeCodec(streamCodec)}` : ''}
              {streamFps ? ` ${streamFps}fps` : ''}
              {streamBitrate ? ` ${streamBitrate}` : ''}
            </span>
          )}
        </div>
      )}

      {/* Camera name */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
        <span className="text-xs text-white/90 font-medium drop-shadow-sm">{cameraName}</span>
      </div>

      {/* Controls overlay */}
      <div className={clsx(
        'absolute top-2 left-2 flex gap-1 transition-opacity duration-150',
        showControls ? 'opacity-100' : 'opacity-0'
      )}>
        <button
          onClick={() => setMuted(!muted)}
          className="p-1 rounded bg-black/60 text-white hover:bg-black/80 transition-colors"
          title={muted ? 'Activar audio' : 'Silenciar'}
        >
          {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
        </button>
        <button onClick={handleRetry} className="p-1 rounded bg-black/60 text-white hover:bg-black/80 transition-colors" title="Recargar">
          <RefreshCw size={12} />
        </button>
        {onDiagnostic && cameraId && (
          <button
            onClick={() => onDiagnostic(cameraId)}
            className="p-1 rounded bg-black/60 text-white hover:bg-black/80 transition-colors"
            title="Diagnóstico de stream"
          >
            <Stethoscope size={12} />
          </button>
        )}
        {onFullscreen && (
          <button onClick={onFullscreen} className="p-1 rounded bg-black/60 text-white hover:bg-black/80 transition-colors" title="Pantalla completa">
            <Maximize2 size={12} />
          </button>
        )}
        {onQualitySwitch && streamType && (
          <div className="flex bg-black/60 rounded overflow-hidden">
            <button
              onClick={() => onQualitySwitch('sub')}
              disabled={qualitySwitchBusy}
              className={clsx('text-[9px] px-1.5 py-0.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                streamType === 'sub' ? 'bg-brand-600 text-white' : 'text-surface-300 hover:text-white')}
              title="Baja calidad (substream H.264)"
            >
              Baja
            </button>
            <button
              onClick={() => onQualitySwitch('main')}
              disabled={qualitySwitchBusy}
              className={clsx('text-[9px] px-1.5 py-0.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                streamType === 'main' ? 'bg-brand-600 text-white' : 'text-surface-300 hover:text-white')}
              title="Alta calidad (stream principal)"
            >
              Alta
            </button>
            {transcodingAvailable && (
              <button
                onClick={() => onQualitySwitch('main_h264')}
                disabled={qualitySwitchBusy}
                className={clsx('text-[9px] px-1.5 py-0.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                  isTranscoded ? 'bg-purple-700 text-white' : 'text-purple-300 hover:text-white')}
                title="Transcodificado H.264"
              >
                Trans
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
