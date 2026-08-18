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
import { parseStreamError, parseRetryAfterMs } from '@/lib/streamErrors'
import { closeViewSessions, closeStreamSession } from '@/lib/sessionClose'
import { resolveHdSessionTtlMs } from '@/lib/hdSessionTtl'
import { decideHdReacquire, finishHdReacquire, initialHdReacquireState, decideHdFallback } from '@/lib/hdReacquire'
import { createQualitySwitchController } from '@/components/cameras/qualitySwitchController'
import { clsx } from 'clsx'
import type { Camera, StreamInfo, GridLayout, StreamHealthStatus, HeartbeatResponse } from '@/types'
import { createHeartbeatScheduler, type HeartbeatScheduler } from '@/lib/heartbeatScheduler'
import { reconcileHlsExpiry, decideExpiryRecovery } from '@/lib/hlsExpiryReconcile'

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
/**
 * Visibilidad de la pestaña, leída SIEMPRE en el momento.
 *
 * Es una función y no una comparación en línea a propósito: TypeScript estrecha
 * `document.visibilityState` tras la primera comparación dentro de una función
 * y marcaría la segunda —la que corre DESPUÉS de un `await`, justo cuando el
 * valor pudo cambiar— como imposible.
 */
const tabIsHidden = (): boolean => document.visibilityState === 'hidden'

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
  // Single-flight del cambio de calidad: deshabilita Baja/Alta/Trans mientras hay un
  // POST start-stream en vuelo para la cámara en foco (P1: evita POST duplicados).
  const [qualitySwitchBusy, setQualitySwitchBusy] = useState(false)

  // playerKeys forces VideoPlayer remount (new HLS instance) when incremented for a camera
  const [playerKeys, setPlayerKeys] = useState<Record<string, number>>({})
  // Mirrors which cameras are using the main_h264 fallback — drives the "Trans H.264" badge.
  // Separate from gridStreamOverride (a ref) so the badge re-renders when fallback is activated.
  const [gridFallbackIds, setGridFallbackIds] = useState<Set<string>>(new Set())

  // Stable ID for this browser tab — used by backend to track sessions per view
  const [viewId] = useState<string>(makeViewId)

  // Resultado de entrar en foco. Discriminado a propósito: el llamador decide
  // el fallback con ESTE valor, nunca leyendo estado de React recién fijado.
  type EnterFocusResult =
    | { ok: true; info: StreamInfo; actualType: 'sub' | 'main' | 'main_h264' }
    | { ok: false; error: CameraPlaybackError }

  // Error codes that belong exclusively to focus/main_h264 streams.
  // Grid tiles show sub streams — showing these errors on a tile is always stale/misleading.
  const TRANSCODE_ONLY_CODES = new Set<CameraPlaybackError['code']>([
    'TRANSCODE_NOT_READY', 'TRANSCODE_PROCESS_EXITED',
  ])

  // Track which cameraIds have active sessions in the backend
  const activeSessions = useRef<Set<string>>(new Set())
  // Track pending start-stream requests to avoid double-firing
  const pendingStarts  = useRef<Set<string>>(new Set())
  // Controlador single-flight del cambio de calidad (mutex + secuencia por cámara).
  // Instancia por montaje para no filtrar estado entre navegaciones.
  const qualityCtl     = useRef(createQualitySwitchController())
  // Backoff Retry-After por cámara tras un 429 de límite en el cambio de calidad.
  const qualityRetryUntil = useRef<Record<string, number>>({})
  // Stagger timers so we can cancel them on navigation
  const staggerTimers  = useRef<ReturnType<typeof setTimeout>[]>([])
  // Track when page became hidden to decide whether to reconcile on unhide
  const hiddenSince    = useRef<number | null>(null)
  // TTL EFECTIVO de la sesión HD en segundo plano. NO se supone 90 s: lo
  // resuelve el backend (STREAM_HD_IDLE_TIMEOUT ya normalizado y acotado) y se
  // recibe en /live-view/capabilities. El valor inicial es sólo el default
  // documentado, vigente hasta que llega la respuesta.
  const hdSessionTtlMs = useRef<number>(90_000)
  // Estado de la readquisición de HD. La decisión vive en `@/lib/hdReacquire`
  // (pura y testeada): una concesión por CICLO de ocultación, con single-flight
  // para eventos duplicados.
  const hdReacquire = useRef(initialHdReacquireState)
  // Puente al re-pedido de HD (definido más abajo, tras handleEnterFocus).
  const reacquireHdRef = useRef<((cam: Camera) => Promise<void>) | null>(null)
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
  /**
   * Expiraciones que NO se pudieron reconciliar todavía: las que llegaron con
   * la pestaña oculta y las que un heartbeat abortado dejó sin recuperar.
   *
   * hls.js considera fatal el 401 y no vuelve a emitirlo: si se pierde este
   * conjunto, el player se queda cargando para siempre (revisión de #157).
   */
  const pendingExpiry = useRef<Set<string>>(new Set())
  /** ¿La cámara en foco quedó con su sesión HD expirada y sin recuperar? */
  const pendingFocusExpiry = useRef<string | null>(null)
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
    apiGet<{
      ffmpegAvailable: boolean; transcodingEnabled: boolean
      streamIdleTimeoutMs?: number; streamHdIdleTimeoutMs?: number
    }>('/live-view/capabilities')
      .then(caps => {
        setStreamCapabilities(caps)
        // El TTL que rige lo resuelve el backend (ya normalizado y acotado).
        const ttl = resolveHdSessionTtlMs(caps, hdSessionTtlMs.current)
        if (ttl !== hdSessionTtlMs.current) {
          hdSessionTtlMs.current = ttl
          console.info(`[live-ui] hd_ttl_from_backend ms=${ttl}`)
        }
      })
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
  //
  // SÓLO envía y devuelve la respuesta: aplicarla es responsabilidad de quien
  // la pidió. Así una misma respuesta no se aplica dos veces cuando la
  // reconciliación de sesiones HLS expiradas usa el mismo camino.
  //
  // Devuelve `null` cuando no había nada que enviar (sin cámaras, sin sesión,
  // pestaña oculta o todas las cámaras filtradas). Los errores se propagan: el
  // programador los clasifica.
  const sendHeartbeat = useCallback(async (
    visibleCameraIds: string[],
    signal?: AbortSignal,
  ): Promise<HeartbeatResponse | null> => {
    if (visibleCameraIds.length === 0) return null
    if (!useAuthStore.getState().isAuthenticated) return null
    // Guarda de visibilidad, en el único punto por el que sale una solicitud.
    if (tabIsHidden()) {
      console.info('[live-ui] heartbeat_skipped reason=document_hidden')
      return null
    }
    {
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
      if (filteredIds.length === 0) return null
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
      }, undefined, signal)
      return result
    }
  }, [viewId])

  // ─── Vaciado de sesiones HLS expiradas ──────────────────────
  //
  // Se llama 2 s después del primer 401 para agrupar las expiraciones
  // simultáneas en UNA sola reconciliación.
  //
  // Ya no habla con la API: delega en `reconcileHlsExpiry`, que usa la
  // operación cancelable del programador. Antes llamaba a `apiPost` por su
  // cuenta —sin señal, sin releer la visibilidad tras el `await`— y su `catch`
  // programaba un `loadStream` aunque la pestaña estuviera oculta: era la única
  // ruta que sobrevivía a la corrección de #156.
  const flushHlsExpiry = useCallback(async () => {
    hlsExpiryTimerRef.current = null
    const expiredIds = Array.from(hlsExpiryQueue.current)
    hlsExpiryQueue.current.clear()
    if (expiredIds.length === 0) return

    const outcome = await reconcileHlsExpiry<HeartbeatResponse | null>(
      expiredIds,
      filteredCamerasRef.current.map(c => c.id),
      {
        isHidden: tabIsHidden,
        now: () => Date.now(),
        lastRestartAt: lastRestartAt.current,
        // TODA la red pasa por el programador: mismo cerrojo de "uno a la vez",
        // misma guarda de visibilidad y misma señal de cancelación que el
        // latido periódico y el de regreso.
        runHeartbeat: () =>
          heartbeatRef.current?.runNow() ?? Promise.resolve({ status: 'hidden' as const }),
        bumpPlayerKeys,
        clearLoading: (ids) => setLoadingStreams(prev => {
          const n = { ...prev }; ids.forEach(id => { n[id] = false }); return n
        }),
        scheduleReload: (ids) => {
          ids.forEach(id => {
            const cam = filteredCamerasRef.current.find(c => c.id === id)
            if (!cam) return
            bumpPlayerKeys([id])
            const timer = setTimeout(() => {
              // Última guarda: la pestaña pudo ocultarse durante estos 500 ms y
              // arrancar un stream ahí resucitaría la sesión.
              if (tabIsHidden()) return
              loadStreamRef.current?.(cam)
            }, 500)
            staggerTimers.current.push(timer)
          })
        },
        startedIdsOf: (r) => r?.startedIds ?? [],
        isAuthError: (e: any) => e?.response?.status === 401,
      },
    )

    if (outcome.status === 'reconciled' && outcome.remounted.length > 0) {
      console.info(
        `[live-ui] hls_reattach_after_expiry ids=[${outcome.remounted.join(',')}]` +
        ' reason=session_alive_cookie_expired'
      )
      return
    }
    if (outcome.status === 'reconciled' || outcome.status === 'empty' ||
        outcome.status === 'throttled' || outcome.status === 'failed') return

    // Quedaron cámaras sin recuperar (abortado, 401, o sin cámaras visibles).
    // Se CONSERVAN: hls.js no volverá a avisar, así que el próximo heartbeat
    // exitoso —el periódico o el de regreso— es quien debe rescatarlas.
    console.info(`[live-ui] hls_expiry_flush outcome=${outcome.status} pending=${outcome.pending.length}`)
    outcome.pending.forEach(id => pendingExpiry.current.add(id))
  }, [bumpPlayerKeys])

  // ─── Heartbeat periódico de la vista (30 s) ─────────────────
  // Reemplaza el touch-stream por cámara (N solicitudes → 1).
  //
  // El intervalo lo posee `heartbeatScheduler`: con la pestaña oculta se
  // CANCELA —no se limita a saltarse el tick— y al volver se envía uno
  // inmediato y se rearma exactamente uno. Antes el intervalo seguía vivo con
  // una guarda dentro del callback, y esa guarda no cubría las demás rutas.
  const heartbeatRef = useRef<HeartbeatScheduler<HeartbeatResponse | null> | null>(null)
  // El envío se lee por ref y el efecto no tiene dependencias A PROPÓSITO: si
  // dependiera de `sendHeartbeat`, cada cambio de su identidad destruiría el
  // programador y crearía otro, y como el nuevo late de inmediato eso sería una
  // ráfaga de heartbeats en vez de una cadencia. Un solo programador por
  // montaje; su contenido siempre el más reciente.
  const sendHeartbeatRef = useRef(sendHeartbeat)
  sendHeartbeatRef.current = sendHeartbeat
  const applyHeartbeatRef = useRef(applyHeartbeat)
  applyHeartbeatRef.current = applyHeartbeat

  /**
   * Consume las expiraciones pendientes con el resultado de UN heartbeat.
   *
   * Se ejecuta exactamente una vez por respuesta: las cámaras que el backend
   * reinició llegan en `startedIds` y ya las remonta `applyHeartbeat`; las que
   * no llegan es porque su sesión seguía viva —regreso antes del TTL— y
   * necesitan un remonte para renovar la cookie HLS.
   */
  const consumePendingExpiry = useCallback((result: HeartbeatResponse) => {
    const pendientes = Array.from(pendingExpiry.current)
    const foco = pendingFocusExpiry.current
    if (pendientes.length === 0 && !foco) return
    pendingExpiry.current.clear()
    pendingFocusExpiry.current = null

    const { remount: aRemontar, focus } = decideExpiryRecovery({
      pending: pendientes,
      pendingFocus: foco,
      startedIds: result.startedIds,
      visibleIds: filteredCamerasRef.current.map(c => c.id),
      currentFocus: focusCameraRef.current,
    })
    if (aRemontar.length > 0) {
      console.info(`[live-ui] hls_expiry_recovered ids=[${aRemontar.join(',')}] reason=session_alive_after_return`)
      bumpPlayerKeys(aRemontar)
      setLoadingStreams(prev => {
        const n = { ...prev }; aRemontar.forEach(id => { n[id] = false }); return n
      })
    }

    // La cámara en foco se recupera igual antes y después del TTL: si el
    // backend la reinició ya está en `startedIds`, y si no, basta remontar el
    // player. En ambos casos hay que quitar el "Reconectando…", o la tarjeta
    // queda trabada con un error que ya no describe nada.
    if (focus) {
      console.info(
        `[live-ui] focus_expiry_recovered cameraId=${focus}` +
        ` restarted=${result.startedIds.includes(focus)}`
      )
      setFocusStreamError(null)
      bumpPlayerKeys([focus])
    }
  }, [bumpPlayerKeys])
  const consumePendingExpiryRef = useRef(consumePendingExpiry)
  consumePendingExpiryRef.current = consumePendingExpiry
  useEffect(() => {
    const scheduler = createHeartbeatScheduler<HeartbeatResponse | null>({
      intervalMs: 30_000,
      isHidden: tabIsHidden,
      send: (signal) => sendHeartbeatRef.current(filteredCamerasRef.current.map(c => c.id), signal),
      // La cadencia aplica su propio resultado; `runNow` no, para que la
      // reconciliación de sesiones HLS lo aplique una sola vez.
      // Punto ÚNICO de aplicación, sea cual sea la ruta que originó la
      // solicitud (cadencia, regreso o reconciliación que se unió a ella).
      onResult: (result) => {
        if (!result) return
        applyHeartbeatRef.current(result)
        consumePendingExpiryRef.current(result)
      },
    })
    heartbeatRef.current = scheduler
    scheduler.start()
    return () => {
      scheduler.stop()
      if (heartbeatRef.current === scheduler) heartbeatRef.current = null
      // Nada de la vista anterior sobrevive al desmontaje o al cambio de NVR:
      // recuperar una cámara que ya no se muestra arrancaría un stream sin
      // espectador.
      if (hlsExpiryTimerRef.current) {
        clearTimeout(hlsExpiryTimerRef.current)
        hlsExpiryTimerRef.current = null
      }
      hlsExpiryQueue.current.clear()
      pendingExpiry.current.clear()
      pendingFocusExpiry.current = null
    }
  }, [])

  // ─── Stop sessions for a set of cameraIds ───────────────────
  const stopSessions = useCallback(async (cameraIds: string[], reason?: string) => {
    const toStop = cameraIds.filter(id => activeSessions.current.has(id))
    if (toStop.length === 0) return
    console.info(`[LiveView] stopSessions reason=${reason || 'unspecified'} count=${toStop.length} ids=[${toStop.join(',')}]`)
    // keepalive: un cambio de layout/cámara puede coincidir con una navegación;
    // sin él la petición se aborta y la sesión queda viva hasta el TTL.
    await Promise.allSettled(
      toStop.map(id => closeStreamSession(id, 'sub', reason || 'stop_sessions', viewId))
    )
    toStop.forEach(id => {
      activeSessions.current.delete(id)
      pendingStarts.current.delete(id)
    })
  }, [viewId])

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

  // ─── Cierre en desmontaje y al descargar la página ───────────
  // Se pasa viewId para que el servidor limpie SÓLO las sesiones de esta
  // pestaña: sin él mataría todas las del usuario, incluidas las que acaba de
  // iniciar el siguiente montaje de LiveViewPage.
  //
  // Se usa DELETE con `keepalive: true`: el navegador aborta las peticiones
  // normales al descargar la página, y el cierre disparado en `pagehide` o en
  // el cleanup de React se perdía. El servidor trata ambos como idempotentes,
  // así que `pagehide` + desmontaje simultáneos no son un problema.
  //
  // El TTL del servidor sigue siendo la garantía final si nada de esto llega.
  useEffect(() => {
    const closeThisView = () => {
      clearStaggerTimers()
      void closeViewSessions(viewId)
    }
    // `pagehide` cubre cierre de pestaña, navegación y bfcache en iOS/Safari,
    // donde `beforeunload` no es fiable.
    window.addEventListener('pagehide', closeThisView)
    return () => {
      window.removeEventListener('pagehide', closeThisView)
      closeThisView()
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
      // El viewId va SIEMPRE: sin él la sesión se registra bajo 'default' y su
      // heartbeat de view nunca coincide con el de esta pestaña.
      const body = overrideType ? { streamType: overrideType, viewId } : { viewId }
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
      // UN SOLO listener para toda la página: el programador decide el latido y
      // acá queda únicamente lo que es específico de la vista (HD y el reloj de
      // ocultación). Dos listeners separados era la puerta a dos heartbeats de
      // regreso y a dos intervalos.
      heartbeatRef.current?.handleVisibilityChange()

      if (tabIsHidden()) {
        // Se suspende el heartbeat (incluido el de HD): con la pestaña oculta no
        // hay espectador, y el servidor debe poder expirar la sesión y liberar
        // FFmpeg. El intervalo queda CANCELADO, no dormido.
        //
        // Y con él, el vaciado de sesiones HLS: su temporizador pendiente se
        // cancela y la cola se descarta. Al volver, el heartbeat de regreso
        // reconcilia el estado real en una sola pasada.
        if (hlsExpiryTimerRef.current) {
          clearTimeout(hlsExpiryTimerRef.current)
          hlsExpiryTimerRef.current = null
        }
        // La cola NO se descarta: se traslada al conjunto pendiente, que el
        // heartbeat de regreso consume una sola vez.
        hlsExpiryQueue.current.forEach(id => pendingExpiry.current.add(id))
        hlsExpiryQueue.current.clear()
        hiddenSince.current = Date.now()
        console.info('[live-ui] heartbeat_suspended reason=document_hidden')
        return
      }

      const hiddenAt = hiddenSince.current
      const hiddenMs = hiddenAt ? Date.now() - hiddenAt : 0
      hiddenSince.current = null
      if (!useAuthStore.getState().isAuthenticated) return

      // El heartbeat inmediato de regreso ya lo envió el programador: si la
      // sesión sigue viva la conserva, y si el servidor la expiró la
      // reconciliación devuelve startedIds y se remonta el player.
      console.info(`[live-ui] heartbeat_resumed hiddenMs=${hiddenMs}`)

      // HD tras una ocultación larga: el servidor ya liberó el FFmpeg. Se pide
      // alta calidad UNA sola vez, y la baja calidad sigue reproduciéndose
      // mientras tanto — nunca se deja la tarjeta en negro.
      const focusId = focusCameraRef.current
      const wasHd = focusStreamTypeRef.current === 'main' || focusStreamTypeRef.current === 'main_h264'
      // La decisión la toma el módulo puro: un intento por ciclo de ocultación,
      // con single-flight ante eventos duplicados.
      const decision = decideHdReacquire({
        hiddenAt,
        hiddenMs,
        hdTtlMs: hdSessionTtlMs.current,
        focusIsHd: !!focusId && wasHd,
        state: hdReacquire.current,
      })
      hdReacquire.current = decision.nextState
      if (!decision.shouldReacquire) return

      const cam = filteredCamerasRef.current.find(c => c.id === focusId)
      if (!cam) {
        hdReacquire.current = finishHdReacquire(hdReacquire.current)
        return
      }
      console.info(
        `[live-ui] hd_reacquire_after_hidden cameraId=${focusId}` +
        ` hiddenMs=${hiddenMs} ttlMs=${hdSessionTtlMs.current} cycle=${hiddenAt}`
      )
      void reacquireHdRef.current?.(cam).finally(() => {
        hdReacquire.current = finishHdReacquire(hdReacquire.current)
      })
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
    // Sin dependencias: el listener se registra UNA vez por montaje y todo lo
    // que consulta —el programador, las cámaras visibles, el foco— lo lee por
    // ref. Re-registrarlo en cada cambio de identidad de un callback era churn
    // innecesario sobre un evento global.
  }, [])

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
    apiPost(`/cameras/${cameraId}/stop-stream`, { streamType: 'sub', reason: 'grid_retry', viewId }).catch(() => {})
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
        // Se ANOTA aunque la pestaña esté visible: si no se recupera antes de
        // ocultarse, el regreso tiene que rescatarla. Sin esto el foco quedaba
        // con "Reconectando…" para siempre al volver antes del TTL, porque
        // `decideHdReacquire` sólo actúa pasado el TTL (revisión de #157).
        pendingFocusExpiry.current = cameraId
        return
      }
      // Con la pestaña oculta no se envía nada ni se programan reintentos, pero
      // el cameraId SÍ se conserva: hls.js considera fatal el 401 y no vuelve a
      // emitirlo, así que descartarlo dejaba el player cargando para siempre.
      if (tabIsHidden()) {
        console.info(`[live-ui] hls_expiry_deferred cameraId=${cameraId} reason=document_hidden`)
        pendingExpiry.current.add(cameraId)
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
      apiPost(`/cameras/${cameraId}/stop-stream`, { streamType: currentStreamType, reason: 'hls_fatal_error', viewId }).catch(() => {})
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
  // Devuelve un resultado DISCRIMINADO además de fijar el estado. El estado de
  // React puede no haberse renderizado todavía cuando el llamador necesita
  // decidir, así que leer un ref inmediatamente después daría `null` y el
  // fallback nunca se activaría (revisión de #146). El valor de retorno es la
  // fuente para decidir; el estado es sólo para pintar.
  const handleEnterFocus = useCallback(async (camera: Camera): Promise<EnterFocusResult> => {
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
      return {
        ok: false,
        error: {
          code: 'CODEC_UNSUPPORTED',
          message: 'El flujo principal está en H.265/HEVC. Los navegadores no pueden reproducir H.265.',
        },
      }
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
      return { ok: true, info, actualType }
    } catch (err: any) {
      // Contrato unificado: lee body.code ?? body.error (antes leía body.error y un 429
      // de límite caía en "Error desconocido").
      const parsed = parseStreamError(
        err?.response?.data || {},
        err?.response?.status,
        'Error al iniciar stream principal',
      )
      if (parsed.code === 'TRANSCODE_LIMIT_REACHED') {
        console.info(`[live-ui] transcode_limit_reached cameraId=${camera.id}`)
        console.info(`[live-ui] fallback_to_substream cameraId=${camera.id} reason=transcode_limit_reached — user can click 'Usar baja calidad'`)
      }
      const failure: CameraPlaybackError = {
        code: parsed.code,
        message: parsed.message,
        technicalDetail: parsed.technicalDetail,
      }
      setFocusStreamError(failure)
      return { ok: false, error: failure }
    }
  }, [bumpPlayerKeys, streamCapabilities, focusStreamType, viewId])

  // ─── Readquisición de HD tras expirar por pestaña oculta ────────────────────
  // El servidor expiró la sesión HD y liberó su FFmpeg. Al volver se pide alta
  // calidad UNA vez por ciclo de ocultación; si no hay cupo o falla, se
  // restaura el substream SIN overlay de error: la transición nunca debe dejar
  // la tarjeta en negro. El tratamiento general del 429 sigue siendo B1.
  useEffect(() => {
    reacquireHdRef.current = async (camera: Camera) => {
      const before = focusStreamTypeRef.current
      let result: EnterFocusResult
      try {
        result = await handleEnterFocus(camera)
      } catch (e: any) {
        result = { ok: false, error: { code: 'UNKNOWN', message: String(e?.message ?? e) } }
      }
      // El plan se decide con el RESULTADO devuelto, no con focusStreamError:
      // el estado de React puede seguir sin renderizar en este punto.
      const plan = decideHdFallback({
        ok: result.ok,
        errorCode: result.ok ? undefined : result.error.code,
      })
      if (result.ok) return

      console.info(
        `[live-ui] hd_reacquire_failed cameraId=${camera.id} code=${result.error.code}` +
        ` prevType=${before} — se restaura baja calidad, sin pantalla negra`
      )
      if (!plan.showErrorOverlay) setFocusStreamError(null)
      if (plan.clearStreamInfo) setFocusStreamInfo(null)
      setFocusStreamType(plan.streamType)
      if (plan.remountPlayer) bumpPlayerKeys([camera.id])
    }
  }, [handleEnterFocus, bumpPlayerKeys])

  // La guarda pertenece al ciclo de ocultación, no a la cámara. Al cambiar de
  // cámara en foco sólo se descarta un intento en vuelo que ya no aplica.
  useEffect(() => { hdReacquire.current = finishHdReacquire(hdReacquire.current) }, [focusCamera])

  // Deep-link ?focus=1: entrar al modo FOCO REAL (calidad principal) una vez que la
  // cámara objetivo está en su NVR. Antes el deep-link sólo cambiaba a layout 1×1 y la
  // celda seguía pidiendo el substream (badge "Sub 640×360"); ahora dispara el mismo
  // camino que el doble clic / pantalla completa, que solicita main/main_h264.
  const appliedFocusQuery = useRef<string | null>(null)
  useEffect(() => {
    const wantFocus = focusParam === '1' || focusParam === 'true'
    if (!wantFocus || !cameraFilter || cameras.length === 0) return
    // Esperar a que las capacidades de streaming estén resueltas ANTES de entrar al foco:
    // con capabilities=null, handleEnterFocus trataría una cámara HEVC como
    // "sin transcodificación" y mostraría CODEC_UNSUPPORTED de forma permanente (el ref
    // appliedFocusQuery impediría reintentar cuando lleguen las capacidades). (Codex #133)
    if (!streamCapabilities) return
    const cam = cameras.find(c => c.id === cameraFilter)
    if (!cam || selectedNVR !== cam.nvrId) return       // esperar a que el NVR objetivo esté activo
    if (appliedFocusQuery.current === cameraFilter || focusCamera === cam.id) {
      appliedFocusQuery.current = cameraFilter
      return
    }
    appliedFocusQuery.current = cameraFilter
    handleEnterFocus(cam)
  }, [focusParam, cameraFilter, cameras, selectedNVR, focusCamera, handleEnterFocus, streamCapabilities])

  // ─── Quality switch from VideoPlayer (Baja/Alta/Trans buttons) ─
  const handleQualitySwitch = useCallback(async (quality: 'sub' | 'main' | 'main_h264') => {
    if (!focusCamera) return
    const cam = focusCamera

    // Retry-After: si un 429 previo pidió esperar, ignorar clics hasta que expire.
    const retryUntil = qualityRetryUntil.current[cam]
    if (retryUntil && Date.now() < retryUntil) {
      console.info(`[live-ui] quality_switch_throttled cameraId=${cam} quality=${quality} until=${retryUntil}`)
      return
    }

    // Single-flight: clic del mismo tipo pendiente → se ignora; otro tipo → supersede.
    const decision = qualityCtl.current.request(cam, quality)
    if (decision.action === 'ignore') {
      console.info(`[live-ui] quality_switch_ignored cameraId=${cam} quality=${quality} reason=same-pending`)
      return
    }
    const seq = decision.seq
    setQualitySwitchBusy(true)

    try {
      if (quality === 'sub') {
        // Explicitly switching back to sub — stop both main streams so FFmpeg is killed.
        console.info(`[LiveView] qualitySwitch cameraId=${cam} from=${focusStreamType} to=sub reason=switch_to_sub`)
        console.info(`[live-ui] fallback_to_substream cameraId=${cam} reason=user_selected_low_quality prevType=${focusStreamType}`)
        void closeStreamSession(cam, 'main',      'switch_to_sub', viewId)
        void closeStreamSession(cam, 'main_h264', 'switch_to_sub', viewId)
        setFocusStreamInfo(null)
        setFocusStreamError(null)
        setFocusStreamType('sub')
        bumpPlayerKeys([cam])
        return
      }

      if (quality === focusStreamType) {
        // Same type — this is a retry. Remount the player without killing FFmpeg.
        // The supervisor keeps FFmpeg alive; a fresh HLS.js instance will reconnect.
        // No relanzamos main_h264 si ya hay una sesión reutilizable del mismo tipo.
        console.info(`[LiveView] qualitySwitch retry cameraId=${cam} type=${quality} — remounting player only`)
        setFocusStreamError(null)
        bumpPlayerKeys([cam])
        return
      }

      // Switching to a different type (e.g. sub→main, main→main_h264, main_h264→main)
      const prevType = focusStreamType
      console.info(`[LiveView] qualitySwitch cameraId=${cam} from=${prevType} to=${quality}`)

      // Only stop 'main' session — never stop 'main_h264' here because:
      // a) On HEVC cameras, 'main' redirects to 'main_h264' anyway (same FFmpeg).
      // b) Stopping main_h264 kills FFmpeg, then start-stream immediately re-spawns it
      //    causing the "closing existing publisher" duplicate in MediaMTX.
      if (prevType === 'main') {
        apiPost(`/cameras/${cam}/stop-stream`, { streamType: 'main', reason: 'quality_switch', viewId }).catch(() => {})
      }

      setFocusStreamInfo(null)
      setFocusStreamError(null)
      setFocusStreamType(quality)

      try {
        const info = await apiPost<StreamInfo>(`/cameras/${cam}/start-stream`, { streamType: quality, viewId })
        // Descarta respuestas tardías de una selección anterior (llegadas fuera de orden).
        if (!qualityCtl.current.isCurrent(cam, seq)) {
          console.info(`[live-ui] quality_switch_stale_response cameraId=${cam} seq=${seq} quality=${quality} — descartada`)
          return
        }
        const actualType: 'sub' | 'main' | 'main_h264' =
          (info as any).transcoded === true || info.streamPath?.endsWith('_main_h264')
            ? 'main_h264' : quality
        if (actualType !== quality) {
          console.info(`[LiveView] qualitySwitch redirect cameraId=${cam} requested=${quality} actual=${actualType}`)
          setFocusStreamType(actualType)
        }
        setFocusStreamInfo(info)
        bumpPlayerKeys([cam])
      } catch (err: any) {
        // Un error tardío de una selección superada tampoco debe pisar la vigente.
        if (!qualityCtl.current.isCurrent(cam, seq)) return
        const parsed = parseStreamError(
          err?.response?.data || {},
          err?.response?.status,
          `Error al iniciar stream ${quality === 'main_h264' ? 'transcodificado' : 'principal'}`,
        )
        if (parsed.isLimit) {
          // Respeta Retry-After del backend (429) antes de permitir otro intento.
          const retryMs = parseRetryAfterMs(err?.response?.headers?.['retry-after'])
          qualityRetryUntil.current[cam] = Date.now() + retryMs
        }
        setFocusStreamError({
          code: parsed.code,
          message: parsed.message,
          technicalDetail: parsed.technicalDetail,
        })
      }
    } finally {
      qualityCtl.current.settle(cam, seq)
      setQualitySwitchBusy(qualityCtl.current.isPending(cam))
    }
  }, [focusCamera, focusStreamType, bumpPlayerKeys, viewId])

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
      void closeStreamSession(prevFocusId, 'main',      'exit_focus', viewId)
      void closeStreamSession(prevFocusId, 'main_h264', 'exit_focus', viewId)
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
              // Metadatos REALES del backend cuando están disponibles (PR B): el
              // start-stream ahora devuelve codec/resolution del stream servido. Para
              // main_h264 el codec es H.264 y la resolución la de origen del main, así el
              // badge muestra "Trans H.264 1920×1080" en vez de ocultar la resolución.
              const info       = focusStreamInfo as any
              const focusCodec = info?.codec ?? (
                focusStreamType === 'main' || focusStreamType === 'main_h264' ? cam.mainCodec : cam.subCodec
              )
              const focusRes   = info?.resolution ?? (
                focusStreamType === 'sub' ? cam.subResolution :
                focusStreamType === 'main' ? cam.mainResolution : undefined
              )
              const focusFps     = info?.fps ?? null
              const focusBitrate = info?.bitrate ?? null
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
                    streamFps={focusFps}
                    streamBitrate={focusBitrate}
                    transcodingAvailable={transcodingAvailable}
                    qualitySwitchBusy={qualitySwitchBusy}
                  />
                  {/* Intentar alta calidad — visible button when watching sub in focus */}
                  {canTryMainStream && (
                    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20">
                      <button
                        onClick={() => handleQualitySwitch('main')}
                        disabled={qualitySwitchBusy}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/70 text-surface-200 text-xs hover:bg-black/90 transition-colors border border-surface-600/50 disabled:opacity-50 disabled:cursor-not-allowed"
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
