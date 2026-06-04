// src/pages/ViewPlayerPage.tsx
import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, LayoutGrid, ChevronLeft, ChevronRight,
  Play, Pause, Clock, Globe, Lock, Monitor, AlertTriangle,
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

  // Fullscreen state — which camera is expanded to HD
  const [fullscreenCamId, setFullscreenCamId] = useState<string | null>(null)
  const [hdStream, setHdStream] = useState<StreamInfo | null>(null)
  const [hdLoading, setHdLoading] = useState(false)

  // Pagination/slideshow
  const slotsPerPage = view ? (() => {
    const layout = view.layout
    if (layout === '1x1') return 1
    if (layout === '2x2') return 4
    if (layout === '3x3') return 9
    if (layout === '4x4') return 16
    if (layout === 'featured') return 8
    return 9
  })() : 9

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
        const assignedIds = v.cameraSlots
          .filter((s) => s.cameraId)
          .map((s) => s.cameraId!)

        const camerasData = await Promise.allSettled(
          assignedIds.map((cid) => apiGet<Camera>(`/cameras/${cid}`))
        )
        const cameraMap = new Map<string, Camera>()
        camerasData.forEach((r, i) => {
          if (r.status === 'fulfilled') cameraMap.set(assignedIds[i], r.value)
        })

        const streamData = await Promise.allSettled(
          assignedIds.map((cid) => apiGet<StreamInfo>(`/cameras/${cid}/stream`))
        )
        const streamMap = new Map<string, StreamInfo>()
        streamData.forEach((r, i) => {
          if (r.status === 'fulfilled') streamMap.set(assignedIds[i], r.value)
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

  useEffect(() => {
    if (view?.slideshowEnabled && totalPages > 1) {
      setSlideshowActive(true)
    }
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

  // Cleanup HD stream on unmount
  useEffect(() => {
    return () => {
      if (fullscreenCamId) {
        apiPost(`/cameras/${fullscreenCamId}/stop-stream`, { streamType: 'main' }).catch(() => {})
      }
    }
  }, [fullscreenCamId])

  const enterFullscreen = useCallback(async (cameraId: string) => {
    // Toggle: double-click same camera exits fullscreen
    if (fullscreenCamId === cameraId) {
      // Exit
      apiPost(`/cameras/${cameraId}/stop-stream`, { streamType: 'main' }).catch(() => {})
      console.log(`[ViewPlayer] fullscreenExit cameraId=${cameraId} restore=sub`)
      setFullscreenCamId(null)
      setHdStream(null)
      return
    }

    // Stop previous HD stream if any
    if (fullscreenCamId) {
      apiPost(`/cameras/${fullscreenCamId}/stop-stream`, { streamType: 'main' }).catch(() => {})
      console.log(`[ViewPlayer] fullscreenExit cameraId=${fullscreenCamId} restore=sub`)
    }

    const slot = slots.find(s => s.cameraId === cameraId)
    const camera = slot?.camera
    const mainIsHevc = camera?.mainCodec
      ? /hevc|h\.265|h265/i.test(camera.mainCodec)
      : false

    setFullscreenCamId(cameraId)
    setHdStream(null)
    setHdLoading(true)

    if (mainIsHevc) {
      console.log(`[ViewPlayer] fullscreenQualitySwitch cameraId=${cameraId} codec=HEVC no-transcode available`)
      setHdLoading(false)
      return
    }

    try {
      console.log(`[ViewPlayer] fullscreenQualitySwitch cameraId=${cameraId} from=sub to=main`)
      const result = await apiPost<StreamInfo>(`/cameras/${cameraId}/start-stream`, { streamType: 'main' })
      setHdStream(result)
      console.log(`[ViewPlayer] playing cameraId=${cameraId} streamType=main`)
    } catch (e) {
      console.warn(`[ViewPlayer] HD stream failed for ${cameraId}, staying on sub`, e)
      setHdStream(null)
    } finally {
      setHdLoading(false)
    }
  }, [fullscreenCamId, slots])

  const exitFullscreen = useCallback(() => {
    if (!fullscreenCamId) return
    apiPost(`/cameras/${fullscreenCamId}/stop-stream`, { streamType: 'main' }).catch(() => {})
    console.log(`[ViewPlayer] fullscreenExit cameraId=${fullscreenCamId} restore=sub`)
    setFullscreenCamId(null)
    setHdStream(null)
  }, [fullscreenCamId])

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

  // Fullscreen single-camera view
  if (fullscreenCamId) {
    const fsSlot = slots.find(s => s.cameraId === fullscreenCamId)
    const fsCamera = fsSlot?.camera
    const activeHls = hdStream?.hls ?? fsSlot?.stream?.hls
    const isHd = !!hdStream
    const mainIsHevc = fsCamera?.mainCodec
      ? /hevc|h\.265|h265/i.test(fsCamera.mainCodec)
      : false

    return (
      <div className="flex flex-col h-full bg-black">
        {/* Fullscreen header */}
        <div className="flex items-center gap-3 px-4 py-2.5 bg-surface-900/80 backdrop-blur-sm border-b border-surface-700/50 flex-shrink-0">
          <button onClick={exitFullscreen} className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700 transition-colors" title="Salir de pantalla completa (o doble clic)">
            <Minimize2 size={14} />
          </button>
          <LayoutGrid size={14} className="text-brand-400" />
          <span className="text-sm font-medium text-surface-100">{view.name}</span>
          <span className="text-xs text-surface-500">·</span>
          <span className="text-sm text-surface-300">{fsCamera?.name ?? 'Cámara'}</span>
          {hdLoading && (
            <span className="ml-2 text-xs text-surface-400 animate-pulse">Cargando HD...</span>
          )}
          {isHd && (
            <span className="ml-2 text-xs px-1.5 py-0.5 bg-brand-900/40 text-brand-400 rounded font-medium">
              HD
            </span>
          )}
          {!isHd && !hdLoading && mainIsHevc && (
            <span className="ml-2 text-xs text-amber-400">H.265 — sin transcodificación</span>
          )}
          <button
            onClick={() => navigate('/views')}
            className="ml-auto p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700 transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
        </div>

        {/* Full-screen video */}
        <div className="flex-1 overflow-hidden">
          {activeHls ? (
            <VideoPlayer
              hlsUrl={activeHls}
              cameraName={fsCamera?.name ?? ''}
              cameraId={fullscreenCamId}
              streamType={isHd ? 'main' : 'sub'}
              streamCodec={isHd ? (fsCamera?.mainCodec ?? undefined) : (fsCamera?.subCodec ?? undefined)}
              streamResolution={isHd ? (fsCamera?.mainResolution ?? undefined) : (fsCamera?.subResolution ?? undefined)}
              onFullscreen={exitFullscreen}
              className="w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
              <Monitor size={24} className="text-surface-600" />
              <span className="text-sm text-surface-400">{fsCamera?.name ?? 'Sin stream'}</span>
            </div>
          )}
        </div>

        {/* Hint */}
        <div className="py-1.5 bg-surface-900/60 border-t border-surface-700/50 text-center">
          <span className="text-[10px] text-surface-600">Doble clic o <Minimize2 size={9} className="inline" /> para salir · Usando {isHd ? 'stream principal (HD)' : 'sub-stream'}</span>
        </div>
      </div>
    )
  }

  // Normal grid view
  const pageSlots = filledSlots.slice(currentPage * slotsPerPage, (currentPage + 1) * slotsPerPage)
  while (pageSlots.length < slotsPerPage) {
    pageSlots.push({ slotIndex: -1, cameraId: null, size: 'normal' })
  }

  const cols = LAYOUT_COLS[view.layout] ?? 3
  const isFeatured = view.layout === 'featured'

  const renderCell = (slot: SlotWithCamera) => {
    if (!slot.cameraId || !slot.camera) {
      return (
        <div className="h-full min-h-[80px] bg-surface-900 rounded flex items-center justify-center">
          <Monitor size={16} className="text-surface-700" />
        </div>
      )
    }

    const isFs = slot.cameraId === fullscreenCamId
    const camera = slot.camera

    return (
      <div className="h-full min-h-[80px] rounded overflow-hidden bg-surface-900 relative group">
        {slot.stream ? (
          <VideoPlayer
            hlsUrl={slot.stream.hls}
            cameraName={camera.name}
            cameraId={slot.cameraId}
            streamType="sub"
            streamCodec={camera.subCodec ?? undefined}
            streamResolution={camera.subResolution ?? undefined}
            onFullscreen={() => enterFullscreen(slot.cameraId!)}
            className="w-full h-full"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5">
            <Monitor size={16} className="text-surface-600" />
            <span className="text-xs text-surface-500">{camera.name}</span>
            <span className="text-[10px] text-surface-600">Sin stream</span>
          </div>
        )}
        {/* Expand button */}
        <button
          onClick={() => enterFullscreen(slot.cameraId!)}
          className={clsx(
            'absolute top-2 left-2 p-1 rounded bg-black/60 text-white transition-opacity',
            isFs ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          title="Pantalla completa HD (o doble clic)"
        >
          <Maximize2 size={10} />
        </button>
      </div>
    )
  }

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

        {totalPages > 1 && (
          <div className="flex items-center gap-1.5 ml-2">
            <button onClick={prevPage} className="p-1.5 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors">
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
            <button onClick={nextPage} className="p-1.5 rounded text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors">
              <ChevronRight size={14} />
            </button>

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
              {slideshowActive && <span>{view.slideshowInterval}s</span>}
            </button>
          </div>
        )}
      </div>

      {/* Camera grid */}
      <div className="flex-1 overflow-hidden p-1">
        {isFeatured ? (
          <div className="h-full grid gap-1" style={{ gridTemplateColumns: '2fr 1fr', gridTemplateRows: '2fr 1fr' }}>
            <div className="row-span-1">{renderCell(pageSlots[0])}</div>
            <div className="grid gap-1" style={{ gridTemplateRows: '1fr 1fr' }}>
              {pageSlots.slice(1, 3).map((s, i) => (
                <div key={i}>{renderCell(s)}</div>
              ))}
            </div>
            <div className="grid gap-1 col-span-2" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
              {pageSlots.slice(3, 8).map((s, i) => (
                <div key={i}>{renderCell(s)}</div>
              ))}
            </div>
          </div>
        ) : (
          <div className="h-full grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {pageSlots.map((s, i) => (
              <div key={i}>{renderCell(s)}</div>
            ))}
          </div>
        )}
      </div>

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
