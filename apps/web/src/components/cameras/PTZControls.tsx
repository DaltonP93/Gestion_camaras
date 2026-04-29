// src/components/cameras/PTZControls.tsx
import { useState } from 'react'
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Square } from 'lucide-react'
import { apiPost } from '@/lib/api'
import { clsx } from 'clsx'
import toast from 'react-hot-toast'

interface Props { cameraId: string }

type PTZCommand = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'ZOOM_IN' | 'ZOOM_OUT' | 'STOP'

export function PTZControls({ cameraId }: Props) {
  const [speed, setSpeed] = useState(50)
  const [active, setActive] = useState<PTZCommand | null>(null)

  const sendPTZ = async (command: PTZCommand) => {
    try {
      setActive(command)
      await apiPost(`/cameras/${cameraId}/ptz`, { command, speed })
    } catch {
      // Error manejado por interceptor
    } finally {
      setActive(null)
    }
  }

  const holdPTZ = (command: PTZCommand) => {
    let interval: ReturnType<typeof setInterval>
    const start = () => {
      sendPTZ(command)
      interval = setInterval(() => sendPTZ(command), 300)
    }
    const stop = () => {
      clearInterval(interval)
      sendPTZ('STOP')
    }
    return { onMouseDown: start, onMouseUp: stop, onMouseLeave: stop, onTouchStart: start, onTouchEnd: stop }
  }

  const btn = (command: PTZCommand, icon: React.ReactNode) => (
    <button
      className={clsx(
        'p-2 rounded-lg border border-surface-600 text-surface-300 transition-colors select-none',
        active === command
          ? 'bg-brand-600 border-brand-500 text-white'
          : 'bg-surface-700 hover:bg-surface-600 hover:text-surface-100'
      )}
      {...holdPTZ(command)}
    >
      {icon}
    </button>
  )

  return (
    <div className="w-36 flex-shrink-0 flex flex-col gap-3 p-3 bg-surface-800 border border-surface-600 rounded-lg">
      <div className="text-xs font-medium text-surface-400 text-center">Control PTZ</div>

      {/* Direccional */}
      <div className="grid grid-cols-3 gap-1 justify-items-center">
        <div />
        {btn('UP', <ChevronUp size={14} />)}
        <div />
        {btn('LEFT', <ChevronLeft size={14} />)}
        <button
          onClick={() => sendPTZ('STOP')}
          className="p-2 rounded-lg bg-surface-700 border border-surface-600 text-surface-400 hover:text-red-400 transition-colors"
        >
          <Square size={12} />
        </button>
        {btn('RIGHT', <ChevronRight size={14} />)}
        <div />
        {btn('DOWN', <ChevronDown size={14} />)}
        <div />
      </div>

      <div className="h-px bg-surface-600" />

      {/* Zoom */}
      <div className="flex gap-1">
        {btn('ZOOM_IN',  <ZoomIn size={14} />)}
        {btn('ZOOM_OUT', <ZoomOut size={14} />)}
      </div>

      {/* Velocidad */}
      <div>
        <div className="text-xs text-surface-500 mb-1">Velocidad: {speed}%</div>
        <input
          type="range"
          min={10}
          max={100}
          step={10}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="w-full accent-brand-600"
        />
      </div>
    </div>
  )
}
