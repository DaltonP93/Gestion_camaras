// src/pages/RecordingsPage.tsx
import { useEffect, useState, useMemo, useRef } from 'react'
import {
  Search, Play, Download, Calendar, Clock, ChevronDown, CheckSquare, Square,
  AlertTriangle, RefreshCw, ExternalLink, XCircle, Loader2, Info,
} from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost, apiGet, apiDelete } from '@/lib/api'
import { format, subDays, subHours, startOfDay, endOfDay } from 'date-fns'
import { clsx } from 'clsx'
import type { Recording, Camera } from '@/types'
import toast from 'react-hot-toast'
import Hls from 'hls.js'

interface RecordingWithCamera extends Recording {
  cameraId: string
  cameraName: string
  nvrName: string
}

interface NvrSearchError {
  nvrId: string
  nvrName: string
  cameraIds: string[]
  code: 'ISAPI_UNSUPPORTED' | 'AUTH_FAILED' | 'NVR_OFFLINE' | 'UNKNOWN'
  message: string
  playbackWebUrl?: string | null
}

interface RecordingCapabilities {
  nvrId: string
  recordingProvider: string
  supportsIsapiRecording: boolean | null
  playbackWebUrl: string | null
  recordingCapabilityError: string | null
}

interface PlaybackStatusResponse {
  status:     'starting' | 'ready' | 'error'
  url:        string
  hlsReady:   boolean
  transcoded: boolean
  errorCode?: string
  error?:     string
  stderrTail?: string
}

function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function classifyError(err: any): 'ISAPI_UNSUPPORTED' | 'AUTH_FAILED' | 'NVR_OFFLINE' | 'UNKNOWN' {
  const msg = (err?.response?.data?.message || err?.message || '').toLowerCase()
  if (msg.includes('isapi') || msg.includes('no soporta') || msg.includes('unsupported')) return 'ISAPI_UNSUPPORTED'
  if (msg.includes('401') || msg.includes('auth') || msg.includes('credencial')) return 'AUTH_FAILED'
  if (msg.includes('offline') || msg.includes('unreachable') || msg.includes('econnrefused')) return 'NVR_OFFLINE'
  return 'UNKNOWN'
}

const POLL_INTERVAL_MS  = 1_000
const POLL_MAX_MS       = 65_000

export function RecordingsPage() {
  const { nvrs, cameras, loadNVRs, loadCameras } = useCameraStore()
  const [selectedNVR, setSelectedNVR] = useState<string>('all')
  const [selectedCameras, setSelectedCameras] = useState<Set<string>>(new Set())
  const [startDate, setStartDate] = useState(toLocalDatetimeString(subHours(new Date(), 1)))
  const [endDate, setEndDate]     = useState(toLocalDatetimeString(new Date()))
  const [recordings, setRecordings] = useState<RecordingWithCamera[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [playbackSessionId, setPlaybackSessionId] = useState<string | null>(null)
  const [playbackLoading, setPlaybackLoading] = useState(false)
  const [playbackStatus, setPlaybackStatus] = useState<'idle' | 'starting' | 'transcoding' | 'ready'>('idle')
  const [selectedRec, setSelectedRec] = useState<RecordingWithCamera | null>(null)
  const videoRef             = useRef<HTMLVideoElement>(null)
  const hlsRef               = useRef<Hls | null>(null)
  // Stale-session guard: each handlePlay call gets a unique key.
  // HLS attachment and error toasts only fire if key still matches.
  const playbackKeyRef       = useRef<string | null>(null)
  // Mirror of playbackSessionId in a ref so stopPlayback can read it in async closures.
  const playbackSessionIdRef = useRef<string | null>(null)
  const startDateRef  = useRef<HTMLInputElement>(null)
  const endDateRef    = useRef<HTMLInputElement>(null)
  const [showCameraList, setShowCameraList] = useState(false)
  const [nvrErrors, setNvrErrors] = useState<NvrSearchError[]>([])
  const [revalidating, setRevalidating] = useState<Set<string>>(new Set())
  const [nvrCaps, setNvrCaps] = useState<Map<string, RecordingCapabilities>>(new Map())
  const [playbackTranscoding, setPlaybackTranscoding] = useState(false)

  useEffect(() => {
    loadNVRs()
    loadCameras()
  }, [])

  const filteredCameras = useMemo(() =>
    cameras.filter(c => selectedNVR === 'all' ? true : c.nvrId === selectedNVR),
    [cameras, selectedNVR]
  )

  const camerasByNVR = useMemo(() => {
    const map = new Map<string, { nvrName: string; cameras: Camera[] }>()
    filteredCameras.forEach((cam) => {
      const nvrName = cam.nvr?.name || 'Sin NVR'
      if (!map.has(cam.nvrId)) map.set(cam.nvrId, { nvrName, cameras: [] })
      map.get(cam.nvrId)!.cameras.push(cam)
    })
    return map
  }, [filteredCameras])

  useEffect(() => { setSelectedCameras(new Set()) }, [selectedNVR])

  const toggleCamera = (cameraId: string) => {
    setSelectedCameras(prev => {
      const next = new Set(prev)
      next.has(cameraId) ? next.delete(cameraId) : next.add(cameraId)
      return next
    })
  }

  const toggleAllInNVR = (nvrId: string) => {
    const group = camerasByNVR.get(nvrId)
    if (!group) return
    const allIds = group.cameras.map(c => c.id)
    const allSelected = allIds.every(id => selectedCameras.has(id))
    setSelectedCameras(prev => {
      const next = new Set(prev)
      if (allSelected) allIds.forEach(id => next.delete(id))
      else allIds.forEach(id => next.add(id))
      return next
    })
  }

  const selectAll = () => setSelectedCameras(new Set(filteredCameras.map(c => c.id)))
  const clearAll  = () => setSelectedCameras(new Set())

  const setQuick = (from: Date, to: Date) => {
    setStartDate(toLocalDatetimeString(from))
    setEndDate(toLocalDatetimeString(to))
  }

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
      cameraIds.map((cameraId) =>
        apiGet<{ recordings: Recording[] }>('/recordings/search', {
          cameraId,
          startTime: new Date(startDate).toISOString(),
          endTime: new Date(endDate).toISOString(),
        }).then((res) => {
          const cam = cameras.find(c => c.id === cameraId)
          return (res?.recordings ?? []).map((r): RecordingWithCamera => ({
            ...r,
            cameraId,
            cameraName: cam?.name || 'Desconocida',
            nvrName: cam?.nvr?.name || '',
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
        const nvrInfo = camToNvr.get(cameraId)
        if (nvrInfo) {
          if (!errsByNvr.has(nvrInfo.nvrId)) {
            errsByNvr.set(nvrInfo.nvrId, {
              nvrId: nvrInfo.nvrId,
              nvrName: nvrInfo.nvrName,
              cameraIds: [],
              code: classifyError(r.reason),
              message: r.reason?.response?.data?.message ?? r.reason?.message ?? 'Error desconocido',
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

  // Stop any active HLS instance and release the MediaMTX recording path
  const stopPlayback = () => {
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
  }

  // Sync ref whenever state changes
  useEffect(() => { playbackSessionIdRef.current = playbackSessionId }, [playbackSessionId])

  // Clean up HLS + session on unmount
  useEffect(() => stopPlayback, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Attach HLS.js whenever playbackUrl changes
  useEffect(() => {
    const video = videoRef.current
    if (!video || !playbackUrl) return
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }

    // Capture key at attachment time — stale checks compare against this
    const attachedKey = playbackKeyRef.current

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
        if (!data.fatal) return
        if (attachedKey !== playbackKeyRef.current) return  // stale session
        const status = (data.response as any)?.code ?? 0
        if (status === 401) {
          toast.error('Sesión expirada — vuelve a seleccionar la grabación', { duration: 6000 })
        } else {
          toast.error('Error al reproducir la grabación', { duration: 5000 })
        }
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = playbackUrl
      video.play().catch(() => {})
    }
  }, [playbackUrl])

  const handlePlay = async (rec: RecordingWithCamera) => {
    stopPlayback()
    setSelectedRec(rec)
    setStartDate(toLocalDatetimeString(new Date(rec.startTime)))
    setEndDate(toLocalDatetimeString(new Date(rec.endTime)))

    const myKey = `${Date.now()}-${Math.random()}`
    playbackKeyRef.current = myKey
    setPlaybackLoading(true)
    setPlaybackStatus('starting')

    let sessionId: string | null = null

    try {
      // POST returns immediately — backend starts background job
      const result = await apiPost<{
        status: string
        sessionId: string
        url: string
        pollUrl: string
        transcoded: boolean
        expiresAt: string
      }>('/recordings/playback', {
        cameraId:    rec.cameraId,
        startTime:   rec.startTime,
        endTime:     rec.endTime,
        playbackURI: rec.playbackURI,
      })

      // Stale check: user may have clicked a different recording before POST returned
      if (playbackKeyRef.current !== myKey) return

      sessionId = result.sessionId
      setPlaybackSessionId(sessionId)
      playbackSessionIdRef.current = sessionId

      if (result.transcoded) setPlaybackStatus('transcoding')

      // Poll /status until ready or error (max 65s, 1s interval)
      const pollStart = Date.now()
      while (Date.now() - pollStart < POLL_MAX_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        if (playbackKeyRef.current !== myKey) return  // user cancelled

        let statusRes: PlaybackStatusResponse
        try {
          statusRes = await apiGet<PlaybackStatusResponse>(
            `/recordings/playback/${sessionId}/status`, {}
          )
        } catch (pollErr: any) {
          if (playbackKeyRef.current !== myKey) return
          const code = pollErr?.response?.data?.status
          if (code === 'error' || pollErr?.response?.status === 404) {
            toast.error('Sesión de reproducción no encontrada', { duration: 6000 })
          } else {
            toast.error('Error al consultar estado de reproducción', { duration: 5000 })
          }
          setPlaybackLoading(false)
          setPlaybackStatus('idle')
          return
        }

        if (playbackKeyRef.current !== myKey) return

        if (statusRes.status === 'ready') {
          setPlaybackUrl(statusRes.url)
          setPlaybackStatus('ready')
          setPlaybackLoading(false)
          return
        }

        if (statusRes.status === 'error') {
          const code = statusRes.errorCode ?? ''
          const msg  = statusRes.error ?? 'Error desconocido'
          if (code === 'HLS_TIMEOUT') {
            toast.error(`MediaMTX no conectó al NVR (timeout)\n${msg}`, { duration: 8000 })
          } else if (code === 'MEDIAMTX_ERROR') {
            toast.error(`Error en MediaMTX: ${msg}`, { duration: 6000 })
          } else {
            toast.error(msg || 'No se pudo cargar la grabación', { duration: 6000 })
          }
          setPlaybackLoading(false)
          setPlaybackStatus('idle')
          return
        }

        // Still 'starting' — update transcoding status from response
        if (statusRes.transcoded) setPlaybackStatus('transcoding')
      }

      // Poll timeout (client-side safety net — backend has its own 60s timeout)
      if (playbackKeyRef.current !== myKey) return
      toast.error('Tiempo de espera agotado. Intenta de nuevo.', { duration: 7000 })
      setPlaybackLoading(false)
      setPlaybackStatus('idle')

    } catch (err: any) {
      if (playbackKeyRef.current !== myKey) return
      const data   = err?.response?.data ?? {}
      const code   = data.code ?? ''
      const detail = data.detail ?? data.message ?? ''
      if (code === 'MEDIAMTX_ERROR') {
        toast.error(`Error en MediaMTX: ${detail}`, { duration: 6000 })
      } else {
        toast.error(detail || 'No se pudo iniciar la reproducción', { duration: 5000 })
      }
      setPlaybackLoading(false)
      setPlaybackStatus('idle')
    }
  }

  const formatDuration = (start: string, end: string) => {
    const diff = new Date(end).getTime() - new Date(start).getTime()
    const mins = Math.floor(diff / 60000)
    const secs = Math.floor((diff % 60000) / 1000)
    return `${mins}:${String(secs).padStart(2, '0')}`
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '—'
    if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
    return `${(bytes / 1048576).toFixed(0)} MB`
  }

  const selectedLabel = selectedCameras.size === 0
    ? 'Seleccionar cámaras'
    : `${selectedCameras.size} cámara${selectedCameras.size > 1 ? 's' : ''} seleccionada${selectedCameras.size > 1 ? 's' : ''}`

  const triggerDatePicker = (ref: React.RefObject<HTMLInputElement | null>) => {
    const el = ref.current
    if (!el) return
    try { ;(el as any).showPicker?.() } catch { el.focus() }
  }

  const loadingLabel = playbackStatus === 'transcoding'
    ? 'Transcodificando H.265 → H.264…'
    : 'Preparando grabación…'

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <h2 className="text-base font-semibold text-surface-100">Grabaciones</h2>

      {/* Filtros */}
      <div className="card p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">

          <div>
            <label className="label">NVR</label>
            <div className="relative">
              <select
                value={selectedNVR}
                onChange={(e) => setSelectedNVR(e.target.value)}
                className="input appearance-none pr-8"
              >
                <option value="all">Todos los NVRs</option>
                {nvrs.map((nvr) => (
                  <option key={nvr.id} value={nvr.id}>{nvr.name}</option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
            </div>
          </div>

          <div>
            <label className="label">Cámaras</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowCameraList(v => !v)}
                className="input text-left flex items-center justify-between w-full"
              >
                <span className={clsx('truncate', selectedCameras.size === 0 && 'text-surface-500')}>
                  {selectedLabel}
                </span>
                <ChevronDown size={12} className="text-surface-400 flex-shrink-0 ml-2" />
              </button>

              {showCameraList && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-surface-800 border border-surface-600 rounded-lg shadow-xl max-h-72 overflow-y-auto">
                  <div className="sticky top-0 bg-surface-800 border-b border-surface-700 px-3 py-2 flex items-center gap-2">
                    <button onClick={selectAll} className="text-xs text-brand-400 hover:text-brand-300">Seleccionar todo</button>
                    <span className="text-surface-600">·</span>
                    <button onClick={clearAll} className="text-xs text-surface-400 hover:text-surface-200">Limpiar</button>
                    <span className="ml-auto text-xs text-surface-500">{selectedCameras.size} sel.</span>
                  </div>

                  {[...camerasByNVR.entries()].map(([nvrId, { nvrName, cameras: cams }]) => {
                    const allSel  = cams.every(c => selectedCameras.has(c.id))
                    const someSel = cams.some(c => selectedCameras.has(c.id))
                    const isUnsupported = nvrErrors.some(e => e.nvrId === nvrId && e.code === 'ISAPI_UNSUPPORTED')
                    return (
                      <div key={nvrId}>
                        <button
                          onClick={() => toggleAllInNVR(nvrId)}
                          className="w-full flex items-center gap-2 px-3 py-2 bg-surface-750 hover:bg-surface-700 transition-colors text-left"
                        >
                          {allSel ? <CheckSquare size={13} className="text-brand-400 flex-shrink-0" />
                            : someSel ? <CheckSquare size={13} className="text-brand-400/50 flex-shrink-0" />
                            : <Square size={13} className="text-surface-500 flex-shrink-0" />}
                          <span className="text-xs font-medium text-surface-200 uppercase tracking-wide">{nvrName}</span>
                          {isUnsupported && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-500 ml-1">sin ISAPI</span>
                          )}
                          <span className="ml-auto text-xs text-surface-500">{cams.length}ch</span>
                        </button>
                        {cams.map((cam) => (
                          <button
                            key={cam.id}
                            onClick={() => toggleCamera(cam.id)}
                            className="w-full flex items-center gap-2 pl-6 pr-3 py-1.5 hover:bg-surface-700/50 transition-colors text-left"
                          >
                            {selectedCameras.has(cam.id)
                              ? <CheckSquare size={12} className="text-brand-400 flex-shrink-0" />
                              : <Square size={12} className="text-surface-600 flex-shrink-0" />}
                            <span className="text-xs text-surface-300 truncate">{cam.name}</span>
                            <span className={clsx('ml-auto text-xs flex-shrink-0', cam.online ? 'text-green-500' : 'text-surface-600')}>
                              {cam.online ? '●' : '○'}
                            </span>
                          </button>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="label">Desde</label>
            <div className="relative">
              <input
                ref={startDateRef}
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="input pr-8"
              />
              <button
                type="button"
                onClick={() => triggerDatePicker(startDateRef)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-200 transition-colors"
                tabIndex={-1}
              >
                <Calendar size={14} />
              </button>
            </div>
          </div>

          <div>
            <label className="label">Hasta</label>
            <div className="relative">
              <input
                ref={endDateRef}
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="input pr-8"
              />
              <button
                type="button"
                onClick={() => triggerDatePicker(endDateRef)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-200 transition-colors"
                tabIndex={-1}
              >
                <Calendar size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-2 flex-wrap flex-1">
            {[
              { label: 'Última hora', fn: () => setQuick(subHours(new Date(), 1), new Date()) },
              { label: 'Hoy',         fn: () => setQuick(startOfDay(new Date()), new Date()) },
              { label: 'Ayer',        fn: () => setQuick(startOfDay(subDays(new Date(), 1)), endOfDay(subDays(new Date(), 1))) },
              { label: 'Últimos 7d',  fn: () => setQuick(startOfDay(subDays(new Date(), 7)), new Date()) },
            ].map(({ label, fn }) => (
              <button key={label} onClick={fn}
                className="text-xs px-2.5 py-1 rounded-md bg-surface-700 text-surface-400 hover:text-surface-200 hover:bg-surface-600 transition-colors"
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={handleSearch}
            disabled={isSearching || selectedCameras.size === 0}
            className="btn-primary justify-center min-w-[120px]"
          >
            {isSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {isSearching ? 'Buscando...' : 'Buscar'}
          </button>
        </div>
      </div>

      {/* Click-away for camera dropdown */}
      {showCameraList && (
        <div className="fixed inset-0 z-40" onClick={() => setShowCameraList(false)} />
      )}

      {/* Per-NVR error banners */}
      {nvrErrors.map((err) => (
        <div key={err.nvrId} className={clsx(
          'flex items-start gap-3 p-3 rounded-lg border text-sm',
          err.code === 'ISAPI_UNSUPPORTED'
            ? 'bg-amber-900/15 border-amber-700/40 text-amber-300'
            : err.code === 'NVR_OFFLINE'
              ? 'bg-red-900/15 border-red-700/40 text-red-300'
              : 'bg-surface-800 border-surface-700 text-surface-400'
        )}>
          {err.code === 'ISAPI_UNSUPPORTED'
            ? <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            : err.code === 'NVR_OFFLINE'
              ? <XCircle size={16} className="flex-shrink-0 mt-0.5" />
              : <Info size={16} className="flex-shrink-0 mt-0.5" />
          }
          <div className="flex-1 min-w-0">
            <div className="font-medium">{err.nvrName}</div>
            <div className="text-xs opacity-80 mt-0.5">
              {err.code === 'ISAPI_UNSUPPORTED' && 'Este NVR no soporta búsqueda de grabaciones vía ISAPI'}
              {err.code === 'AUTH_FAILED' && 'Credenciales inválidas para acceder a grabaciones'}
              {err.code === 'NVR_OFFLINE' && 'NVR no accesible'}
              {err.code === 'UNKNOWN' && err.message}
              {' · '}{err.cameraIds.length} cámara{err.cameraIds.length !== 1 ? 's' : ''} omitida{err.cameraIds.length !== 1 ? 's' : ''}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {err.playbackWebUrl && (
              <a
                href={err.playbackWebUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-surface-700 hover:bg-surface-600 text-surface-200 transition-colors"
              >
                <ExternalLink size={11} /> Abrir web NVR
              </a>
            )}
            <button
              onClick={() => handleRevalidate(err.nvrId)}
              disabled={revalidating.has(err.nvrId)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-surface-700 hover:bg-surface-600 text-surface-200 transition-colors disabled:opacity-50"
            >
              {revalidating.has(err.nvrId) ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Revalidar
            </button>
          </div>
        </div>
      ))}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Lista de grabaciones */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-600 flex items-center justify-between">
            <h3 className="text-sm font-medium text-surface-100">
              Resultados
              {recordings.length > 0 && (
                <span className="ml-2 text-xs text-surface-400">{recordings.length} grabaciones</span>
              )}
            </h3>
          </div>
          <div className="divide-y divide-surface-700 max-h-[500px] overflow-auto">
            {recordings.length === 0 ? (
              <div className="py-12 text-center">
                <Calendar size={24} className="text-surface-600 mx-auto mb-2" />
                <p className="text-sm text-surface-500">
                  {isSearching ? 'Buscando...' : 'Realiza una búsqueda para ver grabaciones'}
                </p>
              </div>
            ) : (
              recordings.map((rec) => (
                <div
                  key={`${rec.cameraId}-${rec.id}`}
                  className={clsx(
                    'px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-surface-700/50 transition-colors',
                    selectedRec?.id === rec.id && selectedRec?.cameraId === rec.cameraId && 'bg-surface-700/80'
                  )}
                  onClick={() => handlePlay(rec)}
                >
                  <div className="w-8 h-8 rounded-lg bg-brand-900/50 flex items-center justify-center flex-shrink-0">
                    <Play size={12} className="text-brand-400 fill-brand-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-xs text-surface-300 font-medium truncate">
                        {rec.nvrName} · {rec.cameraName}
                      </span>
                      {rec.type && rec.type !== 'video/mp4' && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-surface-700 text-surface-400 uppercase tracking-wide flex-shrink-0">
                          {rec.type.replace('video/', '').replace('//recordType.meta.std-cgi.com/', '')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-surface-100">
                      {format(new Date(rec.startTime), 'dd/MM/yyyy HH:mm:ss')}
                    </div>
                    <div className="text-xs text-surface-400 flex items-center gap-2 mt-0.5">
                      <span className="flex items-center gap-1">
                        <Clock size={10} /> {formatDuration(rec.startTime, rec.endTime)}
                      </span>
                      {rec.size > 0 && <span>{formatSize(rec.size)}</span>}
                    </div>
                  </div>
                  <button
                    className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-surface-600 transition-colors flex-shrink-0"
                    title="Descargar"
                    onClick={(e) => { e.stopPropagation(); toast('Descarga no disponible en demo', { icon: 'ℹ️' }) }}
                  >
                    <Download size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Reproductor */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-600">
            <h3 className="text-sm font-medium text-surface-100 truncate">
              {selectedRec
                ? `${selectedRec.nvrName} · ${selectedRec.cameraName} — ${format(new Date(selectedRec.startTime), 'dd/MM HH:mm')}`
                : 'Reproductor'}
            </h3>
          </div>
          <div className="aspect-video bg-surface-900 flex items-center justify-center relative">
            {/* HLS video player — always rendered so ref is stable */}
            <video
              ref={videoRef}
              controls
              className={clsx('w-full h-full', !playbackUrl && 'hidden')}
              style={{ background: '#000' }}
            />
            {/* Placeholder when no playback active */}
            {!playbackUrl && (
              <div className="text-center absolute inset-0 flex flex-col items-center justify-center">
                {playbackLoading ? (
                  <>
                    <Loader2 size={24} className="text-brand-400 mx-auto mb-2 animate-spin" />
                    <p className="text-sm text-surface-300">{loadingLabel}</p>
                    {playbackStatus === 'transcoding' && (
                      <p className="text-xs text-surface-500 mt-1">Puede tardar unos segundos</p>
                    )}
                  </>
                ) : (
                  <>
                    <Play size={32} className="text-surface-700 mx-auto mb-2" />
                    <p className="text-xs text-surface-500">
                      {recordings.length > 0 ? 'Selecciona una grabación para reproducir' : 'Busca grabaciones primero'}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
