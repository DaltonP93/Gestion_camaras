// apps/web/src/components/recordings/RecordingTimeline.tsx
import { useMemo, useRef, useCallback } from 'react'
import { clsx } from 'clsx'
import { format } from 'date-fns'
import type { RecordingWithCamera } from './types'

// Display NVR timestamps in UTC — same formula as RecordingsPage.formatNvrTime
function nvrTimeMs(epochMs: number): number {
  return epochMs + new Date(epochMs).getTimezoneOffset() * 60_000
}
function formatNvrTime(epochMs: number, fmt: string): string {
  return format(new Date(nvrTimeMs(epochMs)), fmt)
}

interface AssignedCamera {
  cameraId:   string
  cameraName: string
  nvrName:    string
  slotIndex:  number
}

interface Props {
  recordings: RecordingWithCamera[]
  /** Cameras assigned to slots — always show a row even with no recordings */
  assignedCameras: AssignedCamera[]
  selectedRec: RecordingWithCamera | null
  /** Visible window bounds (epoch ms, UTC) */
  windowStartMs: number
  windowEndMs: number
  onSelectRecording: (rec: RecordingWithCamera) => void
  globalTime?: Date | null
  /** Called on every mousemove — fast playhead update only, no preview restart */
  onPreviewTimeChange?: (time: Date) => void
  /** Called on mouseup — full seek commit, may restart preview stream */
  onCommitSeekTime?: (time: Date) => void
}

function getTickInterval(totalMs: number): number {
  if (totalMs <= 2 * 3600_000)   return 15 * 60_000
  if (totalMs <= 6 * 3600_000)   return 30 * 60_000
  if (totalMs <= 24 * 3600_000)  return 60 * 60_000
  if (totalMs <= 72 * 3600_000)  return 6 * 3600_000
  return 24 * 3600_000
}

function generateTicks(rangeStart: number, rangeEnd: number, intervalMs: number) {
  const ticks: { time: number; label: string }[] = []
  const first = Math.ceil(rangeStart / intervalMs) * intervalMs
  const spansDays = (rangeEnd - rangeStart) > 24 * 3600_000
  for (let t = first; t <= rangeEnd; t += intervalMs) {
    ticks.push({
      time: t,
      label: spansDays
        ? formatNvrTime(t, 'dd HH:mm')
        : formatNvrTime(t, 'HH:mm'),
    })
  }
  return ticks
}

const LABEL_W   = 130 // px — camera label column
const ROW_H     = 28  // px per camera row

export function RecordingTimeline({
  recordings, assignedCameras, selectedRec, windowStartMs, windowEndMs,
  onSelectRecording, globalTime, onPreviewTimeChange, onCommitSeekTime,
}: Props) {
  const rangeStart = windowStartMs
  const rangeEnd   = windowEndMs
  const totalMs    = rangeEnd - rangeStart

  // Build ordered rows: assigned slots first (preserve slot order), then extra cameras from recordings
  const rows = useMemo(() => {
    if (totalMs <= 0) return []

    // Map cameraId → recordings
    const recsByCam = new Map<string, RecordingWithCamera[]>()
    recordings.forEach(r => {
      if (!recsByCam.has(r.cameraId)) recsByCam.set(r.cameraId, [])
      recsByCam.get(r.cameraId)!.push(r)
    })

    // Rows from assigned cameras first (slot order)
    const seen = new Set<string>()
    const result: Array<{
      cameraId: string; label: string; recs: RecordingWithCamera[]; slotIndex: number | null
    }> = []

    for (const ac of assignedCameras) {
      if (seen.has(ac.cameraId)) continue
      seen.add(ac.cameraId)
      result.push({
        cameraId:   ac.cameraId,
        label:      `${ac.nvrName} · ${ac.cameraName}`,
        recs:       recsByCam.get(ac.cameraId) ?? [],
        slotIndex:  ac.slotIndex,
      })
    }

    // Then any cameras from recordings not already shown
    recordings.forEach(r => {
      if (seen.has(r.cameraId)) return
      seen.add(r.cameraId)
      result.push({
        cameraId:  r.cameraId,
        label:     `${r.nvrName} · ${r.cameraName}`,
        recs:      recsByCam.get(r.cameraId)!,
        slotIndex: null,
      })
    })

    return result
  }, [recordings, assignedCameras, totalMs])

  const ticks = useMemo(() => {
    if (totalMs <= 0) return []
    return generateTicks(rangeStart, rangeEnd, getTickInterval(totalMs))
  }, [rangeStart, rangeEnd, totalMs])

  // ── Drag / click on track ────────────────────────────────────────────────────
  const isDraggingRef = useRef(false)
  const trackRef      = useRef<HTMLDivElement>(null)

  const timeFromX = useCallback((clientX: number): Date | null => {
    const el = trackRef.current
    if (!el || totalMs <= 0) return null
    const rect  = el.getBoundingClientRect()
    const x     = clientX - rect.left
    const ratio = Math.max(0, Math.min(1, x / rect.width))
    return new Date(rangeStart + ratio * totalMs)
  }, [rangeStart, totalMs])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!onPreviewTimeChange && !onCommitSeekTime) return
    e.preventDefault()
    isDraggingRef.current = true
    const t = timeFromX(e.clientX)
    if (t) onPreviewTimeChange?.(t)

    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return
      const t2 = timeFromX(ev.clientX)
      if (t2) onPreviewTimeChange?.(t2)
    }
    const onUp = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      const t3 = timeFromX(ev.clientX)
      if (t3) onCommitSeekTime?.(t3)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [onPreviewTimeChange, onCommitSeekTime, timeFromX])

  const showEmpty = totalMs <= 0 || rows.length === 0

  if (showEmpty) {
    return (
      <div className="h-20 flex items-center justify-center border-t border-surface-700 bg-surface-900">
        <p className="text-[11px] text-surface-600">
          {totalMs <= 0 ? 'Ventana de tiempo inválida' : 'Sin grabaciones — realiza una búsqueda'}
        </p>
      </div>
    )
  }

  const pct = (ms: number) =>
    `${Math.max(0, Math.min(100, (ms - rangeStart) / totalMs * 100)).toFixed(3)}%`
  const widthPct = (startMs: number, endMs: number) => {
    const clamped = Math.min(endMs, rangeEnd) - Math.max(startMs, rangeStart)
    return `${Math.max(0, clamped / totalMs * 100).toFixed(3)}%`
  }

  const playheadMs      = globalTime ? globalTime.getTime() : null
  const playheadVisible = playheadMs !== null && playheadMs >= rangeStart && playheadMs <= rangeEnd

  const maxRows = Math.min(rows.length, 6)
  const maxHeight = maxRows * ROW_H + 4 // +4 for bottom border

  return (
    <div className="flex flex-col select-none" style={{ minHeight: 0 }}>

      {/* ── Time axis ────────────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 border-b border-surface-700/60 h-6">
        <div style={{ width: LABEL_W }} className="flex-shrink-0 border-r border-surface-700/60 bg-surface-900" />
        <div
          ref={trackRef}
          className={clsx('flex-1 relative overflow-hidden bg-surface-900', (onPreviewTimeChange || onCommitSeekTime) && 'cursor-crosshair')}
          onMouseDown={handleMouseDown}
        >
          {ticks.map(tick => (
            <div
              key={tick.time}
              className="absolute top-0 h-full flex flex-col items-start pointer-events-none"
              style={{ left: pct(tick.time) }}
            >
              <div className="h-2 w-px bg-surface-700" />
              <span className="text-[9px] text-surface-600 pl-0.5 leading-none mt-0.5 whitespace-nowrap">
                {tick.label}
              </span>
            </div>
          ))}
          {/* Tick-row playhead */}
          {playheadVisible && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
              style={{ left: pct(playheadMs!) }}
            />
          )}
        </div>
      </div>

      {/* ── Camera rows ──────────────────────────────────────────────── */}
      <div className="overflow-y-auto" style={{ maxHeight }}>
        {rows.map(({ cameraId, label, recs, slotIndex }) => {
          const hasRecs = recs.length > 0
          return (
            <div key={cameraId} className="flex border-b border-surface-800/50" style={{ height: ROW_H }}>

              {/* Camera label */}
              <div
                className="flex-shrink-0 flex items-center gap-1.5 px-2 border-r border-surface-700/60 bg-surface-800/40"
                style={{ width: LABEL_W }}
                title={label}
              >
                {slotIndex !== null && (
                  <span className="text-[8px] px-1 rounded bg-surface-700 text-surface-500 flex-shrink-0 font-mono">
                    S{slotIndex + 1}
                  </span>
                )}
                <span className="text-[9px] text-surface-400 truncate">{label}</span>
              </div>

              {/* Track */}
              <div
                className={clsx(
                  'flex-1 relative',
                  hasRecs ? 'bg-surface-900' : 'bg-surface-900/50',
                  (onPreviewTimeChange || onCommitSeekTime) && 'cursor-crosshair'
                )}
                onMouseDown={handleMouseDown}
              >
                {!hasRecs && (
                  <div className="absolute inset-0 flex items-center px-2">
                    <span className="text-[8px] text-surface-700 italic">sin grabaciones en este rango</span>
                  </div>
                )}

                {recs.map(rec => {
                  const recStart    = new Date(rec.startTime).getTime()
                  const recEnd      = new Date(rec.endTime).getTime()
                  const isSelected  = selectedRec?.id === rec.id && selectedRec?.cameraId === rec.cameraId
                  const durationMin = Math.round((recEnd - recStart) / 60_000)

                  return (
                    <button
                      key={`${rec.cameraId}-${rec.id}`}
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); onSelectRecording(rec) }}
                      title={`${formatNvrTime(recStart, 'HH:mm:ss')} – ${formatNvrTime(recEnd, 'HH:mm:ss')} (${durationMin}min)`}
                      className={clsx(
                        'absolute top-1 bottom-1 rounded-sm transition-colors cursor-pointer',
                        isSelected
                          ? 'bg-brand-500/90 border border-brand-400 z-10'
                          : 'bg-brand-700/80 border border-brand-600/60 hover:bg-brand-500/80 hover:border-brand-400/70'
                      )}
                      style={{
                        left:     pct(recStart),
                        width:    widthPct(recStart, recEnd),
                        minWidth: 4,
                      }}
                    />
                  )
                })}

                {/* Per-row playhead */}
                {playheadVisible && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
                    style={{ left: pct(playheadMs!) }}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
