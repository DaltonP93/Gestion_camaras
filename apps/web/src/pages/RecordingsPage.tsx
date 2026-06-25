// src/pages/RecordingsPage.tsx
import { useEffect, useState, useMemo, useRef } from 'react'
import {
  Play, Clock, AlertTriangle, RefreshCw, ExternalLink,
  XCircle, Loader2, Info, Download,
} from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost, apiGet, apiDelete } from '@/lib/api'
import { format, subHours } from 'date-fns'
import { clsx } from 'clsx'
import type { Recording } from '@/types'
import toast from 'react-hot-toast'
import Hls from 'hls.js'
import { RecordingPlaybackControls } from '@/components/RecordingPlaybackControls'
import { RecordingCameraTree }  from '@/components/recordings/RecordingCameraTree'
import { RecordingSearchBar }   from '@/components/recordings/RecordingSearchBar'
import { RecordingTimeline }    from '@/components/recordings/RecordingTimeline'
import type { RecordingWithCamera, NvrSearchError, PlaybackLayout } from '@/components/recordings/types'

// ─── Local interfaces kept for PlaybackStatusResponse ────────────────────────

interface PlaybackStatusResponse {
  status:               'starting' | 'ready' | 'error'
  url?:                 string
  mimeType?:            string
  hlsReady?:            boolean
  transcoded?:          boolean
  errorCode?:           string
  error?:               string
  downloadUrl?:         string
  outTimeSec?:          number
  frame?:               number
  fps?:                 number
  speed?:               string
  expectedDurationSec?: number
  progressPercent?:     number
  lastProgressAt?:      number
  elapsedMs?:           number
}

interface RecordingCapabilities {
  nvrId: string
  recordingProvider: string
  supportsIsapiRecording: boolean | null
  playbackWebUrl: string | null
  recordingCapabilityError: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function classifyError(err: any): 'ISAPI_UNSUPPORTED' | 'AUTH_FAILED' | 'NVR_OFFLINE' | 'UNKNOWN' {
  const msg = (err?.response?.data?.message || err?.message || '').toLowerCase()
  if (msg.includes('isapi') || msg.includes('no soporta') || msg.includes('unsupported')) return 'ISAPI_UNSUPPORTED'
  if (msg.includes('401') || msg.includes('auth') || msg.includes('credencial'))           return 'AUTH_FAILED'
  if (msg.includes('offline') || msg.includes('unreachable') || msg.includes('econnrefused')) return 'NVR_OFFLINE'
  return 'UNKNOWN'
}

function formatDuration(start: string, end: string) {
  const diff = new Date(end).getTime() - new Date(start).getTime()
  const mins = Math.floor(diff / 60000)
  const secs = Math.floor((diff % 60000) / 1000)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function formatSize(bytes: number) {
  if (bytes === 0) return '—'
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
  return `${(bytes / 1048576).toFixed(0)} MB`
}

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS    = 1_000
const POLL_ABSOLUTE_MAX_MS = 15 * 60 * 1_000
const POLL_STALL_MS       = 45_000

// ─── Component ───────────────────────────────────────────────────────────────

export function RecordingsPage() {
  const { nvrs, cameras, loadNVRs, loadCameras } = useCameraStore()

  // ── Search / filter state ──────────────────────────────────────────────────
  const [selectedCameras, setSelectedCameras] = useState<Set<string>>(new Set())
  const [startDate, setStartDate] = useState(toLocalDatetimeString(subHours(new Date(), 1)))
  const [endDate,   setEndDate]   = useState(toLocalDatetimeString(new Date()))
  const [recordings, setRecordings] = useState<RecordingWithCamera[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [nvrErrors, setNvrErrors]     = useState<NvrSearchError[]>([])
  const [nvrCaps,   setNvrCaps]       = useState<Map<string, RecordingCapabilities>>(new Map())
  const [revalidating, setRevalidating] = useState<Set<string>>(new Set())

  // ── Layout ─────────────────────────────────────────────────────────────────
  const [layout, setLayout] = useState<PlaybackLayout>('1x1')

  // ── Playback state ─────────────────────────────────────────────────────────
  const [playbackUrl, setPlaybackUrl]         = useState<string | null>(null)
  const [playbackSessionId, setPlaybackSessionId] = useState<string | null>(null)
  const [playbackLoading, setPlaybackLoading] = useState(false)
  const [playbackStatus, setPlaybackStatus]   = useState<'idle' | 'starting' | 'transcoding' | 'ready'>('idle')
  const [selectedRec, setSelectedRec]         = useState<RecordingWithCamera | null>(null)
  const [playbackMimeType, setPlaybackMimeType] = useState<string | null>(null)
  const [playbackTranscoding, setPlaybackTranscoding] = useState(false) // eslint-disable-line @typescript-eslint/no-unused-vars
  const [vodProgress, setVodProgress]         = useState<{ outTimeSec: number; expectedDurationSec: number } | null>(null)
  const [downloadUrl,  setDownloadUrl]         = useState<string | null>(null)

  // ── Refs ───────────────────────────────────────────────────────────────────
  const videoRef             = useRef<HTMLVideoElement>(null)
  const hlsRef               = useRef<Hls | null>(null)
  const playbackKeyRef       = useRef<string | null>(null)
  const playbackSessionIdRef = useRef<string | null>(null)
  const playbackEndedRef     = useRef(false)
  const playbackCleaningRef  = useRef(false)
  const selectedRecRef       = useRef<RecordingWithCamera | null>(null)
  const hevcCopyAttemptedRef = useRef(false)
  const hevcRetryDoneRef     = useRef(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlePlayFnRef      = useRef<(rec: RecordingWithCamera, opts?: { forceTranscode?: boolean }) => void>(() => {})

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  useEffect(() => { loadNVRs(); loadCameras() }, [])

  // ── Camera selection helpers ───────────────────────────────────────────────
  const toggleCamera = (cameraId: string) =>
    setSelectedCameras(prev => {
      const next = new Set(prev)
      next.has(cameraId) ? next.delete(cameraId) : next.add(cameraId)
      return next
    })

  const toggleNVR = (nvrId: string) => {
    const ids = cameras.filter(c => c.nvrId === nvrId).map(c => c.id)
    const allSelected = ids.every(id => selectedCameras.has(id))
    setSelectedCameras(prev => {
      const next = new Set(prev)
      if (allSelected) ids.forEach(id => next.delete(id))
      else             ids.forEach(id => next.add(id))
      return next
    })
  }

  const selectAll = () => setSelectedCameras(new Set(cameras.map(c => c.id)))
  const clearAll  = () => setSelectedCameras(new Set())

  // ── Search ─────────────────────────────────────────────────────────────────
  const handleSearch = async () => {
    if (selectedCameras.size === 0) { toast.error('Selecciona al menos una cámara'); return }
    const start = new Date(startDate)
    const end   = new Date(endDate)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) { toast.error('Fechas inválidas'); return }
    if (start >= end) { toast.error('La fecha Desde debe ser anterior a Hasta'); return }

    setIsSearching(true)
    setPlaybackUrl(null)
    setRecordings([])
    setNvrErrors([])

    const cameraIds = [...selectedCameras]

    const camToNvr = new Map<string, { nvrId: string; nvrName: string }>()
    cameras.forEach(c => {
      if (cameraIds.includes(c.id)) {
        camToNvr.set(c.id, { nvrId: c.nvrId, nvrName: c.nvr?.name ?? 'NVR' })
      }
    })

    const results = await Promise.allSettled(
      cameraIds.map(cameraId =>
        apiGet<{ recordings: Recording[] }>('/recordings/search', {
          cameraId,
          startTime: new Date(startDate).toISOString(),
          endTime:   new Date(endDate).toISOString(),
        }).then(res => {
          const cam = cameras.find(c => c.id === cameraId)
          return (res?.recordings ?? []).map((r): RecordingWithCamera => ({
            ...r,
            cameraId,
            cameraName: cam?.name || 'Desconocida',
            nvrName:    cam?.nvr?.name || '',
          }))
        })
      )
    )

    const all: RecordingWithCamera[] = []
    const errsByNvr = new Map<string, NvrSearchError>()

    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        all.push(...r.value)
      } else {
        const cameraId = cameraIds[i]
        const nvrInfo  = camToNvr.get(cameraId)
        if (nvrInfo) {
          if (!errsByNvr.has(nvrInfo.nvrId)) {
            errsByNvr.set(nvrInfo.nvrId, {
              nvrId:    nvrInfo.nvrId,
              nvrName:  nvrInfo.nvrName,
              cameraIds: [],
              code:     classifyError(r.reason),
              message:  r.reason?.response?.data?.message ?? r.reason?.message ?? 'Error desconocido',
              playbackWebUrl: nvrCaps.get(nvrInfo.nvrId)?.playbackWebUrl ?? null,
            })
          }
          errsByNvr.get(nvrInfo.nvrId)!.cameraIds.push(cameraId)
        }
      }
    })

    all.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
    setRecordings(all)
    setNvrErrors([...errsByNvr.values()])
    setIsSearching(false)

    if (all.length === 0 && errsByNvr.size === 0) {
      toast('Sin grabaciones en ese rango', { icon: 'ℹ️' })
    }
  }

  const handleRevalidate = async (nvrId: string) => {
    setRevalidating(prev => new Set([...prev, nvrId]))
    try {
      const caps = await apiPost<RecordingCapabilities>(`/nvrs/${nvrId}/recording-capabilities/check`, {})
      setNvrCaps(prev => new Map([...prev, [nvrId, caps]]))
      if (caps.supportsIsapiRecording) {
        toast.success('NVR ahora soporta ISAPI. Vuelve a buscar para obtener resultados.')
        setNvrErrors(prev => prev.filter(e => e.nvrId !== nvrId))
      } else {
        toast('NVR no soporta búsqueda ISAPI', { icon: 'ℹ️' })
        setNvrErrors(prev => prev.map(e =>
          e.nvrId === nvrId ? { ...e, playbackWebUrl: caps.playbackWebUrl ?? null } : e
        ))
      }
    } catch {
      toast.error('Error al verificar compatibilidad del NVR')
    } finally {
      setRevalidating(prev => { const n = new Set(prev); n.delete(nvrId); return n })
    }
  }

  // ── Playback control ───────────────────────────────────────────────────────

  const stopPlayback = () => {
    playbackCleaningRef.current = true
    toast.dismiss()
    playbackKeyRef.current = null
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
    const sid = playbackSessionIdRef.current
    if (sid) {
      apiDelete(`/recordings/playback/${sid}`).catch(() => {})
      playbackSessionIdRef.current = null
      setPlaybackSessionId(null)
    }
    setPlaybackUrl(null)
    setPlaybackStatus('idle')
    setPlaybackMimeType(null)
    setVodProgress(null)
    setDownloadUrl(null)
  }

  useEffect(() => { playbackSessionIdRef.current = playbackSessionId }, [playbackSessionId])
  useEffect(() => { selectedRecRef.current = selectedRec }, [selectedRec])

  // Clean up on unmount
  useEffect(() => stopPlayback, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Attach video source when playbackUrl / mimeType changes
  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackUrl) return

    playbackEndedRef.current    = false
    playbackCleaningRef.current = false
    const attachedKey = playbackKeyRef.current

    const handleVideoEnded = () => {
      playbackEndedRef.current = true
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
      const sid = playbackSessionIdRef.current
      if (sid) {
        apiDelete(`/recordings/playback/${sid}`).catch(() => {})
        playbackSessionIdRef.current = null
        setPlaybackSessionId(null)
      }
      setPlaybackStatus('idle')
    }

    video.addEventListener('ended', handleVideoEnded)

    if (playbackMimeType === 'video/mp4') {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }

      const handleVideoError = () => {
        if (playbackEndedRef.current)             return
        if (playbackCleaningRef.current)          return
        if (attachedKey !== playbackKeyRef.current) return
        const err = video.error
        console.error(`[recordings-ui] mp4_video_error code=${err?.code} message=${err?.message} currentSrc=${video.currentSrc}`)

        if (hevcCopyAttemptedRef.current && !hevcRetryDoneRef.current && selectedRecRef.current) {
          hevcRetryDoneRef.current = true
          const recToRetry = selectedRecRef.current
          console.info('[recordings-ui] mp4_hevc_copy_failed retrying with forceTranscode=true')
          toast('Video HEVC no compatible con este navegador. Reintentando con conversión H.264…', { duration: 6000 })
          stopPlayback()
          setTimeout(() => handlePlayFnRef.current(recToRetry, { forceTranscode: true }), 150)
          return
        }

        toast.error('El video fue generado pero el navegador no pudo abrir el archivo MP4', { duration: 8000 })
      }

      const handleCanPlay = () => {
        console.info(`[recordings-ui] mp4_canplay sessionId=${playbackSessionIdRef.current} duration=${video.duration?.toFixed(1)}s`)
      }
      const handlePlaying = () => {
        console.info(`[recordings-ui] mp4_playing sessionId=${playbackSessionIdRef.current}`)
      }

      console.info(`[recordings-ui] mp4_attach_url sessionId=${playbackSessionIdRef.current} url=${playbackUrl}`)
      video.addEventListener('error',   handleVideoError)
      video.addEventListener('canplay', handleCanPlay)
      video.addEventListener('playing', handlePlaying)
      video.src = playbackUrl
      video.play().catch(() => {})
      return () => {
        video.removeEventListener('ended',   handleVideoEnded)
        video.removeEventListener('error',   handleVideoError)
        video.removeEventListener('canplay', handleCanPlay)
        video.removeEventListener('playing', handlePlaying)
      }
    }

    // HLS.js path
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false,
        xhrSetup: (xhr) => { xhr.withCredentials = true },
      })
      hlsRef.current = hls
      hls.loadSource(playbackUrl)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}) })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal)                           return
        if (playbackEndedRef.current)              return
        if (playbackCleaningRef.current)           return
        if (attachedKey !== playbackKeyRef.current) return
        const status = (data.response as any)?.code ?? 0
        if (status === 401) {
          toast.error('Sesión expirada — vuelve a seleccionar la grabación', { duration: 6000 })
        } else {
          toast.error('Error al reproducir la grabación', { duration: 5000 })
        }
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playbackUrl
      video.play().catch(() => {})
    }

    return () => { video.removeEventListener('ended', handleVideoEnded) }
  }, [playbackUrl, playbackMimeType])

  // ── handlePlay ─────────────────────────────────────────────────────────────

  const handlePlay = async (rec: RecordingWithCamera, opts?: { forceTranscode?: boolean }) => {
    const forceTranscode = opts?.forceTranscode ?? false
    const isSameRec = selectedRec?.id === rec.id && selectedRec?.cameraId === rec.cameraId

    if (isSameRec && playbackStatus === 'ready')    return
    if (isSameRec && playbackStatus === 'starting') return

    stopPlayback()
    setSelectedRec(rec)
    setStartDate(toLocalDatetimeString(new Date(rec.startTime)))
    setEndDate(toLocalDatetimeString(new Date(rec.endTime)))

    const myKey = `${Date.now()}-${Math.random()}`
    playbackKeyRef.current      = myKey
    playbackEndedRef.current    = false
    playbackCleaningRef.current = false
    setPlaybackMimeType(null)
    setVodProgress(null)
    setPlaybackLoading(true)
    setPlaybackStatus('starting')

    const videoEl        = videoRef.current ?? document.createElement('video')
    const canPlayHevcMp4 = !forceTranscode && (
      videoEl.canPlayType('video/mp4; codecs="hvc1"') !== '' ||
      videoEl.canPlayType('video/mp4; codecs="hev1"') !== ''
    )

    hevcCopyAttemptedRef.current = canPlayHevcMp4
    if (!forceTranscode) hevcRetryDoneRef.current = false

    console.info(`[recordings-ui] playback_start cameraId=${rec.cameraId} canPlayHevcMp4=${canPlayHevcMp4} forceTranscode=${forceTranscode}`)

    let sessionId: string | null = null

    try {
      const result = await apiPost<{
        status: string
        sessionId: string
        pollUrl: string
        expiresAt: string
        expectedDurationSec?: number
        url?: string
        mimeType?: string
        downloadUrl?: string
      }>('/recordings/playback', {
        cameraId:    rec.cameraId,
        startTime:   rec.startTime,
        endTime:     rec.endTime,
        playbackURI: rec.playbackURI,
        canPlayHevcMp4,
        forceTranscode,
      })

      if (playbackKeyRef.current !== myKey) return
      console.info(`[recordings-ui] playback_post_response sessionId=${result.sessionId} status=${result.status} expectedDurationSec=${result.expectedDurationSec}`)

      sessionId = result.sessionId
      setPlaybackSessionId(sessionId)
      playbackSessionIdRef.current = sessionId

      if (result.status === 'ready' && result.url) {
        setPlaybackMimeType(result.mimeType ?? null)
        setPlaybackUrl(result.url)
        setPlaybackStatus('ready')
        setPlaybackLoading(false)
        if (result.downloadUrl) setDownloadUrl(result.downloadUrl)
        return
      }

      const expectedSec    = result.expectedDurationSec ?? 60
      const dynamicPollMs  = Math.min(POLL_ABSOLUTE_MAX_MS, Math.max(180_000, expectedSec * 2500 + 60_000))

      let lastSeenOutTimeSec = -1
      let lastProgressTick   = Date.now()

      const pollStart = Date.now()
      while (Date.now() - pollStart < dynamicPollMs) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        if (playbackKeyRef.current !== myKey) return

        let statusRes: PlaybackStatusResponse
        try {
          statusRes = await apiGet<PlaybackStatusResponse>(
            `/recordings/playback/${sessionId}/status`, {}
          )
        } catch (pollErr: any) {
          if (playbackKeyRef.current !== myKey) return
          const httpStatus = pollErr?.response?.status
          if (httpStatus === 404) {
            toast.error('Sesión de reproducción no encontrada o expirada', { duration: 6000 })
          } else {
            toast.error('Error al consultar estado de reproducción', { duration: 5000 })
          }
          setPlaybackLoading(false)
          setPlaybackStatus('idle')
          return
        }

        if (playbackKeyRef.current !== myKey) return

        if (statusRes.status === 'ready') {
          setPlaybackMimeType(statusRes.mimeType ?? null)
          setPlaybackUrl(statusRes.url ?? null)
          setPlaybackStatus('ready')
          setPlaybackLoading(false)
          setVodProgress(null)
          if (statusRes.downloadUrl) setDownloadUrl(statusRes.downloadUrl)
          return
        }

        if (statusRes.status === 'error') {
          const code = statusRes.errorCode ?? ''
          const msg  = statusRes.error ?? 'Error desconocido'
          if (code === 'RECORDING_STREAM_STALLED') {
            toast.error(msg, { duration: 8000 })
          } else if (code === 'TRANSCODE_FAILED') {
            toast.error(`Error al generar video: ${msg}`, { duration: 8000 })
          } else {
            toast.error(msg || 'No se pudo cargar la grabación', { duration: 6000 })
          }
          setPlaybackLoading(false)
          setPlaybackStatus('idle')
          setVodProgress(null)
          return
        }

        const outSec = statusRes.outTimeSec ?? 0
        const expSec = statusRes.expectedDurationSec ?? expectedSec
        if (outSec > 0) {
          setVodProgress({ outTimeSec: outSec, expectedDurationSec: expSec })
          if (outSec > lastSeenOutTimeSec) {
            lastSeenOutTimeSec = outSec
            lastProgressTick   = Date.now()
          }
        }

        if (lastSeenOutTimeSec >= 0 && Date.now() - lastProgressTick > POLL_STALL_MS) {
          const pct = statusRes.progressPercent ?? 0
          if (pct >= 95) {
            console.info(`[recordings-ui] vod_client_stall_ignored_near_complete pct=${pct}`)
          } else {
            toast.error(
              `Sin progreso de video durante ${POLL_STALL_MS / 1000}s — el NVR puede haber cortado el stream`,
              { duration: 8000 },
            )
            setPlaybackLoading(false)
            setPlaybackStatus('idle')
            setVodProgress(null)
            return
          }
        }
      }

      if (playbackKeyRef.current !== myKey) return
      toast.error('Tiempo de generación superado (>15 min). Intenta de nuevo.', { duration: 8000 })
      setPlaybackLoading(false)
      setPlaybackStatus('idle')
      setVodProgress(null)

    } catch (err: any) {
      if (playbackKeyRef.current !== myKey) return
      const data   = err?.response?.data ?? {}
      const detail = data.detail ?? data.message ?? ''
      toast.error(detail || 'No se pudo iniciar la reproducción', { duration: 5000 })
      setPlaybackLoading(false)
      setPlaybackStatus('idle')
    }
  }

  handlePlayFnRef.current = handlePlay

  // ── Derived UI values ──────────────────────────────────────────────────────

  const vodPct = vodProgress && vodProgress.expectedDurationSec > 0
    ? Math.min(99, Math.round(vodProgress.outTimeSec / vodProgress.expectedDurationSec * 100))
    : null
  const isNearComplete = (vodPct ?? 0) >= 95
  const loadingLabel = isNearComplete
    ? `Finalizando video… ${vodPct}%`
    : vodPct !== null
      ? `Generando video… ${vodPct}%`
      : playbackStatus === 'transcoding'
        ? 'Transcodificando H.265 → H.264…'
        : 'Preparando grabación…'

  // ── Grid layout helpers ────────────────────────────────────────────────────

  const gridColsClass: Record<PlaybackLayout, string> = {
    '1x1': 'grid-cols-1',
    '2x2': 'grid-cols-2',
    '3x3': 'grid-cols-3',
    '4x4': 'grid-cols-4',
  }
  const slotCount: Record<PlaybackLayout, number> = { '1x1': 1, '2x2': 4, '3x3': 9, '4x4': 16 }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full bg-surface-900 overflow-hidden">

      {/* ── Left: camera tree ─────────────────────────────────────────────── */}
      <aside className="w-56 flex-shrink-0 border-r border-surface-700 flex flex-col overflow-hidden">
        <RecordingCameraTree
          nvrs={nvrs}
          cameras={cameras}
          selectedCameras={selectedCameras}
          nvrErrors={nvrErrors}
          onToggleCamera={toggleCamera}
          onToggleNVR={toggleNVR}
          onSelectAll={selectAll}
          onClearAll={clearAll}
        />
      </aside>

      {/* ── Right: main area ──────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Search bar */}
        <RecordingSearchBar
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onSearch={handleSearch}
          isSearching={isSearching}
          cameraCount={selectedCameras.size}
          layout={layout}
          onLayoutChange={setLayout}
        />

        {/* NVR error banners */}
        {nvrErrors.length > 0 && (
          <div className="flex-shrink-0 space-y-1 px-3 py-2 border-b border-surface-700 max-h-32 overflow-y-auto">
            {nvrErrors.map(err => (
              <div key={err.nvrId} className={clsx(
                'flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs',
                err.code === 'ISAPI_UNSUPPORTED' ? 'bg-amber-900/15 border-amber-700/40 text-amber-300'
                  : err.code === 'NVR_OFFLINE'   ? 'bg-red-900/15 border-red-700/40 text-red-300'
                  : 'bg-surface-800 border-surface-700 text-surface-400'
              )}>
                {err.code === 'ISAPI_UNSUPPORTED' ? <AlertTriangle size={12} className="flex-shrink-0" />
                  : err.code === 'NVR_OFFLINE'    ? <XCircle size={12} className="flex-shrink-0" />
                  : <Info size={12} className="flex-shrink-0" />
                }
                <span className="font-medium flex-shrink-0">{err.nvrName}</span>
                <span className="text-[10px] opacity-70 truncate">
                  {err.code === 'ISAPI_UNSUPPORTED' && 'No soporta ISAPI'}
                  {err.code === 'AUTH_FAILED' && 'Credenciales inválidas'}
                  {err.code === 'NVR_OFFLINE' && 'NVR no accesible'}
                  {err.code === 'UNKNOWN' && err.message}
                </span>
                <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                  {err.playbackWebUrl && (
                    <a href={err.playbackWebUrl} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-200 transition-colors">
                      <ExternalLink size={9} /> Web NVR
                    </a>
                  )}
                  <button
                    onClick={() => handleRevalidate(err.nvrId)}
                    disabled={revalidating.has(err.nvrId)}
                    className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-200 transition-colors disabled:opacity-50"
                  >
                    {revalidating.has(err.nvrId)
                      ? <Loader2 size={9} className="animate-spin" />
                      : <RefreshCw size={9} />
                    }
                    Revalidar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Central: video grid + recordings list ─────────────────────── */}
        <div className="flex-1 flex min-h-0 overflow-hidden">

          {/* Video grid */}
          <div className="flex-1 min-w-0 bg-black">
            <div className={clsx('grid h-full gap-0.5 bg-surface-800', gridColsClass[layout])}>
              {Array.from({ length: slotCount[layout] }).map((_, idx) => {
                const isActive = idx === 0

                return (
                  <div
                    key={idx}
                    className={clsx(
                      'relative flex flex-col overflow-hidden',
                      isActive ? 'bg-black' : 'bg-surface-900'
                    )}
                  >
                    {/* Slot label bar */}
                    <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-1.5 px-2 py-1 bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
                      <span className="text-[9px] text-surface-400 font-medium">
                        {isActive && selectedRec
                          ? `${selectedRec.nvrName} · ${selectedRec.cameraName}`
                          : `Canal ${idx + 1}`
                        }
                      </span>
                      {isActive && playbackStatus === 'ready' && (
                        <span className="text-[8px] px-1 py-0.5 rounded bg-green-700/60 text-green-300">●  En vivo</span>
                      )}
                    </div>

                    {/* Active slot: real video + loading overlay */}
                    {isActive ? (
                      <>
                        <video
                          ref={videoRef}
                          controls
                          controlsList="nodownload"
                          className={clsx('absolute inset-0 w-full h-full', !playbackUrl && 'hidden')}
                          style={{ background: '#000' }}
                        />
                        {!playbackUrl && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center">
                            {playbackLoading ? (
                              <>
                                <Loader2 size={24} className="text-brand-400 mb-2 animate-spin" />
                                <p className="text-xs text-surface-300">{loadingLabel}</p>
                                {vodPct !== null && (
                                  <div className="w-40 mt-2 bg-surface-700 rounded-full h-1.5">
                                    <div
                                      className="bg-brand-500 h-1.5 rounded-full transition-all duration-500"
                                      style={{ width: `${vodPct}%` }}
                                    />
                                  </div>
                                )}
                              </>
                            ) : (
                              <>
                                <Play size={28} className="text-surface-700 mb-2" />
                                <p className="text-[11px] text-surface-600">
                                  {recordings.length > 0
                                    ? 'Selecciona una grabación'
                                    : 'Busca grabaciones primero'
                                  }
                                </p>
                              </>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      /* Inactive slot placeholder */
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                        <Play size={16} className="text-surface-800" />
                        <span className="text-[9px] text-surface-700">Vacío</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Recordings list sidebar */}
          <div className="w-52 flex-shrink-0 border-l border-surface-700 flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-surface-700 flex items-center gap-1.5 flex-shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-surface-500">
                Grabaciones
              </span>
              {recordings.length > 0 && (
                <span className="ml-auto text-[10px] text-surface-600 tabular-nums">
                  {recordings.length}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-surface-800">
              {recordings.length === 0 ? (
                <div className="py-10 flex flex-col items-center gap-1.5">
                  <Play size={18} className="text-surface-700" />
                  <p className="text-[10px] text-surface-600 text-center px-3">
                    {isSearching ? 'Buscando…' : 'Sin resultados'}
                  </p>
                </div>
              ) : (
                recordings.map(rec => {
                  const isSelected = selectedRec?.id === rec.id && selectedRec?.cameraId === rec.cameraId
                  return (
                    <button
                      key={`${rec.cameraId}-${rec.id}`}
                      onClick={() => handlePlay(rec)}
                      className={clsx(
                        'w-full text-left px-3 py-2 transition-colors',
                        isSelected
                          ? 'bg-brand-900/30 border-l-2 border-brand-500'
                          : 'hover:bg-surface-800/60 border-l-2 border-transparent'
                      )}
                    >
                      <div className="text-[10px] text-surface-400 truncate">
                        {rec.nvrName} · {rec.cameraName}
                      </div>
                      <div className="text-xs text-surface-200 mt-0.5">
                        {format(new Date(rec.startTime), 'HH:mm:ss')}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] text-surface-500 flex items-center gap-0.5">
                          <Clock size={9} /> {formatDuration(rec.startTime, rec.endTime)}
                        </span>
                        {rec.size > 0 && (
                          <span className="text-[10px] text-surface-600">{formatSize(rec.size)}</span>
                        )}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {/* ── Timeline ──────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 border-t border-surface-700 bg-surface-900">
          <RecordingTimeline
            recordings={recordings}
            selectedRec={selectedRec}
            startDate={startDate}
            endDate={endDate}
            onSelectRecording={handlePlay}
          />
        </div>

        {/* ── Controls toolbar ──────────────────────────────────────────── */}
        {playbackStatus === 'ready' && (
          <div className="flex-shrink-0 border-t border-surface-700">
            {/* Download row */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-surface-800/30">
              <span className="text-[10px] text-surface-500 truncate max-w-[50%]">
                {selectedRec
                  ? `${selectedRec.nvrName} · ${selectedRec.cameraName} — ${format(new Date(selectedRec.startTime), 'dd/MM HH:mm')}`
                  : ''
                }
              </span>
              {downloadUrl && (
                <a
                  href={downloadUrl}
                  download
                  className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md bg-surface-700 text-surface-300 hover:bg-surface-600 hover:text-surface-100 transition-colors flex-shrink-0"
                >
                  <Download size={11} />
                  Descargar MP4
                </a>
              )}
            </div>
            <RecordingPlaybackControls
              key={playbackSessionId ?? 'idle'}
              videoRef={videoRef}
            />
          </div>
        )}
      </div>
    </div>
  )
}
