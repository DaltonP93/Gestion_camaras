// src/pages/ViewPlayerPage.tsx
import { useEffect, useState, useRef, useCallback, type MutableRefObject } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, LayoutGrid, ChevronLeft, ChevronRight,
  Play, Pause, Globe, Lock, Monitor, AlertTriangle,
  Maximize2, Minimize2,
} from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { VideoPlayer } from '@/components/cameras/VideoPlayer'
import { clsx } from 'clsx'
import type { CameraView, CameraSlot, Camera, StreamInfo } from '@/types'

const LAYOUT_COLS: Record<string, number> = {
  '1x1': 1,
  '2x2': 2,
  '3x3': 3,
  '4x4': 4,
  'featured': 3,
  'custom': 3,
}

function getSlotsPerPage(layout: string): number {
  if (layout === '1x1') return 1
  if (layout === '2x2') return 4
  if (layout === '3x3') return 9
  if (layout === '4x4') return 16
  if (layout === 'featured') return 8
  return 9
}

interface SlotWithCamera extends CameraSlot {
  camera?: Camera
  stream?: StreamInfo
}

export function ViewPlayerPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)

  const [view, setView] = useState<CameraView | null>(null)
  const [slots, setSlots] = useState<SlotWithCamera[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Pagination/slideshow
  const slotsPerPage = view ? getSlotsPerPage(view.layout) : 9
  const filledSlots = slots.filter((s) => s.cameraId)
  const totalPages = Math.max(1, Math.ceil(filledSlots.length / slotsPerPage))
  const [currentPage, setCurrentPage] = useState(0)
  const [slideshowActive, setSlideshowActive] = useState(false)
  const slideshowRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fullscreen: which camera (by cameraId) is fullscreen, and the DOM node ref
  const [fullscreenCamId, setFullscreenCamId] = useState<string | null>(null)
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const enterFullscreen = useCallback((cameraId: string) => {
    const el = tileRefs.current.get(cameraId)
    if (el?.requestFullscreen) {
      el.requestFullscreen().then(() => setFullscreenCamId(cameraId)).catch(() => setFullscreenCamId(cameraId))
    } else {
      // Fallback: modal-style in-page fullscreen
      setFullscreenCamId(cameraId)
    }
  }, [])

  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
    setFullscreenCamId(null)
  }, [])

  // Sync native fullscreen exit (ESC key) with our state
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement) setFullscreenCamId(null)
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // Load view and cameras
  useEffect(() => {
    if (!id) return
    setIsLoading(true)
    setError(null)

    apiGet<CameraView>(`/views/${id}`)
      .then(async (v) => {
        setView(v)
        const assignedSlots = v.cameraSlots.filter((s) => s.cameraId)
        const assignedIds = assignedSlots.map((s) => s.cameraId!)

        const camerasArr = assignedIds.length > 0
          ? await apiPost<Camera[]>('/cameras/batch', { ids: assignedIds })
          : []
        const cameraMap = new Map<string, Camera>()
        camerasArr.forEach((c) => cameraMap.set(c.id, c))

        // Start streams for first-page cameras
        const perPage = getSlotsPerPage(v.layout)
        const firstPageIds = assignedIds.slice(0, perPage)
        const streamData = await Promise.allSettled(
          firstPageIds.map((cid) => apiPost<StreamInfo>(`/cameras/${cid}/start-stream`, {}))
        )
        const streamMap = new Map<string, StreamInfo>()
        streamData.forEach((r, i) => {
          if (r.status === 'fulfilled') streamMap.set(firstPageIds[i], r.value)
        })

        setSlots(v.cameraSlots.map((s) => ({
          ...s,
          camera: s.cameraId ? cameraMap.get(s.cameraId) : undefined,
          stream: s.cameraId ? streamMap.get(s.cameraId) : undefined,
        })))
      })
      .catch((e) => setError(e?.message ?? 'No se pudo cargar la vista'))
      .finally(() => setIsLoading(false))
  }, [id])

  // Load streams for newly visible cameras when page changes
  useEffect(() => {
    if (!view) return
    const perPage = getSlotsPerPage(view.layout)
    const pageIds = filledSlots
      .slice(currentPage * perPage, (currentPage + 1) * perPage)
      .map((s) => s.cameraId!)
      .filter((cid) => {
        const slot = slots.find((s) => s.cameraId === cid)
        return slot && !slot.stream
      })
    if (pageIds.length === 0) return

    Promise.allSettled(
      pageIds.map((cid) => apiPost<StreamInfo>(`/cameras/${cid}/start-stream`, {}))
    ).then((results) => {
      const loaded = new Map<string, StreamInfo>()
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') loaded.set(pageIds[i], r.value)
      })
      if (loaded.size > 0) {
        setSlots((prev) =>
          prev.map((s) => (s.cameraId && loaded.has(s.cameraId) ? { ...s, stream: loaded.get(s.cameraId) } : s))
        )
      }
    })
  }, [currentPage, view]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (view?.slideshowEnabled && totalPages > 1) setSlideshowActive(true)
  }, [view, totalPages])

  useEffect(() => {
    if (slideshowRef.current) clearInterval(slideshowRef.current)
    if (slideshowActive && view && totalPages > 1) {
      slideshowRef.current = setInterval(() => {
        setCurrentPage((p) => (p + 1) % totalPages)
      }, (view.slideshowInterval ?? 10) * 1000)
    }
    return () => { if (slideshowRef.current) clearInterval(slideshowRef.current) }
  }, [slideshowActive, view, totalPages])

  const prevPage = useCallback(() => setCurrentPage((p) => (p - 1 + totalPages) % totalPages), [totalPages])
  const nextPage = useCallback(() => setCurrentPage((p) => (p + 1) % totalPages), [totalPages])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-surface-400 text-sm">Cargando vista...</p>
        </div>
      </div>
    )
  }

  if (error || !view) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <AlertTriangle size={32} className="text-brand-400 mx-auto" />
          <p className="text-surface-200 text-sm font-medium">{error ?? 'Vista no encontrada'}</p>
          <button className="btn-secondary" onClick={() => navigate('/views')}>
            <ArrowLeft size={13} /> Volver a vistas
          </button>
        </div>
      </div>
    )
  }

  // Compute page slots
  const pageSlots = filledSlots.slice(currentPage * slotsPerPage, (currentPage + 1) * slotsPerPage)
  // Pad with empty slots only if layout requires a fixed count (not for responsive grids)
  while (pageSlots.length < slotsPerPage) {
    pageSlots.push({ slotIndex: -1, cameraId: null, size: 'normal' })
  }

  const cols = LAYOUT_COLS[view.layout] ?? 3
  const rows = Math.ceil(pageSlots.length / cols)
  const isFeatured = view.layout === 'featured'

  // The in-page fullscreen overlay (fallback when requestFullscreen is unavailable)
  const fullscreenSlot = fullscreenCamId
    ? pageSlots.find((s) => s.cameraId === fullscreenCamId)
    : null

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-black select-none">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 bg-surface-900/90 backdrop-blur-sm border-b border-surface-700/50 flex-shrink-0">
        <button
          onClick={() => navigate('/views')}
          className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700 transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <LayoutGrid size={14} className="text-brand-400" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-surface-100 truncate">{view.name}</div>
          {view.description && (
            <div className="text-xs text-surface-500 truncate">{view.description}</div>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-surface-400 flex-shrink-0">
          <Monitor size={11} />
          <span>{filledSlots.length} cámaras</span>
          {view.isPublic
            ? <Globe size={11} className="text-green-400" />
            : <Lock size={11} className="text-amber-400" />}
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex items-center gap-1 ml-2 flex-shrink-0">
            <button onClick={prevPage} className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors">
              <ChevronLeft size={14} />
            </button>
            <div className="flex items-center gap-1">
              {Array.from({ length: totalPages }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i)}
                  className={clsx('h-1.5 rounded-full transition-all', i === currentPage ? 'bg-brand-400 w-4' : 'bg-surface-600 hover:bg-surface-400 w-1.5')}
                />
              ))}
            </div>
            <button onClick={nextPage} className="p-1 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors">
              <ChevronRight size={14} />
            </button>
            <button
              onClick={() => setSlideshowActive(!slideshowActive)}
              className={clsx(
                'ml-1 flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                slideshowActive ? 'bg-brand-600/30 text-brand-400' : 'bg-surface-700 text-surface-400 hover:text-surface-200'
              )}
            >
              {slideshowActive ? <Pause size={10} /> : <Play size={10} />}
              {slideshowActive && <span>{view.slideshowInterval}s</span>}
            </button>
          </div>
        )}
      </div>

      {/* Camera grid — fills remaining space, rows split equally */}
      <div className="flex-1 min-h-0 p-0.5">
        {isFeatured ? (
          <FeaturedGrid slots={pageSlots} tileRefs={tileRefs} onDoubleClick={enterFullscreen} />
        ) : (
          <div
            className="w-full h-full grid gap-0.5"
            style={{
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gridTemplateRows: `repeat(${rows}, 1fr)`,
            }}
          >
            {pageSlots.map((s, i) => (
              <CameraCell
                key={s.cameraId ?? `empty-${i}`}
                slot={s}
                tileRefs={tileRefs}
                onDoubleClick={enterFullscreen}
              />
            ))}
          </div>
        )}
      </div>

      {/* Fullscreen in-page overlay (fallback when native FS unavailable) */}
      {fullscreenSlot && !document.fullscreenElement && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 bg-surface-900/80 flex-shrink-0">
            <span className="text-sm text-surface-200 font-medium">
              {fullscreenSlot.camera?.name ?? 'Cámara'}
            </span>
            <button
              onClick={exitFullscreen}
              className="p-1.5 rounded bg-surface-700 text-surface-300 hover:text-white hover:bg-surface-600 transition-colors"
            >
              <Minimize2 size={14} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            {fullscreenSlot.stream ? (
              <VideoPlayer
                key={`fs-${fullscreenSlot.cameraId}`}
                hlsUrl={fullscreenSlot.stream.hls}
                cameraName={fullscreenSlot.camera?.name ?? ''}
                className="w-full h-full"
                onFullscreen={exitFullscreen}
              />
            ) : (
              <OfflinePlaceholder name={fullscreenSlot.camera?.name} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Camera tile ─────────────────────────────────────────────────────────────

function CameraCell({
  slot,
  tileRefs,
  onDoubleClick,
}: {
  slot: SlotWithCamera
  tileRefs: MutableRefObject<Map<string, HTMLDivElement>>
  onDoubleClick: (cameraId: string) => void
}) {
  if (!slot.cameraId || !slot.camera) {
    return (
      <div className="bg-surface-900/50 flex items-center justify-center border border-surface-800">
        <Monitor size={14} className="text-surface-700" />
      </div>
    )
  }

  const isOffline = slot.camera.online === false

  return (
    <div
      ref={(el) => { if (el) tileRefs.current.set(slot.cameraId!, el); else tileRefs.current.delete(slot.cameraId!) }}
      className="relative overflow-hidden bg-black border border-surface-800/60 group"
      onDoubleClick={() => slot.cameraId && onDoubleClick(slot.cameraId)}
    >
      {isOffline ? (
        <OfflinePlaceholder name={slot.camera.name} />
      ) : slot.stream ? (
        <VideoPlayer
          key={`vp-${slot.cameraId}-${slot.stream.hls}`}
          hlsUrl={slot.stream.hls}
          cameraName={slot.camera.name}
          cameraId={slot.cameraId}
          className="w-full h-full"
          onFullscreen={() => slot.cameraId && onDoubleClick(slot.cameraId)}
        />
      ) : (
        <OfflinePlaceholder name={slot.camera.name} loading />
      )}

      {/* Double-click hint on hover */}
      <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); slot.cameraId && onDoubleClick(slot.cameraId) }}
          className="p-1 rounded bg-black/60 text-surface-400 hover:text-white transition-colors"
          title="Pantalla completa (doble clic)"
        >
          <Maximize2 size={10} />
        </button>
      </div>
    </div>
  )
}

// ─── Featured layout ─────────────────────────────────────────────────────────
// Layout: 1 large cell (top-left) + 2 medium right + 5 small bottom

function FeaturedGrid({
  slots,
  tileRefs,
  onDoubleClick,
}: {
  slots: SlotWithCamera[]
  tileRefs: MutableRefObject<Map<string, HTMLDivElement>>
  onDoubleClick: (cameraId: string) => void
}) {
  return (
    <div className="w-full h-full grid gap-0.5" style={{ gridTemplateColumns: '2fr 1fr', gridTemplateRows: '2fr 1fr' }}>
      {/* Main large tile */}
      <div className="row-span-1">
        <CameraCell slot={slots[0] ?? { slotIndex: 0, cameraId: null, size: 'normal' }} tileRefs={tileRefs} onDoubleClick={onDoubleClick} />
      </div>
      {/* Right column: 2 stacked */}
      <div className="grid gap-0.5" style={{ gridTemplateRows: '1fr 1fr' }}>
        {slots.slice(1, 3).map((s, i) => (
          <CameraCell key={s.cameraId ?? `r${i}`} slot={s} tileRefs={tileRefs} onDoubleClick={onDoubleClick} />
        ))}
      </div>
      {/* Bottom row: 5 equal */}
      <div className="col-span-2 grid gap-0.5" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        {slots.slice(3, 8).map((s, i) => (
          <CameraCell key={s.cameraId ?? `b${i}`} slot={s} tileRefs={tileRefs} onDoubleClick={onDoubleClick} />
        ))}
      </div>
    </div>
  )
}

// ─── Offline / loading placeholder ────────────────────────────────────────────

function OfflinePlaceholder({ name, loading }: { name?: string; loading?: boolean }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-surface-900">
      {loading ? (
        <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      ) : (
        <Monitor size={14} className="text-surface-700" />
      )}
      {name && <span className="text-[10px] text-surface-600 text-center px-2 truncate max-w-full">{name}</span>}
    </div>
  )
}
