// apps/web/src/components/RecordingPlaybackControls.tsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement | null>
}

const FORWARD_RATES  = [1, 1.5, 2, 4, 8, 12]
const REVERSE_RATES  = [-1.5, -2, -4, -6]
const REVERSE_TICK_MS = 100  // seek loop interval — 100ms gives smooth backward motion

export function RecordingPlaybackControls({ videoRef }: Props) {
  const [currentRate, setCurrentRate]   = useState(1)
  const reverseIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopReverse = useCallback((reason: string) => {
    if (reverseIntervalRef.current !== null) {
      clearInterval(reverseIntervalRef.current)
      reverseIntervalRef.current = null
      console.info(`[recordings-ui] reverse_playback_stop reason=${reason}`)
    }
  }, [])

  const applyForwardRate = useCallback((rate: number) => {
    const video = videoRef.current
    if (!video) return
    stopReverse('forward_selected')
    video.playbackRate = rate
    if ('preservesPitch' in video) (video as any).preservesPitch = false
    video.play().catch(() => {})
    setCurrentRate(rate)
    console.info(`[recordings-ui] playback_rate_set rate=${rate}`)
  }, [videoRef, stopReverse])

  const startReverse = useCallback((rate: number) => {   // rate is negative
    const video = videoRef.current
    if (!video) return
    stopReverse('new_rate')
    video.pause()
    setCurrentRate(rate)
    console.info(`[recordings-ui] reverse_playback_start rate=${rate}`)

    const step = (REVERSE_TICK_MS / 1000) * Math.abs(rate)
    const id = setInterval(() => {
      const v = videoRef.current
      if (!v) { clearInterval(id); return }
      // Safety: if superseded by a newer interval, self-destruct
      if (reverseIntervalRef.current !== id) { clearInterval(id); return }
      const next = v.currentTime - step
      if (next <= 0) {
        v.currentTime = 0
        // Clear ref BEFORE calling play() so the play-event handler doesn't re-cancel
        clearInterval(id)
        reverseIntervalRef.current = null
        console.info('[recordings-ui] reverse_playback_stop reason=start_of_video')
        setCurrentRate(1)
        v.playbackRate = 1
        v.play().catch(() => {})
      } else {
        v.currentTime = next
      }
    }, REVERSE_TICK_MS)

    reverseIntervalRef.current = id
  }, [videoRef, stopReverse])

  const seekRelative = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video) return
    const next = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds))
    video.currentTime = next
    console.info(`[recordings-ui] seek_relative seconds=${seconds}`)
  }, [videoRef])

  // Cancel reverse when the user triggers a play event from native controls
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlay = () => {
      // Only intervene if our reverse loop is currently running
      if (reverseIntervalRef.current !== null) {
        stopReverse('user_play_event')
        setCurrentRate(1)
        video.playbackRate = 1
      }
    }
    video.addEventListener('play', onPlay)
    return () => video.removeEventListener('play', onPlay)
  }, [videoRef, stopReverse])

  // Cancel reverse on unmount (new recording loaded, recording stopped)
  useEffect(() => () => stopReverse('unmount'), [stopReverse])

  const rateLabel = currentRate > 0 ? `${currentRate}×` : `${currentRate}×`

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 bg-surface-800/40 border-t border-surface-700">
      {/* Row 1: seek shortcuts + speed badge */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => seekRelative(-30)}
          title="Retroceder 30 segundos"
          className="btn-ghost text-[10px] px-1.5 py-1 flex items-center gap-0.5"
        >
          <ChevronLeft size={10} />30s
        </button>
        <button
          onClick={() => seekRelative(-10)}
          title="Retroceder 10 segundos"
          className="btn-ghost text-[10px] px-1.5 py-1 flex items-center gap-0.5"
        >
          <ChevronLeft size={10} />10s
        </button>

        <div className="flex-1 flex justify-center">
          <span className={clsx(
            'text-[11px] font-mono font-bold px-2 py-0.5 rounded-full border',
            currentRate < 0
              ? 'bg-brand-900/60 border-brand-600 text-brand-300'
              : currentRate > 1
                ? 'bg-surface-700 border-surface-500 text-surface-100'
                : 'bg-surface-800 border-surface-700 text-surface-400'
          )}>
            {rateLabel}
          </span>
        </div>

        <button
          onClick={() => seekRelative(10)}
          title="Avanzar 10 segundos"
          className="btn-ghost text-[10px] px-1.5 py-1 flex items-center gap-0.5"
        >
          10s<ChevronRight size={10} />
        </button>
        <button
          onClick={() => seekRelative(30)}
          title="Avanzar 30 segundos"
          className="btn-ghost text-[10px] px-1.5 py-1 flex items-center gap-0.5"
        >
          30s<ChevronRight size={10} />
        </button>
      </div>

      {/* Row 2: speed selector */}
      <div className="flex items-center gap-1 justify-center flex-wrap">
        {REVERSE_RATES.map(rate => (
          <button
            key={rate}
            onClick={() => startReverse(rate)}
            title={`Retroceder a ${Math.abs(rate)}×`}
            className={clsx(
              'text-[10px] px-2 py-0.5 rounded border transition-colors',
              currentRate === rate
                ? 'bg-brand-700/80 border-brand-500 text-brand-100'
                : 'bg-surface-800 border-surface-700 text-surface-500 hover:text-surface-200 hover:border-surface-600'
            )}
          >
            {rate}×
          </button>
        ))}
        <div className="w-px h-4 bg-surface-700 mx-0.5 self-center flex-shrink-0" />
        {FORWARD_RATES.map(rate => (
          <button
            key={rate}
            onClick={() => applyForwardRate(rate)}
            title={`Reproducir a ${rate}×`}
            className={clsx(
              'text-[10px] px-2 py-0.5 rounded border transition-colors',
              currentRate === rate
                ? 'bg-surface-600 border-surface-400 text-surface-100'
                : 'bg-surface-800 border-surface-700 text-surface-500 hover:text-surface-200 hover:border-surface-600'
            )}
          >
            {rate}×
          </button>
        ))}
      </div>
    </div>
  )
}
