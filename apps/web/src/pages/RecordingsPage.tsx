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

// Convert a datetime-local input value into NVR wall-clock ISO (UTC components).
// NVR timestamps carry the wall clock in the UTC fields, so the search range must
// be sent in the same frame — NOT shifted through the browser timezone.
function localInputToNvrIso(s: string): string {
  if (!s) return s
  return s.length === 16 ? `${s}:00Z` : `${s}Z`
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

// Continuity tuning — overridable at build time via Vite env
const CONTINUITY_GAP_MS        = Number(import.meta.env.VITE_RECORDINGS_CONTINUITY_GAP_MS)        || 5_000
const MIN_PREVIEW_DURATION_MS  = Number(import.meta.env.VITE_RECORDINGS_MIN_PREVIEW_DURATION_MS)  || 3_000

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

  // ── Timeline range = last searched range (NVR wall-clock epoch ms) ─────────
  const [searchRangeMs, setSearchRangeMs] = useState<{ start: number; end: number } | null>(null)

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
  const startPreviewInSlotRef = useRef<(si: number, rec: RecordingWithCamera, playheadTime: Date, opts?: { forceTranscode?: boolean; noClockAnchor?: boolean }) => void>(() => {})
  const previewStartTimesRef  = useRef<{ [k: number]: number | null }>({})
  const previewRetriedRef     = useRef<{ [k: number]: boolean }>({})
  const recordingsRef         = useRef<RecordingWithCamera[]>([])
  const nextRecBySlotRef      = useRef<{ [k: number]: RecordingWithCamera | null }>({})
  const errorCategoryBySlotRef = useRef<{ [k: number]: string | null }>({})
  const errorDetailBySlotRef   = useRef<{ [k: number]: string | null }>({})
  const clipInfoBySlotRef      = useRef<{ [k: number]: { clipStartMs: number; clipEndMs: number; effectiveStartMs: number } | null }>({})
  // Sessions already deleted — avoids duplicate DELETE from error/ended/unmount/slot-change
  const deletedSessionsRef    = useRef<Set<string>>(new Set())
  // Cameras manually closed (slot X / unchecked) — blocked from autostart
  // until the user selects or assigns them again
  const closedCamerasRef      = useRef<Set<string>>(new Set())
  // Search cache: `${cameraId}|${startIso}|${endIso}` already fetched — avoids
  // re-querying the NVR when a camera is re-selected for the same range
  const searchedKeysRef       = useRef<Set<string>>(new Set())
  const searchRangeIsoRef     = useRef<{ start: string; end: string } | null>(null)
  const continuityTimerRef    = useRef<{ [k: number]: ReturnType<typeof setTimeout> | null }>({})

  const deleteSessionOnce = (sessionType: string | null, sessionId: string | null | undefined) => {
    if (!sessionId) return
    if (deletedSessionsRef.current.has(sessionId)) return
    deletedSessionsRef.current.add(sessionId)
    const ep = sessionType === 'preview'
      ? `/recordings/preview/${sessionId}`
      : `/recordings/playback/${sessionId}`
    apiDelete(ep).catch(() => {})
  }

  // Keep refs in sync
  useEffect(() => { slotsRef.current = slots }, [slots])
  useEffect(() => { globalPlayingRef.current = globalPlaying }, [globalPlaying])
  useEffect(() => { globalPlaybackRateRef.current = globalPlaybackRate }, [globalPlaybackRate])
  useEffect(() => { recordingsRef.current = recordings }, [recordings])

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
            deleteSessionOnce(s.sessionType, s.sessionId)
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
      if (continuityTimerRef.current[s.slotIndex]) {
        clearTimeout(continuityTimerRef.current[s.slotIndex]!)
        continuityTimerRef.current[s.slotIndex] = null
      }
      slotKeysRef.current[s.slotIndex] = null
      previewStartTimesRef.current[s.slotIndex] = null
      if (videoCleanupRef.current[s.slotIndex]) videoCleanupRef.current[s.slotIndex]!()
      if (s.sessionId) {
        deleteSessionOnce(s.sessionType, s.sessionId)
      }
    })
  }, [])

  // ── Master clock via requestAnimationFrame ────────────────────────────────
  // Advances globalPlaybackTime independently of any video element, so the
  // timeline playhead stays smooth even when a slot is buffering or loading.
  const activeSlot = slots[activeSlotIndex] ?? emptySlot(activeSlotIndex)

  const masterClockRef = useRef<{ wallMs: number; playheadMs: number; rate: number } | null>(null)
  const rafHandleRef   = useRef<number | null>(null)

  useEffect(() => {
    if (!globalPlaying || !globalPlaybackTime) {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current)
        rafHandleRef.current = null
      }
      masterClockRef.current = null
      return
    }

    // Snapshot the playhead at the moment playback starts (or resumes)
    masterClockRef.current = {
      wallMs:     performance.now(),
      playheadMs: globalPlaybackTime.getTime(),
      rate:       globalPlaybackRateRef.current,
    }

    let lastSetMs = performance.now()
    const tick = () => {
      const clock = masterClockRef.current
      if (!clock) return
      const now       = performance.now()
      const elapsed   = now - clock.wallMs
      const newPlayMs = clock.playheadMs + elapsed * clock.rate
      // Throttle React state updates to ~10 fps for timeline — RAF is 60fps
      if (now - lastSetMs >= 100) {
        setGlobalPlaybackTime(new Date(newPlayMs))
        lastSetMs = now
      }
      rafHandleRef.current = requestAnimationFrame(tick)
    }
    rafHandleRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current)
        rafHandleRef.current = null
      }
    }
  }, [globalPlaying])

  // ── iVMS-style auto-start: while playing, slots waiting without a recording
  // auto-load when the master clock reaches one of their recordings ──────────
  const autoStartLockRef = useRef<{ [k: number]: number }>({})

  useEffect(() => {
    if (!globalPlaying || !globalPlaybackTime) return
    const playheadMs = globalPlaybackTime.getTime()

    slotsRef.current.forEach(slot => {
      if (!slot.cameraId) return
      if (slot.status !== 'no_recording' && slot.status !== 'idle') return
      // Manually closed cameras never autostart until re-selected/assigned
      if (closedCamerasRef.current.has(slot.cameraId)) return

      // Debounce: don't retry the same slot more than once every 5 s
      const lastAttempt = autoStartLockRef.current[slot.slotIndex] ?? 0
      if (Date.now() - lastAttempt < 5_000) return

      const covering = recordingsRef.current.find(r =>
        r.cameraId === slot.cameraId &&
        new Date(r.startTime).getTime() <= playheadMs &&
        new Date(r.endTime).getTime() > playheadMs
      )
      if (covering) {
        autoStartLockRef.current[slot.slotIndex] = Date.now()
        console.info(
          `[recordings-ui] slot_autostart_at_playhead slot=${slot.slotIndex}` +
          ` cameraId=${slot.cameraId} recId=${covering.id} playhead=${globalPlaybackTime.toISOString()}`
        )
        // Never re-anchor the master clock from a watcher start — the clock
        // is already running and other slots follow it
        startPreviewInSlotRef.current(slot.slotIndex, covering, globalPlaybackTime, { noClockAnchor: true })
      }
    })
  }, [globalPlaybackTime, globalPlaying])

  // ── Camera selection helpers ───────────────────────────────────────────────
  const toggleCamera = (cameraId: string) => {
    const isDeselecting = selectedCameras.has(cameraId)
    if (isDeselecting) {
      // Deselecting also closes any slot showing this camera and hides its
      // timeline rows (results stay in memory — re-selecting restores them)
      const closedSlots: number[] = []
      slotsRef.current.forEach(s => {
        if (s.cameraId === cameraId) {
          closedSlots.push(s.slotIndex)
          stopSlot(s.slotIndex)
          nextRecBySlotRef.current[s.slotIndex] = null
          errorCategoryBySlotRef.current[s.slotIndex] = null
          previewRetriedRef.current[s.slotIndex] = false
        }
      })
      if (closedSlots.length > 0) {
        setSlots(prev => prev.map((s, i) => closedSlots.includes(i) ? emptySlot(i) : s))
      }
      closedCamerasRef.current.add(cameraId)
      closedSlots.forEach(si =>
        console.info(`[recordings-ui] camera_unselected_close_slot cameraId=${cameraId} slot=${si}`)
      )
      console.info(`[recordings-ui] checkbox_unselected cameraId=${cameraId} closedSlots=${closedSlots.join(',') || 'none'}`)
    } else {
      closedCamerasRef.current.delete(cameraId)
      // Incremental search: an active range exists → fetch just this camera
      // for the SAME range instead of requiring a new full search
      fetchCameraForCurrentRange(cameraId)
    }
    setSelectedCameras(prev => {
      const next = new Set(prev)
      next.has(cameraId) ? next.delete(cameraId) : next.add(cameraId)
      return next
    })
  }

  // Fetch recordings for one camera using the currently-searched range.
  // Cached per cameraId+range — re-selecting a camera already fetched for
  // this range only restores its (hidden) timeline rows.
  const fetchCameraForCurrentRange = (cameraId: string) => {
    const range = searchRangeIsoRef.current
    if (!range) return
    const key = `${cameraId}|${range.start}|${range.end}`
    if (searchedKeysRef.current.has(key)) {
      console.info(`[recordings-ui] incremental_search_cache_hit cameraId=${cameraId}`)
      return
    }
    searchedKeysRef.current.add(key)
    console.info(`[recordings-ui] incremental_search_start cameraId=${cameraId} from=${range.start} to=${range.end}`)
    const cam = cameras.find(c => c.id === cameraId)
    apiGet<{ recordings: Recording[] }>('/recordings/search', {
      cameraId, startTime: range.start, endTime: range.end,
    })
      .then(res => {
        const mapped = (res?.recordings ?? []).map((r): RecordingWithCamera => ({
          ...r,
          cameraId,
          cameraName: cam?.name || 'Desconocida',
          nvrName:    cam?.nvr?.name || '',
        }))
        console.info(`[recordings-ui] incremental_search_done cameraId=${cameraId} count=${mapped.length}`)
        setRecordings(prev => {
          const existing = new Set(prev.map(r => `${r.cameraId}|${r.id}`))
          const fresh = mapped.filter(r => !existing.has(`${r.cameraId}|${r.id}`))
          if (fresh.length === 0) return prev
          return [...prev, ...fresh].sort(
            (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
          )
        })
        // Auto-start in an available slot if currently playing
        if (globalPlayingRef.current && mapped.length > 0) {
          setTimeout(() => {
            if (!globalPlayingRef.current) return
            const currentSlots = slotsRef.current
            if (currentSlots.some(s => s.cameraId === cameraId)) return
            const emptySi = currentSlots.findIndex(s => !s.cameraId)
            if (emptySi < 0) return
            const clock = masterClockRef.current
            const playheadMs = clock
              ? clock.playheadMs + (performance.now() - clock.wallMs) * clock.rate
              : null
            const sorted = [...mapped].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
            const covering = playheadMs != null
              ? sorted.find(r => new Date(r.startTime).getTime() <= playheadMs && new Date(r.endTime).getTime() > playheadMs)
              : null
            const target = covering
              ?? sorted.find(r => playheadMs == null || new Date(r.startTime).getTime() > playheadMs)
              ?? sorted[0]
            if (target) {
              console.info(`[recordings-ui] incremental_autostart slot=${emptySi} cameraId=${cameraId} recId=${target.id}`)
              startPreviewInSlotRef.current(emptySi, target,
                covering && playheadMs != null ? new Date(playheadMs) : new Date(target.startTime),
                { noClockAnchor: true }
              )
            }
          }, 100)
        }
      })
      .catch(() => {
        // Allow a manual retry by re-toggling
        searchedKeysRef.current.delete(key)
        toast.error(`No se pudieron cargar grabaciones de ${cam?.name ?? 'la cámara'}`)
      })
  }

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
    if (continuityTimerRef.current[slotIndex]) {
      clearTimeout(continuityTimerRef.current[slotIndex]!)
      continuityTimerRef.current[slotIndex] = null
    }
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
      deleteSessionOnce(s.sessionType, s.sessionId)
    }
  }

  // Close a single slot: stops ONLY the video of that slot. The camera stays
  // selected, its timeline rows stay visible and the search cache is kept —
  // matching iVMS semantics (X = close video, checkbox = remove camera).
  const closeSlot = (slotIndex: number) => {
    const cameraId = slotsRef.current[slotIndex]?.cameraId ?? null
    console.info(`[recordings-ui] slot_closed_video_only slot=${slotIndex} cameraId=${cameraId ?? 'none'}`)
    stopSlot(slotIndex)
    nextRecBySlotRef.current[slotIndex] = null
    errorCategoryBySlotRef.current[slotIndex] = null
    previewRetriedRef.current[slotIndex] = false
    if (cameraId) closedCamerasRef.current.add(cameraId)
    setSlots(prev => prev.map((s, i) => i === slotIndex ? {
      ...s,
      recording: null,
      status: 'idle',
      playbackUrl: null,
      sessionId: null,
      sessionType: null,
      downloadUrl: null,
      errorMsg: null,
      vodProgress: null,
      mimeType: null,
    } : s))
  }

  // Shared continuity logic: advances a slot to the next recording block.
  // Called by the expected-duration timer AND by ended/error-at-tail events.
  const continueSlotToNextRecording = (slotIndex: number, reason: string) => {
    if (continuityTimerRef.current[slotIndex]) {
      clearTimeout(continuityTimerRef.current[slotIndex]!)
      continuityTimerRef.current[slotIndex] = null
    }
    const slot = slotsRef.current[slotIndex]
    if (!slot?.cameraId || !slot.recording) return
    if (slot.status === 'loading') return

    const cameraId = slot.cameraId
    const rec = slot.recording
    if (closedCamerasRef.current.has(cameraId)) return

    const vid = videoRefs.current[slotIndex]
    const previewStart = previewStartTimesRef.current[slotIndex]
    const endedAtMs = previewStart != null && vid
      ? previewStart + (vid.currentTime * 1000)
      : new Date(rec.endTime).getTime()

    console.info(
      `[recordings-ui] continuity_continue slot=${slotIndex} reason=${reason}` +
      ` endedAt=${new Date(endedAtMs).toISOString()}`
    )

    if (slot.sessionId) deleteSessionOnce(slot.sessionType, slot.sessionId)

    const currentStartMs = new Date(rec.startTime).getTime()
    const currentEndMs = new Date(rec.endTime).getTime()
    const nextRec = recordingsRef.current
      .filter(r => r.cameraId === cameraId && new Date(r.startTime).getTime() > currentStartMs && r.id !== rec.id)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0] ?? null

    if (nextRec) {
      const nextStartMs = new Date(nextRec.startTime).getTime()
      const gap = nextStartMs - currentEndMs
      console.info(
        `[recordings-ui] continuity_next_clip slot=${slotIndex}` +
        ` currentEnd=${rec.endTime} nextStart=${nextRec.startTime} gapMs=${gap}`
      )
      if (gap <= CONTINUITY_GAP_MS) {
        const otherPlaying = slotsRef.current.some((s, i) => i !== slotIndex && s.status === 'ready')
        startPreviewInSlotRef.current(slotIndex, nextRec, new Date(nextStartMs), { noClockAnchor: otherPlaying })
        return
      }
    }

    console.info(
      `[recordings-ui] ${nextRec ? 'no_recording_at_playhead' : 'continuity_no_next_clip'} slot=${slotIndex}` +
      ` playhead=${new Date(endedAtMs).toISOString()} nextRec=${nextRec?.id ?? 'none'}`
    )
    nextRecBySlotRef.current[slotIndex] = nextRec
    setSlots(prev => prev.map((s, i) => i === slotIndex ? {
      ...s, status: 'no_recording', sessionId: null, sessionType: null, errorMsg: null,
    } : s))
    if (!nextRec) setGlobalPlaying(false)
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
    closedCamerasRef.current.delete(cameraId)
    setSelectedCameras(prev => new Set([...prev, cameraId]))

    // Move instead of duplicate: if this camera lives in another slot, free it
    const previousSlot = slotsRef.current.findIndex(
      (s, i) => s.cameraId === cameraId && i !== activeSlotIndex
    )
    if (previousSlot >= 0) {
      console.info(`[recordings-ui] slot_assign_existing_moved from=${previousSlot} to=${activeSlotIndex} cameraId=${cameraId}`)
      stopSlot(previousSlot)
    }

    stopSlot(activeSlotIndex)

    setSlots(prev => prev.map((s, i) => {
      if (i === previousSlot) return emptySlot(i)
      if (i !== activeSlotIndex) return s
      return {
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
      }
    }))

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
  const handleSearch = async (dateOverride?: { startDate: string; endDate: string }) => {
    const assignedCameraIds = new Set(slotsRef.current.filter(s => s.cameraId).map(s => s.cameraId!))
    const effectiveCameraIds = new Set([...selectedCameras, ...assignedCameraIds])

    console.info(
      `[recordings-ui] search_effective_cameras selected=${selectedCameras.size}` +
      ` assigned=${assignedCameraIds.size} effective=${effectiveCameraIds.size}`
    )

    if (effectiveCameraIds.size === 0) { toast.error('Selecciona o asigna al menos una cámara'); return }
    const sd = dateOverride?.startDate ?? startDate
    const ed = dateOverride?.endDate   ?? endDate
    // Interpret picker values as NVR wall clock (UTC components), not browser local time
    const startIso = localInputToNvrIso(sd)
    const endIso   = localInputToNvrIso(ed)
    const start = new Date(startIso)
    const end   = new Date(endIso)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) { toast.error('Fechas inválidas'); return }
    if (start >= end) { toast.error('La fecha Desde debe ser anterior a Hasta'); return }

    console.info(`[recordings-time] search_range input=${sd}→${ed} sent=${startIso}→${endIso}`)

    // New full search resets the incremental cache and becomes the active range
    searchRangeIsoRef.current = { start: startIso, end: endIso }
    searchedKeysRef.current   = new Set()

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
          startTime: startIso,
          endTime:   endIso,
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
        // Mark camera+range as fetched for the incremental-selection cache
        searchedKeysRef.current.add(`${cameraIds[i]}|${startIso}|${endIso}`)
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

    // Timeline spans exactly the searched range
    setSearchRangeMs({ start: start.getTime(), end: end.getTime() })

    // Initialize playhead to earliest recording found
    let earliest: RecordingWithCamera | null = null
    if (all.length > 0) {
      earliest = all.reduce((min, r) =>
        new Date(r.startTime).getTime() < new Date(min.startTime).getTime() ? r : min
      )
      setGlobalPlaybackTime(new Date(new Date(earliest.startTime).getTime()))
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
      deleteSessionOnce(existingSlot.sessionType, existingSlot.sessionId)
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
        if (slot?.sessionId) deleteSessionOnce(slot.sessionType, slot.sessionId)
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
    opts?:        { forceTranscode?: boolean; noClockAnchor?: boolean },
  ) => {
    const forceTranscode = opts?.forceTranscode ?? false
    const currentSlot = slotsRef.current[slotIndex]
    // If the slot shows a different camera, adopt the recording's camera —
    // the caller routed this recording here deliberately.
    const adoptCamera = !currentSlot?.cameraId || currentSlot.cameraId !== rec.cameraId
    if (adoptCamera) {
      const cam = cameras.find(c => c.id === rec.cameraId)
      console.info(
        `[recordings-ui] slot_adopt_camera slot=${slotIndex}` +
        ` prevCameraId=${currentSlot?.cameraId ?? 'none'} newCameraId=${rec.cameraId}`
      )
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s,
        cameraId:   rec.cameraId,
        cameraName: rec.cameraName,
        nvrId:      cam?.nvrId ?? s.nvrId,
        nvrName:    rec.nvrName,
      } : s))
    }

    const playheadMs    = playheadTime.getTime()
    const recStartMs    = new Date(rec.startTime).getTime()
    const recEndMs      = new Date(rec.endTime).getTime()
    const effectiveMs   = Math.max(recStartMs, Math.min(playheadMs, recEndMs - 1000))
    const effectiveStart = new Date(effectiveMs).toISOString()

    // Never open a preview shorter than MIN_PREVIEW_DURATION_MS — the playhead
    // is at the tail of this block, so jump straight to the next block instead
    const remainingMs = recEndMs - effectiveMs
    if (remainingMs < MIN_PREVIEW_DURATION_MS) {
      console.info(`[recordings-ui] continuity_skip_short_clip slot=${slotIndex} durationMs=${remainingMs} recId=${rec.id}`)
      const next = recordingsRef.current
        .filter(r => r.cameraId === rec.cameraId && new Date(r.startTime).getTime() > effectiveMs)
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0] ?? null
      if (next && next.id !== rec.id) {
        startPreviewInSlotRef.current(slotIndex, next, new Date(next.startTime), opts)
        return
      }
      nextRecBySlotRef.current[slotIndex] = null
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s, status: 'no_recording', sessionId: null, sessionType: null, errorMsg: null,
      } : s))
      return
    }

    // The slot remembers its clip bounds and real start point
    clipInfoBySlotRef.current[slotIndex] = {
      clipStartMs: recStartMs, clipEndMs: recEndMs, effectiveStartMs: effectiveMs,
    }

    // Anchor the master clock to the REAL start of this preview so the
    // toolbar clock / timeline playhead match the camera overlay exactly.
    // Skipped (noClockAnchor) when another slot is already driving the clock.
    if (!opts?.noClockAnchor) {
      setGlobalPlaybackTime(new Date(effectiveMs))
      if (masterClockRef.current) {
        masterClockRef.current = {
          wallMs: performance.now(), playheadMs: effectiveMs, rate: globalPlaybackRateRef.current,
        }
      }
      console.info(
        `[recordings-ui] preview_clock_anchor slot=${slotIndex}` +
        ` effectiveStart=${effectiveStart} clipStart=${rec.startTime} clipEnd=${rec.endTime}` +
        ` globalPlaybackTime=${effectiveStart}`
      )
    }

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
      deleteSessionOnce(existing.sessionType, existing.sessionId)
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

      const handleError = async () => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        const mediaErr = vid.error
        console.error(
          `[recordings-ui] preview_video_error slot=${slotIndex} sessionId=${sessionId}` +
          ` code=${mediaErr?.code ?? 'none'} msg=${mediaErr?.message ?? 'none'}` +
          ` forceTranscode=${forceTranscode} alreadyRetried=${previewRetriedRef.current[slotIndex] ?? false}`
        )

        // Natural end of clip disguised as an error: the stream closed after
        // playing to (near) the end of the recorded block. Some browsers fire
        // `error` instead of `ended` when the fMP4 stream terminates.
        const previewStartForEnd = previewStartTimesRef.current[slotIndex]
        const clipInfo = clipInfoBySlotRef.current[slotIndex]
        if (previewStartForEnd != null && vid.currentTime > 1 && clipInfo) {
          const positionMs  = previewStartForEnd + vid.currentTime * 1000
          const remainingMs = clipInfo.clipEndMs - positionMs
          if (remainingMs < 5_000) {
            console.info(
              `[recordings-ui] continuity_skip_error_because_natural_end slot=${slotIndex}` +
              ` position=${new Date(positionMs).toISOString()} remainingMs=${remainingMs}`
            )
            runClipContinuity('stream_closed_at_tail')
            return
          }
        }

        // Ask the backend what actually failed (FFmpeg stderr classification).
        // Retry once after a short delay: the FFmpeg exit that produces the
        // category can land milliseconds after the video element errors.
        let category: string | null = null
        let detail:   string | null = null
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const st = await apiGet<{
              category?: string | null; detail?: string | null
              errorCategory?: string | null; errorDetail?: string | null
            }>(`/recordings/preview/${sessionId}/status`, {})
            category = st.category ?? st.errorCategory ?? null
            detail   = st.detail ?? st.errorDetail ?? null
            console.info(`[recordings-ui] preview_status_loaded slot=${slotIndex} sessionId=${sessionId} category=${category ?? 'none'}`)
            if (category) break
          } catch { /* retained record may not exist yet */ }
          if (attempt === 0) await new Promise(r => setTimeout(r, 700))
        }
        if (slotKeysRef.current[slotIndex] !== myKey) return
        console.info(`[recordings-ui] preview_error_category slot=${slotIndex} category=${category ?? 'unknown'} detail=${detail ?? ''}`)

        const CATEGORY_MSG: Record<string, string> = {
          NVR_BANDWIDTH_OR_SESSION_LIMIT: 'El NVR rechazó esta segunda reproducción por límite de sesiones/ancho de banda. Probá cerrar vistas en vivo o reproducir una sola cámara de este NVR.',
          RTSP_AUTH_OR_TRACK_DENIED:      'Canal/track no autorizado por el NVR.',
          RTSP_TRACK_NOT_FOUND:           'Track de grabación no disponible.',
          NVR_OFFLINE_OR_TIMEOUT:         'El NVR no responde (timeout / conexión rechazada).',
          RTSP_OPEN_FAILED:               'No se pudo abrir RTSP de reproducción.',
          CODEC_UNSUPPORTED:              'Codec no soportado. Probá convertir a H.264.',
        }
        // H.264 transcode only fixes codec problems — never retry it for
        // bandwidth/auth/track/offline failures
        const isCodecIssue = !category || category === 'CODEC_UNSUPPORTED' || category === 'UNKNOWN'

        // Auto-retry with H.264 only when the failure is codec-related —
        // transcoding can't fix auth/track/offline errors
        if (isCodecIssue && !forceTranscode && !previewRetriedRef.current[slotIndex]) {
          previewRetriedRef.current[slotIndex] = true
          toast('Reintentando con H.264…', { duration: 5000 })
          startPreviewInSlotRef.current(slotIndex, rec, playheadTime, { forceTranscode: true })
          return
        }
        previewRetriedRef.current[slotIndex] = false
        errorCategoryBySlotRef.current[slotIndex] = category
        errorDetailBySlotRef.current[slotIndex]   = detail
        console.info(`[recordings-ui] preview_error_rendered slot=${slotIndex} category=${category ?? 'unknown'} showH264Retry=${isCodecIssue}`)
        setSlots(prev => prev.map((s, i) => i === slotIndex ? {
          ...s, status: 'error',
          errorMsg: (category && CATEGORY_MSG[category]) ?? 'No se pudo reproducir el stream del NVR',
        } : s))
      }

      const runClipContinuity = (reason: string) => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        continueSlotToNextRecording(slotIndex, reason)
      }

      const handleEnded = () => runClipContinuity('ended_event')

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

      // Continuity timer: clip expected duration + safety margin.
      // Fires even if onended/onerror never arrive (fMP4 pipe can silently close).
      if (continuityTimerRef.current[slotIndex]) clearTimeout(continuityTimerRef.current[slotIndex]!)
      const expectedDurationMs = recEndMs - effectiveMs
      continuityTimerRef.current[slotIndex] = setTimeout(() => {
        const currentSlot = slotsRef.current[slotIndex]
        if (currentSlot?.sessionId === sessionId) {
          continueSlotToNextRecording(slotIndex, 'expected_timer')
        }
      }, expectedDurationMs + 1000)

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

    // Play never requires a prior timeline click: without a playhead, start
    // from the earliest recording of the assigned/selected cameras
    let playheadMs = globalPlaybackTime ? globalPlaybackTime.getTime() : null
    if (playheadMs === null) {
      const candidateCams = new Set<string>([
        ...assignedSlots.map(s => s.cameraId!).filter(Boolean),
        ...selectedCameras,
      ])
      const earliest = recordingsRef.current
        .filter(r => candidateCams.has(r.cameraId))
        .reduce<number | null>((min, r) => {
          const t = new Date(r.startTime).getTime()
          return min === null || t < min ? t : min
        }, null)
      if (earliest !== null) {
        playheadMs = earliest
        setGlobalPlaybackTime(new Date(earliest))
      }
    }

    console.info(
      `[recordings-ui] global_play_requested` +
      ` playhead=${playheadMs !== null ? new Date(playheadMs).toISOString() : 'null'}` +
      ` readySlots=${readySlots.length} assignedSlots=${assignedSlots.length}`
    )

    // Play all slots that are already ready
    readySlots.forEach(s => videoRefs.current[s.slotIndex]?.play().catch(() => {}))

    // For assigned-but-not-ready slots: start at the playhead if a recording
    // covers it, otherwise jump to that camera's NEXT block in range
    let clockAnchored = readySlots.length > 0
    assignedSlots
      .filter(s => s.status !== 'ready')
      .forEach(slot => {
        if (!slot.cameraId) return
        if (playheadMs === null) return
        closedCamerasRef.current.delete(slot.cameraId)

        const camRecs   = recordingsByCamera.get(slot.cameraId) ?? []
        const covering  = camRecs.find(r =>
          new Date(r.startTime).getTime() <= playheadMs! && new Date(r.endTime).getTime() > playheadMs!
        )
        const target = covering ?? camRecs
          .filter(r => new Date(r.startTime).getTime() > playheadMs!)
          .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0] ?? null

        if (target) {
          console.info(
            `[recordings-ui] slot_autoload_from_playhead slot=${slot.slotIndex}` +
            ` cameraId=${slot.cameraId} recId=${target.id} covering=${!!covering}` +
            ` recStart=${target.startTime} recEnd=${target.endTime}`
          )
          const startAt = covering ? new Date(playheadMs!) : new Date(target.startTime)
          startPreviewInSlotRef.current(slot.slotIndex, target, startAt, { noClockAnchor: clockAnchored })
          clockAnchored = true
        } else {
          console.info(
            `[recordings-ui] no_recording_at_playhead slot=${slot.slotIndex}` +
            ` cameraId=${slot.cameraId} playhead=${new Date(playheadMs!).toISOString()}`
          )
          stopSlot(slot.slotIndex)
          setSlots(prev => prev.map((s, i) => i === slot.slotIndex ? {
            ...s, status: 'no_recording', recording: null, playbackUrl: null, sessionId: null,
          } : s))
        }
      })

    // Auto-assign selected cameras not yet in any slot to empty slots
    if (playheadMs !== null) {
      const assignedCamIds = new Set(currentSlots.filter(s => s.cameraId).map(s => s.cameraId!))
      const unassigned = [...selectedCameras].filter(id => !assignedCamIds.has(id))
      const emptySlotIndices = currentSlots.filter(s => !s.cameraId).map(s => s.slotIndex)

      unassigned.forEach((cameraId, idx) => {
        if (idx >= emptySlotIndices.length) return
        const si = emptySlotIndices[idx]
        closedCamerasRef.current.delete(cameraId)

        const camRecs = recordingsByCamera.get(cameraId) ?? []
        const covering = camRecs.find(r =>
          new Date(r.startTime).getTime() <= playheadMs! && new Date(r.endTime).getTime() > playheadMs!
        )
        const target = covering ?? camRecs
          .filter(r => new Date(r.startTime).getTime() > playheadMs!)
          .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0] ?? null

        if (target) {
          console.info(`[recordings-ui] play_auto_assign slot=${si} cameraId=${cameraId} recId=${target.id}`)
          const startAt = covering ? new Date(playheadMs!) : new Date(target.startTime)
          startPreviewInSlotRef.current(si, target, startAt, { noClockAnchor: clockAnchored })
          clockAnchored = true
        } else {
          const cam = cameras.find(c => c.id === cameraId)
          if (cam) {
            const nvrObj = nvrs.find(n => n.id === cam.nvrId)
            setSlots(prev => prev.map((s, i) => i === si ? {
              ...emptySlot(si),
              cameraId: cam.id, cameraName: cam.name, nvrId: cam.nvrId, nvrName: nvrObj?.name ?? '',
              status: 'no_recording',
            } : s))
          }
        }
      })
    }

    setGlobalPlaying(true)
  }

  const syncedRate = (rate: number) => {
    // Re-snapshot master clock at the current computed playhead before changing rate
    if (masterClockRef.current && globalPlaybackTime) {
      const elapsed = performance.now() - masterClockRef.current.wallMs
      masterClockRef.current = {
        wallMs:     performance.now(),
        playheadMs: masterClockRef.current.playheadMs + elapsed * masterClockRef.current.rate,
        rate,
      }
    }
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

    // Re-anchor master clock to the new seek position
    if (masterClockRef.current) {
      masterClockRef.current = { ...masterClockRef.current, wallMs: performance.now(), playheadMs: timeMs }
    }
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

  // Timeline shows only visible cameras: selected ∪ assigned to slots.
  // Closing/deselecting a camera hides its rows; results stay in memory.
  const visibleRecordings = useMemo(() => {
    const visible = new Set(selectedCameras)
    slots.forEach(s => { if (s.cameraId) visible.add(s.cameraId) })
    return recordings.filter(r => visible.has(r.cameraId))
  }, [recordings, selectedCameras, slots])

  useEffect(() => {
    const count = new Set(visibleRecordings.map(r => r.cameraId)).size
    console.info(`[recordings-ui] timeline_visible_cameras count=${count}`)
  }, [visibleRecordings])

  // Camera for the recording-days calendar: the single selected camera,
  // else the active slot's camera
  const availabilityCameraId = selectedCameras.size === 1
    ? [...selectedCameras][0]
    : (activeSlot.cameraId ?? (selectedCameras.size > 0 ? [...selectedCameras][0] : null))
  const availabilityCamera = availabilityCameraId
    ? cameras.find(c => c.id === availabilityCameraId) ?? null
    : null

  // ── Timeline range: exactly the searched range ─────────────────────────────
  const windowStartMs = searchRangeMs?.start ?? new Date(localInputToNvrIso(startDate)).getTime()
  const windowEndMs   = searchRangeMs?.end   ?? new Date(localInputToNvrIso(endDate)).getTime()

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
          onQuickSearch={(from, to) => handleSearch({ startDate: from, endDate: to })}
          isSearching={isSearching}
          cameraCount={new Set([...selectedCameras, ...slots.filter(s => s.cameraId).map(s => s.cameraId!)]).size}
          layout={layout}
          onLayoutChange={setLayout}
          availabilityCameraId={availabilityCamera?.id ?? null}
          availabilityCameraName={availabilityCamera?.name}
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
                      {slot.status === 'loading' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-surface-700/70 text-surface-300">Cargando…</span>
                      )}
                      {slot.status === 'error' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-red-900/70 text-red-300">Error</span>
                      )}
                      {slot.status === 'no_recording' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-surface-700/70 text-surface-400">Sin grabación</span>
                      )}
                      <span className="flex-1" />
                      {slot.cameraId && (
                        <button
                          onClick={e => { e.stopPropagation(); closeSlot(idx) }}
                          title="Cerrar cámara de este canal"
                          className="pointer-events-auto flex-shrink-0 p-0.5 rounded text-surface-400 hover:text-red-400 hover:bg-black/60 transition-colors"
                        >
                          <XCircle size={12} />
                        </button>
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

                    {slot.status === 'no_recording' && (() => {
                      const nextRec = nextRecBySlotRef.current[idx] ?? null
                      return (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black px-3">
                          <Clock size={18} className="text-surface-700" />
                          <span className="text-[9px] text-surface-600 text-center">Sin grabación en este momento</span>
                          {nextRec && (
                            <button
                              onClick={e => {
                                e.stopPropagation()
                                nextRecBySlotRef.current[idx] = null
                                startPreviewInSlotRef.current(idx, nextRec, new Date(nextRec.startTime))
                              }}
                              className="text-[9px] px-2 py-0.5 rounded bg-brand-700/60 hover:bg-brand-600/70 border border-brand-600/50 text-brand-300 transition-colors"
                            >
                              Saltar al siguiente bloque
                            </button>
                          )}
                        </div>
                      )
                    })()}

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

                    {slot.status === 'error' && (() => {
                      const errCategory = errorCategoryBySlotRef.current[idx] ?? null
                      const showH264 = !errCategory || errCategory === 'CODEC_UNSUPPORTED' || errCategory === 'UNKNOWN'
                      const retryLabel = errCategory === 'NVR_BANDWIDTH_OR_SESSION_LIMIT'
                        ? 'Reintentar cuando haya sesión libre'
                        : 'Reintentar'
                      return (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black px-3">
                          <AlertTriangle size={18} className="text-red-500 flex-shrink-0" />
                          <p className="text-[9px] text-surface-400 text-center line-clamp-2">
                            {slot.errorMsg ?? 'Error desconocido'}
                          </p>
                          {slot.recording && (
                            <div className="flex flex-col gap-1 items-center">
                              {showH264 && (
                                <button
                                  onClick={e => {
                                    e.stopPropagation()
                                    startPreviewInSlotRef.current(idx, slot.recording!, globalPlaybackTime ?? new Date(slot.recording!.startTime), { forceTranscode: true })
                                  }}
                                  className="text-[9px] px-2 py-0.5 rounded bg-brand-700/60 hover:bg-brand-600/70 border border-brand-600/50 text-brand-300 transition-colors"
                                >
                                  Reintentar con H.264
                                </button>
                              )}
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  startPreviewInSlotRef.current(idx, slot.recording!, globalPlaybackTime ?? new Date(slot.recording!.startTime))
                                }}
                                className="text-[9px] px-2 py-0.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-400 transition-colors"
                              >
                                {retryLabel}
                              </button>
                              {(!errCategory || errCategory === 'UNKNOWN') && errorDetailBySlotRef.current[idx] && (
                                <button
                                  onClick={e => {
                                    e.stopPropagation()
                                    toast(errorDetailBySlotRef.current[idx] ?? '', { duration: 10000 })
                                  }}
                                  className="text-[9px] px-2 py-0.5 rounded bg-surface-800 hover:bg-surface-700 border border-surface-700 text-surface-500 transition-colors"
                                >
                                  Detalles
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
          </div>
        </div>

        {/* ── Timeline ──────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 border-t border-surface-700 bg-surface-900">
          <RecordingTimeline
            recordings={visibleRecordings}
            assignedCameras={assignedCameras}
            selectedRec={activeRecording}
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
            onSelectRecording={rec => {
              // Route the recording to the slot showing its camera; fall back to
              // the first empty slot, then the active slot.
              const currentSlots = slotsRef.current
              let si = currentSlots.findIndex(s => s.cameraId === rec.cameraId)
              if (si < 0) si = currentSlots.findIndex(s => !s.cameraId)
              if (si < 0) si = activeSlotIndex
              console.info(`[recordings-ui] timeline_rec_selected recCameraId=${rec.cameraId} routedSlot=${si}`)
              startPreviewInSlotRef.current(si, rec, new Date(rec.startTime))
            }}
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
