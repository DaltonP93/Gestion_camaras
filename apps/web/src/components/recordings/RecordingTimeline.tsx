// apps/web/src/components/recordings/RecordingTimeline.tsx
import { useMemo } from 'react'
import { clsx } from 'clsx'
import { format } from 'date-fns'
import type { RecordingWithCamera } from './types'

interface Props {
  recordings: RecordingWithCamera[]
  selectedRec: RecordingWithCamera | null
  startDate: string
  endDate: string
  onSelectRecording: (rec: RecordingWithCamera) => void
}

function getTickInterval(totalMs: number): number {
  if (totalMs <= 2 * 3600_000)   return 15 * 60_000   // every 15min
  if (totalMs <= 6 * 3600_000)   return 30 * 60_000   // every 30min
  if (totalMs <= 24 * 3600_000)  return 60 * 60_000   // every 1h
  if (totalMs <= 72 * 3600_000)  return 6 * 3600_000  // every 6h
  return 24 * 3600_000                                  // every 24h
}

function generateTicks(rangeStart: number, rangeEnd: number, intervalMs: number) {
  const ticks: { time: number; label: string }[] = []
  // Start at first tick boundary after rangeStart
  const first = Math.ceil(rangeStart / intervalMs) * intervalMs
  const spansDays = (rangeEnd - rangeStart) > 24 * 3600_000
  for (let t = first; t <= rangeEnd; t += intervalMs) {
    ticks.push({
      time: t,
      label: spansDays
        ? format(new Date(t), 'dd HH:mm')
        : format(new Date(t), 'HH:mm'),
    })
  }
  return ticks
}

const LABEL_W = 120 // px — left label column width

export function RecordingTimeline({
  recordings, selectedRec, startDate, endDate, onSelectRecording,
}: Props) {
  const rangeStart = useMemo(() => new Date(startDate).getTime(), [startDate])
  const rangeEnd   = useMemo(() => new Date(endDate).getTime(),   [endDate])
  const totalMs    = rangeEnd - rangeStart

  // Group recordings by NVR + camera
  const groups = useMemo(() => {
    if (totalMs <= 0) return []
    const map = new Map<string, { label: string; recs: RecordingWithCamera[] }>()
    recordings.forEach(rec => {
      const key = `${rec.nvrName}||${rec.cameraId}`
      if (!map.has(key)) {
        map.set(key, { label: `${rec.nvrName} · ${rec.cameraName}`, recs: [] })
      }
      map.get(key)!.recs.push(rec)
    })
    return [...map.values()]
  }, [recordings, totalMs])

  const ticks = useMemo(() => {
    if (totalMs <= 0) return []
    return generateTicks(rangeStart, rangeEnd, getTickInterval(totalMs))
  }, [rangeStart, rangeEnd, totalMs])

  if (totalMs <= 0 || recordings.length === 0) {
    return (
      <div className="h-24 flex items-center justify-center">
        <p className="text-[11px] text-surface-600">
          {recordings.length === 0 ? 'Sin grabaciones — realiza una búsqueda' : 'Rango de fechas inválido'}
        </p>
      </div>
    )
  }

  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms - rangeStart) / totalMs * 100)).toFixed(3)}%`
  const widthPct = (startMs: number, endMs: number) => {
    const clamped = Math.min(endMs, rangeEnd) - Math.max(startMs, rangeStart)
    return `${Math.max(0, clamped / totalMs * 100).toFixed(3)}%`
  }

  return (
    <div className="flex flex-col select-none" style={{ minHeight: 0 }}>
      {/* Time axis */}
      <div className="flex flex-shrink-0 border-b border-surface-700/60 h-6">
        {/* Label column spacer */}
        <div style={{ width: LABEL_W }} className="flex-shrink-0 border-r border-surface-700/60" />
        {/* Ticks */}
        <div className="flex-1 relative overflow-hidden">
          {ticks.map(tick => (
            <div
              key={tick.time}
              className="absolute top-0 h-full flex flex-col items-start"
              style={{ left: pct(tick.time) }}
            >
              <div className="h-2 w-px bg-surface-700" />
              <span className="text-[9px] text-surface-600 pl-0.5 leading-none mt-0.5 whitespace-nowrap">
                {tick.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Camera rows */}
      <div className="overflow-y-auto" style={{ maxHeight: 112 }}>
        {groups.map(({ label, recs }) => (
          <div
            key={label}
            className="flex border-b border-surface-800/50 h-7"
          >
            {/* Label */}
            <div
              className="flex-shrink-0 flex items-center px-2 border-r border-surface-700/60 bg-surface-800/30"
              style={{ width: LABEL_W }}
            >
              <span className="text-[9px] text-surface-500 truncate" title={label}>
                {label}
              </span>
            </div>

            {/* Recording blocks */}
            <div className="flex-1 relative bg-surface-900">
              {recs.map(rec => {
                const recStart = new Date(rec.startTime).getTime()
                const recEnd   = new Date(rec.endTime).getTime()
                const isSelected = selectedRec?.id === rec.id && selectedRec?.cameraId === rec.cameraId
                const durationMin = Math.round((recEnd - recStart) / 60_000)

                return (
                  <button
                    key={`${rec.cameraId}-${rec.id}`}
                    onClick={() => onSelectRecording(rec)}
                    title={`${format(new Date(rec.startTime), 'HH:mm:ss')} – ${format(new Date(rec.endTime), 'HH:mm:ss')} (${durationMin}min)`}
                    className={clsx(
                      'absolute top-1 bottom-1 rounded-sm transition-colors cursor-pointer',
                      isSelected
                        ? 'bg-brand-500/90 border border-brand-400 z-10'
                        : 'bg-brand-800/70 border border-brand-700/50 hover:bg-brand-600/70 hover:border-brand-500/60'
                    )}
                    style={{
                      left: pct(recStart),
                      width: widthPct(recStart, recEnd),
                      minWidth: 3,
                    }}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
