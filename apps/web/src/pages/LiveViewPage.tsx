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
import { apiGet, apiPost } from '@/lib/api'
import { clsx } from 'clsx'
import type { Camera, StreamInfo, GridLayout, StreamHealthStatus, HeartbeatResponse } from '@/types'

function isHevcCodec(codec?: string): boolean {
  if (!codec) return false
  const c = codec.toLowerCase()
  return c.includes('hevc') || c.includes('h265') || c.includes('h.265')
}

// ─── Stagger delay per layout ────────────────────────────────
const STAGGER_MS: Record<GridLayout, number> = { 1: 0, 4: 250, 9: 400, 16: 500, 25: 600 }

// ─── Health status config ────────────────────────────────────
const HEALTH_CONFIG: Record<string, { icon: React.ReactNode; label: string; blockStream: boolean }> = {
  USING_MAIN_STREAM:       { icon: <Film size={12} />,          label: 'Sub no disponible',     blockStream: false },
  RTSP_SUB_NOT_FOUND:      { icon: <AlertTriangle size={12} />, label: 'Substream 404',         blockStream: true },
  RTSP_MAIN_NOT_FOUND:     { icon: <AlertTriangle size={12} />, label: 'RTSP no encontrado',    blockStream: true },
  CODEC_UNSUPPORTED_HEVC:  { icon: <Film size={12} />,          label: 'HEVC no compatible',    blockStream: false },
  STREAM_UNSTABLE:         { icon: <AlertTriangle size={12} />, label: 'Stream inestable',      blockStream: false },
  MEDIA_SERVER_ERROR:      { icon: <AlertTriangle size={12} />, label: 'Error servidor',        blockStream: false },
  AUTH_FAILED:             { icon: <Lock size={12} />,          label: 'Auth fallida',          blockStream: true },
  OFFLINE:                 { icon: <WifiOff size={12} />,       label: 'Offline',               blockStream: true },
}

function isBlockedByHealth(camera: Camera): boolean {
  // RTSP validator confirmed camera unreachable
  if (camera.online === false) return true
  const status = camera.streamHealthStatus
  // USING_MAIN_STREAM: sub is down but main H264 works — backend auto-redirects, never block
  if (status === 'USING_MAIN_STREAM') return false
  // Sub RTSP specifically confirmed down — grid always requests sub
  if (camera.rtspSubOk === false) return true
  if (!status || status === 'UNKNOWN' || status === 'HEALTHY' || status === 'STREAM_UNSTABLE') return false
  return HEALTH_CONFIG[status]?.blockStream ?? false
}

function getHealthError(status: StreamHealthStatus, channel: number): CameraPlaybackError {
  const cfg = HEALTH_CONFIG[status]
  const codeMap: Record<string, CameraPlaybackError['code']> = {
    RTSP_SUB_NOT_FOUND:     'RTSP_CHANNEL_NOT_FOUND',
    RTSP_MAIN_NOT_FOUND:    'RTSP_CHANNEL_NOT_FOUND',
    USING_MAIN_STREAM:      'RTSP_CHANNEL_NOT_FOUND',
    CODEC_UNSUPPORTED_HEVC: 'CODEC_UNSUPPORTED',
    AUTH_FAILED:            'AUTH_FAILED',
    OFFLINE:                'CAMERA_OFFLINE',
    MEDIA_SERVER_ERROR:     'MEDIAMTX_ROUTE_MISSING',
    STREAM_UNSTABLE:        'UNKNOWN',
  }
  return {
    code:    codeMap[status] ?? 'UNKNOWN',
    message: status === 'CODEC_UNSUPPORTED_HEVC'
      ? 'HEVC/H.265 no es compatible con navegadores. Configura H.264 en la cámara o habilita transcodificación en el NVR.'
      : cfg?.label ?? status,
    technicalDetail: status === 'RTSP_SUB_NOT_FOUND'
      ? `Substream /Streaming/Channels/${channel}02 devolvió 404`
      : status === 'USING_MAIN_STREAM'
        ? 'Substream no disponible — doble clic para ver en pantalla completa'
        : status === 'CODEC_UNSUPPORTED_HEVC'
          ? 'Recomendación: cambiar el codec del substream a H.264 en la interfaz del NVR (Configuración → Video → Substream → Codec: H.264)'
          : undefined,
  }
}

const GRID_OPTIONS: { value: GridLayout; label: string; icon: React.ReactNode; cols: string }[] = [
  { value: 1,  label: '1×1',  icon: <Maximize2 size={14} />,  cols: 'grid-cols-1' },
  { value: 4,  label: '2×2',  icon: <Grid2x2 size={14} />,    cols: 'grid-cols-2' },
  { value: 9,  label: '3×3',  icon: <Grid3x3 size={14} />,    cols: 'grid-cols-3' },
  { value: 16, label: '4×4',  icon: <LayoutGrid size={14} />, cols: 'grid-cols-4' },
]

// Genera un ID estable para este tab/view del navegador
function makeViewId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `view-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function LiveViewPage() {
  const [searchParams] = useSearchParams()
  const nvrFilter    = searchParams.get('nvr')
  const cameraFilter = searchParams.get('camera')
  // Al llegar desde "Ver en vivo" de una cámara, abrirla en 1×1 (foco) directamente.
  const focusParam   = searchParams.get('focus')

  const { nvrs, cameras, loadNVRs, loadCameras } = useCameraStore()
  const { user } = useAuthStore()

  const [gridLayout, setGridLayout]   = useState<GridLayout>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 4 : 9
  )
  const [selectedNVR, setSelectedNVR] = useState<string>(nvrFilter || 'all')
  const [page, setPage]               = useState(0)
  const [highlightCamera, setHighlightCamera] = useState<string | null>(null)
  // Tracks the last cameraFilter value already applied — prevents re-running when cameras
  // array updates but cameraFilter hasn't changed. Stores the camera id, not a boolean,
  // so a new search result (different camera) correctly triggers re-navigation.
  const appliedCameraQuery = useRef<string | null>(null)
  const [streams, setStreams]         = useState<Record<string, StreamInfo>>({})
  const [loadingStreams, setLoadingStreams] = useState<Record<string, boolean>>({})
  const [streamErrors, setStreamErrors]    = useState<Record<string, CameraPlaybackError>>({})
  const streamErrorsRef = useRef<Record<string, CameraPlaybackError>>({})
  streamErrorsRef.current = streamErrors  // keep ref current without triggering re-renders
  const [focusCamera, setFocusCamera]      = useState<string | null>(null)
  // Track the intended stream type separately — focusStreamInfo alone can't tell us 'main'
  // when HEVC blocks the stream before the API call (focusStreamInfo stays null).
  const [focusStreamType, setFocusStreamType]   = useState<'sub' | 'main' | 'main_h264'>('sub')
  // Refs for focus state — used by async HLS error callbacks to avoid stale closures
  const focusCameraRef      = useRef<string | null>(null)
  focusCameraRef.current    = focusCamera
  const focusStreamTypeRef  = useRef<'sub' | 'main' | 'main_h264'>('sub')
  focusStreamTypeRef.current = focusStreamType
  const [focusStreamInfo, setFocusStreamInfo]   = useState<StreamInfo | null>(null)
  const [focusStreamError, setFocusStreamError] = useState<CameraPlaybackError | null>(null)
  const [diagnosticCamera, setDiagnosticCamera] = useState<{ id: string; name: string } | null>(null)
  const [streamCapabilities, setStreamCapabilities] = useState<{ ffmpegAvailable: boolean; transcodingEnabled: boolean } | null>(null)

  // playerKeys forces VideoPlayer remount (new HLS instance) when incremented for a camera
  const [playerKeys, setPlayerKeys] = useState<Record<string, number>>({})
  // Mirrors which cameras are using the main_h264 fallback — drives the "Trans H.264" badge.
  // Separate from gridStreamOverride (a ref) so the badge re-renders when fallback is activated.
  const [gridFallbackIds, setGridFallbackIds] = useState<Set<string>>(new Set())

  // Stable ID for this browser tab — used by backend to track sessions per view
  const [viewId] = useState<string>(makeViewId)

  // Error codes that belong exclusively to focus/main_h264 streams.
  // Grid tiles show sub streams — showing these errors on a tile is always stale/misleading.
  const TRANSCODE_ONLY_CODES = new Set<CameraPlaybackError['code']>([
    'TRANSCODE_NOT_READY', 'TRANSCODE_PROCESS_EXITED',
  ])

  // Track which cameraIds have active sessions in the backend
  const activeSessions = useRef<Set<string>>(new Set())
  // Track pending start-stream requests to avoid double-firing
  const pendingStarts  = useRef<Set<string>>(new Set())
  // Stagger timers so we can cancel them on navigation
  const staggerTimers  = useRef<ReturnType<typeof setTimeout>[]>([])
  // Track when page became hidden to decide whether to reconcile on unhide
  const hiddenSince    = useRef<number | null>(null)
  // Rate-limit per-camera 401 auto-restarts: timestamp of last restart per cameraId
  const lastRestartAt  = useRef<Record<string, number>>({})
  // Backoff cuando se recibe STREAM_LIMIT_*: no reintentar esa cámara hasta este
  // timestamp (ms). Evita que el heartbeat golpee el límite en cada ciclo.
  const limitBackoffUntil = useRef<Record<string, number>>({})
  // Ref mirror of filteredCameras to avoid stale closures in heartbeat interval
  const filteredCamerasRef = useRef<Camera[]>([])
  // Coalescing queue for HLS_SESSION_EXPIRED: collects simultaneous 401s
  // and flushes them as a single heartbeat after a 2s window
  const hlsExpiryQueue    = useRef<Set<string>>(new Set())
  const hlsExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Ref to loadStream so flushHlsExpiry (declared before loadStream) can call it
  // without a forward-reference compile error.
  const loadStreamRef = useRef<((camera: Camera) => Promise<void>) | null>(null)
  // When a grid camera's sub stream fails (MEDIAMTX_NOT_READY / RTSP not found), we
  // auto-fallback to main_h264 transcode. This ref tracks per-camera overrides so the
  // heartbeat and applyHeartbeat don't revert the camera back to a broken sub stream.
  const gridStreamOverride = useRef<Record<string, 'main_h264'>>({})
  // Tracks the HLS URL currently loaded by each camera's VideoPlayer.
  // applyHeartbeat uses this to skip playerKey bumps when the URL hasn't changed.
  const currentStreamUrls = useRef<Record<string, string>>({})

  useEffect(() => {
    loadNVRs()
    loadCameras()
    // Note: no cleanup-my-sessions on mount — orphaned sessions from crashed tabs
    // expire via the server-side idle cleanup (90s). Calling cleanup here would race
    // with any streams started during this mount cycle if a previous unmount cleanup
    // request arrives late (async HTTP race condition → immediate FFmpeg kill).
  }, [])
  useEffect(() => { if (nvrFilter) setSelectedNVR(nvrFilter) }, [nvrFilter])

  // Handle camera query param: once cameras are loaded, navigate to the correct NVR/page
  // and highlight the target camera. Tracks by value (not boolean) so navigating to a
  // second search result correctly re-fires even if we're already on /live.
  useEffect(() => {
    if (!cameraFilter || appliedCameraQuery.current === cameraFilter || cameras.length === 0) return
    const cam = cameras.find(c => c.id === cameraFilter)
    if (!cam) {
      console.info(`[LiveView] queryCameraResolved cameraId=${cameraFilter} found=false`)
      return
    }
    appliedCameraQuery.current = cameraFilter

    const targetNvrId = cam.nvrId
    const nvrCams     = cameras.filter(c => c.nvrId === targetNvrId)
    const camIdx      = nvrCams.findIndex(c => c.id === cameraFilter)
    // Foco 1×1 pedido por el deep-link: la cámara queda SOLA en su página. Con
    // layout 1 la página objetivo es su índice directo (no floor/gridLayout).
    const wantFocus       = focusParam === '1' || focusParam === 'true'
    const effectiveLayout = wantFocus ? 1 : gridLayout
    const targetPage      = camIdx >= 0 ? Math.floor(camIdx / effectiveLayout) : 0
    console.info(`[LiveView] queryCameraResolved cameraId=${cameraFilter} nvrId=${targetNvrId} index=${camIdx} page=${targetPage} focus=${wantFocus}`)

    // Start highlight immediately so it's visible once the grid settles
    setHighlightCamera(cameraFilter)
    setTimeout(() => setHighlightCamera(null), 4000)

    const needsNvrSwitch    = selectedNVR !== targetNvrId
    const needsPageSwitch   = safePage !== targetPage
    const needsLayoutSwitch = wantFocus && gridLayout !== 1

    if (needsNvrSwitch || needsPageSwitch || needsLayoutSwitch) {
      // Stop all active streams before switching NVR/page — mirrors handleNVRChange/handlePageChange
      stopAllSessions('camera_query').then(() => {
        prevVisibleIds.current = []
        if (wantFocus) setGridLayout(1)   // abrir en 1×1
        setSelectedNVR(targetNvrId)
        setPage(targetPage)
      })
    }
    // If camera is already visible (same NVR, same page) only the highlight is needed
  }, [cameras, cameraFilter, gridLayout, focusParam]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiGet<{ ffmpegAvailable: boolean; transcodingEnabled: boolean }>('/live-view/capabilities')
      .then(caps => setStreamCapabilities(caps))
      .catch(() => setStreamCapabilities({ ffmpegAvailable: false, transcodingEnabled: false }))
  }, [])

  // Derived visible cameras
  const allFiltered = cameras.filter((c) =>
    selectedNVR === 'all' ? true : c.nvrId === selectedNVR
  )
  const totalPages      = Math.max(1, Math.ceil(allFiltered.length / gridLayout))
  const safePage        = Math.min(page, totalPages - 1)
  const filteredCameras = allFiltered.slice(safePage * gridLayout, (safePage + 1) * gridLayout)

  // Keep ref in sync — used by heartbeat and visibility handlers to avoid stale closures
  filteredCamerasRef.current = filteredCameras

  // ─── Bump player keys to force VideoPlayer remount ──────────
  const bumpPlayerKeys = useCallback((cameraIds: string[]) => {
    setPlayerKeys(prev => {
      const next = { ...prev }
      cameraIds.forEach(id => { next[id] = (next[id] ?? 0) + 1 })
      return next
    })
  }, [])

  // ─── Apply heartbeat response to state ─────────────────────
  // Updates streams state, bumps keys for newly started cameras, sets errors.
  // Called from both the periodic heartbeat and visibility-restore handler.
  const applyHeartbeat = useCallback((result: HeartbeatResponse) => {
    // Merge stream URLs into state (started + already-running).
    // Skip cameras with a gridStreamOverride — the heartbeat returns sub-stream URLs
    // but these cameras are intentionally running main_h264; overwriting would cause
    // VideoPlayer to load the broken sub URL and restart the fallback loop.
    if (Object.keys(result.streams).length > 0) {
      setStreams(prev => {
        const next = { ...prev }
        for (const [cameraId, info] of Object.entries(result.streams)) {
          if (gridStreamOverride.current[cameraId]) continue  // keep fallback URL intact
          next[cameraId] = {
            cameraId,
            streamPath: info.streamPath,
            hls: info.hls,
            webrtc: info.webrtc,
            channel: info.channel ?? 0,
            nvrName: info.nvrName ?? '',
            warning: info.warning,
          }
          activeSessions.current.add(cameraId)
        }
        return next
      })
    }
    // Cameras that the backend newly started need fresh HLS.js instances.
    // Skip cameras with a gridStreamOverride AND whose URL hasn't changed —
    // bumping would remount VideoPlayer and break the working fallback session.
    if (result.startedIds.length > 0) {
      const toReallyBump = result.startedIds.filter(id => {
        if (!gridStreamOverride.current[id]) return true
        // Override active: only bump if the URL actually changed
        const incoming = result.streams[id]?.hls
        return incoming && incoming !== currentStreamUrls.current[id]
      })
      if (toReallyBump.length > 0) bumpPlayerKeys(toReallyBump)
      // Clear any previous errors for restarted cameras
      setStreamErrors(prev => {
        const n = { ...prev }
        result.startedIds.forEach(id => delete n[id])
        return n
      })
      setLoadingStreams(prev => {
        const n = { ...prev }
        result.startedIds.forEach(id => { n[id] = false })
        return n
      })
    }
    // Cameras the backend stopped
    if (result.stoppedIds.length > 0) {
      result.stoppedIds.forEach(id => activeSessions.current.delete(id))
    }
    // Map backend errors to frontend error format
    for (const [cameraId, err] of Object.entries(result.errors)) {
      const errCodeMap: Record<string, CameraPlaybackError['code']> = {
        RTSP_SUB_NOT_FOUND:     'RTSP_CHANNEL_NOT_FOUND',
        RTSP_MAIN_NOT_FOUND:    'RTSP_CHANNEL_NOT_FOUND',
        CODEC_UNSUPPORTED_HEVC: 'CODEC_UNSUPPORTED',
        AUTH_FAILED:            'AUTH_FAILED',
        OFFLINE:                'CAMERA_OFFLINE',
        CAMERA_OFFLINE:         'CAMERA_OFFLINE',
        MEDIA_SERVER_ERROR:     'MEDIAMTX_NOT_READY',
        CAMERA_NOT_FOUND:       'UNKNOWN',
        CAMERA_DISABLED:        'UNKNOWN',
        TRANSCODING_DISABLED:    'CODEC_UNSUPPORTED',
        TRANSCODE_LIMIT_REACHED: 'TRANSCODE_LIMIT_REACHED',
        TRANSCODE_NOT_READY:     'TRANSCODE_NOT_READY',
        TRANSCODE_PROCESS_EXITED:'TRANSCODE_PROCESS_EXITED',
        // Límites de streams que también pueden llegar por el heartbeat (reconcileView)
        STREAM_LIMIT_GLOBAL:     'STREAM_LIMIT_REACHED',
        STREAM_LIMIT_REACHED:    'STREAM_LIMIT_REACHED',
      }
      // Límite de streams vía heartbeat: aplicar backoff (no reintentar en cada
      // ciclo) y mostrar current/max si el backend los entrega.
      if (err.code === 'STREAM_LIMIT_GLOBAL' || err.code === 'STREAM_LIMIT_REACHED') {
        const cur = (err as any).current as number | undefined
        const max = (err as any).max as number | undefined
        limitBackoffUntil.current[cameraId] = Date.now() + 15_000
        setStreamErrors(prev => ({
          ...prev,
          [cameraId]: {
            code: 'STREAM_LIMIT_REACHED',
            message: cur !== undefined && max !== undefined
              ? `Límite de streams alcanzado (${cur}/${max} activos)`
              : err.message,
          },
        }))
        setLoadingStreams(prev => ({ ...prev, [cameraId]: false }))
        continue
      }
      const isHevc = err.code === 'CODEC_UNSUPPORTED_HEVC'
      setStreamErrors(prev => ({
        ...prev,
        [cameraId]: {
          code: (errCodeMap[err.code] || 'UNKNOWN') as any,
          message: isHevc
            ? 'HEVC/H.265 no es compatible con navegadores. Configura H.264 en la cámara o habilita transcodificación en el NVR.'
            : err.message,
          technicalDetail: isHevc
            ? 'Recomendación: cambiar el codec del substream a H.264 en la interfaz del NVR (Configuración → Video → Substream → Codec: H.264)'
            : err.details,
        },
      }))
      setLoadingStreams(prev => ({ ...prev, [cameraId]: false }))
    }
  }, [bumpPlayerKeys])

  // ─── Send viewport heartbeat ────────────────────────────────
  // Single call replaces N per-camera touch-stream calls.
  // Backend reconciles: starts missing streams, stops removed streams, touches existing.
  const sendHeartbeat = useCallback(async (visibleCameraIds: string[]): Promise<void> => {
    if (visibleCameraIds.length === 0) return
    if (!useAuthStore.getState().isAuthenticated) return
    try {
      // Don't re-queue cameras with permanent blocking errors — prevents MediaMTX RTSP retry spam
      const PERMANENT_ERROR_CODES: CameraPlaybackError['code'][] = [
        'RTSP_CHANNEL_NOT_FOUND', 'CAMERA_OFFLINE', 'AUTH_FAILED',
        'CODEC_UNSUPPORTED', 'SUBSTREAM_DISABLED', 'NVR_OFFLINE',
        'NO_PERMISSION',  // 403 — reintentar en cada heartbeat no lo va a arreglar
      ]
      const filteredIds = visibleCameraIds.filter(id => {
        const err = streamErrorsRef.current[id]
        return !err || !PERMANENT_ERROR_CODES.includes(err.code)
      })
      if (filteredIds.length === 0) return
      // Cámaras con backoff de límite vigente y sin sesión activa: se mantienen
      // visibles pero se pide al backend NO iniciarlas (evita que reconcileView
      // se salte el backoff del frontend y golpee el límite en cada heartbeat).
      const now = Date.now()
      const suppressStartCameraIds = filteredIds.filter(id =>
        (limitBackoffUntil.current[id] ?? 0) > now && !activeSessions.current.has(id))
      const result = await apiPost<HeartbeatResponse>('/live-view/heartbeat', {
        viewId,
        visibleCameraIds: filteredIds,
        ...(suppressStartCameraIds.length > 0 ? { suppressStartCameraIds } : {}),
      })
      applyHeartbeat(result)
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 401) {
        // Interceptor already attempted token refresh + retry.
        // If refresh succeeded: should not reach here (interceptor returned retried response).
        // If refresh failed: dispatchAuthExpired fired → isAuthenticated=false → login redirect.
        // Either way: do NOT modify camera state — user view must stay intact during auth recovery.
        console.warn(`[LiveView] heartbeat 401 — token refresh attempted by interceptor`)
      }
      // Network errors / 5xx: next 30s heartbeat will retry automatically
    }
  }, [viewId, applyHeartbeat])

  // ─── Flush coalesced HLS_SESSION_EXPIRED batch ──────────────
  // Called 2s after the first 401 to batch simultaneous muxer expirations
  // into a single heartbeat instead of N individual restarts.
  const flushHlsExpiry = useCallback(async () => {
    hlsExpiryTimerRef.current = null
    const expiredIds = Array.from(hlsExpiryQueue.current)
    hlsExpiryQueue.current.clear()
    if (expiredIds.length === 0) return

    console.warn(`[LiveView] HLS_SESSION_EXPIRED batch: ${expiredIds.length} cámara(s) [${expiredIds.join(', ')}]`)

    const now = Date.now()
    const toRestart = expiredIds.filter(id => (now - (lastRestartAt.current[id] ?? 0)) >= 30_000)
    const tooRecent = expiredIds.filter(id => (now - (lastRestartAt.current[id] ?? 0)) < 30_000)

    if (tooRecent.length > 0) {
      // Too soon to restart via heartbeat — remount the player so HLS.js
      // re-establishes its session cookie against the still-running MediaMTX source.
      // Don't show error; let VideoPlayer recover silently or report a different error.
      bumpPlayerKeys(tooRecent)
      setLoadingStreams(prev => { const n = { ...prev }; tooRecent.forEach(id => { n[id] = false }); return n })
    }

    if (toRestart.length === 0) return
    toRestart.forEach(id => { lastRestartAt.current[id] = now })

    const visibleIds = filteredCamerasRef.current.map(c => c.id)
    if (visibleIds.length === 0) return

    try {
      const result = await apiPost<HeartbeatResponse>('/live-view/heartbeat', { viewId, visibleCameraIds: visibleIds })
      applyHeartbeat(result)
      // Always remount players for cameras that had expired sessions but were NOT freshly
      // started by the backend (freshly started ones are already bumped in applyHeartbeat).
      // This forces HLS.js to re-establish its session cookie even when the backend
      // kept the session alive (session still active → not in startedIds → would stay stuck).
      const notFreshlyStarted = toRestart.filter(id => !result.startedIds.includes(id))
      if (notFreshlyStarted.length > 0) {
        console.info(`[live-ui] hls_reattach_after_expiry ids=[${notFreshlyStarted.join(',')}] reason=session_alive_cookie_expired`)
        bumpPlayerKeys(notFreshlyStarted)
      }
    } catch (err: any) {
      if (err?.response?.status === 401) return  // auth expired; interceptor handles redirect
      // Fallback: individual restart per camera (non-auth errors only).
      // Uses loadStreamRef to avoid forward-reference compile error (loadStream
      // is declared later in this component but ref is always current).
      toRestart.forEach(id => {
        const cam = filteredCamerasRef.current.find(c => c.id === id)
        if (cam) {
          bumpPlayerKeys([id])
          setTimeout(() => loadStreamRef.current?.(cam), 500)
        }
      })
    }
  }, [viewId, applyHeartbeat, bumpPlayerKeys])

  // ─── Periodic viewport heartbeat every 30s ──────────────────
  // Replaces per-camera touch-stream (N requests → 1 request).
  // Also reconciles state if any camera was stopped by backend idle cleanup.
  useEffect(() => {
    const interval = setInterval(() => {
      // No enviar heartbeat con la pestaña oculta — evita polling en background
      // que contribuye a la acumulación de sesiones y a los 429.
      if (document.visibilityState === 'hidden') return
      const ids = filteredCamerasRef.current.map(c => c.id)
      sendHeartbeat(ids)
    }, 30_000)
    return () => clearInterval(interval)
  }, [sendHeartbeat])

  // ─── Stop sessions for a set of cameraIds ───────────────────
  const stopSessions = useCallback(async (cameraIds: string[], reason?: string) => {
    const toStop = cameraIds.filter(id => activeSessions.current.has(id))
    if (toStop.length === 0) return
    console.info(`[LiveView] stopSessions reason=${reason || 'unspecified'} count=${toStop.length} ids=[${toStop.join(',')}]`)
    await Promise.allSettled(
      toStop.map(id => apiPost(`/cameras/${id}/stop-stream`, { streamType: 'sub' }).catch(() => {}))
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
  const stopAllSessions = useCallback(async (reason?: string) => {
    clearStaggerTimers()
    const allActive = Array.from(activeSessions.current)
    await stopSessions(allActive, reason || 'stop_all')
    setStreams({})
    setStreamErrors({})
    setLoadingStreams({})
    gridStreamOverride.current = {}
    currentStreamUrls.current  = {}
    setGridFallbackIds(new Set())
  }, [stopSessions, clearStaggerTimers])

  // ─── Cleanup on unmount ─────────────────────────────────────
  // Pass viewId so the server only cleans THIS view's sessions.
  // Without viewId, the server would kill ALL user sessions — including sessions
  // the next LiveViewPage mount just started (async HTTP race condition).
  useEffect(() => {
    return () => {
      clearStaggerTimers()
      apiPost('/cameras/cleanup-my-sessions', { viewId }).catch(() => {
        // Fallback: individual stops scoped to active sessions in this view
        activeSessions.current.forEach(id => {
          apiPost(`/cameras/${id}/stop-stream`, {}).catch(() => {})
        })
      })
    }
  }, [clearStaggerTimers, viewId])

  // ─── Load a single stream ────────────────────────────────────
  // NOTE: intentionally does NOT depend on `streams` state — using it would create
  // a stale closure bug. pendingStarts guards against concurrent duplicate calls.
  const loadStream = useCallback(async (camera: Camera): Promise<void> => {
    if (pendingStarts.current.has(camera.id)) return

    // Backoff activo por límite de streams: no reintentar hasta que expire.
    const backoffUntil = limitBackoffUntil.current[camera.id]
    if (backoffUntil && Date.now() < backoffUntil) return

    // Block cameras with known bad health
    if (isBlockedByHealth(camera)) {
      const blockError: CameraPlaybackError =
        camera.streamHealthStatus && camera.streamHealthStatus !== 'UNKNOWN'
          ? getHealthError(camera.streamHealthStatus as StreamHealthStatus, camera.channel)
          : { code: 'CAMERA_OFFLINE', message: 'Sin señal — cámara offline o sin RTSP disponible' }
      setStreamErrors(prev => ({ ...prev, [camera.id]: blockError }))
      return
    }

    pendingStarts.current.add(camera.id)
    setLoadingStreams(prev => ({ ...prev, [camera.id]: true }))

    try {
      const overrideType = gridStreamOverride.current[camera.id]
      const body = overrideType ? { streamType: overrideType } : {}
      const info = await apiPost<StreamInfo>(`/cameras/${camera.id}/start-stream`, body)
      activeSessions.current.add(camera.id)
      if (info.hls) currentStreamUrls.current[camera.id] = info.hls
      setStreams(prev => ({ ...prev, [camera.id]: info }))
      setStreamErrors(prev => {
        const next = { ...prev }
        delete next[camera.id]
        return next
      })
    } catch (err: any) {
      const body = err?.response?.data || {}
      // El backend envía el error como { code, message } — antes se leía body.error
      // (siempre undefined), por eso STREAM_LIMIT_GLOBAL caía en "Error desconocido"
      // y el frontend seguía reintentando en cada heartbeat.
      const status: number | undefined = err?.response?.status
      // 403 sin código (backends viejos) también debe mostrar "Sin permiso" —
      // antes caía en UNKNOWN o quedaba en tile vacío silencioso.
      const code: string = body.code || body.error || (status === 403 ? 'NO_PERMISSION' : '')
      const rawMsg: string = body.message || body.code || body.error || ''

      if (code === 'STREAM_LIMIT_REACHED' || code === 'STREAM_LIMIT_GLOBAL') {
        await handleLimitHit(camera, body.current as number | undefined, body.max as number | undefined)
        return
      }

      const errCodeMap: Record<string, CameraPlaybackError['code']> = {
        RTSP_SUB_NOT_FOUND:      'RTSP_CHANNEL_NOT_FOUND',
        RTSP_MAIN_NOT_FOUND:     'RTSP_CHANNEL_NOT_FOUND',
        CODEC_UNSUPPORTED_HEVC:  'CODEC_UNSUPPORTED',
        AUTH_FAILED:             'AUTH_FAILED',
        OFFLINE:                 'CAMERA_OFFLINE',
        CAMERA_OFFLINE:          'CAMERA_OFFLINE',
        MEDIA_SERVER_ERROR:      'MEDIAMTX_NOT_READY',
        CAMERA_NOT_FOUND:        'UNKNOWN',
        CAMERA_DISABLED:         'UNKNOWN',
        TRANSCODING_DISABLED:    'CODEC_UNSUPPORTED',
        TRANSCODE_LIMIT_REACHED: 'TRANSCODE_LIMIT_REACHED',
        TRANSCODE_NOT_READY:     'TRANSCODE_NOT_READY',
        TRANSCODE_PROCESS_EXITED:'TRANSCODE_PROCESS_EXITED',
        NO_PERMISSION:           'NO_PERMISSION',
      }

      // Garantía anti-tile-vacío: TODO fallo de start-stream (403, red, código
      // desconocido, etc.) debe dejar un error visible con el motivo real.
      setStreamErrors(prev => ({
        ...prev,
        [camera.id]: {
          code: (errCodeMap[code] || 'UNKNOWN') as any,
          message: code === 'NO_PERMISSION'
            ? (rawMsg || 'Sin permiso para ver esta cámara')
            : (rawMsg || 'No se pudo obtener el stream'),
          technicalDetail: body.details,
        },
      }))
    } finally {
      pendingStarts.current.delete(camera.id)
      setLoadingStreams(prev => ({ ...prev, [camera.id]: false }))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  loadStreamRef.current = loadStream  // keep ref current for flushHlsExpiry

  // ─── Handle stream limit: cleanup non-visible then retry ────
  const handleLimitHit = useCallback(async (camera: Camera, current?: number, max?: number) => {
    const visibleIds = new Set(filteredCameras.map(c => c.id))
    const nonVisible = Array.from(activeSessions.current).filter(id => !visibleIds.has(id))

    if (nonVisible.length > 0) {
      // Liberar sesiones no visibles resuelve el límite — limpiar backoff y reintentar
      await stopSessions(nonVisible)
      setStreams(prev => {
        const next = { ...prev }
        nonVisible.forEach(id => delete next[id])
        return next
      })
      delete limitBackoffUntil.current[camera.id]
      pendingStarts.current.delete(camera.id)
      await loadStream(camera)
    } else {
      // Nada que liberar: mostrar un error claro (no "desconocido") y aplicar
      // backoff para no reintentar en cada heartbeat mientras persista el límite.
      const limitMsg = current !== undefined && max !== undefined
        ? `Límite de streams alcanzado (${current}/${max} activos)`
        : `Límite de streams alcanzado`
      limitBackoffUntil.current[camera.id] = Date.now() + 15_000
      setStreamErrors(prev => ({
        ...prev,
        [camera.id]: { code: 'STREAM_LIMIT_REACHED', message: limitMsg },
      }))
      setLoadingStreams(prev => ({ ...prev, [camera.id]: false }))
    }
  }, [filteredCameras, stopSessions, loadStream])

  // ─── Start visible streams with stagger ─────────────────────
  // Blocked cameras (offline / known bad health) are loaded immediately without stagger
  // so their error overlay appears right away without a spinner delay.
  const startVisibleStreams = useCallback((cams: Camera[]) => {
    const delay = STAGGER_MS[gridLayout] ?? 500
    let staggerIdx = 0
    cams.forEach((cam) => {
      if (isBlockedByHealth(cam)) {
        // Immediate — no timer needed, loadStream returns synchronously for blocked cameras
        loadStream(cam)
      } else {
        const timer = setTimeout(() => loadStream(cam), staggerIdx * delay)
        staggerTimers.current.push(timer)
        staggerIdx++
      }
    })
  }, [gridLayout, loadStream])

  // ─── Page visibility: reconcile on unhide ───────────────────
  // When the PC is locked/unlocked or tab switches, instead of restarting
  // the whole grid (wasteful), we send a heartbeat. The backend reconciles:
  // cameras still active → just touched (HLS.js self-heals); cameras that
  // the backend stopped → returned as startedIds → get bumped player keys.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince.current = Date.now()
      } else {
        const hiddenMs = hiddenSince.current ? Date.now() - hiddenSince.current : 0
        hiddenSince.current = null
        if (hiddenMs > 10_000 && activeSessions.current.size > 0 && useAuthStore.getState().isAuthenticated) {
          // Reconcile only — do NOT restart all cameras
          const ids = filteredCamerasRef.current.map(c => c.id)
          sendHeartbeat(ids)
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [sendHeartbeat])

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

    stopSessions(leaving, 'viewport_change').then(() => {
      if (leaving.length > 0) {
        setStreams(prev => { const n = { ...prev }; leaving.forEach(id => delete n[id]); return n })
        setStreamErrors(prev => { const n = { ...prev }; leaving.forEach(id => delete n[id]); return n })
        setLoadingStreams(prev => { const n = { ...prev }; leaving.forEach(id => delete n[id]); return n })
        leaving.forEach(id => {
          delete gridStreamOverride.current[id]
          delete currentStreamUrls.current[id]
        })
        setGridFallbackIds(prev => {
          const n = new Set(prev)
          leaving.forEach(id => n.delete(id))
          return n
        })
      }
      startVisibleStreams(arriving)
      isTransitioning.current = false
    })
  }, [filteredCameras.map(c => c.id).join(',')])

  // ─── Layout / NVR / page selection → stop all + restart ─────
  const handleLayoutChange = useCallback(async (layout: GridLayout) => {
    await stopAllSessions('layout_change')
    prevVisibleIds.current = []
    appliedCameraQuery.current = null  // allow re-navigation to selected camera with new layout
    setGridLayout(layout)
    setPage(0)
  }, [stopAllSessions])

  const handleNVRChange = useCallback(async (nvrId: string) => {
    await stopAllSessions('nvr_change')
    prevVisibleIds.current = []
    setSelectedNVR(nvrId)
    setPage(0)
  }, [stopAllSessions])

  const handlePageChange = useCallback(async (newPage: number) => {
    await stopAllSessions('page_change')
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

  // ─── Retry a single grid camera (full stream restart) ───────
  const handleGridCameraRetry = useCallback((cameraId: string) => {
    apiPost(`/cameras/${cameraId}/stop-stream`, { streamType: 'sub', reason: 'grid_retry' }).catch(() => {})
    activeSessions.current.delete(cameraId)
    setStreamErrors(prev => { const n = { ...prev }; delete n[cameraId]; return n })
    setStreams(prev => { const n = { ...prev }; delete n[cameraId]; return n })
    pendingStarts.current.delete(cameraId)
    bumpPlayerKeys([cameraId])
    const cam = cameras.find(c => c.id === cameraId)
    if (cam) setTimeout(() => loadStream(cam), 300)
  }, [cameras, loadStream, bumpPlayerKeys])

  // ─── HLS fatal error from VideoPlayer ───────────────────────
  // HLS_SESSION_EXPIRED is coalesced: batches simultaneous 401s into one
  // heartbeat (2s window) so N cameras expiring together get 1 backend call.
  const handleStreamError = useCallback((cameraId: string, err: CameraPlaybackError) => {
    console.warn('[LiveView] stream error', { cameraId, code: err.code, message: err.message, detail: err.technicalDetail })

    if (err.code === 'HLS_SESSION_EXPIRED') {
      // Focus main/main_h264 session expired → show reconnecting state and re-request stream.
      // Grid cameras go through the coalesced heartbeat path below.
      const isFocusH264 = cameraId === focusCameraRef.current &&
        (focusStreamTypeRef.current === 'main_h264' || focusStreamTypeRef.current === 'main')
      if (isFocusH264) {
        console.info(`[LiveView] HLS_SESSION_EXPIRED focus cameraId=${cameraId} — reconnecting transcodificación`)
        setFocusStreamError({ code: 'TRANSCODE_NOT_READY', message: 'Reconectando transcodificación...' })
        return
      }
      setStreamErrors(prev => { const n = { ...prev }; delete n[cameraId]; return n })
      setLoadingStreams(prev => ({ ...prev, [cameraId]: true }))
      hlsExpiryQueue.current.add(cameraId)
      if (!hlsExpiryTimerRef.current) {
        hlsExpiryTimerRef.current = setTimeout(flushHlsExpiry, 2_000)
      }
      return
    }

    // For focus-camera main/main_h264 errors: route to focusStreamError, NOT streamErrors.
    // Use refs (not state) to avoid stale-closure issues in async HLS error callbacks
    // (e.g. user exits focus, then a pending HLS retry fires — closure would read null).
    const isFocusStream = cameraId === focusCameraRef.current &&
      (focusStreamTypeRef.current === 'main_h264' || focusStreamTypeRef.current === 'main')
    if (isFocusStream) {
      console.info(`[LiveView] stream_error focus cameraId=${cameraId} type=${focusStreamTypeRef.current} code=${err.code} — routing to focusStreamError`)
      setFocusStreamError(err)
      return
    }

    // For all other fatal errors, stop the backend stream using the correct type.
    // Focus camera non-transcode: use focusStreamType. Grid camera: always sub.
    // Pass reason=hls_fatal_error so backend does NOT kill FFmpeg (transient error).
    const isGridCamera = cameraId !== focusCameraRef.current
    const currentStreamType = isGridCamera
      ? (gridStreamOverride.current[cameraId] ?? 'sub')
      : (cameraId === focusCamera ? focusStreamType : 'sub')
    if (activeSessions.current.has(cameraId)) {
      console.info(`[LiveView] stop-stream cameraId=${cameraId} streamType=${currentStreamType} reason=hls_fatal_error code=${err.code}`)
      apiPost(`/cameras/${cameraId}/stop-stream`, { streamType: currentStreamType, reason: 'hls_fatal_error' }).catch(() => {})
      activeSessions.current.delete(cameraId)
    }
    // HLS manifest 404 on a grid (sub) camera = RTSP source returned 404 from NVR.
    // Reclassify to RTSP_CHANNEL_NOT_FOUND so the tile shows a meaningful message.
    let displayErr = err
    if (err.code === 'HLS_MANIFEST_NOT_FOUND' && isGridCamera) {
      displayErr = {
        code: 'RTSP_CHANNEL_NOT_FOUND',
        message: 'Canal no disponible en NVR (substream no encontrado)',
        technicalDetail: err.technicalDetail,
      }
      console.info(`[live-ui] rtsp_404_reclassified cameraId=${cameraId}`)
    }

    // Auto-fallback: if a grid camera's sub stream fails with a transient or path-not-found
    // error AND it has no active override, silently retry with main_h264 transcode.
    // This covers the common case where the sub stream isn't ready in MediaMTX but the
    // main (transcoded) stream works fine — the user sees a seamless fallback rather than
    // an error tile.
    const GRID_FALLBACK_CODES: CameraPlaybackError['code'][] = [
      'MEDIAMTX_NOT_READY', 'RTSP_CHANNEL_NOT_FOUND',
    ]
    if (
      isGridCamera &&
      !gridStreamOverride.current[cameraId] &&
      (GRID_FALLBACK_CODES.includes(displayErr.code) || GRID_FALLBACK_CODES.includes(err.code))
    ) {
      console.info(`[live-ui] grid_fallback_to_main_h264 cameraId=${cameraId} originalCode=${err.code}`)
      gridStreamOverride.current[cameraId] = 'main_h264'
      delete currentStreamUrls.current[cameraId]
      pendingStarts.current.delete(cameraId)
      setGridFallbackIds(prev => new Set([...prev, cameraId]))
      setStreamErrors(prev => { const n = { ...prev }; delete n[cameraId]; return n })
      setStreams(prev => { const n = { ...prev }; delete n[cameraId]; return n })
      bumpPlayerKeys([cameraId])
      const cam = filteredCamerasRef.current.find(c => c.id === cameraId)
      if (cam) setTimeout(() => loadStreamRef.current?.(cam), 300)
      return
    }

    setStreamErrors(prev => ({ ...prev, [cameraId]: displayErr }))
  }, [flushHlsExpiry, focusCamera, focusStreamType, bumpPlayerKeys])

  // ─── Enter focus/fullscreen — start main stream ─────────────
  const handleEnterFocus = useCallback(async (camera: Camera) => {
    console.info(`[live-ui] fullscreen_requested cameraId=${camera.id} streamType=main`)
    setFocusCamera(camera.id)
    setFocusStreamInfo(null)
    setFocusStreamError(null)
    setFocusStreamType('main')  // always targeting main in focus view
    // Clear any stale sub-stream error from the grid so it doesn't leak into the focus view
    setStreamErrors(prev => { const n = { ...prev }; delete n[camera.id]; return n })

    // Proactively block known HEVC main stream only when transcoding is unavailable.
    // When transcoding is available, let the backend handle the auto-redirect to main_h264.
    const transcodingAvailable = streamCapabilities?.ffmpegAvailable && streamCapabilities?.transcodingEnabled
    if (isHevcCodec(camera.mainCodec) && !transcodingAvailable) {
      setFocusStreamError({
        code: 'CODEC_UNSUPPORTED',
        message: 'El flujo principal está en H.265/HEVC. Los navegadores no pueden reproducir H.265.',
        technicalDetail: `Codec: ${camera.mainCodec}${camera.mainResolution ? `, Resolución: ${camera.mainResolution}` : ''}`,
      })
      return
    }

    try {
      const info = await apiPost<StreamInfo>(`/cameras/${camera.id}/start-stream`, { streamType: 'main', viewId })
      // Backend may auto-redirect main→main_h264 (HEVC camera + transcoding enabled).
      // Detect the actual stream type from the response so stop-stream/quality-switch
      // use the correct type key.
      const actualType: 'sub' | 'main' | 'main_h264' =
        (info as any).transcoded === true || info.streamPath?.endsWith('_main_h264')
          ? 'main_h264'
          : 'main'
      if (actualType !== focusStreamType) {
        console.info(`[LiveView] enterFocus redirect cameraId=${camera.id} requested=main actual=${actualType}`)
        setFocusStreamType(actualType)
      }
      setFocusStreamInfo(info)
      bumpPlayerKeys([camera.id])
    } catch (err: any) {
      const body = err?.response?.data || {}
      const errCodeMap: Record<string, CameraPlaybackError['code']> = {
        CODEC_UNSUPPORTED_HEVC:  'CODEC_UNSUPPORTED',
        AUTH_FAILED:             'AUTH_FAILED',
        OFFLINE:                 'CAMERA_OFFLINE',
        MEDIA_SERVER_ERROR:      'MEDIAMTX_NOT_READY',
        RTSP_MAIN_NOT_FOUND:     'RTSP_CHANNEL_NOT_FOUND',
        TRANSCODE_NOT_READY:     'TRANSCODE_NOT_READY',
        TRANSCODE_PROCESS_EXITED:'TRANSCODE_PROCESS_EXITED',
        TRANSCODE_LIMIT_REACHED: 'TRANSCODE_LIMIT_REACHED',
      }
      const mappedCode = (errCodeMap[body.error] || 'UNKNOWN') as CameraPlaybackError['code']
      if (mappedCode === 'TRANSCODE_LIMIT_REACHED') {
        console.info(`[live-ui] transcode_limit_reached cameraId=${camera.id}`)
        console.info(`[live-ui] fallback_to_substream cameraId=${camera.id} reason=transcode_limit_reached — user can click 'Usar baja calidad'`)
      }
      setFocusStreamError({
        code: mappedCode,
        message: body.message || 'Error al iniciar stream principal',
        technicalDetail: body.details,
      })
    }
  }, [bumpPlayerKeys, streamCapabilities, focusStreamType])

  // ─── Quality switch from VideoPlayer (Baja/Alta/Trans buttons) ─
  const handleQualitySwitch = useCallback(async (quality: 'sub' | 'main' | 'main_h264') => {
    if (!focusCamera) return

    if (quality === 'sub') {
      // Explicitly switching back to sub — stop both main streams so FFmpeg is killed.
      console.info(`[LiveView] qualitySwitch cameraId=${focusCamera} from=${focusStreamType} to=sub reason=switch_to_sub`)
      console.info(`[live-ui] fallback_to_substream cameraId=${focusCamera} reason=user_selected_low_quality prevType=${focusStreamType}`)
      apiPost(`/cameras/${focusCamera}/stop-stream`, { streamType: 'main',      reason: 'switch_to_sub' }).catch(() => {})
      apiPost(`/cameras/${focusCamera}/stop-stream`, { streamType: 'main_h264', reason: 'switch_to_sub' }).catch(() => {})
      setFocusStreamInfo(null)
      setFocusStreamError(null)
      setFocusStreamType('sub')
      bumpPlayerKeys([focusCamera])
      return
    }

    if (quality === focusStreamType) {
      // Same type — this is a retry. Remount the player without killing FFmpeg.
      // The supervisor keeps FFmpeg alive; a fresh HLS.js instance will reconnect.
      console.info(`[LiveView] qualitySwitch retry cameraId=${focusCamera} type=${quality} — remounting player only`)
      setFocusStreamError(null)
      bumpPlayerKeys([focusCamera])
      return
    }

    // Switching to a different type (e.g. sub→main, main→main_h264, main_h264→main)
    const prevType = focusStreamType
    console.info(`[LiveView] qualitySwitch cameraId=${focusCamera} from=${prevType} to=${quality}`)

    // Only stop 'main' session — never stop 'main_h264' here because:
    // a) On HEVC cameras, 'main' redirects to 'main_h264' anyway (same FFmpeg).
    // b) Stopping main_h264 kills FFmpeg, then start-stream immediately re-spawns it
    //    causing the "closing existing publisher" duplicate in MediaMTX.
    if (prevType === 'main') {
      apiPost(`/cameras/${focusCamera}/stop-stream`, { streamType: 'main', reason: 'quality_switch' }).catch(() => {})
    }

    setFocusStreamInfo(null)
    setFocusStreamError(null)
    setFocusStreamType(quality)

    try {
      const info = await apiPost<StreamInfo>(`/cameras/${focusCamera}/start-stream`, { streamType: quality, viewId })
      const actualType: 'sub' | 'main' | 'main_h264' =
        (info as any).transcoded === true || info.streamPath?.endsWith('_main_h264')
          ? 'main_h264' : quality
      if (actualType !== quality) {
        console.info(`[LiveView] qualitySwitch redirect cameraId=${focusCamera} requested=${quality} actual=${actualType}`)
        setFocusStreamType(actualType)
      }
      setFocusStreamInfo(info)
      bumpPlayerKeys([focusCamera])
    } catch (err: any) {
      const body = err?.response?.data || {}
      const errCodeMap: Record<string, CameraPlaybackError['code']> = {
        CODEC_UNSUPPORTED_HEVC:  'CODEC_UNSUPPORTED',
        AUTH_FAILED:             'AUTH_FAILED',
        OFFLINE:                 'CAMERA_OFFLINE',
        MEDIA_SERVER_ERROR:      'MEDIAMTX_NOT_READY',
        RTSP_MAIN_NOT_FOUND:     'RTSP_CHANNEL_NOT_FOUND',
        TRANSCODE_NOT_READY:     'TRANSCODE_NOT_READY',
        TRANSCODE_PROCESS_EXITED:'TRANSCODE_PROCESS_EXITED',
        TRANSCODE_LIMIT_REACHED: 'TRANSCODE_LIMIT_REACHED',
      }
      setFocusStreamError({
        code: (errCodeMap[body.error] || 'UNKNOWN') as any,
        message: body.message || `Error al iniciar stream ${quality === 'main_h264' ? 'transcodificado' : 'principal'}`,
        technicalDetail: body.details,
      })
    }
  }, [focusCamera, focusStreamType, bumpPlayerKeys])

  // ─── Exit fullscreen/focus view ──────────────────────────────
  // On return from fullscreen, stop the focus camera and restart the grid cameras.
  // We do NOT restart cameras that weren't affected by the fullscreen.
  const handleExitFocus = useCallback(async () => {
    const prevFocusId = focusCamera
    setFocusCamera(null)
    setFocusStreamInfo(null)
    setFocusStreamError(null)
    setFocusStreamType('sub')

    // Stop main/main_h264 streams — sub stream stays alive for the grid
    if (prevFocusId) {
      apiPost(`/cameras/${prevFocusId}/stop-stream`, { streamType: 'main',      reason: 'exit_focus' }).catch(() => {})
      apiPost(`/cameras/${prevFocusId}/stop-stream`, { streamType: 'main_h264', reason: 'exit_focus' }).catch(() => {})
    }

    // Reconcile the grid cameras after returning from fullscreen.
    // Small delay for state to settle before starting streams.
    await new Promise(r => setTimeout(r, 100))
    const ids = filteredCamerasRef.current.map(c => c.id)

    // Bump keys for grid cameras so stale HLS instances are destroyed
    bumpPlayerKeys(ids)
    await new Promise(r => setTimeout(r, 300))
    startVisibleStreams(filteredCamerasRef.current)
  }, [focusCamera, bumpPlayerKeys, startVisibleStreams])

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
              const isMain     = !!focusStreamInfo
              // Use focusStreamType (not isMain) so HEVC overlay shows even when
              // the stream was blocked before the API call (focusStreamInfo=null).
              const focusType  = focusStreamType
              const focusHls   = isMain ? focusStreamInfo!.hls : (stream?.hls || '')
              const focusCodec = focusStreamType === 'main' || focusStreamType === 'main_h264'
                ? cam.mainCodec
                : cam.subCodec
              // For transcoded streams the output resolution depends on TRANSCODE_WIDTH env var,
              // not the camera's native mainResolution — don't show misleading metadata.
              const focusRes   = focusStreamType === 'main_h264'
                ? undefined
                : focusStreamType === 'main'
                  ? cam.mainResolution
                  : cam.subResolution
              const canTryMainStream = focusStreamType === 'sub' && !focusStreamError
              const transcodingAvailable = !!(streamCapabilities?.ffmpegAvailable && streamCapabilities?.transcodingEnabled)
              return (
                <div className="h-full flex flex-col gap-0 relative">
                  <VideoPlayer
                    key={`focus-${focusCamera}-${focusType}-${playerKeys[focusCamera] ?? 0}`}
                    hlsUrl={focusHls}
                    cameraName={`${cam.nvr?.name} — ${cam.name}`}
                    cameraId={cam.id}
                    isRecording={cam.online}
                    onFullscreen={handleExitFocus}
                    onDiagnostic={handleDiagnostic}
                    onStreamError={handleStreamError}
                    onQualitySwitch={handleQualitySwitch}
                    onRetry={focusType === 'main_h264' ? () => {
                      // Remount the player so HLS.js reconnects to the existing stream.
                      // Do NOT call handleQualitySwitch — that would kill FFmpeg unnecessarily.
                      // The supervisor keeps FFmpeg alive; VideoPlayer reconnects on remount.
                      setFocusStreamError(null)
                      bumpPlayerKeys([focusCamera!])
                    } : undefined}
                    className="flex-1 min-h-0"
                    playbackError={focusStreamError || streamErrors[focusCamera]}
                    streamType={focusType}
                    streamCodec={focusCodec}
                    streamResolution={focusRes}
                    transcodingAvailable={transcodingAvailable}
                  />
                  {/* Intentar alta calidad — visible button when watching sub in focus */}
                  {canTryMainStream && (
                    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20">
                      <button
                        onClick={() => handleQualitySwitch('main')}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/70 text-surface-200 text-xs hover:bg-black/90 transition-colors border border-surface-600/50"
                        title="Intentar stream principal HD (puede ser H.265 en algunas cámaras)"
                      >
                        ↑ Intentar alta calidad
                      </button>
                    </div>
                  )}
                  {(user?.role === 'ADMIN' || user?.role === 'SUPERVISOR') && cam.ptzEnabled && (
                    <div className="flex-shrink-0">
                      <PTZControls cameraId={cam.id} />
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        ) : (
          <div className={clsx('grid gap-1.5 h-full', currentGrid.cols)}>
            {filteredCameras.map(camera => {
              const stream       = streams[camera.id]
              const health       = camera.streamHealthStatus
              const isHighlit    = highlightCamera === camera.id
              const isFallback   = gridFallbackIds.has(camera.id)
              const gridType     = isFallback ? 'main_h264' : 'sub'
              const gridCodec    = isFallback ? camera.mainCodec : camera.subCodec
              const gridRes      = isFallback ? undefined : camera.subResolution
              return (
                <div
                  key={camera.id}
                  className={clsx(
                    'relative min-h-0 rounded-lg overflow-hidden border transition-all duration-300',
                    isHighlit
                      ? 'border-brand-400 ring-2 ring-brand-400/60 shadow-lg shadow-brand-400/20'
                      : 'border-surface-700'
                  )}
                >
                  {/* Health badge */}
                  {(() => {
                    if (!health || health === 'HEALTHY' || health === 'UNKNOWN' || !HEALTH_CONFIG[health]) return null
                    const badgeLabel = HEALTH_CONFIG[health].label
                    return (
                      <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1 rounded px-1.5 py-0.5 bg-black/70">
                        <span className="text-amber-400">{HEALTH_CONFIG[health].icon}</span>
                        <span className="text-[9px] font-medium text-amber-300">{badgeLabel}</span>
                      </div>
                    )
                  })()}
                  {/* Trans H.264 fallback badge */}
                  {isFallback && (
                    <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded px-1.5 py-0.5 bg-brand-700/80">
                      <Film size={9} className="text-brand-200" />
                      <span className="text-[9px] font-medium text-brand-100">Trans H.264</span>
                    </div>
                  )}
                  <VideoPlayer
                    key={`${camera.id}-${playerKeys[camera.id] ?? 0}`}
                    hlsUrl={stream?.hls || ''}
                    cameraName={`${camera.nvr?.name || ''} · ${camera.name}`}
                    cameraId={camera.id}
                    isRecording={camera.online}
                    onFullscreen={() => handleEnterFocus(camera)}
                    onDiagnostic={handleDiagnostic}
                    onStreamError={handleStreamError}
                    onPlaying={(cid) => setStreamErrors(prev => { const n = { ...prev }; delete n[cid]; return n })}
                    onRetry={handleGridCameraRetry}
                    className="w-full h-full"
                    playbackError={
                      streamErrors[camera.id] && TRANSCODE_ONLY_CODES.has(streamErrors[camera.id]!.code)
                        ? undefined
                        : streamErrors[camera.id]
                    }
                    streamType={gridType}
                    streamCodec={gridCodec}
                    streamResolution={gridRes}
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
