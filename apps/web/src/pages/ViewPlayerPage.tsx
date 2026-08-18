// src/pages/ViewPlayerPage.tsx
import { useEffect, useState, useRef, useCallback, type MutableRefObject } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, LayoutGrid, ChevronLeft, ChevronRight,
  Play, Pause, Globe, Lock, Monitor, AlertTriangle,
  Maximize2, Minimize2, Crop, ScanLine, Expand,
  Loader2,
} from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { createHeartbeatScheduler } from '@/lib/heartbeatScheduler'
import { closeStreamSession, closeViewSessions } from '@/lib/sessionClose'
import { VideoPlayer } from '@/components/cameras/VideoPlayer'
import type { CameraPlaybackError } from '@/components/cameras/VideoPlayer'
import { clsx } from 'clsx'
import type { CameraView, CameraSlot, Camera, StreamInfo } from '@/types'

// ─── Constants ──────────────────────────────────────────────────────────────

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

// ─── Types ───────────────────────────────────────────────────────────────────

type ObjectFitMode = 'cover' | 'contain' | 'adapt'

type FsPhase =
  | 'idle'
  | 'starting_hd'
  | 'fullscreen_hd'
  | 'fullscreen_sub_fallback'
  | 'exiting'
  | 'error'

interface FsState {
  phase:        FsPhase
  cameraId:     string | null
  hdStream:     StreamInfo | null   // non-null when HD is active
  hdStreamType: 'main' | 'main_h264' | null
  errorCode:    string | null       // e.g. 'TRANSCODE_LIMIT', 'MEDIA_SERVER_ERROR'
  errorMsg:     string | null
}

const FS_IDLE: FsState = {
  phase: 'idle', cameraId: null, hdStream: null, hdStreamType: null, errorCode: null, errorMsg: null,
}

interface SlotWithCamera extends CameraSlot {
  camera?: Camera
  stream?: StreamInfo
}

/** Derive HD stream type from camera's main codec */
function pickHdStreamType(cam: Camera | undefined): 'main' | 'main_h264' {
  if (!cam?.mainCodec) return 'main'
  return /hevc|h\.265|h265/i.test(cam.mainCodec) ? 'main_h264' : 'main'
}

/** Parse WxH from resolution string like "1920x1080" */
function parseResolution(res?: string | null): { w: number; h: number } | null {
  if (!res) return null
  const [w, h] = res.split('x').map(Number)
  return (w > 0 && h > 0) ? { w, h } : null
}

/** Badge label shown in fullscreen header */
function buildStreamBadge(fsState: FsState, cam: Camera | undefined): string {
  if (fsState.phase === 'starting_hd') return 'Iniciando HD...'
  if (fsState.phase === 'error' || fsState.phase === 'fullscreen_sub_fallback') {
    const sub = cam?.subResolution ? `Sub ${cam.subResolution}` : 'Sub-stream'
    const err = fsState.errorCode ? ` — fallback: ${fsState.errorCode}` : ''
    return `${sub} H.264${err}`
  }
  if (fsState.phase === 'fullscreen_hd' && fsState.hdStream) {
    const isTranscoded = fsState.hdStreamType === 'main_h264'
    const prefix = isTranscoded ? 'Trans' : 'Main'
    const res = cam?.mainResolution ? ` ${cam.mainResolution}` : ''
    const codec = (isTranscoded ? 'H.264' : cam?.mainCodec?.toUpperCase()) ?? 'H.264'
    return `${prefix}${res} ${codec}`
  }
  return 'Sub-stream'
}

// ─── CameraCell (used in standard grid layouts) ────────────────────────────

function CameraCell({
  slot, tileRefs, objectFit, onFullscreen,
}: {
  slot: SlotWithCamera
  tileRefs: MutableRefObject<Map<string, HTMLDivElement>>
  objectFit: ObjectFitMode
  onFullscreen: (cameraId: string) => void
}) {
  if (!slot.cameraId || !slot.camera) {
    if (objectFit === 'adapt') return null  // hide empty slots in adapt mode
    return (
      <div className="h-full min-h-[80px] bg-surface-900 rounded flex items-center justify-center">
        <Monitor size={16} className="text-surface-700" />
      </div>
    )
  }
  const camera = slot.camera
  const res    = parseResolution(camera.subResolution ?? camera.mainResolution)
  const adaptStyle = (objectFit === 'adapt' && res)
    ? { aspectRatio: `${res.w}/${res.h}`, width: '100%' }
    : undefined

  return (
    <div
      ref={(el) => { if (el) tileRefs.current.set(slot.cameraId!, el) }}
      className="rounded overflow-hidden bg-surface-900 relative group"
      style={adaptStyle ?? { height: '100%', minHeight: '80px' }}
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
          objectFit={objectFit === 'adapt' ? 'contain' : objectFit}
          className="w-full h-full"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5" style={{ minHeight: 80 }}>
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

// ─── Main component ───────────────────────────────────────────────────────────

/** Visibilidad leída en el momento (evita el estrechamiento de TypeScript). */
const tabIsHidden = (): boolean => document.visibilityState === 'hidden'

export function ViewPlayerPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [view, setView] = useState<CameraView | null>(null)
  const [slots, setSlots] = useState<SlotWithCamera[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [objectFit, setObjectFit] = useState<ObjectFitMode>('contain')

  // Pagination / slideshow
  const slotsPerPage = view ? getSlotsPerPage(view.layout) : 9
  const filledSlots  = slots.filter((s) => s.cameraId)
  const totalPages   = Math.max(1, Math.ceil(filledSlots.length / slotsPerPage))
  const [currentPage, setCurrentPage] = useState(0)
  const [slideshowActive, setSlideshowActive] = useState(false)
  const slideshowRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Identidad ESTABLE de esta pestaña. Se declara acá arriba, antes que
  // cualquier arranque, porque todos los caminos que crean o reinician un
  // stream deben mandar EXACTAMENTE este viewId.
  //
  // El defecto que corrige (revisión de #146): los start-stream de esta página
  // no enviaban viewId, así que el backend registraba la sesión bajo
  // viewId='default' mientras el heartbeat periódico usaba 'vp_…'. La sesión
  // quedaba con heartbeat de cliente fresco pero sin heartbeat de view que le
  // correspondiera, y expiraba por `view_heartbeat_missing` — matando el FFmpeg
  // de una cámara que el usuario estaba mirando.
  const viewIdRef = useRef<string>(`vp_${Math.random().toString(36).slice(2)}`)

  // ─── Fullscreen state machine ─────────────────────────────────────────────
  const [fsState, setFsState] = useState<FsState>(FS_IDLE)
  // Ref mirror for fsState.cameraId — readable inside event listeners without stale closures
  const fsCamIdRef = useRef<string | null>(null)
  // DOM refs for each tile — set by CameraCell ref callback
  const tileRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // ─── Stop active HD stream ────────────────────────────────────────────────
  const stopHdStream = useCallback((cameraId: string) => {
    void closeStreamSession(cameraId, 'main',      'exit_fullscreen', viewIdRef.current)
    void closeStreamSession(cameraId, 'main_h264', 'exit_fullscreen', viewIdRef.current)
  }, [])

  // ─── Enter fullscreen (must be called inside user gesture) ───────────────
  const enterFullscreen = useCallback((cameraId: string) => {
    // Toggle off: same camera clicked while already in fullscreen
    if (fsState.cameraId === cameraId && fsState.phase !== 'idle' && fsState.phase !== 'exiting') {
      setFsState(FS_IDLE)
      fsCamIdRef.current = null
      stopHdStream(cameraId)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      return
    }

    // Switch camera: different camera clicked while in fullscreen — stop previous HD
    if (fsState.cameraId && fsState.cameraId !== cameraId && fsState.phase !== 'idle') {
      stopHdStream(fsState.cameraId)
    }

    // Choose HD stream type based on codec
    const cam = slots.find(s => s.cameraId === cameraId)?.camera
    const hdStreamType = pickHdStreamType(cam)

    // Set starting state immediately (always render CSS overlay)
    setFsState({ phase: 'starting_hd', cameraId, hdStream: null, hdStreamType, errorCode: null, errorMsg: null })
    fsCamIdRef.current = cameraId

    // Request OS-level fullscreen on document root so overlay stays mounted
    if (!document.fullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {})
      } else if ((document.documentElement as any).webkitRequestFullscreen) {
        ;(document.documentElement as any).webkitRequestFullscreen()
      }
    }

    // Start HD stream
    apiPost<StreamInfo>(`/cameras/${cameraId}/start-stream`, { streamType: hdStreamType, viewId: viewIdRef.current })
      .then((info) => {
        // Verify this camera is still the active fullscreen
        if (fsCamIdRef.current !== cameraId) return
        setFsState(prev =>
          prev.cameraId === cameraId
            ? { ...prev, phase: 'fullscreen_hd', hdStream: info, hdStreamType }
            : prev
        )
      })
      .catch((e: any) => {
        if (fsCamIdRef.current !== cameraId) return
        const errorCode = e?.response?.data?.error?.code ?? e?.response?.data?.code ?? 'HD_UNAVAILABLE'
        const errorMsg  = e?.response?.data?.error?.message ?? e?.response?.data?.message ?? 'Stream HD no disponible'
        setFsState(prev =>
          prev.cameraId === cameraId
            ? { ...prev, phase: 'fullscreen_sub_fallback', errorCode, errorMsg }
            : prev
        )
      })
  }, [fsState, slots, stopHdStream])

  // ─── Exit fullscreen ──────────────────────────────────────────────────────
  const exitFullscreen = useCallback(() => {
    const prev = fsState.cameraId ?? fsCamIdRef.current
    setFsState(FS_IDLE)
    fsCamIdRef.current = null
    if (prev) stopHdStream(prev)
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else if ((document as any).webkitFullscreenElement) (document as any).webkitExitFullscreen?.()
  }, [fsState.cameraId, stopHdStream])

  // ─── ESC / native fullscreenchange ───────────────────────────────────────
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
        const cam = fsCamIdRef.current
        fsCamIdRef.current = null
        if (cam) stopHdStream(cam)
        setFsState(FS_IDLE)
      }
    }
    document.addEventListener('fullscreenchange', handler)
    document.addEventListener('webkitfullscreenchange', handler)
    return () => {
      document.removeEventListener('fullscreenchange', handler)
      document.removeEventListener('webkitfullscreenchange', handler)
    }
  }, [stopHdStream])

  // ─── Cierre en navegación, desmontaje y descarga de la página ────────────
  // Antes sólo se cerraba el HD en pantalla completa: los substreams de la
  // grilla quedaban vivos hasta vencer el TTL. Ahora se cierra TODA la vista
  // con `keepalive`, que sobrevive a la descarga de la página, y de forma
  // idempotente (pagehide + desmontaje pueden dispararse a la vez).
  useEffect(() => {
    const closeThisView = () => {
      const cam = fsCamIdRef.current
      if (cam) stopHdStream(cam)
      void closeViewSessions(viewIdRef.current)
    }
    window.addEventListener('pagehide', closeThisView)
    return () => {
      window.removeEventListener('pagehide', closeThisView)
      closeThisView()
    }
  }, [stopHdStream])

  // ─── Stream error handlers ────────────────────────────────────────────────
  const handleStreamError = useCallback((cameraId: string, err: CameraPlaybackError) => {
    if (err.code !== 'HLS_SESSION_EXPIRED') return
    setTimeout(() => {
      apiPost<StreamInfo>(`/cameras/${cameraId}/start-stream`, { viewId: viewIdRef.current })
        .then((info) => setSlots((prev) => prev.map((s) => s.cameraId === cameraId ? { ...s, stream: info } : s)))
        .catch(() => {})
    }, 2000)
  }, [])

  const handleFsStreamError = useCallback((cameraId: string, err: CameraPlaybackError) => {
    if (err.code !== 'HLS_SESSION_EXPIRED') return
    const cam = slots.find((s) => s.cameraId === cameraId)?.camera
    const hdStreamType = pickHdStreamType(cam)
    setTimeout(() => {
      apiPost<StreamInfo>(`/cameras/${cameraId}/start-stream`, { streamType: hdStreamType, viewId: viewIdRef.current })
        .then((info) => {
          setFsState(prev =>
            prev.cameraId === cameraId ? { ...prev, hdStream: info } : prev
          )
        })
        .catch(() => {})
    }, 2000)
  }, [slots])

  // ─── Load view + cameras + streams ───────────────────────────────────────
  useEffect(() => {
    if (!id) return
    setIsLoading(true)
    setError(null)

    apiGet<CameraView>(`/views/${id}`)
      .then(async (v) => {
        setView(v)
        const assignedIds = v.cameraSlots.filter((s) => s.cameraId).map((s) => s.cameraId!)

        const [camerasData, streamData] = await Promise.all([
          Promise.allSettled(assignedIds.map((cid) => apiGet<Camera>(`/cameras/${cid}`))),
          Promise.allSettled(assignedIds.map((cid) => apiGet<StreamInfo>(`/cameras/${cid}/stream`))),
        ])

        const cameraMap = new Map<string, Camera>()
        camerasData.forEach((r, i) => { if (r.status === 'fulfilled') cameraMap.set(assignedIds[i], r.value) })

        const streamMap = new Map<string, StreamInfo>()
        streamData.forEach((r, i) => { if (r.status === 'fulfilled') streamMap.set(assignedIds[i], r.value) })

        setSlots(v.cameraSlots.map((s) => ({
          ...s,
          camera: s.cameraId ? cameraMap.get(s.cameraId) : undefined,
          stream: s.cameraId ? streamMap.get(s.cameraId) : undefined,
        })))
      })
      .catch((e) => setError(e?.message ?? 'No se pudo cargar la vista'))
      .finally(() => setIsLoading(false))
  }, [id])

  // Load streams for new pages
  useEffect(() => {
    if (!view) return
    const perPage = getSlotsPerPage(view.layout)
    const pageIds = filledSlots
      .slice(currentPage * perPage, (currentPage + 1) * perPage)
      .map((s) => s.cameraId!)
      .filter((cid) => !slots.find((s) => s.cameraId === cid)?.stream)
    if (pageIds.length === 0) return

    Promise.allSettled(pageIds.map((cid) => apiPost<StreamInfo>(`/cameras/${cid}/start-stream`, { viewId: viewIdRef.current })))
      .then((results) => {
        const loaded = new Map<string, StreamInfo>()
        results.forEach((r, i) => { if (r.status === 'fulfilled') loaded.set(pageIds[i], r.value) })
        if (loaded.size > 0) {
          setSlots((prev) => prev.map((s) => (s.cameraId && loaded.has(s.cameraId) ? { ...s, stream: loaded.get(s.cameraId) } : s)))
        }
      })
  }, [currentPage, view]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Slideshow ────────────────────────────────────────────────────────────
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

  const prevPage = useCallback(() => setCurrentPage((p) => (p - 1 + totalPages) % totalPages), [totalPages])
  const nextPage = useCallback(() => setCurrentPage((p) => (p + 1) % totalPages), [totalPages])

  // ─── Heartbeat — mantiene vivas las sesiones (TTL de 90 s) ───────────────
  //
  // Este intervalo NO tenía guarda de visibilidad: con la pestaña oculta seguía
  // latiendo cada 30 s, el servidor veía un espectador y nunca expiraba las
  // sesiones ni liberaba FFmpeg (validación A1). Ahora el intervalo lo posee
  // `heartbeatScheduler`: se cancela al ocultarse y se rearma —uno solo, con un
  // latido inmediato— al volver.
  useEffect(() => {
    if (!view || filledSlots.length === 0) return
    const perPage     = getSlotsPerPage(view.layout)
    const pageSlots   = filledSlots.slice(currentPage * perPage, (currentPage + 1) * perPage)
    const visibleIds  = pageSlots.map((s) => s.cameraId!).filter(Boolean)
    if (visibleIds.length === 0) return

    const sendBeat = (signal: AbortSignal) =>
      apiPost('/live-view/heartbeat', {
        viewId:           viewIdRef.current,
        visibleCameraIds: visibleIds,
        layout:           perPage,
        page:             currentPage,
      }, undefined, signal).then((result: any) => {
        if (!result?.streams) return
        // La pestaña pudo ocultarse mientras la solicitud viajaba.
        if (tabIsHidden()) return
        setSlots((prev) => prev.map((s) => {
          if (!s.cameraId) return s
          const info = result.streams[s.cameraId]
          return info ? { ...s, stream: info } : s
        }))
      }).catch(() => {})

    const scheduler = createHeartbeatScheduler({
      intervalMs: 30_000,
      isHidden: tabIsHidden,
      send: sendBeat,
    })
    const onVisibility = () => scheduler.handleVisibilityChange()
    document.addEventListener('visibilitychange', onVisibility)
    scheduler.start()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      scheduler.stop()
    }
  }, [view, currentPage, filledSlots.map((s) => s.cameraId).join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Loading / error UI ───────────────────────────────────────────────────
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

  // ─── Fullscreen CSS overlay ───────────────────────────────────────────────
  if (fsState.phase !== 'idle') {
    const fsSlot   = slots.find(s => s.cameraId === fsState.cameraId)
    const fsCamera = fsSlot?.camera
    const activeHls = fsState.hdStream?.hls ?? fsSlot?.stream?.hls
    const isHd      = fsState.phase === 'fullscreen_hd' && !!fsState.hdStream
    const badge     = buildStreamBadge(fsState, fsCamera)

    return (
      <div className="flex flex-col h-full bg-black">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2.5 bg-surface-900/80 backdrop-blur-sm border-b border-surface-700/50 flex-shrink-0">
          <button onClick={exitFullscreen} className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700 transition-colors" title="Salir de pantalla completa">
            <Minimize2 size={14} />
          </button>
          <LayoutGrid size={14} className="text-brand-400" />
          <span className="text-sm font-medium text-surface-100">{view.name}</span>
          <span className="text-xs text-surface-500">·</span>
          <span className="text-sm text-surface-300">{fsCamera?.name ?? 'Cámara'}</span>

          {/* Stream badge */}
          <span className={clsx('ml-2 text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1',
            fsState.phase === 'starting_hd'              ? 'bg-surface-700 text-surface-400' :
            isHd                                          ? 'bg-brand-900/40 text-brand-400' :
            fsState.phase === 'fullscreen_sub_fallback'  ? 'bg-amber-900/40 text-amber-400' :
            'bg-red-900/40 text-red-400'
          )}>
            {fsState.phase === 'starting_hd' && <Loader2 size={9} className="animate-spin" />}
            {badge}
          </span>

          {/* Error detail */}
          {fsState.errorMsg && (
            <span className="text-[10px] text-amber-500/70 ml-1" title={fsState.errorMsg}>
              <AlertTriangle size={9} className="inline" /> {fsState.errorCode}
            </span>
          )}

          <button
            onClick={() => navigate('/views')}
            className="ml-auto p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-700 transition-colors"
          >
            <ArrowLeft size={14} />
          </button>
        </div>

        {/* Video */}
        <div className="flex-1 overflow-hidden">
          {activeHls ? (
            <VideoPlayer
              hlsUrl={activeHls}
              cameraName={fsCamera?.name ?? ''}
              cameraId={fsState.cameraId!}
              streamType={isHd ? 'main' : 'sub'}
              streamCodec={isHd ? (fsCamera?.mainCodec ?? undefined) : (fsCamera?.subCodec ?? undefined)}
              streamResolution={isHd ? (fsCamera?.mainResolution ?? undefined) : (fsCamera?.subResolution ?? undefined)}
              onFullscreen={exitFullscreen}
              onStreamError={handleFsStreamError}
              objectFit={objectFit === 'adapt' ? 'contain' : objectFit}
              className="w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
              <Monitor size={24} className="text-surface-600" />
              <span className="text-sm text-surface-400">{fsCamera?.name ?? 'Sin stream'}</span>
              {fsState.phase === 'starting_hd' && (
                <span className="text-xs text-surface-500 flex items-center gap-1">
                  <Loader2 size={11} className="animate-spin" /> Iniciando stream HD...
                </span>
              )}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="py-1.5 bg-surface-900/60 border-t border-surface-700/50 text-center">
          <span className="text-[10px] text-surface-600">
            Doble clic o <Minimize2 size={9} className="inline" /> para salir · {badge}
          </span>
        </div>
      </div>
    )
  }

  // ─── Normal grid view ─────────────────────────────────────────────────────
  const pageSlots = filledSlots.slice(currentPage * slotsPerPage, (currentPage + 1) * slotsPerPage)
  // In adapt mode skip empty padding; in other modes pad to full grid
  if (objectFit !== 'adapt') {
    while (pageSlots.length < slotsPerPage) {
      pageSlots.push({ slotIndex: -1, cameraId: null, size: 'normal' })
    }
  }

  const cols       = LAYOUT_COLS[view.layout] ?? 3
  const isFeatured = view.layout === 'featured'

  // renderCell used by featured layout — same approach as CameraCell
  const renderCell = (slot: SlotWithCamera) => {
    if (!slot.cameraId || !slot.camera) {
      if (objectFit === 'adapt') return null
      return (
        <div className="h-full min-h-[80px] bg-surface-900 rounded flex items-center justify-center">
          <Monitor size={16} className="text-surface-700" />
        </div>
      )
    }
    const camera = slot.camera
    const res    = parseResolution(camera.subResolution ?? camera.mainResolution)
    const adaptStyle = (objectFit === 'adapt' && res)
      ? { aspectRatio: `${res.w}/${res.h}`, width: '100%' }
      : undefined

    return (
      <div
        ref={(el) => { if (el) tileRefs.current.set(slot.cameraId!, el) }}
        className="rounded overflow-hidden bg-surface-900 relative group"
        style={adaptStyle ?? { height: '100%', minHeight: '80px' }}
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
            objectFit={objectFit === 'adapt' ? 'contain' : objectFit}
            className="w-full h-full"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5" style={{ minHeight: 80 }}>
            <Monitor size={16} className="text-surface-600" />
            <span className="text-xs text-surface-500">{camera.name}</span>
            <span className="text-[10px] text-surface-600">Sin stream</span>
          </div>
        )}
        <button
          onClick={() => enterFullscreen(slot.cameraId!)}
          className="absolute top-2 left-2 p-1 rounded bg-black/60 text-white transition-opacity opacity-0 group-hover:opacity-100"
          title="Pantalla completa HD"
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

        {/* Fit / Fill / Adapt toggle */}
        <div className="flex gap-0.5 flex-shrink-0">
          {([
            { mode: 'contain' as ObjectFitMode, icon: <ScanLine size={11} />, label: 'Fit',    title: 'Fit: imagen completa con posibles barras negras' },
            { mode: 'cover'   as ObjectFitMode, icon: <Crop     size={11} />, label: 'Fill',   title: 'Fill: llena el tile recortando bordes' },
            { mode: 'adapt'   as ObjectFitMode, icon: <Expand   size={11} />, label: 'Adaptar', title: 'Adaptar: tile se ajusta a la proporción del video, sin recorte ni barras' },
          ] as const).map(({ mode, icon, label, title }) => (
            <button
              key={mode}
              onClick={() => setObjectFit(mode)}
              title={title}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors',
                objectFit === mode
                  ? 'bg-brand-700/40 text-brand-300 border border-brand-600/40'
                  : 'bg-surface-700/50 text-surface-400 hover:text-surface-200'
              )}
            >
              {icon} {label}
            </button>
          ))}
        </div>

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
      <div className={clsx('flex-1 min-h-0 p-0.5', objectFit === 'adapt' && 'overflow-y-auto')}>
        {isFeatured && objectFit !== 'adapt' ? (
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
        ) : objectFit === 'adapt' ? (
          // Adapt mode: flex-wrap so tiles take their natural aspect-ratio size
          <div className="flex flex-wrap gap-1 content-start">
            {pageSlots.filter(s => s.cameraId).map((s, i) => (
              <div key={s.cameraId ?? `empty-${i}`} style={{ flexBasis: `calc(${100 / cols}% - 4px)`, flexGrow: 1, maxWidth: `calc(${100 / cols}% - 4px)` }}>
                <CameraCell slot={s} tileRefs={tileRefs} objectFit={objectFit} onFullscreen={enterFullscreen} />
              </div>
            ))}
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
