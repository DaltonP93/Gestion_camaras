// src/pages/ViewPlayerPage.tsx
import { useEffect, useState, useRef, useCallback, type MutableRefObject } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, LayoutGrid, ChevronLeft, ChevronRight,
  Play, Pause, Clock, Globe, Lock, Monitor, AlertTriangle,
  Maximize2, Minimize2, Crop, ScanLine,
} from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { VideoPlayer } from '@/components/cameras/VideoPlayer'
import type { CameraPlaybackError } from '@/components/cameras/VideoPlayer'
import { clsx } from 'clsx'
import type { CameraView, CameraSlot, Camera, StreamInfo } from '@/types'

const LAYOUT_COLS: Record<string, number> = {
  '1x1': 1, '2x2': 2, '3x3': 3, '4x4': 4, 'featured': 3, 'custom': 3,
}

function getSlotsPerPage(layout: string): number {
  if (layout === '1x1') return 1
  if (layout === '2x2') return 4
  if (layout === '3x3') return 9
  if (layout === '4x4') return 16
  if (layout === 'featured') return 8
  return 9
}

// Parse streamType from MediaMTX path suffix (e.g. "uuid-uuid-sub", "…-main_h264")
function getStreamTypeFromPath(streamPath: string): 'sub' | 'main' | 'main_h264' {
  if (streamPath.endsWith('-main_h264')) return 'main_h264'
  if (streamPath.endsWith('-main')) return 'main'
  return 'sub'
}

interface SlotWithCamera extends CameraSlot {
  camera?: Camera
  stream?: StreamInfo
}

function CameraCell({
  slot, tileRefs, objectFit, onFullscreen,
}: {
  slot: SlotWithCamera
  tileRefs: MutableRefObject<Map<string, HTMLDivElement>>
  objectFit: 'cover' | 'contain'
  onFullscreen: (cameraId: string) => void
}) {
  if (!slot.cameraId || !slot.camera) {
    return (
      <div className="h-full min-h-[80px] bg-surface-900 rounded flex items-center justify-center">
        <Monitor size={16} className="text-surface-700" />
      </div>
    )
  }
  const camera = slot.camera
  return (
    <div
      ref={(el) => { if (el) tileRefs.current.set(slot.cameraId!, el) }}
      className="h-full min-h-[80px] rounded overflow-hidden bg-surface-900 relative group"
    >
      {slot.stream ? (
        <VideoPlayer
          hlsUrl={slot.stream.hls}
          cameraName={camera.name}
          cameraId={slot.cameraId}
          streamType="sub"
          streamCodec={camera.subCodec ?? undefined}
          streamResolution={camera.subResolution ?? undefined}
          onFullscreen={() => onFullscreen(slot.cameraId!)}
          objectFit={objectFit}
          className="w-full h-full"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5">
          <Monitor size={16} className="text-surface-600" />
          <span className="text-xs text-surface-500">{camera.name}</span>
          <span className="text-[10px] text-surface-600">Sin stream</span>
        </div>
      )}
      <button
        onClick={() => onFullscreen(slot.cameraId!)}
        className="absolute top-2 left-2 p-1 rounded bg-black/60 text-white transition-opacity opacity-0 group-hover:opacity-100"
        title="Pantalla completa HD (o doble clic)"
      >
        <Maximize2 size={10} />
      </button>
    </div>
  )
}

export function ViewPlayerPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [view, setView] = useState<CameraView | null>(null)
  const [slots, setSlots] = useState<SlotWithCamera[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [objectFit, setObjectFit] = useState<'cover' | 'contain'>('contain')

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

  // In-page (CSS overlay) fullscreen — used when native requestFullscreen is unavailable
  const [fullscreenCamId, setFullscreenCamId] = useState<string | null>(null)
  // Main stream started for the fullscreen camera (upgraded quality)
  const [fullscreenMainStream, setFullscreenMainStream] = useState<StreamInfo | null>(null)
  // DOM refs per tile — populated by CameraCell's ref callback
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  // Tracks which camera has an active HD (main/main_h264) stream — covers both native and CSS FS
  const hdCamIdRef = useRef<string | null>(null)

  // ─── Fullscreen (called directly from user-gesture handlers) ─────────────────
  // IMPORTANT: requestFullscreen must be called synchronously inside a user gesture.
  // We receive this call from VideoPlayer's onFullscreen, which itself fires inside
  // onDoubleClick / onClick — both are direct user gesture events.
  const enterFullscreen = useCallback((cameraId: string) => {
    console.log('[fullscreen] toggle', { hasNativeFS: Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement), hasCssFS: fullscreenCamId !== null, cameraId })

    // Case 1: native fullscreen is active → exit it (fullscreenchange handler cleans up state)
    if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {})
      } else {
        (document as any).webkitExitFullscreen?.()
      }
      return
    }

    // Case 2: CSS overlay fullscreen is active → exit it
    if (fullscreenCamId !== null) {
      const prevCamId = fullscreenCamId
      hdCamIdRef.current = null
      setFullscreenCamId(null)
      setFullscreenMainStream(null)
      apiPost(`/cameras/${prevCamId}/stop-stream`, { streamType: 'main', reason: 'exit_fullscreen' }).catch(() => {})
      apiPost(`/cameras/${prevCamId}/stop-stream`, { streamType: 'main_h264', reason: 'exit_fullscreen' }).catch(() => {})
      return
    }

    // Case 3: enter fullscreen — always render CSS overlay so HD stream is used.
    // We also request OS-level fullscreen on the document root so it stays mounted.
    setFullscreenCamId(cameraId)
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else if ((document.documentElement as any).webkitRequestFullscreen) {
      ;(document.documentElement as any).webkitRequestFullscreen()
    }

    // Upgrade to HD quality in fullscreen.
    // If main codec is H.265/HEVC → request main_h264 (transcoded) for browser compat.
    // If main codec is H.264 → request main directly.
    const cam = slots.find(s => s.cameraId === cameraId)?.camera
    const mainIsHevc = cam?.mainCodec
      ? /hevc|h\.265|h265/i.test(cam.mainCodec)
      : false
    const hdStreamType = mainIsHevc ? 'main_h264' : 'main'
    // Track before async call so fullscreenchange handler can stop it even if FS resolves fast
    hdCamIdRef.current = cameraId
    setFullscreenMainStream(null)
    apiPost<StreamInfo>(`/cameras/${cameraId}/start-stream`, { streamType: hdStreamType })
      .then((info) => {
        setFullscreenMainStream(info)
      })
      .catch(() => {
        // HD stream unavailable — CSS overlay uses sub stream as fallback
      })
  }, [fullscreenCamId, slots])

  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
      // Native FS: trigger exit — fullscreenchange handler does the stream cleanup via hdCamIdRef
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {})
      else (document as any).webkitExitFullscreen?.()
      return
    }
    // CSS overlay FS: clean up directly
    const prevCamId = fullscreenCamId || hdCamIdRef.current
    hdCamIdRef.current = null
    setFullscreenCamId(null)
    setFullscreenMainStream(null)
    if (prevCamId) {
      apiPost(`/cameras/${prevCamId}/stop-stream`, { streamType: 'main', reason: 'exit_fullscreen' }).catch(() => {})
      apiPost(`/cameras/${prevCamId}/stop-stream`, { streamType: 'main_h264', reason: 'exit_fullscreen' }).catch(() => {})
    }
  }, [fullscreenCamId])

  // Sync ESC / browser-native FS exit with React state
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
        // Use ref (not state) so native FS exits always find the camera to stop
        const camToStop = hdCamIdRef.current
        hdCamIdRef.current = null
        if (camToStop) {
          apiPost(`/cameras/${camToStop}/stop-stream`, { streamType: 'main', reason: 'exit_fullscreen' }).catch(() => {})
          apiPost(`/cameras/${camToStop}/stop-stream`, { streamType: 'main_h264', reason: 'exit_fullscreen' }).catch(() => {})
        }
        setFullscreenCamId(null)
        setFullscreenMainStream(null)
      }
    }
    document.addEventListener('fullscreenchange', handler)
    document.addEventListener('webkitfullscreenchange', handler)
    return () => {
      document.removeEventListener('fullscreenchange', handler)
      document.removeEventListener('webkitfullscreenchange', handler)
    }
  }, [])

  // ─── Load view + cameras + first-page streams ────────────────────────────────
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
        camerasData.forEach((r, i) => { if (r.status === 'fulfilled') cameraMap.set(assignedIds[i], r.value) })

        // Start streams for first-page cameras only (lazy-load the rest on page change)
        const perPage      = getSlotsPerPage(v.layout)
        const firstPageIds = assignedIds.slice(0, perPage)

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
    if (!view) return
    const perPage  = getSlotsPerPage(view.layout)
    const pageIds  = filledSlots
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

  // ─── Slideshow ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (view?.slideshowEnabled && totalPages > 1) setSlideshowActive(true)
  }, [view, totalPages])

  useEffect(() => {
    if (slideshowRef.current) clearInterval(slideshowRef.current)
    if (slideshowActive && view && totalPages > 1) {
      slideshowRef.current = setInterval(
        () => setCurrentPage((p) => (p + 1) % totalPages),
        (view.slideshowInterval ?? 10) * 1000
      )
    }
    return () => { if (slideshowRef.current) clearInterval(slideshowRef.current) }
  }, [slideshowActive, view, totalPages])

  const prevPage = useCallback(() => {
    setCurrentPage((p) => (p - 1 + totalPages) % totalPages)
  }, [totalPages])

  const nextPage = useCallback(() => {
    setCurrentPage((p) => (p + 1) % totalPages)
  }, [totalPages])

  // Retry stream on 401 (HLS_SESSION_EXPIRED) — cookie may have refreshed
  const handleStreamError = useCallback((cameraId: string, err: CameraPlaybackError) => {
    if (err.code === 'HLS_SESSION_EXPIRED') {
      setTimeout(() => {
        apiPost<StreamInfo>(`/cameras/${cameraId}/start-stream`, {})
          .then((info) => setSlots((prev) => prev.map((s) => s.cameraId === cameraId ? { ...s, stream: info } : s)))
          .catch(() => {})
      }, 2000)
    }
  }, [])

  const handleFsStreamError = useCallback((cameraId: string, err: CameraPlaybackError) => {
    if (err.code === 'HLS_SESSION_EXPIRED') {
      const cam = slots.find((s) => s.cameraId === cameraId)?.camera
      const mainIsHevc = cam?.mainCodec ? /hevc|h\.265|h265/i.test(cam.mainCodec) : false
      const hdStreamType: 'main' | 'main_h264' = mainIsHevc ? 'main_h264' : 'main'
      setTimeout(() => {
        apiPost<StreamInfo>(`/cameras/${cameraId}/start-stream`, { streamType: hdStreamType })
          .then((info) => setFullscreenMainStream(info))
          .catch(() => {})
      }, 2000)
    }
  }, [slots])

  // ─── Loading / error states ──────────────────────────────────────────────────
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
    const activeHls = fullscreenMainStream?.hls ?? fsSlot?.stream?.hls
    const isHd = !!fullscreenMainStream
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
          {!isHd && !mainIsHevc && (
            <span className="ml-2 text-xs text-surface-400 animate-pulse">Cargando HD...</span>
          )}
          {isHd && (
            <span className="ml-2 text-xs px-1.5 py-0.5 bg-brand-900/40 text-brand-400 rounded font-medium">
              HD
            </span>
          )}
          {!isHd && mainIsHevc && (
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
              onStreamError={handleFsStreamError}
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

  const cols       = LAYOUT_COLS[view.layout] ?? 3
  const rows       = Math.ceil(pageSlots.length / cols)
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
      <div
        ref={(el) => { if (el) tileRefs.current.set(slot.cameraId!, el) }}
        className="h-full min-h-[80px] rounded overflow-hidden bg-surface-900 relative group"
      >
        {slot.stream ? (
          <VideoPlayer
            hlsUrl={slot.stream.hls}
            cameraName={camera.name}
            cameraId={slot.cameraId}
            streamType="sub"
            streamCodec={camera.subCodec ?? undefined}
            streamResolution={camera.subResolution ?? undefined}
            onFullscreen={() => enterFullscreen(slot.cameraId!)}
            onStreamError={handleStreamError}
            objectFit={objectFit}
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
    <div className="flex flex-col h-full bg-black select-none">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
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

        {/* Fill / Fit toggle */}
        <button
          onClick={() => setObjectFit((f) => (f === 'cover' ? 'contain' : 'cover'))}
          className={clsx(
            'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors flex-shrink-0',
            objectFit === 'cover'
              ? 'bg-brand-700/40 text-brand-300 border border-brand-600/40'
              : 'bg-surface-700 text-surface-400 hover:text-surface-200'
          )}
          title={objectFit === 'cover' ? 'Modo Fill: video recorta bordes para llenar el tile (clic para cambiar a Fit)' : 'Modo Fit: video con barras negras sin recortar (clic para cambiar a Fill)'}
        >
          {objectFit === 'cover' ? <Crop size={11} /> : <ScanLine size={11} />}
          {objectFit === 'cover' ? 'Fill' : 'Fit'}
        </button>

        <div className="flex items-center gap-2 text-xs text-surface-400 flex-shrink-0">
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
                  className={clsx('h-1.5 rounded-full transition-all', i === currentPage ? 'bg-brand-400 w-4' : 'bg-surface-600 hover:bg-surface-400 w-1.5')}
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
                slideshowActive ? 'bg-brand-600/30 text-brand-400' : 'bg-surface-700 text-surface-400 hover:text-surface-200'
              )}
            >
              {slideshowActive ? <Pause size={10} /> : <Play size={10} />}
              {slideshowActive && <span>{view.slideshowInterval}s</span>}
            </button>
          </div>
        )}
      </div>

      {/* ── Camera grid ──────────────────────────────────────────────────────── */}
      {/* flex-1 + min-h-0 lets this div fill all remaining height without overflow */}
      <div className="flex-1 min-h-0 p-0.5">
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
              <CameraCell
                key={s.cameraId ?? `empty-${i}`}
                slot={s}
                tileRefs={tileRefs}
                objectFit={objectFit}
                onFullscreen={enterFullscreen}
              />
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
