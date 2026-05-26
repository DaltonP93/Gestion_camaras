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
const STAGGER_MS: Record<GridLayout, number> = { 1: 0, 4: 250, 9: 400, 16: 500, 25: 600 }

// ─── Health status config ────────────────────────────────────
const HEALTH_CONFIG: Record<string, { icon: React.ReactNode; label: string; blockStream: boolean }> = {
  USING_MAIN_STREAM:       { icon: <Film size={12} />,          label: 'Main stream',           blockStream: false },
  RTSP_SUB_NOT_FOUND:      { icon: <AlertTriangle size={12} />, label: 'Substream 404',         blockStream: true },
  RTSP_MAIN_NOT_FOUND:     { icon: <AlertTriangle size={12} />, label: 'RTSP no encontrado',    blockStream: true },
  CODEC_UNSUPPORTED_HEVC:  { icon: <Film size={12} />,          label: 'HEVC no compatible',    blockStream: true },
  STREAM_UNSTABLE:         { icon: <AlertTriangle size={12} />, label: 'Stream inestable',      blockStream: false },
  MEDIA_SERVER_ERROR:      { icon: <AlertTriangle size={12} />, label: 'Error servidor',        blockStream: false },
  AUTH_FAILED:             { icon: <Lock size={12} />,          label: 'Auth fallida',          blockStream: true },
  OFFLINE:                 { icon: <WifiOff size={12} />,       label: 'Offline',               blockStream: true },
}

function isBlockedByHealth(camera: Camera): boolean {
  const status = camera.streamHealthStatus
  if (!status || status === 'UNKNOWN' || status === 'HEALTHY' || status === 'STREAM_UNSTABLE') return false
  if (status === 'USING_MAIN_STREAM') {
    // Block if main codec is HEVC — browser can't play it; validator may have stale data
    const mc = ((camera as any).mainCodec || '').toLowerCase()
    if (mc.includes('hevc') || mc.includes('h265') || mc.includes('h.265')) return true
    return false
  }
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
    code:            codeMap[status] ?? 'UNKNOWN',
    message:         cfg?.label ?? status,
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

  // playerKeys forces VideoPlayer remount (new HLS instance) when incremented for a camera
  const [playerKeys, setPlayerKeys] = useState<Record<string, number>>({})

  // Track which cameraIds have active sessions in the backend
  const activeSessions = useRef<Set<string>>(new Set())
  // Track pending start-stream requests to avoid double-firing
  const pendingStarts  = useRef<Set<string>>(new Set())
  // Stagger timers so we can cancel them on navigation
  const staggerTimers  = useRef<ReturnType<typeof setTimeout>[]>([])
  // Track when page became hidden to decide whether to refresh on unhide
  const hiddenSince    = useRef<number | null>(null)
  // Rate-limit per-camera 401 auto-restarts: timestamp of last restart per cameraId
  const lastRestartAt  = useRef<Record<string, number>>({})

  useEffect(() => { loadNVRs(); loadCameras() }, [])
  useEffect(() => { if (nvrFilter) setSelectedNVR(nvrFilter) }, [nvrFilter])

  // Derived visible cameras
  const allFiltered = cameras.filter((c) =>
    selectedNVR === 'all' ? true : c.nvrId === selectedNVR
  )
  const totalPages      = Math.max(1, Math.ceil(allFiltered.length / gridLayout))
  const safePage        = Math.min(page, totalPages - 1)
  const filteredCameras = allFiltered.slice(safePage * gridLayout, (safePage + 1) * gridLayout)

  // ─── Bump player keys to force VideoPlayer remount ──────────
  // This is necessary because when hlsUrl stays the same after a session restart,
  // VideoPlayer's useEffect doesn't re-run and the old (broken) HLS instance persists.
  const bumpPlayerKeys = useCallback((cameraIds: string[]) => {
    setPlayerKeys(prev => {
      const next = { ...prev }
      cameraIds.forEach(id => { next[id] = (next[id] ?? 0) + 1 })
      return next
    })
  }, [])

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
  // NOTE: intentionally does NOT depend on `streams` state — using it would create
  // a stale closure bug where after a 401 clears streams[id], the setTimeout that
  // calls loadStream still sees the old streams snapshot and returns early.
  // pendingStarts guards against concurrent duplicate calls instead.
  const loadStream = useCallback(async (camera: Camera): Promise<void> => {
    if (pendingStarts.current.has(camera.id)) return

    // Block cameras with known bad health (including USING_MAIN_STREAM + HEVC)
    if (isBlockedByHealth(camera)) {
      const effectiveStatus = camera.streamHealthStatus === 'USING_MAIN_STREAM' ? 'CODEC_UNSUPPORTED_HEVC' : camera.streamHealthStatus!
      setStreamErrors(prev => ({
        ...prev,
        [camera.id]: getHealthError(effectiveStatus, camera.channel),
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
      const body = err?.response?.data || {}
      // Backend returns { error: "CODE", message: "...", details: "..." }
      const code: string = body.error || ''
      const rawMsg: string = body.message || body.error || ''

      if (code === 'STREAM_LIMIT_REACHED' || code === 'STREAM_LIMIT_GLOBAL') {
        await handleLimitHit(camera)
        return
      }

      const errCodeMap: Record<string, CameraPlaybackError['code']> = {
        RTSP_SUB_NOT_FOUND:     'RTSP_CHANNEL_NOT_FOUND',
        RTSP_MAIN_NOT_FOUND:    'RTSP_CHANNEL_NOT_FOUND',
        CODEC_UNSUPPORTED_HEVC: 'CODEC_UNSUPPORTED',
        AUTH_FAILED:            'AUTH_FAILED',
        OFFLINE:                'CAMERA_OFFLINE',
        MEDIA_SERVER_ERROR:     'MEDIAMTX_NOT_READY',
        CAMERA_NOT_FOUND:       'UNKNOWN',
        CAMERA_DISABLED:        'UNKNOWN',
      }

      setStreamErrors(prev => ({
        ...prev,
        [camera.id]: {
          code: errCodeMap[code] || 'UNKNOWN',
          message: rawMsg || 'No se pudo obtener el stream',
          technicalDetail: body.details,
        },
      }))
    } finally {
      pendingStarts.current.delete(camera.id)
      setLoadingStreams(prev => ({ ...prev, [camera.id]: false }))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Handle stream limit: cleanup non-visible then retry ────
  const handleLimitHit = useCallback(async (camera: Camera) => {
    const visibleIds = new Set(filteredCameras.map(c => c.id))
    const nonVisible = Array.from(activeSessions.current).filter(id => !visibleIds.has(id))

    if (nonVisible.length > 0) {
      await stopSessions(nonVisible)
      setStreams(prev => {
        const next = { ...prev }
        nonVisible.forEach(id => delete next[id])
        return next
      })
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
  const startVisibleStreams = useCallback((cams: Camera[]) => {
    const delay = STAGGER_MS[gridLayout] ?? 500
    cams.forEach((cam, idx) => {
      const timer = setTimeout(() => loadStream(cam), idx * delay)
      staggerTimers.current.push(timer)
    })
  }, [gridLayout, loadStream])

  // ─── Full session refresh: stop → bump keys → restart ───────
  // Used after PC lock/unlock (visibilitychange > 10s) and fullscreen exit.
  // Bumping playerKeys forces VideoPlayer to remount so the stale HLS.js
  // instance (which keeps making 401 requests) is fully destroyed.
  const refreshVisibleStreams = useCallback(async (
    reason: 'visibilitychange' | 'fullscreen-exit' | 'manual-retry',
    cams?: Camera[],
  ) => {
    clearStaggerTimers()
    const targetCams = cams ?? filteredCameras
    const targetIds  = targetCams.map(c => c.id)

    // Stop sessions for target cameras + any non-visible active ones
    const toStop = Array.from(activeSessions.current)
    await Promise.allSettled(
      toStop.map(id => apiPost(`/cameras/${id}/stop-stream`, {}).catch(() => {}))
    )
    toStop.forEach(id => {
      activeSessions.current.delete(id)
      pendingStarts.current.delete(id)
    })

    // Clear state
    setStreams({})
    setStreamErrors({})
    setLoadingStreams({})

    // Bump player keys — forces VideoPlayer to unmount+remount so stale HLS
    // instances are fully destroyed before we restart
    bumpPlayerKeys(targetIds)

    // Wait for state to settle + MediaMTX to release connections
    await new Promise(r => setTimeout(r, 500))

    startVisibleStreams(targetCams)
  }, [clearStaggerTimers, filteredCameras, bumpPlayerKeys, startVisibleStreams])

  // ─── Page visibility: refresh after 10s of being hidden ─────
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince.current = Date.now()
      } else {
        const hiddenMs = hiddenSince.current ? Date.now() - hiddenSince.current : 0
        hiddenSince.current = null
        // Only refresh if hidden long enough that sessions might have expired
        if (hiddenMs > 10_000 && activeSessions.current.size > 0) {
          refreshVisibleStreams('visibilitychange')
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [refreshVisibleStreams])

  // ─── React to visible camera set changes ────────────────────
  const prevVisibleIds = useRef<string[]>([])
  const isTransitioning = useRef(false)

  useEffect(() => {
    const currentIds = filteredCameras.map(c => c.id)
    const prevIds    = prevVisibleIds.current

    if (currentIds.join(',') === prevIds.join(',')) return

    const leaving  = prevIds.filter(id => !currentIds.includes(id))
    const arriving = filteredCameras.filter(c => !prevIds.includes(c.id))

    prevVisibleIds.current = currentIds

    if (isTransitioning.current) return
    isTransitioning.current = true

    clearStaggerTimers()

    stopSessions(leaving).then(() => {
      if (leaving.length > 0) {
        setStreams(prev => { const n = { ...prev }; leaving.forEach(id => delete n[id]); return n })
        setStreamErrors(prev => { const n = { ...prev }; leaving.forEach(id => delete n[id]); return n })
        setLoadingStreams(prev => { const n = { ...prev }; leaving.forEach(id => delete n[id]); return n })
      }
      startVisibleStreams(arriving)
      isTransitioning.current = false
    })
  }, [filteredCameras.map(c => c.id).join(',')])

  // ─── Layout / NVR / page selection → stop all + restart ─────
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
    bumpPlayerKeys([cameraId])
    await apiPost(`/cameras/${cameraId}/restart-stream`, {}).catch(() => {})
    const cam = cameras.find(c => c.id === cameraId)
    if (cam) setTimeout(() => loadStream(cam), 3000)
  }, [cameras, loadStream, bumpPlayerKeys])

  // ─── HLS fatal error from VideoPlayer ───────────────────────
  const handleStreamError = useCallback((cameraId: string, err: CameraPlaybackError) => {
    console.warn('[LiveView] stream error', { cameraId, code: err.code, message: err.message, detail: err.technicalDetail })

    if (activeSessions.current.has(cameraId)) {
      apiPost(`/cameras/${cameraId}/stop-stream`, {}).catch(() => {})
      activeSessions.current.delete(cameraId)
    }

    if (err.code === 'HLS_SESSION_EXPIRED') {
      // HLS session expired (muxer destroyed or cookie timeout) — clear stale stream,
      // bump key so HLS.js is destroyed, then auto-restart once (rate-limited 30s/camera).
      setStreams(prev => { const n = { ...prev }; delete n[cameraId]; return n })
      setStreamErrors(prev => { const n = { ...prev }; delete n[cameraId]; return n })
      setLoadingStreams(prev => ({ ...prev, [cameraId]: true }))
      bumpPlayerKeys([cameraId])

      const now = Date.now()
      const last = lastRestartAt.current[cameraId] ?? 0
      if (now - last >= 30_000) {
        lastRestartAt.current[cameraId] = now
        const cam = cameras.find(c => c.id === cameraId)
        if (cam) setTimeout(() => loadStream(cam), 500)
      } else {
        // Restarted too recently — show error so user can retry manually
        setLoadingStreams(prev => ({ ...prev, [cameraId]: false }))
        setStreamErrors(prev => ({
          ...prev,
          [cameraId]: {
            code: 'HLS_SESSION_EXPIRED',
            message: 'Sesión HLS expirada. Haz clic en Reintentar.',
          },
        }))
      }
    } else {
      setStreamErrors(prev => ({ ...prev, [cameraId]: err }))
    }
  }, [cameras, loadStream, bumpPlayerKeys])

  // ─── Exit fullscreen/focus view ──────────────────────────────
  // Grid cameras were unmounted while focus was active. On return they would
  // remount with the same (now-stale) HLS URL → triggers 401 from expired sessions.
  // refreshVisibleStreams bumps playerKeys so they get fresh HLS instances.
  const handleExitFocus = useCallback(async () => {
    setFocusCamera(null)
    // Stop the focus camera session too
    if (focusCamera && activeSessions.current.has(focusCamera)) {
      apiPost(`/cameras/${focusCamera}/stop-stream`, {}).catch(() => {})
      activeSessions.current.delete(focusCamera)
    }
    // Small delay so focusCamera state clears before we restart grid
    await new Promise(r => setTimeout(r, 50))
    await refreshVisibleStreams('fullscreen-exit', filteredCameras)
  }, [focusCamera, filteredCameras, refreshVisibleStreams])

  const currentGrid    = GRID_OPTIONS.find(g => g.value === gridLayout) || GRID_OPTIONS[2]
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
                    key={`focus-${focusCamera}-${playerKeys[focusCamera] ?? 0}`}
                    hlsUrl={stream?.hls || ''}
                    cameraName={`${cam.nvr?.name} — ${cam.name}`}
                    cameraId={cam.id}
                    isRecording={cam.online}
                    onFullscreen={handleExitFocus}
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
                  {(() => {
                    if (!health || health === 'HEALTHY' || health === 'UNKNOWN' || !HEALTH_CONFIG[health]) return null
                    const mc = ((camera as any).mainCodec || '').toLowerCase()
                    const mainIsHevc = mc.includes('hevc') || mc.includes('h265') || mc.includes('h.265')
                    const isHevcMain = health === 'USING_MAIN_STREAM' && mainIsHevc
                    const badgeLabel = isHevcMain ? 'Main HEVC' : HEALTH_CONFIG[health].label
                    const bgClass = isHevcMain ? 'bg-amber-900/70' : health === 'USING_MAIN_STREAM' ? 'bg-blue-900/70' : 'bg-black/70'
                    const iconClass = isHevcMain ? 'text-amber-400' : health === 'USING_MAIN_STREAM' ? 'text-blue-400' : 'text-amber-400'
                    const textClass = isHevcMain ? 'text-amber-300' : health === 'USING_MAIN_STREAM' ? 'text-blue-300' : 'text-amber-300'
                    return (
                      <div className={clsx('absolute top-1.5 left-1.5 z-10 flex items-center gap-1 rounded px-1.5 py-0.5', bgClass)}>
                        <span className={iconClass}>{HEALTH_CONFIG[health].icon}</span>
                        <span className={clsx('text-[9px] font-medium', textClass)}>{badgeLabel}</span>
                      </div>
                    )
                  })()}
                  <VideoPlayer
                    key={`${camera.id}-${playerKeys[camera.id] ?? 0}`}
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
