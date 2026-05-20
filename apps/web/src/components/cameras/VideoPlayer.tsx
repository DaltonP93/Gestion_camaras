// src/components/cameras/VideoPlayer.tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import type { ErrorData } from 'hls.js'
import {
  Maximize2, Volume2, VolumeX, RefreshCw,
  Circle, AlertTriangle, Loader2, Stethoscope,
  WifiOff, Lock, Clock, Film, Server
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
  PLAYER_TIMEOUT:          { icon: <Clock size={16} />,        label: 'Sin frames (timeout)',        color: 'text-surface-400' },
  UNKNOWN:                 { icon: <AlertTriangle size={16} />, label: 'Error desconocido',          color: 'text-surface-400' },
}

function classifyHlsError(data: ErrorData): CameraPlaybackErrorCode {
  if (data.response?.code === 401) return 'RTSP_UNAUTHORIZED'
  if (data.response?.code === 404) return 'HLS_MANIFEST_NOT_FOUND'
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
  className?: string
  error?: boolean
  playbackError?: CameraPlaybackError
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
  className,
  error,
  playbackError: externalError,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const firstFrameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
        // Timeout si no llegan frames tras 15s
        firstFrameTimer.current = setTimeout(() => {
          if (status !== 'playing') {
            const err: CameraPlaybackError = { code: 'PLAYER_TIMEOUT', message: 'Sin frames tras 15 segundos', technicalDetail: hlsUrl }
            setStatus('error')
            setInternalError(err)
            if (cameraId) onStreamError?.(cameraId, err)
          }
        }, 15000)
      })

      hls.on(Hls.Events.FRAG_LOADED, () => {
        if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
        setStatus('playing')
        setInternalError(null)
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          const errorCode = classifyHlsError(data)
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setRetryCount((r) => {
              if (r >= 5) {
                const err: CameraPlaybackError = {
                  code: errorCode,
                  message: 'Sin respuesta del servidor de streaming',
                  technicalDetail: `Fatal network error. URL: ${hlsUrl}`,
                }
                setStatus('error')
                setInternalError(err)
                // Notify parent so it can release the backend session
                if (cameraId) onStreamError?.(cameraId, err)
                return r
              }
              // Exponential backoff retry via startLoad (keeps HLS session)
              setTimeout(() => hls.startLoad(), 3000 * (r + 1))
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
            // Notify parent on all fatal non-network errors (401, 404, media errors)
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
      hlsRef.current?.destroy()
      setStatus('error')
      return
    }
    if (!hlsUrl) {
      setStatus('loading')
      return
    }
    initPlayer()
    return () => {
      if (firstFrameTimer.current) clearTimeout(firstFrameTimer.current)
      hlsRef.current?.destroy()
    }
  }, [hlsUrl, error, initPlayer])

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
      {(status === 'error' || (error && status !== 'playing')) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-900/95 gap-2 px-3">
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
        </div>
      )}

      {/* REC indicator */}
      {isRecording && status === 'playing' && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 px-1.5 py-0.5 rounded">
          <Circle size={6} className="fill-brand-500 text-brand-500 rec-indicator" />
          <span className="text-xs text-brand-400 font-medium">REC</span>
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
      </div>
    </div>
  )
}
