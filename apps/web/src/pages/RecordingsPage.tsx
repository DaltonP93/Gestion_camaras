// src/pages/RecordingsPage.tsx
import { useEffect, useState, useMemo, useRef } from 'react'
import {
  Play, Clock, AlertTriangle, RefreshCw, ExternalLink,
  XCircle, Loader2, Info, Download, Video,
} from 'lucide-react'
// Clock kept for slot overlays
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost, apiGet, apiDelete } from '@/lib/api'
import { format, subHours } from 'date-fns'
import { clsx } from 'clsx'
import type { Recording } from '@/types'
import toast from 'react-hot-toast'
import { RecordingPlaybackControls } from '@/components/RecordingPlaybackControls'
import { RecordingCameraTree }  from '@/components/recordings/RecordingCameraTree'
import { RecordingSearchBar }   from '@/components/recordings/RecordingSearchBar'
import { RecordingTimeline }    from '@/components/recordings/RecordingTimeline'
import type {
  RecordingWithCamera, NvrSearchError, PlaybackLayout,
  PlaybackSlot,
} from '@/components/recordings/types'
import { emptySlot } from '@/components/recordings/types'

// ─── Local interfaces ─────────────────────────────────────────────────────────

interface PlaybackStatusResponse {
  status:               'starting' | 'ready' | 'error'
  url?:                 string
  mimeType?:            string
  transcoded?:          boolean
  errorCode?:           string
  error?:               string
  downloadUrl?:         string
  outTimeSec?:          number
  expectedDurationSec?: number
  progressPercent?:     number
}

interface RecordingCapabilities {
  nvrId: string
  recordingProvider: string
  supportsIsapiRecording: boolean | null
  playbackWebUrl: string | null
  recordingCapabilityError: string | null
}

interface DownloadJob {
  sessionId: string
  status: 'generating' | 'ready' | 'error'
  progress: { outTimeSec: number; expectedDurationSec: number } | null
  downloadUrl: string | null
  errorMsg: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Display NVR timestamps in UTC — NVRs store wall-clock time as UTC.
// Shifting by the local timezone offset makes date-fns render UTC components
// correctly regardless of the browser's local timezone.
function nvrTimeMs(epochMs: number): number {
  return epochMs + new Date(epochMs).getTimezoneOffset() * 60_000
}
function formatNvrTime(isoOrMs: string | number | Date, fmt: string): string {
  const ms = isoOrMs instanceof Date ? isoOrMs.getTime()
    : typeof isoOrMs === 'number' ? isoOrMs
    : new Date(isoOrMs as string).getTime()
  return format(new Date(nvrTimeMs(ms)), fmt)
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

const POLL_INTERVAL_MS     = 1_000
const POLL_ABSOLUTE_MAX_MS = 15 * 60 * 1_000
const POLL_STALL_MS        = 45_000

const SLOT_COUNT: Record<PlaybackLayout, number> = { '1x1': 1, '2x2': 4, '3x3': 9, '4x4': 16 }
const GRID_COLS:  Record<PlaybackLayout, string> = {
  '1x1': 'grid-cols-1',
  '2x2': 'grid-cols-2',
  '3x3': 'grid-cols-3',
  '4x4': 'grid-cols-4',
}

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

  // ── Multi-slot state ───────────────────────────────────────────────────────
  const [slots, setSlots]                   = useState<PlaybackSlot[]>([emptySlot(0)])
  const [activeSlotIndex, setActiveSlotIndex] = useState(0)

  // ── Global playback state ──────────────────────────────────────────────────
  const [globalPlaying, setGlobalPlaying]           = useState(false)
  const [globalPlaybackRate, setGlobalPlaybackRate] = useState(1)
  const [globalPlaybackTime, setGlobalPlaybackTime] = useState<Date | null>(null)

  // ── Background MP4 download job (independent of slot preview state) ────────
  const [downloadJob, setDownloadJob]   = useState<DownloadJob | null>(null)
  const downloadJobKeyRef               = useRef<string | null>(null)

  // ── Refs ───────────────────────────────────────────────────────────────────
  const videoRefs       = useRef<{ [k: number]: HTMLVideoElement | null }>({})
  const slotKeysRef     = useRef<{ [k: number]: string | null }>({})
  const hevcAttemptedRef = useRef<{ [k: number]: boolean }>({})
  const hevcRetryRef    = useRef<{ [k: number]: boolean }>({})
  const slotsRef        = useRef<PlaybackSlot[]>([])
  const globalPlayingRef     = useRef(false)
  const globalPlaybackRateRef = useRef(1)
  const videoCleanupRef = useRef<{ [k: number]: (() => void) | null }>({})
  const loadInSlotRef         = useRef<(si: number, rec: RecordingWithCamera, opts?: { forceTranscode?: boolean }) => void>(() => {})
  const startPreviewInSlotRef = useRef<(si: number, rec: RecordingWithCamera, playheadTime: Date, opts?: { forceTranscode?: boolean }) => void>(() => {})
  const previewStartTimesRef  = useRef<{ [k: number]: number | null }>({})
  const previewRetriedRef     = useRef<{ [k: number]: boolean }>({})

  // Keep refs in sync
  useEffect(() => { slotsRef.current = slots }, [slots])
  useEffect(() => { globalPlayingRef.current = globalPlaying }, [globalPlaying])
  useEffect(() => { globalPlaybackRateRef.current = globalPlaybackRate }, [globalPlaybackRate])

  // Cancel background download job when active slot or recording changes
  useEffect(() => {
    downloadJobKeyRef.current = null
    setDownloadJob(null)
  }, [activeSlotIndex, slots[activeSlotIndex]?.recording?.id])

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  useEffect(() => { loadNVRs(); loadCameras() }, [])

  // ── Resize slots when layout changes ──────────────────────────────────────
  useEffect(() => {
    const count = SLOT_COUNT[layout]
    setSlots(prev => {
      if (prev.length === count) return prev
      if (prev.length > count) {
        // Stop sessions for removed slots
        prev.slice(count).forEach(s => {
          slotKeysRef.current[s.slotIndex] = null
          previewStartTimesRef.current[s.slotIndex] = null
          if (videoCleanupRef.current[s.slotIndex]) {
            videoCleanupRef.current[s.slotIndex]!()
            videoCleanupRef.current[s.slotIndex] = null
          }
          if (s.sessionId) {
            const ep = s.sessionType === 'preview'
              ? `/recordings/preview/${s.sessionId}`
              : `/recordings/playback/${s.sessionId}`
            apiDelete(ep).catch(() => {})
          }
        })
        return prev.slice(0, count)
      }
      const extra = Array.from({ length: count - prev.length }, (_, i) => emptySlot(prev.length + i))
      return [...prev, ...extra]
    })
    setActiveSlotIndex(ai => Math.min(ai, count - 1))
  }, [layout])

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => () => {
    slotsRef.current.forEach(s => {
      slotKeysRef.current[s.slotIndex] = null
      previewStartTimesRef.current[s.slotIndex] = null
      if (videoCleanupRef.current[s.slotIndex]) videoCleanupRef.current[s.slotIndex]!()
      if (s.sessionId) {
        const ep = s.sessionType === 'preview'
          ? `/recordings/preview/${s.sessionId}`
          : `/recordings/playback/${s.sessionId}`
        apiDelete(ep).catch(() => {})
      }
    })
  }, [])

  // ── Track global time from active slot ────────────────────────────────────
  const activeSlot = slots[activeSlotIndex] ?? emptySlot(activeSlotIndex)

  useEffect(() => {
    const vid = videoRefs.current[activeSlotIndex]
    const slot = slotsRef.current[activeSlotIndex]
    if (!vid || slot?.status !== 'ready' || !slot?.recording) return

    const handleTimeUpdate = () => {
      const currentSlot  = slotsRef.current[activeSlotIndex]
      const previewStart = previewStartTimesRef.current[activeSlotIndex]
      if (currentSlot?.sessionType === 'preview' && previewStart != null) {
        setGlobalPlaybackTime(new Date(previewStart + vid.currentTime * 1000))
      } else if (currentSlot?.recording) {
        const recStartMs = new Date(currentSlot.recording.startTime).getTime()
        setGlobalPlaybackTime(new Date(recStartMs + vid.currentTime * 1000))
      }
    }
    vid.addEventListener('timeupdate', handleTimeUpdate)
    return () => vid.removeEventListener('timeupdate', handleTimeUpdate)
  }, [activeSlotIndex, activeSlot.status, activeSlot.recording?.startTime, activeSlot.sessionType])

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

  // ── Slot helpers ───────────────────────────────────────────────────────────

  const stopSlot = (slotIndex: number) => {
    slotKeysRef.current[slotIndex] = null
    previewStartTimesRef.current[slotIndex] = null
    if (videoCleanupRef.current[slotIndex]) {
      videoCleanupRef.current[slotIndex]!()
      videoCleanupRef.current[slotIndex] = null
    }
    const vid = videoRefs.current[slotIndex]
    if (vid) { vid.src = ''; vid.load() }
    const s = slotsRef.current[slotIndex]
    if (s?.sessionId) {
      const ep = s.sessionType === 'preview'
        ? `/recordings/preview/${s.sessionId}`
        : `/recordings/playback/${s.sessionId}`
      apiDelete(ep).catch(() => {})
    }
  }

  const clearAllPlayback = () => {
    const count = slotsRef.current.length
    for (let i = 0; i < count; i++) stopSlot(i)
    setSlots(prev => prev.map(s => ({
      ...s,
      recording: null,
      status: s.cameraId ? 'idle' : 'empty',
      playbackUrl: null,
      sessionId: null,
      sessionType: null,
      downloadUrl: null,
      errorMsg: null,
      vodProgress: null,
      mimeType: null,
    })))
    setGlobalPlaying(false)
    setGlobalPlaybackTime(null)
  }

  // Assign camera from tree double-click to active slot
  const assignCameraToSlot = (cameraId: string) => {
    const cam = cameras.find(c => c.id === cameraId)
    if (!cam) return
    const nvrObj = nvrs.find(n => n.id === cam.nvrId)

    console.info(`[recordings-ui] slot_camera_assigned slot=${activeSlotIndex} cameraId=${cameraId} cameraName=${cam.name} source=single_click`)
    console.info(`[recordings-ui] assigned_camera_added_to_search slot=${activeSlotIndex} cameraId=${cameraId}`)
    setSelectedCameras(prev => new Set([...prev, cameraId]))

    stopSlot(activeSlotIndex)

    setSlots(prev => prev.map((s, i) => i === activeSlotIndex ? {
      ...s,
      cameraId: cam.id,
      cameraName: cam.name,
      nvrId: cam.nvrId,
      nvrName: nvrObj?.name ?? '',
      recording: null,
      status: 'idle',
      playbackUrl: null,
      sessionId: null,
      downloadUrl: null,
      errorMsg: null,
      vodProgress: null,
      mimeType: null,
    } : s))

    // If we already have recordings for this camera, auto-load via preview
    const camRecs = recordingsByCamera.get(cameraId)
    if (camRecs && camRecs.length > 0) {
      const first = camRecs[0]
      console.info(`[recordings-ui] slot_camera_assigned_autoload slot=${activeSlotIndex} cameraId=${cameraId} recId=${first.id} recStart=${first.startTime}`)
      // Slight delay so setSlots above has committed
      setTimeout(() => {
        const playhead = globalPlaybackTime ?? new Date(first.startTime)
        startPreviewInSlotRef.current(activeSlotIndex, first, playhead)
      }, 0)
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  const handleSearch = async () => {
    const assignedCameraIds = new Set(slotsRef.current.filter(s => s.cameraId).map(s => s.cameraId!))
    const effectiveCameraIds = new Set([...selectedCameras, ...assignedCameraIds])

    console.info(
      `[recordings-ui] search_effective_cameras selected=${selectedCameras.size}` +
      ` assigned=${assignedCameraIds.size} effective=${effectiveCameraIds.size}`
    )

    if (effectiveCameraIds.size === 0) { toast.error('Selecciona o asigna al menos una cámara'); return }
    const start = new Date(startDate)
    const end   = new Date(endDate)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) { toast.error('Fechas inválidas'); return }
    if (start >= end) { toast.error('La fecha Desde debe ser anterior a Hasta'); return }

    setIsSearching(true)
    clearAllPlayback()
    setRecordings([])
    setNvrErrors([])
    downloadJobKeyRef.current = null
    setDownloadJob(null)

    const cameraIds = [...effectiveCameraIds]
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

    // Initialize playhead to start of earliest recording found
    let earliest: RecordingWithCamera | null = null
    if (all.length > 0) {
      earliest = all.reduce((min, r) =>
        new Date(r.startTime).getTime() < new Date(min.startTime).getTime() ? r : min
      )
      setGlobalPlaybackTime(new Date(earliest.startTime))
    }

    // Auto-assign: if exactly 1 camera selected and no slot has a camera assigned, assign to active slot
    if (all.length > 0 && selectedCameras.size === 1 && assignedCameraIds.size === 0) {
      const singleCamId = [...selectedCameras][0]
      const cam = cameras.find(c => c.id === singleCamId)
      const nvrObj = cam ? nvrs.find(n => n.id === cam.nvrId) : null
      const camRecs = all.filter(r => r.cameraId === singleCamId)
      if (cam && camRecs.length > 0) {
        console.info(`[recordings-ui] search_auto_assign cameraId=${singleCamId} slot=${activeSlotIndex}`)
        stopSlot(activeSlotIndex)
        setSlots(prev => prev.map((s, i) => i === activeSlotIndex ? {
          ...s,
          cameraId: cam.id, cameraName: cam.name, nvrId: cam.nvrId, nvrName: nvrObj?.name ?? '',
          recording: null, status: 'idle', playbackUrl: null, sessionId: null, sessionType: null,
          downloadUrl: null, errorMsg: null, vodProgress: null, mimeType: null,
        } : s))
        const playhead = earliest ? new Date(earliest.startTime) : new Date(camRecs[0].startTime)
        setTimeout(() => startPreviewInSlotRef.current(activeSlotIndex, camRecs[0], playhead), 0)
      }
    }

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

  // ── Core: load recording into a specific slot ──────────────────────────────

  const loadRecordingInSlot = async (
    slotIndex: number,
    rec: RecordingWithCamera,
    opts?: { forceTranscode?: boolean },
  ) => {
    const forceTranscode = opts?.forceTranscode ?? false

    // Guard: if slot has an explicit camera assignment, reject recordings from different cameras
    // (unless this is a forceTranscode retry, which always uses the same rec)
    const currentSlot = slotsRef.current[slotIndex]
    if (!forceTranscode && currentSlot?.cameraId && currentSlot.cameraId !== rec.cameraId) {
      console.info(
        `[recordings-ui] slot_recording_rejected_camera_mismatch slot=${slotIndex}` +
        ` slotCameraId=${currentSlot.cameraId} recCameraId=${rec.cameraId}` +
        ` recId=${rec.id} recStart=${rec.startTime}`
      )
      return
    }

    console.info(
      `[recordings-ui] slot_recording_load slot=${slotIndex}` +
      ` slotCameraId=${currentSlot?.cameraId ?? 'none'} recCameraId=${rec.cameraId}` +
      ` recId=${rec.id} recStart=${rec.startTime} recEnd=${rec.endTime}` +
      ` forceTranscode=${forceTranscode}`
    )

    // ── Timezone diagnostic ──────────────────────────────────────────────────
    const browserTz      = Intl.DateTimeFormat().resolvedOptions().timeZone
    const displayedStart = formatNvrTime(rec.startTime, 'dd/MM/yyyy HH:mm:ss')
    const displayedEnd   = formatNvrTime(rec.endTime,   'dd/MM/yyyy HH:mm:ss')
    console.info(
      `[recordings-time] slot=${slotIndex}` +
      ` recStart_raw=${rec.startTime} recEnd_raw=${rec.endTime}` +
      ` displayedStart_utc=${displayedStart} displayedEnd_utc=${displayedEnd}` +
      ` browserTz=${browserTz}` +
      ` playbackURI=${(rec as any).playbackURI ?? 'none'}`
    )

    const myKey = `${Date.now()}-${Math.random()}`
    slotKeysRef.current[slotIndex] = myKey

    // Stop existing session + video for this slot
    if (videoCleanupRef.current[slotIndex]) {
      videoCleanupRef.current[slotIndex]!()
      videoCleanupRef.current[slotIndex] = null
    }
    const existingSlot = slotsRef.current[slotIndex]
    if (existingSlot?.sessionId) {
      const ep = existingSlot.sessionType === 'preview'
        ? `/recordings/preview/${existingSlot.sessionId}`
        : `/recordings/playback/${existingSlot.sessionId}`
      apiDelete(ep).catch(() => {})
    }
    previewStartTimesRef.current[slotIndex] = null
    const vid0 = videoRefs.current[slotIndex]
    if (vid0) { vid0.src = ''; vid0.load() }

    // Transition to loading
    setSlots(prev => prev.map((s, i) => i === slotIndex ? {
      ...s,
      recording: rec,
      status: 'loading',
      playbackUrl: null,
      sessionId: null,
      sessionType: null,
      downloadUrl: null,
      errorMsg: null,
      vodProgress: null,
      mimeType: null,
    } : s))

    const videoEl = videoRefs.current[slotIndex] ?? document.createElement('video')
    const canPlayHevcMp4 = !forceTranscode && (
      videoEl.canPlayType('video/mp4; codecs="hvc1"') !== '' ||
      videoEl.canPlayType('video/mp4; codecs="hev1"') !== ''
    )
    hevcAttemptedRef.current[slotIndex] = canPlayHevcMp4
    if (!forceTranscode) hevcRetryRef.current[slotIndex] = false

    // Attach video + event handlers once URL is ready
    const attachAndPlay = (url: string, mimeType: string | null, sessionId: string | null, downloadUrl: string | null) => {
      if (slotKeysRef.current[slotIndex] !== myKey) return
      const vid = videoRefs.current[slotIndex]
      if (!vid) return

      const handleError = () => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        const slot = slotsRef.current[slotIndex]
        if (hevcAttemptedRef.current[slotIndex] && !hevcRetryRef.current[slotIndex] && slot?.recording) {
          hevcRetryRef.current[slotIndex] = true
          const recToRetry = slot.recording
          toast('Video HEVC no compatible. Reintentando con conversión H.264…', { duration: 6000 })
          loadInSlotRef.current(slotIndex, recToRetry, { forceTranscode: true })
          return
        }
        setSlots(prev => prev.map((s, i) => i === slotIndex ? {
          ...s, status: 'error', errorMsg: 'El navegador no pudo abrir el archivo MP4',
        } : s))
      }

      const handleEnded = () => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        const slot = slotsRef.current[slotIndex]
        if (slot?.sessionId) apiDelete(`/recordings/playback/${slot.sessionId}`).catch(() => {})
        setSlots(prev => prev.map((s, i) => i === slotIndex ? {
          ...s, status: 'idle', sessionId: null,
        } : s))
        setGlobalPlaying(false)
      }

      // Remove previous handlers before attaching new ones
      if (videoCleanupRef.current[slotIndex]) videoCleanupRef.current[slotIndex]!()
      vid.addEventListener('error', handleError)
      vid.addEventListener('ended', handleEnded)
      videoCleanupRef.current[slotIndex] = () => {
        vid.removeEventListener('error', handleError)
        vid.removeEventListener('ended', handleEnded)
      }

      vid.src = url
      vid.playbackRate = globalPlaybackRateRef.current
      if (globalPlayingRef.current) vid.play().catch(() => {})

      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s,
        status: 'ready',
        playbackUrl: url,
        mimeType,
        sessionId,
        sessionType: 'mp4',
        downloadUrl,
        vodProgress: null,
      } : s))
    }

    try {
      const result = await apiPost<{
        status: string
        sessionId: string
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

      if (slotKeysRef.current[slotIndex] !== myKey) return

      const sessionId = result.sessionId
      setSlots(prev => prev.map((s, i) => i === slotIndex ? { ...s, sessionId } : s))

      if (result.status === 'ready' && result.url) {
        attachAndPlay(result.url, result.mimeType ?? null, sessionId, result.downloadUrl ?? null)
        return
      }

      const expectedSec   = result.expectedDurationSec ?? 60
      const dynamicPollMs = Math.min(POLL_ABSOLUTE_MAX_MS, Math.max(180_000, expectedSec * 2500 + 60_000))

      let lastSeenOutTimeSec = -1
      let lastProgressTick   = Date.now()
      const pollStart        = Date.now()

      while (Date.now() - pollStart < dynamicPollMs) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        if (slotKeysRef.current[slotIndex] !== myKey) return

        let statusRes: PlaybackStatusResponse
        try {
          statusRes = await apiGet<PlaybackStatusResponse>(`/recordings/playback/${sessionId}/status`, {})
        } catch (pollErr: any) {
          if (slotKeysRef.current[slotIndex] !== myKey) return
          const httpStatus = pollErr?.response?.status
          const errMsg = httpStatus === 404
            ? 'Sesión no encontrada o expirada'
            : 'Error al consultar estado de reproducción'
          setSlots(prev => prev.map((s, i) => i === slotIndex ? {
            ...s, status: 'error', errorMsg: errMsg,
          } : s))
          return
        }

        if (slotKeysRef.current[slotIndex] !== myKey) return

        if (statusRes.status === 'ready' && statusRes.url) {
          attachAndPlay(statusRes.url, statusRes.mimeType ?? null, sessionId, statusRes.downloadUrl ?? null)
          return
        }

        if (statusRes.status === 'error') {
          setSlots(prev => prev.map((s, i) => i === slotIndex ? {
            ...s, status: 'error', errorMsg: statusRes.error ?? 'Error desconocido',
          } : s))
          return
        }

        const outSec = statusRes.outTimeSec ?? 0
        const expSec = statusRes.expectedDurationSec ?? expectedSec
        if (outSec > 0) {
          setSlots(prev => prev.map((s, i) => i === slotIndex ? {
            ...s, vodProgress: { outTimeSec: outSec, expectedDurationSec: expSec },
          } : s))
          if (outSec > lastSeenOutTimeSec) {
            lastSeenOutTimeSec = outSec
            lastProgressTick   = Date.now()
          }
        }

        if (lastSeenOutTimeSec >= 0 && Date.now() - lastProgressTick > POLL_STALL_MS) {
          const pct = statusRes.progressPercent ?? 0
          if (pct < 95) {
            setSlots(prev => prev.map((s, i) => i === slotIndex ? {
              ...s, status: 'error', errorMsg: `Sin progreso durante ${POLL_STALL_MS / 1000}s`,
            } : s))
            return
          }
        }
      }

      if (slotKeysRef.current[slotIndex] !== myKey) return
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s, status: 'error', errorMsg: 'Tiempo de generación superado (>15 min)',
      } : s))

    } catch (err: any) {
      if (slotKeysRef.current[slotIndex] !== myKey) return
      const data   = err?.response?.data ?? {}
      const detail = data.detail ?? data.message ?? 'No se pudo iniciar la reproducción'
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s, status: 'error', errorMsg: detail,
      } : s))
    }
  }

  loadInSlotRef.current = loadRecordingInSlot

  // ── Preview streaming ─────────────────────────────────────────────────────
  // Starts an fMP4 stream directly from NVR RTSP → browser <video>.
  // Starts in 1-3s instead of waiting for full MP4 generation.
  const startPreviewInSlot = async (
    slotIndex:    number,
    rec:          RecordingWithCamera,
    playheadTime: Date,
    opts?:        { forceTranscode?: boolean },
  ) => {
    const forceTranscode = opts?.forceTranscode ?? false
    const currentSlot = slotsRef.current[slotIndex]
    if (currentSlot?.cameraId && currentSlot.cameraId !== rec.cameraId) {
      console.info(
        `[recordings-ui] preview_rejected_camera_mismatch slot=${slotIndex}` +
        ` slotCameraId=${currentSlot.cameraId} recCameraId=${rec.cameraId}`
      )
      return
    }

    const playheadMs    = playheadTime.getTime()
    const recStartMs    = new Date(rec.startTime).getTime()
    const recEndMs      = new Date(rec.endTime).getTime()
    const effectiveMs   = Math.max(recStartMs, Math.min(playheadMs, recEndMs - 1000))
    const effectiveStart = new Date(effectiveMs).toISOString()

    const videoEl = videoRefs.current[slotIndex] ?? document.createElement('video')
    const canPlayHevcMp4 = !forceTranscode && (
      videoEl.canPlayType('video/mp4; codecs="hvc1"') !== '' ||
      videoEl.canPlayType('video/mp4; codecs="hev1"') !== ''
    )

    console.info(
      `[recordings-ui] preview_start slot=${slotIndex}` +
      ` cameraId=${rec.cameraId} recId=${rec.id}` +
      ` playhead=${playheadTime.toISOString()} effectiveStart=${effectiveStart}` +
      ` forceTranscode=${forceTranscode} canPlayHevcMp4=${canPlayHevcMp4}`
    )

    const myKey = `${Date.now()}-${Math.random()}`
    slotKeysRef.current[slotIndex] = myKey
    previewStartTimesRef.current[slotIndex] = null
    if (!forceTranscode) previewRetriedRef.current[slotIndex] = false

    // Stop existing session
    if (videoCleanupRef.current[slotIndex]) {
      videoCleanupRef.current[slotIndex]!()
      videoCleanupRef.current[slotIndex] = null
    }
    const existing = slotsRef.current[slotIndex]
    if (existing?.sessionId) {
      const ep = existing.sessionType === 'preview'
        ? `/recordings/preview/${existing.sessionId}`
        : `/recordings/playback/${existing.sessionId}`
      apiDelete(ep).catch(() => {})
    }
    const vid0 = videoRefs.current[slotIndex]
    if (vid0) { vid0.src = ''; vid0.load() }

    setSlots(prev => prev.map((s, i) => i === slotIndex ? {
      ...s,
      recording: rec,
      status: 'loading',
      playbackUrl: null,
      sessionId: null,
      sessionType: null,
      downloadUrl: null,
      errorMsg: null,
      vodProgress: null,
      mimeType: null,
    } : s))

    try {
      const result = await apiPost<{ sessionId: string; streamUrl: string }>(
        '/recordings/preview/start',
        {
          cameraId:       rec.cameraId,
          slotIndex,
          startTime:      effectiveStart,
          endTime:        rec.endTime,
          playbackURI:    (rec as any).playbackURI,
          forceTranscode,
          canPlayHevcMp4,
        }
      )

      if (slotKeysRef.current[slotIndex] !== myKey) return

      const { sessionId, streamUrl } = result
      // Track when this preview starts (video.currentTime = 0 → effectiveMs)
      previewStartTimesRef.current[slotIndex] = effectiveMs

      const vid = videoRefs.current[slotIndex]
      if (!vid) return

      const handleError = () => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        const mediaErr = vid.error
        console.error(
          `[recordings-ui] preview_video_error slot=${slotIndex} sessionId=${sessionId}` +
          ` code=${mediaErr?.code ?? 'none'} msg=${mediaErr?.message ?? 'none'}` +
          ` forceTranscode=${forceTranscode} alreadyRetried=${previewRetriedRef.current[slotIndex] ?? false}`
        )
        // Auto-retry once with forceTranscode=true (transcodes HEVC → H.264 compatible)
        if (!forceTranscode && !previewRetriedRef.current[slotIndex]) {
          previewRetriedRef.current[slotIndex] = true
          toast('Reintentando con H.264…', { duration: 5000 })
          startPreviewInSlotRef.current(slotIndex, rec, playheadTime, { forceTranscode: true })
          return
        }
        previewRetriedRef.current[slotIndex] = false
        setSlots(prev => prev.map((s, i) => i === slotIndex ? {
          ...s, status: 'error', errorMsg: 'No se pudo reproducir el stream del NVR',
        } : s))
      }

      const handleEnded = () => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        apiDelete(`/recordings/preview/${sessionId}`).catch(() => {})
        setSlots(prev => prev.map((s, i) => i === slotIndex ? {
          ...s, status: 'idle', sessionId: null, sessionType: null,
        } : s))
        setGlobalPlaying(false)
      }

      ;(videoCleanupRef.current[slotIndex] as (() => void) | null)?.()
      vid.addEventListener('error', handleError)
      vid.addEventListener('ended', handleEnded)
      videoCleanupRef.current[slotIndex] = () => {
        vid.removeEventListener('error', handleError)
        vid.removeEventListener('ended', handleEnded)
      }

      vid.src = streamUrl
      vid.playbackRate = globalPlaybackRateRef.current
      if (globalPlayingRef.current) {
        vid.play()
          .then(() => console.info(`[recordings-ui] preview_playing slot=${slotIndex} sessionId=${sessionId}`))
          .catch((e: Error) => console.warn(`[recordings-ui] preview_play_rejected slot=${slotIndex} reason=${e.message}`))
      }

      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s,
        status: 'ready',
        playbackUrl: streamUrl,
        mimeType: 'video/mp4',
        sessionId,
        sessionType: 'preview',
        downloadUrl: null,
        vodProgress: null,
      } : s))

      console.info(`[recordings-ui] preview_ready slot=${slotIndex} sessionId=${sessionId}`)

    } catch (err: any) {
      if (slotKeysRef.current[slotIndex] !== myKey) return
      const detail = err?.response?.data?.message ?? 'No se pudo iniciar el stream de preview'
      console.error(`[recordings-ui] preview_error slot=${slotIndex} err=${detail}`)
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s, status: 'error', errorMsg: detail,
      } : s))
    }
  }

  startPreviewInSlotRef.current = startPreviewInSlot

  // ── Background MP4 download — does NOT interrupt the preview slot ─────────
  const triggerMp4Download = async (rec: RecordingWithCamera) => {
    const jobKey = `${Date.now()}-${Math.random()}`
    downloadJobKeyRef.current = jobKey
    setDownloadJob({ sessionId: '', status: 'generating', progress: null, downloadUrl: null, errorMsg: null })

    console.info(
      `[recordings-ui] mp4_download_triggered cameraId=${rec.cameraId}` +
      ` recId=${rec.id} recStart=${rec.startTime}`
    )

    try {
      const result = await apiPost<{
        status: string; sessionId: string;
        expectedDurationSec?: number; url?: string; downloadUrl?: string; mimeType?: string;
      }>('/recordings/playback', {
        cameraId:    rec.cameraId,
        startTime:   rec.startTime,
        endTime:     rec.endTime,
        playbackURI: (rec as any).playbackURI,
        canPlayHevcMp4: false,
        forceTranscode: false,
      })

      if (downloadJobKeyRef.current !== jobKey) return

      const sessionId = result.sessionId
      setDownloadJob(prev => prev ? { ...prev, sessionId } : null)

      if (result.status === 'ready' && result.downloadUrl) {
        setDownloadJob({ sessionId, status: 'ready', progress: null, downloadUrl: result.downloadUrl, errorMsg: null })
        return
      }

      const expectedSec = result.expectedDurationSec ?? 60
      const pollMax = Math.min(POLL_ABSOLUTE_MAX_MS, Math.max(180_000, expectedSec * 2500 + 60_000))
      const pollStart = Date.now()

      while (Date.now() - pollStart < pollMax) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        if (downloadJobKeyRef.current !== jobKey) return

        let statusRes: PlaybackStatusResponse
        try {
          statusRes = await apiGet<PlaybackStatusResponse>(`/recordings/playback/${sessionId}/status`, {})
        } catch { break }

        if (downloadJobKeyRef.current !== jobKey) return

        if (statusRes.status === 'ready' && statusRes.downloadUrl) {
          setDownloadJob({ sessionId, status: 'ready', progress: null, downloadUrl: statusRes.downloadUrl, errorMsg: null })
          return
        }
        if (statusRes.status === 'error') {
          setDownloadJob(prev => prev ? { ...prev, status: 'error', errorMsg: statusRes.error ?? 'Error al generar' } : null)
          return
        }
        const outSec = statusRes.outTimeSec ?? 0
        const expSec = statusRes.expectedDurationSec ?? expectedSec
        if (outSec > 0) {
          setDownloadJob(prev => prev ? { ...prev, progress: { outTimeSec: outSec, expectedDurationSec: expSec } } : null)
        }
      }

      if (downloadJobKeyRef.current !== jobKey) return
      setDownloadJob(prev => prev ? { ...prev, status: 'error', errorMsg: 'Tiempo límite superado' } : null)

    } catch (err: any) {
      if (downloadJobKeyRef.current !== jobKey) return
      const msg = err?.response?.data?.message ?? 'No se pudo generar el MP4'
      setDownloadJob(prev => prev ? { ...prev, status: 'error', errorMsg: msg } : null)
    }
  }

  // ── Global synchronized controls ──────────────────────────────────────────

  const syncedTogglePlayPause = () => {
    if (globalPlayingRef.current) {
      slotsRef.current.forEach((_, i) => videoRefs.current[i]?.pause())
      setGlobalPlaying(false)
      return
    }

    const currentSlots   = slotsRef.current
    const readySlots     = currentSlots.filter(s => s.status === 'ready')
    const assignedSlots  = currentSlots.filter(s => s.cameraId && s.status !== 'loading')

    console.info(
      `[recordings-ui] global_play_requested` +
      ` playhead=${globalPlaybackTime?.toISOString() ?? 'null'}` +
      ` readySlots=${readySlots.length} assignedSlots=${assignedSlots.length}`
    )

    // Play all slots that are already ready
    readySlots.forEach(s => videoRefs.current[s.slotIndex]?.play().catch(() => {}))

    // For assigned-but-not-ready slots, auto-load recording covering the playhead
    const playheadMs = globalPlaybackTime ? globalPlaybackTime.getTime() : null
    assignedSlots
      .filter(s => s.status !== 'ready')
      .forEach(slot => {
        if (!slot.cameraId) return
        if (playheadMs === null) return

        const camRecs   = recordingsByCamera.get(slot.cameraId) ?? []
        const covering  = camRecs.find(r =>
          new Date(r.startTime).getTime() <= playheadMs && new Date(r.endTime).getTime() > playheadMs
        )

        if (covering) {
          console.info(
            `[recordings-ui] slot_autoload_from_playhead slot=${slot.slotIndex}` +
            ` cameraId=${slot.cameraId} recId=${covering.id}` +
            ` recStart=${covering.startTime} recEnd=${covering.endTime}`
          )
          startPreviewInSlotRef.current(slot.slotIndex, covering, new Date(playheadMs))
        } else {
          console.info(
            `[recordings-ui] slot_no_recording_at_playhead slot=${slot.slotIndex}` +
            ` cameraId=${slot.cameraId} playhead=${new Date(playheadMs).toISOString()}`
          )
          stopSlot(slot.slotIndex)
          setSlots(prev => prev.map((s, i) => i === slot.slotIndex ? {
            ...s, status: 'no_recording', recording: null, playbackUrl: null, sessionId: null,
          } : s))
        }
      })

    setGlobalPlaying(true)
  }

  const syncedRate = (rate: number) => {
    slotsRef.current.forEach((s, i) => {
      const vid = videoRefs.current[i]
      if (vid && s.status === 'ready') {
        vid.playbackRate = rate
        if ('preservesPitch' in vid) (vid as any).preservesPitch = false
      }
    })
    setGlobalPlaybackRate(rate)
  }

  const syncedJump = (seconds: number) => {
    slotsRef.current.forEach((s, i) => {
      const vid = videoRefs.current[i]
      if (vid && s.status === 'ready') {
        vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + seconds))
      }
    })
  }

  const syncedFrameForward = () => {
    slotsRef.current.forEach((s, i) => {
      const vid = videoRefs.current[i]
      if (vid && s.status === 'ready') {
        vid.pause()
        vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 1 / 25)
      }
    })
    setGlobalPlaying(false)
  }

  // ── Timeline seek handlers ────────────────────────────────────────────────

  const recordingsByCamera = useMemo(() => {
    const map = new Map<string, RecordingWithCamera[]>()
    recordings.forEach(rec => {
      if (!map.has(rec.cameraId)) map.set(rec.cameraId, [])
      map.get(rec.cameraId)!.push(rec)
    })
    return map
  }, [recordings])

  // Called on every mousemove — only updates playhead, never restarts preview
  const handleTimelinePreviewChange = (time: Date) => {
    console.info(`[recordings-ui] timeline_drag_preview playhead=${time.toISOString()}`)
    setGlobalPlaybackTime(time)
  }

  // Called on mouseup — commits the seek; restarts preview if currently playing
  const handleTimelineCommit = (time: Date) => {
    const timeMs    = time.getTime()
    const wasPlaying = globalPlayingRef.current
    console.info(`[recordings-ui] timeline_seek_commit playhead=${time.toISOString()} wasPlaying=${wasPlaying}`)

    setGlobalPlaybackTime(time)

    if (!wasPlaying) return

    // Playing: restart preview from new seek point for each assigned slot
    slotsRef.current.forEach((slot, slotIndex) => {
      if (!slot.cameraId) return

      const camRecs  = recordingsByCamera.get(slot.cameraId) ?? []
      const covering = camRecs.find(r =>
        new Date(r.startTime).getTime() <= timeMs && new Date(r.endTime).getTime() > timeMs
      )

      if (!covering) {
        stopSlot(slotIndex)
        setSlots(prev => prev.map((s, i) => i === slotIndex ? {
          ...s, status: 'no_recording', recording: null, playbackUrl: null, sessionId: null,
        } : s))
        return
      }

      // Preview streams don't support random seek — restart from the new point
      startPreviewInSlotRef.current(slotIndex, covering, time)
    })
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  const anySlotReady   = slots.some(s => s.status === 'ready')
  const assignedSlotCount = slots.filter(s => s.cameraId !== null).length
  const canGlobalPlay  = Boolean(
    globalPlaybackTime &&
    recordings.length > 0 &&
    (assignedSlotCount > 0 || selectedCameras.size > 0)
  )

  // Active slot info for controls
  const activeRecording = activeSlot.recording
  const activeDownloadUrl = activeSlot.downloadUrl

  // Cameras assigned to slots — passed to timeline to always show their row
  const assignedCameras = useMemo(() =>
    slots
      .filter(s => s.cameraId !== null)
      .map(s => ({
        cameraId:   s.cameraId!,
        cameraName: s.cameraName!,
        nvrName:    s.nvrName ?? '',
        slotIndex:  s.slotIndex,
      })),
    [slots]
  )

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
          onAssignCamera={assignCameraToSlot}
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
          cameraCount={new Set([...selectedCameras, ...slots.filter(s => s.cameraId).map(s => s.cameraId!)]).size}
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

        {/* ── Central: video grid (full width) ─────────────────────────── */}
        <div className="flex-1 min-h-0 bg-black overflow-hidden">
          <div className={clsx('grid h-full gap-0.5 bg-surface-800', GRID_COLS[layout])}>
              {Array.from({ length: SLOT_COUNT[layout] }).map((_, idx) => {
                const slot      = slots[idx] ?? emptySlot(idx)
                const isActive  = idx === activeSlotIndex
                const vodPct    = slot.vodProgress && slot.vodProgress.expectedDurationSec > 0
                  ? Math.min(99, Math.round(slot.vodProgress.outTimeSec / slot.vodProgress.expectedDurationSec * 100))
                  : null
                const loadLabel = (vodPct !== null && vodPct >= 95)
                  ? `Finalizando… ${vodPct}%`
                  : vodPct !== null
                    ? `Generando MP4… ${vodPct}%`
                    : 'Conectando al NVR…'

                return (
                  <div
                    key={idx}
                    onClick={() => {
                      console.info(`[recordings-ui] slot_selected slot=${idx} cameraId=${slots[idx]?.cameraId ?? 'none'} status=${slots[idx]?.status ?? 'empty'}`)
                      setActiveSlotIndex(idx)
                    }}
                    className={clsx(
                      'relative flex flex-col overflow-hidden cursor-pointer',
                      isActive
                        ? 'ring-2 ring-inset ring-red-600'
                        : 'bg-surface-900'
                    )}
                  >
                    {/* Slot label bar */}
                    <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-1.5 px-2 py-1 bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
                      <span className="text-[9px] text-surface-300 font-medium truncate">
                        {slot.cameraId
                          ? `${slot.nvrName} · ${slot.cameraName}`
                          : `Canal ${idx + 1}`
                        }
                      </span>
                      {slot.status === 'ready' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-green-700/60 text-green-300">● Play</span>
                      )}
                    </div>

                    {/* Video element — always rendered, shown only when ready */}
                    <video
                      ref={el => { videoRefs.current[idx] = el }}
                      controls
                      controlsList="nodownload"
                      className={clsx(
                        'absolute inset-0 w-full h-full bg-black',
                        slot.status === 'ready' ? 'block' : 'hidden'
                      )}
                    />

                    {/* Overlays */}
                    {slot.status === 'empty' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-surface-900">
                        <Video size={20} className="text-surface-800" />
                        <span className="text-[9px] text-surface-700">
                          {isActive ? 'Clic en cámara para asignar' : `Canal ${idx + 1}`}
                        </span>
                      </div>
                    )}

                    {slot.status === 'idle' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black">
                        <Play size={20} className="text-surface-700" />
                        <span className="text-[9px] text-surface-500">
                          {recordings.length > 0 ? 'Mueve el cabezal y presiona Play' : 'Busca grabaciones y presiona Play'}
                        </span>
                      </div>
                    )}

                    {slot.status === 'no_recording' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black">
                        <Clock size={18} className="text-surface-700" />
                        <span className="text-[9px] text-surface-600">Sin grabación en este momento</span>
                      </div>
                    )}

                    {slot.status === 'loading' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black">
                        <Loader2 size={20} className="text-brand-400 animate-spin" />
                        <p className="text-[10px] text-surface-300">{loadLabel}</p>
                        {vodPct !== null && (
                          <div className="w-32 bg-surface-700 rounded-full h-1">
                            <div
                              className="bg-brand-500 h-1 rounded-full transition-all duration-500"
                              style={{ width: `${vodPct}%` }}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {slot.status === 'error' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black px-3">
                        <AlertTriangle size={18} className="text-red-500 flex-shrink-0" />
                        <p className="text-[9px] text-surface-400 text-center line-clamp-2">
                          {slot.errorMsg ?? 'Error desconocido'}
                        </p>
                        {slot.recording && (
                          <button
                            onClick={e => { e.stopPropagation(); startPreviewInSlotRef.current(idx, slot.recording!, globalPlaybackTime ?? new Date(slot.recording!.startTime)) }}
                            className="text-[9px] px-2 py-0.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-300 transition-colors"
                          >
                            Reintentar
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        </div>

        {/* ── Timeline ──────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 border-t border-surface-700 bg-surface-900">
          <RecordingTimeline
            recordings={recordings}
            assignedCameras={assignedCameras}
            selectedRec={activeRecording}
            startDate={startDate}
            endDate={endDate}
            onSelectRecording={rec => startPreviewInSlotRef.current(activeSlotIndex, rec, globalPlaybackTime ?? new Date(rec.startTime))}
            globalTime={globalPlaybackTime}
            onPreviewTimeChange={recordings.length > 0 || assignedCameras.length > 0 ? handleTimelinePreviewChange : undefined}
            onCommitSeekTime={recordings.length > 0 || assignedCameras.length > 0 ? handleTimelineCommit : undefined}
          />
        </div>

        {/* ── Controls toolbar — always visible ─────────────────────── */}
        <div className="flex-shrink-0 border-t border-surface-700">
          {/* Info row: playhead time · slot label · download */}
          <div className="flex items-center gap-3 px-3 py-1.5 bg-surface-800/50 border-b border-surface-700/60">
            {/* Playhead time — shown as NVR wall clock (UTC) */}
            <span className="text-[11px] font-mono text-surface-200 tabular-nums flex-shrink-0">
              {globalPlaybackTime
                ? formatNvrTime(globalPlaybackTime, 'dd/MM HH:mm:ss')
                : activeRecording
                  ? formatNvrTime(activeRecording.startTime, 'dd/MM HH:mm:ss')
                  : '--/-- --:--:--'
              }
            </span>

            {/* Slot indicator */}
            <span className="text-[9px] text-surface-600 flex-shrink-0">
              {activeSlot.cameraName
                ? `S${activeSlotIndex + 1} · ${activeSlot.nvrName} · ${activeSlot.cameraName}`
                : `S${activeSlotIndex + 1} — sin cámara`
              }
            </span>

            <div className="flex-1" />

            {/* Download area — independent of preview slot state */}
            {downloadJob?.status === 'ready' && downloadJob.downloadUrl ? (
              <a
                href={downloadJob.downloadUrl}
                download
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md bg-green-800/60 text-green-300 hover:bg-green-800 transition-colors flex-shrink-0"
              >
                <Download size={11} />
                Descargar MP4
              </a>
            ) : downloadJob?.status === 'generating' ? (
              <span className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 text-surface-400 flex-shrink-0">
                <Loader2 size={11} className="animate-spin" />
                {downloadJob.progress && downloadJob.progress.expectedDurationSec > 0
                  ? `MP4 ${Math.min(99, Math.round(downloadJob.progress.outTimeSec / downloadJob.progress.expectedDurationSec * 100))}%`
                  : 'Generando MP4…'
                }
              </span>
            ) : downloadJob?.status === 'error' ? (
              <button
                onClick={() => activeRecording && triggerMp4Download(activeRecording)}
                title={downloadJob.errorMsg ?? 'Error'}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md bg-red-900/40 text-red-400 hover:bg-red-900/60 transition-colors flex-shrink-0"
              >
                <Download size={11} />
                Reintentar MP4
              </button>
            ) : activeRecording ? (
              <button
                onClick={() => triggerMp4Download(activeRecording)}
                title="Genera el MP4 completo en segundo plano (el preview sigue activo)"
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md bg-surface-700 text-surface-400 hover:bg-surface-600 hover:text-surface-200 transition-colors flex-shrink-0"
              >
                <Download size={11} />
                Generar MP4…
              </button>
            ) : null}
          </div>

          {/* Playback controls — Play enabled by canGlobalPlay; seek/speed disabled until a slot is ready */}
          <div className={clsx(!canGlobalPlay && 'opacity-40 pointer-events-none')}>
            <RecordingPlaybackControls
              key={`slot-${activeSlotIndex}-${activeSlot.sessionId ?? 'idle'}`}
              video={videoRefs.current[activeSlotIndex] ?? undefined}
              onTogglePlayPause={syncedTogglePlayPause}
              onSeekRelative={syncedJump}
              onFrameForward={syncedFrameForward}
              onApplyRate={syncedRate}
              disableSeekControls={!anySlotReady}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
