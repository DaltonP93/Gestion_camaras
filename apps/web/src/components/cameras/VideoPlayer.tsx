// src/components/cameras/VideoPlayer.tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
import {
  Maximize2, Volume2, VolumeX, RefreshCw,
  Circle, AlertTriangle, Loader2
} from 'lucide-react'
import { clsx } from 'clsx'

interface Props {
  hlsUrl: string
  cameraName: string
  isRecording?: boolean
  onFullscreen?: () => void
  className?: string
  error?: boolean
}

type Status = 'loading' | 'playing' | 'error' | 'offline'

export function VideoPlayer({ hlsUrl, cameraName, isRecording, onFullscreen, className, error }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [muted, setMuted] = useState(true)
  const [showControls, setShowControls] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const initPlayer = useCallback(() => {
    if (!videoRef.current || !hlsUrl) return

    // Limpiar instancia anterior
    hlsRef.current?.destroy()
    setStatus('loading')

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        maxBufferLength: 60,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
      })

      hlsRef.current = hls

      hls.loadSource(hlsUrl)
      hls.attachMedia(videoRef.current)

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoRef.current?.play().catch(() => {})
        setStatus('playing')
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setRetryCount((r) => {
              if (r >= 5) {
                setStatus('offline')
                return r
              }
              // Destruir y reiniciar completamente tras un delay
              setTimeout(() => initPlayer(), 4000)
              return r + 1
            })
          } else {
            setStatus('error')
          }
        }
      })
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari nativo
      videoRef.current.src = hlsUrl
      videoRef.current.addEventListener('loadedmetadata', () => {
        videoRef.current?.play()
        setStatus('playing')
      })
      videoRef.current.addEventListener('error', () => setStatus('error'))
    } else {
      setStatus('error')
    }
  }, [hlsUrl, retryCount])

  useEffect(() => {
    if (error) {
      hlsRef.current?.destroy()
      setStatus('offline')
      return
    }
    if (!hlsUrl) {
      setStatus('loading')
      return
    }
    // Esperar a que MediaMTX conecte RTSP y bufferee el primer segmento
    const timer = setTimeout(() => initPlayer(), 1500)
    return () => {
      clearTimeout(timer)
      hlsRef.current?.destroy()
    }
  }, [hlsUrl, error])

  const handleRetry = () => {
    setRetryCount(0)
    initPlayer()
  }

  return (
    <div
      className={clsx('relative bg-black overflow-hidden group rounded-lg', className)}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
    >
      {/* Video */}
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        muted={muted}
        autoPlay
        playsInline
      />

      {/* Overlay de carga */}
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-900/80">
          <Loader2 size={24} className="text-surface-400 animate-spin" />
        </div>
      )}

      {/* Overlay de error */}
      {(status === 'error' || status === 'offline') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-900/90 gap-2">
          <AlertTriangle size={20} className="text-surface-500" />
          <span className="text-xs text-surface-500">
            {status === 'offline' ? 'Cámara sin señal' : 'Error de conexión'}
          </span>
          <button onClick={handleRetry} className="btn-ghost text-xs mt-1">
            <RefreshCw size={12} /> Reintentar
          </button>
        </div>
      )}

      {/* Indicador REC */}
      {isRecording && status === 'playing' && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 px-1.5 py-0.5 rounded">
          <Circle size={6} className="fill-brand-500 text-brand-500 rec-indicator" />
          <span className="text-xs text-brand-400 font-medium">REC</span>
        </div>
      )}

      {/* Nombre de cámara */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
        <span className="text-xs text-white/90 font-medium drop-shadow-sm">{cameraName}</span>
      </div>

      {/* Controles */}
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
        <button
          onClick={handleRetry}
          className="p-1 rounded bg-black/60 text-white hover:bg-black/80 transition-colors"
          title="Recargar stream"
        >
          <RefreshCw size={12} />
        </button>
        {onFullscreen && (
          <button
            onClick={onFullscreen}
            className="p-1 rounded bg-black/60 text-white hover:bg-black/80 transition-colors"
            title="Pantalla completa"
          >
            <Maximize2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
