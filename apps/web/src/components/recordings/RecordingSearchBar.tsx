// apps/web/src/components/recordings/RecordingSearchBar.tsx
import { useRef } from 'react'
import { clsx } from 'clsx'
import { Calendar, Search, Loader2 } from 'lucide-react'
import { subDays, subHours, startOfDay, endOfDay } from 'date-fns'
import type { PlaybackLayout } from './types'
import { RecordingAvailabilityCalendar } from './RecordingAvailabilityCalendar'

interface Props {
  startDate: string
  endDate: string
  onStartDateChange: (v: string) => void
  onEndDateChange: (v: string) => void
  onSearch: () => void
  /** Called when a quick preset is chosen — passes from/to so the page can search without stale state */
  onQuickSearch?: (from: string, to: string) => void
  isSearching: boolean
  cameraCount: number
  layout: PlaybackLayout
  onLayoutChange: (v: PlaybackLayout) => void
  /** Camera to query the recording-days calendar for (single selected camera) */
  availabilityCameraId?: string | null
  availabilityCameraName?: string
}

function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const QUICK_PRESETS = [
  { label: 'Últ. 4h', from: () => subHours(new Date(), 4),          to: () => new Date() },
  { label: 'Hoy',     from: () => startOfDay(new Date()),            to: () => new Date() },
  { label: 'Ayer',    from: () => startOfDay(subDays(new Date(), 1)),to: () => endOfDay(subDays(new Date(), 1)) },
  { label: '7d',      from: () => startOfDay(subDays(new Date(), 7)),to: () => new Date() },
]

const LAYOUTS: { value: PlaybackLayout; label: string; title: string }[] = [
  { value: '1x1', label: '1×1', title: 'Una cámara' },
  { value: '2x2', label: '2×2', title: 'Cuatro cámaras' },
  { value: '3x3', label: '3×3', title: 'Nueve cámaras' },
  { value: '4x4', label: '4×4', title: 'Dieciséis cámaras' },
]

export function RecordingSearchBar({
  startDate, endDate,
  onStartDateChange, onEndDateChange,
  onSearch, onQuickSearch, isSearching, cameraCount,
  layout, onLayoutChange,
  availabilityCameraId, availabilityCameraName,
}: Props) {
  const startRef = useRef<HTMLInputElement>(null)
  const endRef   = useRef<HTMLInputElement>(null)

  const triggerPicker = (ref: React.RefObject<HTMLInputElement | null>) => {
    const el = ref.current
    if (!el) return
    try { ;(el as any).showPicker?.() } catch { el.focus() }
  }

  const setQuick = (from: Date, to: Date) => {
    const fromStr = toLocalDatetimeString(from)
    const toStr   = toLocalDatetimeString(to)
    onStartDateChange(fromStr)
    onEndDateChange(toStr)
    // Auto-search if cameras are available — pass dates directly to avoid stale state
    if (cameraCount > 0 && !isSearching && onQuickSearch) {
      onQuickSearch(fromStr, toStr)
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-700 bg-surface-800/40 flex-wrap">

      {/* Date range */}
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <input
            ref={startRef}
            type="datetime-local"
            value={startDate}
            onChange={e => onStartDateChange(e.target.value)}
            className="text-[11px] bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 pr-7 text-surface-200 focus:outline-none focus:border-brand-600 w-[180px]"
          />
          <button
            type="button"
            onClick={() => triggerPicker(startRef)}
            tabIndex={-1}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 transition-colors"
          >
            <Calendar size={12} />
          </button>
        </div>

        <span className="text-surface-600 text-xs flex-shrink-0">→</span>

        <div className="relative">
          <input
            ref={endRef}
            type="datetime-local"
            value={endDate}
            onChange={e => onEndDateChange(e.target.value)}
            className="text-[11px] bg-surface-800 border border-surface-700 rounded-md px-2 py-1.5 pr-7 text-surface-200 focus:outline-none focus:border-brand-600 w-[180px]"
          />
          <button
            type="button"
            onClick={() => triggerPicker(endRef)}
            tabIndex={-1}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 transition-colors"
          >
            <Calendar size={12} />
          </button>
        </div>
      </div>

      {/* Quick presets */}
      <div className="flex items-center gap-1">
        {QUICK_PRESETS.map(({ label, from, to }) => (
          <button
            key={label}
            onClick={() => setQuick(from(), to())}
            className="text-[10px] px-1.5 py-1 rounded bg-surface-700 text-surface-400 hover:text-surface-200 hover:bg-surface-600 transition-colors"
          >
            {label}
          </button>
        ))}
        {/* iVMS-style recording-days calendar — shown when a single camera is selected */}
        {availabilityCameraId && (
          <RecordingAvailabilityCalendar
            cameraId={availabilityCameraId}
            cameraName={availabilityCameraName ?? 'Cámara'}
            onPickDay={(fromStr, toStr) => {
              onStartDateChange(fromStr)
              onEndDateChange(toStr)
              if (cameraCount > 0 && !isSearching && onQuickSearch) onQuickSearch(fromStr, toStr)
            }}
          />
        )}
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-surface-700 mx-0.5 flex-shrink-0" />

      {/* Layout selector */}
      <div className="flex items-center gap-0.5">
        {LAYOUTS.map(({ value, label, title }) => (
          <button
            key={value}
            onClick={() => onLayoutChange(value)}
            title={title}
            className={clsx(
              'text-[10px] px-2 py-1 rounded transition-colors font-mono',
              layout === value
                ? 'bg-surface-600 text-surface-100 border border-surface-500'
                : 'text-surface-500 hover:text-surface-300 hover:bg-surface-700/60'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Search button */}
      <button
        onClick={onSearch}
        disabled={isSearching || cameraCount === 0}
        className={clsx(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
          'bg-brand-600 hover:bg-brand-500 text-white',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {isSearching
          ? <Loader2 size={12} className="animate-spin" />
          : <Search size={12} />
        }
        {isSearching ? 'Buscando…' : cameraCount === 0 ? 'Selecciona cámaras' : 'Buscar'}
      </button>
    </div>
  )
}
