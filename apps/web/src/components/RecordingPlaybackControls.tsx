// apps/web/src/components/RecordingPlaybackControls.tsx
import { useEffect, useState, useCallback } from 'react'
import { clsx } from 'clsx'
import {
  ChevronLeft, ChevronRight, Play, Pause, SkipForward,
} from 'lucide-react'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement | null>
}

const SPEEDS: { value: number; label: string }[] = [
  { value: 1 / 16, label: '1/16×' },
  { value: 1 / 8,  label: '1/8×'  },
  { value: 1 / 4,  label: '1/4×'  },
  { value: 1 / 2,  label: '1/2×'  },
  { value: 1,      label: '1×'    },
  { value: 2,      label: '2×'    },
  { value: 4,      label: '4×'    },
  { value: 8,      label: '8×'    },
  { value: 16,     label: '16×'   },
]

function formatTime(secs: number): string {
  if (!isFinite(secs) || isNaN(secs)) return '--:--'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function RecordingPlaybackControls({ videoRef }: Props) {
  const [paused, setPaused]           = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration]       = useState(0)
  const [currentRate, setCurrentRate] = useState(1)

  // Sync UI state from native video events
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onPlay     = () => setPaused(false)
    const onPause    = () => setPaused(true)
    const onTimeup   = () => setCurrentTime(video.currentTime)
    const onMeta     = () => { setDuration(video.duration); setCurrentTime(video.currentTime) }
    const onDuration = () => setDuration(video.duration)
    const onRate     = () => setCurrentRate(video.playbackRate)

    setPaused(video.paused)
    setCurrentTime(video.currentTime)
    setDuration(video.duration || 0)
    setCurrentRate(video.playbackRate)

    video.addEventListener('play',             onPlay)
    video.addEventListener('pause',            onPause)
    video.addEventListener('timeupdate',       onTimeup)
    video.addEventListener('loadedmetadata',   onMeta)
    video.addEventListener('durationchange',   onDuration)
    video.addEventListener('ratechange',       onRate)

    return () => {
      video.removeEventListener('play',           onPlay)
      video.removeEventListener('pause',          onPause)
      video.removeEventListener('timeupdate',     onTimeup)
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('durationchange', onDuration)
      video.removeEventListener('ratechange',     onRate)
    }
  }, [videoRef])

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [videoRef])

  const frameForward = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 1 / 25)
    console.info('[recordings-ui] frame_forward')
  }, [videoRef])

  const seekRelative = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds))
    console.info(`[recordings-ui] seek_relative seconds=${seconds}`)
  }, [videoRef])

  const applyRate = useCallback((rate: number) => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = rate
    if ('preservesPitch' in video) (video as any).preservesPitch = false
    setCurrentRate(rate)
    console.info(`[recordings-ui] playback_rate_set rate=${rate}`)
  }, [videoRef])

  const currentSpeed = SPEEDS.find(s => Math.abs(s.value - currentRate) < 0.001) ?? null

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 bg-surface-800/50 border-t border-surface-700">
      {/* Row 1: transport controls + time display */}
      <div className="flex items-center gap-1">

        {/* Jump back */}
        <button
          onClick={() => seekRelative(-30)}
          title="Retroceder 30 s"
          className="btn-ghost text-[10px] px-1.5 py-1 flex items-center gap-0.5 tabular-nums"
        >
          <ChevronLeft size={10} />30s
        </button>
        <button
          onClick={() => seekRelative(-10)}
          title="Retroceder 10 s"
          className="btn-ghost text-[10px] px-1.5 py-1 flex items-center gap-0.5 tabular-nums"
        >
          <ChevronLeft size={10} />10s
        </button>

        {/* Play / Pause */}
        <button
          onClick={togglePlayPause}
          title={paused ? 'Reproducir' : 'Pausar'}
          className="btn-ghost p-1.5 rounded-full"
        >
          {paused
            ? <Play  size={14} className="text-brand-400 fill-brand-400" />
            : <Pause size={14} className="text-surface-300" />
          }
        </button>

        {/* Jump forward */}
        <button
          onClick={() => seekRelative(10)}
          title="Avanzar 10 s"
          className="btn-ghost text-[10px] px-1.5 py-1 flex items-center gap-0.5 tabular-nums"
        >
          10s<ChevronRight size={10} />
        </button>
        <button
          onClick={() => seekRelative(30)}
          title="Avanzar 30 s"
          className="btn-ghost text-[10px] px-1.5 py-1 flex items-center gap-0.5 tabular-nums"
        >
          30s<ChevronRight size={10} />
        </button>

        {/* Divider */}
        <div className="w-px h-4 bg-surface-700 mx-0.5 self-center flex-shrink-0" />

        {/* Frame forward */}
        <button
          onClick={frameForward}
          title="Avanzar un fotograma"
          className="btn-ghost p-1.5 flex items-center gap-0.5"
        >
          <SkipForward size={12} className="text-surface-400" />
        </button>

        {/* Divider */}
        <div className="w-px h-4 bg-surface-700 mx-0.5 self-center flex-shrink-0" />

        {/* Time display */}
        <span className="text-[10px] font-mono text-surface-400 tabular-nums px-1">
          {formatTime(currentTime)}
          <span className="text-surface-600"> / </span>
          {formatTime(duration)}
        </span>

        {/* Spacer + current speed badge */}
        <div className="flex-1" />
        <span className={clsx(
          'text-[11px] font-mono font-bold px-2 py-0.5 rounded-full border flex-shrink-0',
          currentRate > 1
            ? 'bg-surface-700 border-surface-500 text-surface-100'
            : currentRate < 1
              ? 'bg-brand-900/60 border-brand-600 text-brand-300'
              : 'bg-surface-800 border-surface-700 text-surface-400'
        )}>
          {currentSpeed?.label ?? `${currentRate}×`}
        </span>
      </div>

      {/* Row 2: speed selector */}
      <div className="flex items-center gap-1 justify-center flex-wrap">
        {SPEEDS.map(({ value, label }) => (
          <button
            key={label}
            onClick={() => applyRate(value)}
            title={`Velocidad ${label}`}
            className={clsx(
              'text-[10px] px-2 py-0.5 rounded border transition-colors',
              Math.abs(currentRate - value) < 0.001
                ? 'bg-surface-600 border-surface-400 text-surface-100'
                : 'bg-surface-800 border-surface-700 text-surface-500 hover:text-surface-200 hover:border-surface-600'
            )}
          >
            {label}
          </button>
        ))}
        <div className="w-px h-4 bg-surface-700 mx-0.5 self-center flex-shrink-0" />
        <button
          onClick={() => applyRate(1)}
          title="Volver a velocidad normal"
          className="text-[10px] px-2 py-0.5 rounded border border-surface-700 bg-surface-800 text-surface-500 hover:text-surface-200 hover:border-surface-600 transition-colors"
        >
          reset
        </button>
      </div>
    </div>
  )
}
