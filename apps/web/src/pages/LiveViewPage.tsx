// src/pages/LiveViewPage.tsx
import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Grid2x2, Grid3x3, LayoutGrid, Maximize2, ChevronDown,
  ChevronLeft, ChevronRight, AlertTriangle, WifiOff, Film, Lock,
} from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { VideoPlayer, type CameraPlaybackError } from '@/components/cameras/VideoPlayer'
import { PTZControls } from '@/components/cameras/PTZControls'
import { CameraDiagnosticModal } from '@/components/cameras/CameraDiagnosticModal'
import { useAuthStore } from '@/stores/authStore'
import { apiPost } from '@/lib/api'
import { clsx } from 'clsx'
import type { Camera, StreamInfo, GridLayout, StreamHealthStatus } from '@/types'

// ─── Stagger delay per layout ────────────────────────────────
const STAGGER_MS: Record<GridLayout, number> = { 1: 0, 4: 250, 9: 400, 16: 500 }

// ─── Health status config ────────────────────────────────────
const HEALTH_CONFIG: Record<string, { icon: React.ReactNode; label: string; blockStream: boolean }> = {
  RTSP_SUB_NOT_FOUND:      { icon: <AlertTriangle size={12} />, label: 'Substream 404',         blockStream: true },
  RTSP_MAIN_NOT_FOUND:     { icon: <AlertTriangle size={12} />, label: 'RTSP no encontrado',    blockStream: true },
  CODEC_UNSUPPORTED_HEVC:  { icon: <Film size={12} />,          label: 'HEVC no compatible',    blockStream: true },
  STREAM_UNSTABLE:         { icon: <AlertTriangle size={12} />, label: 'Stream inestable',      blockStream: false },
  MEDIA_SERVER_ERROR:      { icon: <AlertTriangle size={12} />, label: 'Error servidor',        blockStream: false },
  AUTH_FAILED:             { icon: <Lock size={12} />,          label: 'Auth fallida',          blockStream: true },
  OFFLINE:                 { icon: <WifiOff size={12} />,       label: 'Offline',               blockStream: true },
}

function isBlockedByHealth(status?: StreamHealthStatus): boolean {
  if (!status || status === 'UNKNOWN' || status === 'HEALTHY' || status === 'STREAM_UNSTABLE') return false
  return HEALTH_CONFIG[status]?.blockStream ?? false
}

function getHealthError(status: StreamHealthStatus, channel: number): CameraPlaybackError {
  const cfg = HEALTH_CONFIG[status]
  const codeMap: Record<string, CameraPlaybackError['code']> = {
    RTSP_SUB_NOT_FOUND:     'RTSP_CHANNEL_NOT_FOUND',
    RTSP_MAIN_NOT_FOUND:    'RTSP_CHANNEL_NOT_FOUND',
    CODEC_UNSUPPORTED_HEVC: 'CODEC_UNSUPPORTED',
    AUTH_FAILED:            'AUTH_FAILED',
    OFFLINE:                'CAMERA_OFFLINE',
    MEDIA_SERVER_ERROR:     'MEDIAMTX_ROUTE_MISSING',
    STREAM_UNSTABLE:        'UNKNOWN',
  }
  return {
    code:          codeMap[status] ?? 'UNKNOWN',
    message:       cfg?.label ?? status,
    technicalDetail: status === 'RTSP_SUB_NOT_FOUND'
      ? `Substream /Streaming/Channels/${channel}02 devolvió 404`
      : status === 'CODEC_UNSUPPORTED_HEVC'
        ? 'El stream usa HEVC/H.265 — no reproducible en navegadores sin transcodificación'
        : undefined,
  }
}

const GRID_OPTIONS: { value: GridLayout; label: string; icon: React.ReactNode; cols: string }[] = [
  { value: 1,  label: '1×1',  icon: <Maximize2 size={14} />,  cols: 'grid-cols-1' },
  { value: 4,  label: '2×2',  icon: <Grid2x2 size={14} />,    cols: 'grid-cols-2' },
  { value: 9,  label: '3×3',  icon: <Grid3x3 size={14} />,    cols: 'grid-cols-3' },
  { value: 16, label: '4×4',  icon: <LayoutGrid size={14} />, cols: 'grid-cols-4' },
]

export function LiveViewPage() {
  const [searchParams] = useSearchParams()
  const nvrFilter = searchParams.get('nvr')

  const { nvrs, cameras, loadNVRs, loadCameras } = useCameraStore()
  const { user } = useAuthStore()

  const [gridLayout, setGridLayout]   = useState<GridLayout>(9)
  const [selectedNVR, setSelectedNVR] = useState<string>(nvrFilter || 'all')
  const [page, setPage]               = useState(0)
  const [streams, setStreams]         = useState<Record<string, StreamInfo>>({})
  const [loadingStreams, setLoadingStreams] = useState<Record<string, boolean>>({})
  const [streamErrors, setStreamErrors]    = useState<Record<string, CameraPlaybackError>>({})
  const [focusCamera, setFocusCamera]      = useState<string | null>(null)
  const [diagnosticCamera, setDiagnosticCamera] = useState<{ id: string; name: string } | null>(null)

  // Track which cameraIds have active sessions in the backend
  const activeSessions = useRef<Set<string>>(new Set())
  // Track pending start-stream requests to avoid double-firing
  const pendingStarts  = useRef<Set<string>>(new Set())
  // Stagger timers so we can cancel them on navigation
  const staggerTimers  = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => { loadNVRs(); loadCameras() }, [])
  useEffect(() => { if (nvrFilter) setSelectedNVR(nvrFilter) }, [nvrFilter])

  // Derived visible cameras
  const allFiltered = cameras.filter((c) =>
    selectedNVR === 'all' ? true : c.nvrId === selectedNVR
  )
  const totalPages      = Math.max(1, Math.ceil(allFiltered.length / gridLayout))
  const safePage        = Math.min(page, totalPages - 1)
  const filteredCameras = allFiltered.slice(safePage * gridLayout, (safePage + 1) * gridLayout)

  // ─── Stop sessions for a set of cameraIds ───────────────────
  const stopSessions = useCallback(async (cameraIds: string[]) => {
    const toStop = cameraIds.filter(id => activeSessions.current.has(id))
    if (toStop.length === 0) return
    await Promise.allSettled(
      toStop.map(id => apiPost(`/cameras/${id}/stop-stream`, {}).catch(() => {}))
    )
    toStop.forEach(id => {
      activeSessions.current.delete(id)
      pendingStarts.current.delete(id)
    })
  }, [])

  // ─── Clear stagger timers ────────────────────────────────────
  const clearStaggerTimers = useCallback(() => {
    staggerTimers.current.forEach(clearTimeout)
    staggerTimers.current = []
  }, [])

  // ─── Stop ALL current sessions + clear state ────────────────
  const stopAllSessions = useCallback(async () => {
    clearStaggerTimers()
    const allActive = Array.from(activeSessions.current)
    await stopSessions(allActive)
    setStreams({})
    setStreamErrors({})
    setLoadingStreams({})
  }, [stopSessions, clearStaggerTimers])

  // ─── Heartbeat every 60s ────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      activeSessions.current.forEach(id => {
        apiPost(`/cameras/${id}/touch-stream`, {}).catch(() => {})
      })
    }, 60_000)
    return () => clearInterval(interval)
  }, [])

  // ─── Cleanup on unmount ─────────────────────────────────────
  useEffect(() => {
    return () => {
      clearStaggerTimers()
      activeSessions.current.forEach(id => {
        apiPost(`/cameras/${id}/stop-stream`, {}).catch(() => {})
      })
    }
  }, [clearStaggerTimers])

  // ─── Load a single stream ────────────────────────────────────
  const loadStream = useCallback(async (camera: Camera): Promise<void> => {
    if (streams[camera.id] || pendingStarts.current.has(camera.id)) return

    // Block cameras with known bad health
    if (isBlockedByHealth(camera.streamHealthStatus)) {
      setStreamErrors(prev => ({
        ...prev,
        [camera.id]: getHealthError(camera.streamHealthStatus!, camera.channel),
      }))
      return
    }

    pendingStarts.current.add(camera.id)
    setLoadingStreams(prev => ({ ...prev, [camera.id]: true }))

    try {
      const info = await apiPost<StreamInfo>(`/cameras/${camera.id}/start-stream`, {})
      activeSessions.current.add(camera.id)
      setStreams(prev => ({ ...prev, [camera.id]: info }))
      setStreamErrors(prev => {
        const next = { ...prev }
        delete next[camera.id]
        return next
      })
    } catch (err: any) {
      const msg: string = err?.response?.data?.message || ''
      let code: CameraPlaybackError['code'] = 'UNKNOWN'
      let message = 'No se pudo obtener el stream'

      if (msg.includes('offline') || msg.includes('NVR')) { code = 'NVR_OFFLINE'; message = 'NVR offline o inaccesible' }
      else if (msg.includes('401') || msg.includes('auth') || msg.includes('credencial')) { code = 'AUTH_FAILED'; message = 'Credenciales inválidas' }
      else if (msg.includes('timeout')) { code = 'RTSP_TIMEOUT'; message = 'RTSP timeout' }
      else if (msg.includes('canal') || msg.includes('channel') || msg.includes('404')) { code = 'RTSP_CHANNEL_NOT_FOUND'; message = 'Canal no encontrado' }
      else if (msg.includes('HEVC') || msg.includes('H.265')) { code = 'CODEC_UNSUPPORTED'; message = 'Codec HEVC no soportado' }
      else if (msg.includes('Límite')) {
        // Limit hit — try to cleanup non-visible sessions and retry once
        await handleLimitHit(camera)
        return
      }

      setStreamErrors(prev => ({ ...prev, [camera.id]: { code, message, technicalDetail: msg } }))
    } finally {
      pendingStarts.current.delete(camera.id)
      setLoadingStreams(prev => ({ ...prev, [camera.id]: false }))
    }
  }, [streams]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Handle stream limit: cleanup non-visible then retry ────
  const handleLimitHit = useCallback(async (camera: Camera) => {
    const visibleIds = new Set(filteredCameras.map(c => c.id))
    const nonVisible = Array.from(activeSessions.current).filter(id => !visibleIds.has(id))

    if (nonVisible.length > 0) {
      await stopSessions(nonVisible)
      // Remove ghost streams from state
      setStreams(prev => {
        const next = { ...prev }
        nonVisible.forEach(id => delete next[id])
        return next
      })
      // Single retry
      pendingStarts.current.delete(camera.id)
      await loadStream(camera)
    } else {
      setStreamErrors(prev => ({
        ...prev,
        [camera.id]: { code: 'UNKNOWN', message: `Límite de streams alcanzado (${gridLayout} máx)` },
      }))
      setLoadingStreams(prev => ({ ...prev, [camera.id]: false }))
    }
  }, [filteredCameras, gridLayout, stopSessions, loadStream])

  // ─── Start visible streams with stagger ─────────────────────
  const startVisibleStreams = useCallback((cameras: Camera[]) => {
    const delay = STAGGER_MS[gridLayout] ?? 500
    cameras.forEach((cam, idx) => {
      const timer = setTimeout(() => loadStream(cam), idx * delay)
      staggerTimers.current.push(timer)
    })
  }, [gridLayout, loadStream])

  // ─── React to page/NVR/layout changes ───────────────────────
  // When the visible camera set changes, stop cameras that left the view,
  // then start new ones with stagger.
  const prevVisibleIds = useRef<string[]>([])
  const isTransitioning = useRef(false)

  useEffect(() => {
    const currentIds = filteredCameras.map(c => c.id)
    const prevIds    = prevVisibleIds.current

    // Nothing changed
    if (currentIds.join(',') === prevIds.join(',')) return

    const leaving  = prevIds.filter(id => !currentIds.includes(id))
    const arriving = filteredCameras.filter(c => !prevIds.includes(c.id))

    prevVisibleIds.current = currentIds

    if (isTransitioning.current) return
    isTransitioning.current = true

    clearStaggerTimers()

    // Stop leaving cameras
    stopSessions(leaving).then(() => {
      // Remove leaving cameras from state
      if (leaving.length > 0) {
        setStreams(prev => {
          const next = { ...prev }
          leaving.forEach(id => delete next[id])
          return next
        })
        setStreamErrors(prev => {
          const next = { ...prev }
          leaving.forEach(id => delete next[id])
          return next
        })
        setLoadingStreams(prev => {
          const next = { ...prev }
          leaving.forEach(id => delete next[id])
          return next
        })
      }
      // Start arriving cameras
      startVisibleStreams(arriving)
      isTransitioning.current = false
    })
  }, [filteredCameras.map(c => c.id).join(',')])

  // ─── On layout/NVR/page selection change → stop all + restart
  const handleLayoutChange = useCallback(async (layout: GridLayout) => {
    await stopAllSessions()
    prevVisibleIds.current = []
    setGridLayout(layout)
    setPage(0)
  }, [stopAllSessions])

  const handleNVRChange = useCallback(async (nvrId: string) => {
    await stopAllSessions()
    prevVisibleIds.current = []
    setSelectedNVR(nvrId)
    setPage(0)
  }, [stopAllSessions])

  const handlePageChange = useCallback(async (newPage: number) => {
    await stopAllSessions()
    prevVisibleIds.current = []
    setPage(newPage)
  }, [stopAllSessions])

  // ─── Diagnostic & restart ─────────────────────────────────
  const handleDiagnostic = useCallback((cameraId: string) => {
    const cam = cameras.find(c => c.id === cameraId)
    if (cam) setDiagnosticCamera({ id: cameraId, name: `${cam.nvr?.name || ''} · ${cam.name}` })
  }, [cameras])

  const handleRestartStream = useCallback(async (cameraId: string) => {
    activeSessions.current.delete(cameraId)
    pendingStarts.current.delete(cameraId)
    setStreams(prev => { const n = { ...prev }; delete n[cameraId]; return n })
    setStreamErrors(prev => { const n = { ...prev }; delete n[cameraId]; return n })
    // Restart MediaMTX path
    await apiPost(`/cameras/${cameraId}/restart-stream`, {}).catch(() => {})
    const cam = cameras.find(c => c.id === cameraId)
    if (cam) setTimeout(() => loadStream(cam), 3000)
  }, [cameras, loadStream])

  // ─── Called by VideoPlayer when HLS error is fatal ──────────
  const handleStreamError = useCallback((cameraId: string, err: CameraPlaybackError) => {
    if (activeSessions.current.has(cameraId)) {
      apiPost(`/cameras/${cameraId}/stop-stream`, {}).catch(() => {})
      activeSessions.current.delete(cameraId)
    }
    setStreamErrors(prev => ({ ...prev, [cameraId]: err }))
  }, [])

  const currentGrid   = GRID_OPTIONS.find(g => g.value === gridLayout) || GRID_OPTIONS[2]
  const totalForFilter = allFiltered.length

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-surface-800 border-b border-surface-600">
        <div className="relative">
          <select
            value={selectedNVR}
            onChange={e => handleNVRChange(e.target.value)}
            className="appearance-none pl-3 pr-8 py-1.5 rounded-lg bg-surface-700 border border-surface-600
                       text-surface-100 text-xs focus:outline-none focus:border-brand-500 cursor-pointer"
          >
            <option value="all">Todos los NVRs ({cameras.length} cámaras)</option>
            {nvrs.map(nvr => (
              <option key={nvr.id} value={nvr.id}>
                {nvr.name} ({nvr.channels} canales)
              </option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
        </div>

        <div className="h-4 w-px bg-surface-600" />

        <div className="flex gap-1">
          {GRID_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => handleLayoutChange(opt.value)}
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors',
                gridLayout === opt.value
                  ? 'bg-brand-600 text-white'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
              )}
            >
              {opt.icon}
              <span className="hidden sm:block">{opt.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handlePageChange(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              className="p-1 rounded-lg bg-surface-700 text-surface-300 hover:bg-surface-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-surface-400 tabular-nums min-w-[4rem] text-center">
              {safePage + 1} / {totalPages}
            </span>
            <button
              onClick={() => handlePageChange(Math.min(totalPages - 1, safePage + 1))}
              disabled={safePage === totalPages - 1}
              className="p-1 rounded-lg bg-surface-700 text-surface-300 hover:bg-surface-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}

        <span className="text-xs text-surface-500">
          {safePage * gridLayout + 1}–{Math.min((safePage + 1) * gridLayout, totalForFilter)} de {totalForFilter}
        </span>
      </div>

      {/* Grid de video */}
      <div className="flex-1 overflow-hidden p-2 bg-surface-900">
        {focusCamera ? (
          <div className="h-full">
            {(() => {
              const cam    = cameras.find(c => c.id === focusCamera)
              const stream = streams[focusCamera]
              if (!cam) return null
              return (
                <div className="h-full flex gap-2">
                  <VideoPlayer
                    hlsUrl={stream?.hls || ''}
                    cameraName={`${cam.nvr?.name} — ${cam.name}`}
                    cameraId={cam.id}
                    isRecording={cam.online}
                    onFullscreen={() => setFocusCamera(null)}
                    onDiagnostic={handleDiagnostic}
                    onStreamError={handleStreamError}
                    className="flex-1 h-full"
                    playbackError={streamErrors[focusCamera]}
                  />
                  {(user?.role === 'ADMIN' || user?.role === 'SUPERVISOR') && cam.ptzEnabled && (
                    <PTZControls cameraId={cam.id} />
                  )}
                </div>
              )
            })()}
          </div>
        ) : (
          <div className={clsx('grid gap-1.5 h-full', currentGrid.cols)}>
            {filteredCameras.map(camera => {
              const stream = streams[camera.id]
              const health = camera.streamHealthStatus
              return (
                <div
                  key={camera.id}
                  className="relative min-h-0 rounded-lg overflow-hidden border border-surface-700"
                >
                  {/* Health badge */}
                  {health && health !== 'HEALTHY' && health !== 'UNKNOWN' && HEALTH_CONFIG[health] && (
                    <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1 bg-black/70 rounded px-1.5 py-0.5">
                      <span className="text-amber-400">{HEALTH_CONFIG[health].icon}</span>
                      <span className="text-[9px] text-amber-300 font-medium">{HEALTH_CONFIG[health].label}</span>
                    </div>
                  )}
                  <VideoPlayer
                    hlsUrl={stream?.hls || ''}
                    cameraName={`${camera.nvr?.name || ''} · ${camera.name}`}
                    cameraId={camera.id}
                    isRecording={camera.online}
                    onFullscreen={() => setFocusCamera(camera.id)}
                    onDiagnostic={handleDiagnostic}
                    onStreamError={handleStreamError}
                    className="w-full h-full"
                    playbackError={streamErrors[camera.id]}
                  />
                </div>
              )
            })}
            {Array.from({ length: Math.max(0, gridLayout - filteredCameras.length) }).map((_, i) => (
              <div key={`empty-${i}`} className="rounded-lg border border-surface-700 bg-surface-800/50 flex items-center justify-center">
                <span className="text-xs text-surface-600">Sin cámara</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal diagnóstico */}
      {diagnosticCamera && (
        <CameraDiagnosticModal
          cameraId={diagnosticCamera.id}
          cameraName={diagnosticCamera.name}
          onClose={() => setDiagnosticCamera(null)}
          onRestartStream={() => handleRestartStream(diagnosticCamera.id)}
        />
      )}
    </div>
  )
}
