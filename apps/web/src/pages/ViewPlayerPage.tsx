// src/pages/ViewPlayerPage.tsx
import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, LayoutGrid, ChevronLeft, ChevronRight,
  Play, Pause, Clock, Globe, Lock, Monitor, AlertTriangle
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

        // Batch-fetch all camera metadata in one request
        const camerasArr = assignedIds.length > 0
          ? await apiPost<Camera[]>('/cameras/batch', { ids: assignedIds })
          : []
        const cameraMap = new Map<string, Camera>()
        camerasArr.forEach((c) => cameraMap.set(c.id, c))

        // Start streams only for first-page cameras
        const perPage = getSlotsPerPage(v.layout)
        const firstPageIds = assignedIds.slice(0, perPage)
        const streamData = await Promise.allSettled(
          firstPageIds.map((cid) => apiGet<StreamInfo>(`/cameras/${cid}/stream`))
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
      pageIds.map((cid) => apiGet<StreamInfo>(`/cameras/${cid}/stream`))
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
  }, [currentPage, view])

  // Start slideshow when view loads and slideshowEnabled
  useEffect(() => {
    if (view?.slideshowEnabled && totalPages > 1) {
      setSlideshowActive(true)
    }
  }, [view, totalPages])

  // Slideshow timer
  useEffect(() => {
    if (slideshowRef.current) clearInterval(slideshowRef.current)
    if (slideshowActive && view && totalPages > 1) {
      slideshowRef.current = setInterval(() => {
        setCurrentPage((p) => (p + 1) % totalPages)
      }, (view.slideshowInterval ?? 10) * 1000)
    }
    return () => { if (slideshowRef.current) clearInterval(slideshowRef.current) }
  }, [slideshowActive, view, totalPages])

  const prevPage = useCallback(() => {
    setCurrentPage((p) => (p - 1 + totalPages) % totalPages)
  }, [totalPages])

  const nextPage = useCallback(() => {
    setCurrentPage((p) => (p + 1) % totalPages)
  }, [totalPages])

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
  // Pad with empty slots if needed
  while (pageSlots.length < slotsPerPage) {
    pageSlots.push({ slotIndex: -1, cameraId: null, size: 'normal' })
  }

  const cols = LAYOUT_COLS[view.layout] ?? 3
  const isFeatured = view.layout === 'featured'

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-surface-900/80 backdrop-blur-sm border-b border-surface-700/50 flex-shrink-0">
        <button
          onClick={() => navigate('/views')}
          className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700 transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <LayoutGrid size={14} className="text-brand-400" />
        <div className="flex-1">
          <div className="text-sm font-medium text-surface-100">{view.name}</div>
          {view.description && (
            <div className="text-xs text-surface-500">{view.description}</div>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-surface-400">
          <Monitor size={11} />
          <span>{filledSlots.length} cámaras</span>
          {view.isPublic
            ? <Globe size={11} className="text-green-400" />
            : <Lock size={11} className="text-amber-400" />}
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5 ml-2">
            <button
              onClick={prevPage}
              className="p-1.5 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <div className="flex items-center gap-1">
              {Array.from({ length: totalPages }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i)}
                  className={clsx(
                    'w-1.5 h-1.5 rounded-full transition-all',
                    i === currentPage ? 'bg-brand-400 w-4' : 'bg-surface-600 hover:bg-surface-400'
                  )}
                />
              ))}
            </div>
            <button
              onClick={nextPage}
              className="p-1.5 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors"
            >
              <ChevronRight size={14} />
            </button>

            {/* Slideshow toggle */}
            <button
              onClick={() => setSlideshowActive(!slideshowActive)}
              className={clsx(
                'ml-1 flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                slideshowActive
                  ? 'bg-brand-600/30 text-brand-400'
                  : 'bg-surface-700 text-surface-400 hover:text-surface-200'
              )}
              title={slideshowActive ? 'Pausar presentación' : 'Iniciar presentación'}
            >
              {slideshowActive ? <Pause size={10} /> : <Play size={10} />}
              {slideshowActive && (
                <span>{view.slideshowInterval}s</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Camera grid */}
      <div className="flex-1 overflow-hidden p-1">
        {isFeatured ? (
          <div className="h-full grid gap-1" style={{ gridTemplateColumns: '2fr 1fr', gridTemplateRows: '2fr 1fr' }}>
            {/* Featured large cell */}
            <div className="row-span-1">
              {renderCell(pageSlots[0])}
            </div>
            {/* Right column */}
            <div className="grid gap-1" style={{ gridTemplateRows: '1fr 1fr' }}>
              {pageSlots.slice(1, 3).map((s, i) => (
                <div key={i}>{renderCell(s)}</div>
              ))}
            </div>
            {/* Bottom row */}
            <div className="grid gap-1 col-span-2" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
              {pageSlots.slice(3, 8).map((s, i) => (
                <div key={i}>{renderCell(s)}</div>
              ))}
            </div>
          </div>
        ) : (
          <div
            className="h-full grid gap-1"
            style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
          >
            {pageSlots.map((s, i) => (
              <div key={i}>{renderCell(s)}</div>
            ))}
          </div>
        )}
      </div>

      {/* Page indicator */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-1.5 bg-surface-900/60 border-t border-surface-700/50 flex-shrink-0">
          <span className="text-xs text-surface-500">
            Página {currentPage + 1} de {totalPages}
            {slideshowActive && <span className="text-brand-400 ml-2">· Presentación activa</span>}
          </span>
        </div>
      )}
    </div>
  )
}

function renderCell(slot: SlotWithCamera) {
  if (!slot.cameraId || !slot.camera) {
    return (
      <div className="h-full min-h-[80px] bg-surface-900 rounded flex items-center justify-center">
        <Monitor size={16} className="text-surface-700" />
      </div>
    )
  }

  return (
    <div className="h-full min-h-[80px] rounded overflow-hidden bg-surface-900">
      {slot.stream ? (
        <VideoPlayer
          hlsUrl={slot.stream.hls}
          cameraName={slot.camera.name}
          className="w-full h-full"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5">
          <Monitor size={16} className="text-surface-600" />
          <span className="text-xs text-surface-500">{slot.camera.name}</span>
          <span className="text-[10px] text-surface-600">Sin stream</span>
        </div>
      )}
    </div>
  )
}
