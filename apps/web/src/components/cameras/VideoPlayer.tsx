// src/components/cameras/VideoPlayer.tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import type { ErrorData } from 'hls.js'
import {
  Maximize2, Volume2, VolumeX, RefreshCw,
  Circle, AlertTriangle, Loader2, Stethoscope,
  WifiOff, Lock, Clock, Film, Server,
} from 'lucide-react'
import { clsx } from 'clsx'

export type CameraPlaybackErrorCode =
  | 'NVR_OFFLINE'
  | 'CAMERA_OFFLINE'
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
  | 'PLAYER_TIMEOUT'
  | 'UNKNOWN'

export interface CameraPlaybackError {
  code: CameraPlaybackErrorCode
  message: string
  technicalDetail?: string
}

const ERROR_CONFIG: Record<CameraPlaybackErrorCode, { icon: React.ReactNode; label: string; color: string }> = {
  NVR_OFFLINE:             { icon: <WifiOff size={16} />,      label: 'NVR offline',                 color: 'text-red-400' },
  CAMERA_OFFLINE:          { icon: <WifiOff size={16} />,      label: 'Cámara offline',              color: 'text-red-400' },
  AUTH_FAILED:             { icon: <Lock size={16} />,         label: 'Credenciales inválidas',      color: 'text-amber-400' },
  RTSP_TIMEOUT:            { icon: <Clock size={16} />,        label: 'RTSP timeout',                color: 'text-amber-400' },
  RTSP_UNAUTHORIZED:       { icon: <Lock size={16} />,         label: 'RTSP 401 Unauthorized',       color: 'text-amber-400' },
  RTSP_CHANNEL_NOT_FOUND:  { icon: <AlertTriangle size={16} />, label: 'Canal no encontrado',        color: 'text-amber-400' },
  SUBSTREAM_DISABLED:      { icon: <Film size={16} />,         label: 'Substream deshabilitado',     color: 'text-amber-400' },
  CODEC_UNSUPPORTED:       { icon: <Film size={16} />,         label: 'Codec H.265 no compatible',  color: 'text-amber-400' },
  MEDIAMTX_ROUTE_MISSING:  { icon: <Server size={16} />,       label: 'Ruta MediaMTX no existe',    color: 'text-orange-400' },
  MEDIAMTX_NOT_READY:      { icon: <Server size={16} />,       label: 'Stream MediaMTX no listo',   color: 'text-orange-400' },
  HLS_MANIFEST_NOT_FOUND:  { icon: <Film size={16} />,         label: 'HLS manifest no encontrado', color: 'text-orange-400' },
  HLS_SESSION_EXPIRED:     { icon: <Clock size={16} />,        label: 'Sesión HLS expirada',         color: 'text-amber-400' },
  PLAYER_TIMEOUT:          { icon: <Clock size={16} />,        label: 'Sin frames (timeout)',        color: 'text-surface-400' },
  UNKNOWN:                 { icon: <AlertTriangle size={16} />, label: 'Error desconocido',          color: 'text-surface-400' },
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
  onQualitySwitch?: (quality: 'sub' | 'main') => void
  className?: string
  error?: boolean
  playbackError?: CameraPlaybackError
  streamType?: 'sub' | 'main'
  streamCodec?: string        // e.g. "hevc", "h264"
  streamResolution?: string   // e.g. "1920×1080", "640×360"
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
  onQualitySwitch,
  className,
  error,
  playbackError: externalError,
  streamType,
  streamCodec,
  streamResolution,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const firstFrameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref mirrors playing state so firstFrameTimer closure reads current value, not stale snapshot
  const isPlayingRef = useRef(false)
  const [status, setStatus] = useState<Status>('loading')
  const [internalError, setInternalError] = useState<CameraPlaybackError | null>(null)
  const [muted, setMuted] = useState(true)
  const [showControls, setShowControls] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const displayError = externalError || internalError

  const initPlayer = useCallback(() => {
    if (!videoRef.current || !hlsUrl) return

    hlsRef.current?.destroy()
    if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
    isPlayingRef.current = false
    setStatus('loading')
    setInternalError(null)

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
        // Timeout si no llegan frames tras 15s — use ref, not state, to avoid stale closure
        firstFrameTimer.current = setTimeout(() => {
          if (!isPlayingRef.current) {
            const err: CameraPlaybackError = { code: 'PLAYER_TIMEOUT', message: 'Sin frames tras 15 segundos', technicalDetail: hlsUrl }
            setStatus('error')
            setInternalError(err)
            if (cameraId) onStreamError?.(cameraId, err)
          }
        }, 15000)
      })

      hls.on(Hls.Events.FRAG_LOADED, () => {
        if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
        isPlayingRef.current = true
        setStatus('playing')
        setInternalError(null)
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          const errorCode = classifyHlsError(data)

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
            // 500 → MediaMTX source error (HEVC/RTSP fail / muxer destroyed) → max 1 retry
            // 404 → stream still starting up → max 2 retries
            // other network errors → max 5 retries with backoff
            const statusCode = data.response?.code
            const is500 = statusCode === 500
            const is404 = statusCode === 404
            if (is500) console.warn('[VideoPlayer] HLS 500 — MediaMTX muxer/source error', { cameraId, details: data.details })
            const maxRetries = is500 ? 1 : is404 ? 2 : 5
            setRetryCount((r) => {
              if (r >= maxRetries) {
                const err: CameraPlaybackError = {
                  code: errorCode,
                  message: is500 ? 'Error en servidor de streaming (MediaMTX 500)'
                          : is404 ? 'Stream no disponible en el servidor'
                          :         'Sin respuesta del servidor de streaming',
                  technicalDetail: `HTTP ${statusCode ?? 'err'} ${data.details}. URL: ${hlsUrl}`,
                }
                setStatus('error')
                setInternalError(err)
                if (cameraId) onStreamError?.(cameraId, err)
                return r
              }
              const delay = is500 ? 5000 : is404 ? 4000 : 3000 * (r + 1)
              setTimeout(() => hls.startLoad(), delay)
              return r + 1
            })
          } else {
            const err: CameraPlaybackError = {
              code: errorCode,
              message: data.reason || 'Error fatal del player',
              technicalDetail: `${data.type} / ${data.details}`,
            }
            setStatus('error')
            setInternalError(err)
            if (cameraId) onStreamError?.(cameraId, err)
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
    if (error || externalError) {
      if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
      hlsRef.current?.destroy()
      hlsRef.current = null
      setStatus('error')
      return
    }
    if (!hlsUrl) {
      // hlsUrl cleared (session stopped) — destroy HLS so it stops making requests
      if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
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
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [hlsUrl, error, externalError, initPlayer])

  const handleRetry = () => {
    setRetryCount(0)
    setInternalError(null)
    initPlayer()
  }

  const activeError = displayError
  const errCfg = activeError ? ERROR_CONFIG[activeError.code] : null

  return (
    <div
      className={clsx('relative bg-black overflow-hidden group rounded-lg', className)}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
      onDoubleClick={() => onFullscreen?.()}
    >
      <video ref={videoRef} className="w-full h-full object-contain" muted={muted} autoPlay playsInline />

      {/* Loading */}
      {status === 'loading' && !activeError && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-900/80">
          <Loader2 size={24} className="text-surface-400 animate-spin" />
        </div>
      )}

      {/* Error overlay — muestra causa técnica real */}
      {(status === 'error' || !!activeError || (error && status !== 'playing')) && (() => {
        const isHevcMain = streamType === 'main' && (
          activeError?.code === 'CODEC_UNSUPPORTED' ||
          (streamCodec || '').toLowerCase().includes('hevc') ||
          (streamCodec || '').toLowerCase().includes('h.265') ||
          (streamCodec || '').toLowerCase().includes('h265')
        )
        return (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-900/95 gap-2 px-3">
            {isHevcMain ? (
              <>
                <Film size={18} className="text-amber-400" />
                <p className="text-xs font-medium text-amber-300 text-center">H.265/HEVC no compatible</p>
                <p className="text-[10px] text-surface-400 text-center leading-snug max-w-[200px]">
                  El flujo principal está en H.265/HEVC. Para alta calidad web se requiere H.264 o transcodificación.
                </p>
                <div className="flex gap-1.5 mt-1">
                  {onQualitySwitch && (
                    <button
                      onClick={() => onQualitySwitch('sub')}
                      className="btn-ghost text-[10px] px-2 py-1 text-brand-400 hover:text-brand-300"
                    >
                      Usar baja calidad
                    </button>
                  )}
                  <button
                    onClick={() => onQualitySwitch ? onQualitySwitch('main') : handleRetry()}
                    className="btn-ghost text-[10px] px-2 py-1"
                  >
                    <RefreshCw size={10} /> Reintentar alta calidad
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
                  <button onClick={handleRetry} className="btn-ghost text-[10px] px-2 py-1">
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
            <span className="text-[9px] text-surface-300 font-medium leading-none">
              {streamType === 'main' ? 'Main' : 'Sub'}
              {streamResolution && ` ${formatResolution(streamResolution)}`}
              {streamCodec && ` ${formatBadgeCodec(streamCodec)}`}
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
              className={clsx('text-[9px] px-1.5 py-0.5 transition-colors',
                streamType === 'sub' ? 'bg-brand-600 text-white' : 'text-surface-300 hover:text-white')}
              title="Baja calidad (substream H.264)"
            >
              Baja
            </button>
            <button
              onClick={() => onQualitySwitch('main')}
              className={clsx('text-[9px] px-1.5 py-0.5 transition-colors',
                streamType === 'main' ? 'bg-brand-600 text-white' : 'text-surface-300 hover:text-white')}
              title="Alta calidad (stream principal)"
            >
              Alta
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
