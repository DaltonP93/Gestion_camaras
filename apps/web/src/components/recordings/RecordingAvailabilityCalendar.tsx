// apps/web/src/components/recordings/RecordingAvailabilityCalendar.tsx
// iVMS-style calendar: marks the days that have recordings for a camera
// (ISAPI dailyDistribution) and lets the user jump straight to a day.
import { useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { apiGet } from '@/lib/api'

interface Props {
  cameraId: string
  cameraName: string
  /** Called with the picked day as datetime-local strings (00:00 → 23:59) */
  onPickDay: (startLocal: string, endLocal: string) => void
}

const WEEKDAYS = ['do', 'lu', 'ma', 'mi', 'ju', 'vi', 'sa']
const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

export function RecordingAvailabilityCalendar({ cameraId, cameraName, onPickDay }: Props) {
  const now = new Date()
  const [open, setOpen]           = useState(false)
  const [year, setYear]           = useState(now.getFullYear())
  const [month, setMonth]         = useState(now.getMonth() + 1) // 1-12
  const [days, setDays]           = useState<Set<number>>(new Set())
  const [loading, setLoading]     = useState(false)
  const [supported, setSupported] = useState(true)
  const popRef = useRef<HTMLDivElement>(null)

  // Load availability whenever popover opens or camera/month changes
  useEffect(() => {
    if (!open || !cameraId) return
    let cancelled = false
    setLoading(true)
    apiGet<{ days: number[]; supported: boolean }>('/recordings/calendar', {
      cameraId, year: String(year), month: String(month),
    })
      .then(res => {
        if (cancelled) return
        setDays(new Set(res.days))
        setSupported(res.supported)
      })
      .catch(() => { if (!cancelled) { setDays(new Set()); setSupported(false) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, cameraId, year, month])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const shiftMonth = (delta: number) => {
    let m = month + delta
    let y = year
    if (m < 1)  { m = 12; y-- }
    if (m > 12) { m = 1;  y++ }
    setMonth(m); setYear(y)
  }

  const pickDay = (day: number) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const d = `${year}-${pad(month)}-${pad(day)}`
    onPickDay(`${d}T00:00`, `${d}T23:59`)
    setOpen(false)
  }

  // Build the month grid
  const firstDow    = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={() => setOpen(o => !o)}
        title={`Días con grabación — ${cameraName}`}
        className={clsx(
          'flex items-center gap-1 text-[10px] px-1.5 py-1 rounded transition-colors',
          open
            ? 'bg-brand-700/60 text-brand-200'
            : 'bg-surface-700 text-surface-400 hover:text-surface-200 hover:bg-surface-600'
        )}
      >
        <CalendarDays size={11} />
        Días
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-60 rounded-lg border border-surface-600 bg-surface-800 shadow-2xl p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-surface-400 truncate pr-2" title={cameraName}>{cameraName}</span>
            <button onClick={() => setOpen(false)} className="p-0.5 text-surface-500 hover:text-surface-200"><X size={11} /></button>
          </div>

          <div className="flex items-center justify-between mb-2">
            <button onClick={() => shiftMonth(-1)} className="p-1 rounded text-surface-400 hover:text-surface-100 hover:bg-surface-700">
              <ChevronLeft size={12} />
            </button>
            <span className="text-[11px] font-medium text-surface-200">
              {MONTHS[month - 1]} {year}
            </span>
            <button onClick={() => shiftMonth(1)} className="p-1 rounded text-surface-400 hover:text-surface-100 hover:bg-surface-700">
              <ChevronRight size={12} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {WEEKDAYS.map(d => (
              <span key={d} className="text-center text-[8px] text-surface-600 uppercase">{d}</span>
            ))}
          </div>

          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 size={16} className="animate-spin text-surface-500" />
            </div>
          ) : (
            <div className="grid grid-cols-7 gap-0.5">
              {cells.map((day, i) => {
                if (day === null) return <span key={`e${i}`} />
                const hasRec = days.has(day)
                const isToday =
                  day === now.getDate() && month === now.getMonth() + 1 && year === now.getFullYear()
                return (
                  <button
                    key={day}
                    onClick={() => pickDay(day)}
                    title={hasRec ? 'Con grabaciones — clic para buscar este día' : 'Sin grabaciones registradas'}
                    className={clsx(
                      'relative h-7 rounded text-[10px] tabular-nums transition-colors',
                      hasRec
                        ? 'bg-brand-900/50 text-brand-200 font-semibold hover:bg-brand-700/60 border border-brand-700/50'
                        : 'text-surface-500 hover:bg-surface-700/60',
                      isToday && 'ring-1 ring-surface-400'
                    )}
                  >
                    {day}
                    {hasRec && (
                      <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-brand-400" />
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {!supported && !loading && (
            <p className="mt-2 text-[9px] text-amber-500/80">
              Este NVR no expone el calendario de grabaciones por ISAPI.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
