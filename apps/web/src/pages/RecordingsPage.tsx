// src/pages/RecordingsPage.tsx
import { useEffect, useState, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Play, Clock, AlertTriangle, RefreshCw, ExternalLink,
  XCircle, Loader2, Info, Download, Video, Camera as CameraIcon,
} from 'lucide-react'
// Clock kept for slot overlays
import { useCameraStore } from '@/stores/cameraStore'
import { apiPost, apiGet, apiDelete } from '@/lib/api'
import { subHours } from 'date-fns'
import { clsx } from 'clsx'
import type { Recording } from '@/types'
import toast from 'react-hot-toast'
import { RecordingPlaybackControls } from '@/components/RecordingPlaybackControls'
import { RecordingCameraTree }  from '@/components/recordings/RecordingCameraTree'
import { RecordingSearchBar }   from '@/components/recordings/RecordingSearchBar'
import { RecordingTimeline }    from '@/components/recordings/RecordingTimeline'
import type {
  RecordingWithCamera, NvrSearchError, PlaybackLayout,
  PlaybackSlot, SlotStatus,
} from '@/components/recordings/types'
import { emptySlot } from '@/components/recordings/types'

// Estados de slot que tienen un elemento de video con media activa (URL asignada):
// el <video> debe mostrarse y las operaciones de rate/seek/continuidad aplican.
const LIVE_SLOT_STATUSES: SlotStatus[] = ['ready', 'playing', 'buffering', 'stalled']
const isLiveSlot = (s: SlotStatus) => LIVE_SLOT_STATUSES.includes(s)
import {
  toLocalDatetimeString, localInputToNvrIso, formatNvrTime, classifyError,
  selectRecordingForPlayhead,
} from '@/components/recordings/utils'
import {
  decideContinuity, canClaimTransition, clockReachedNextStart,
} from '@/components/recordings/continuity'

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
// Pure helpers live in components/recordings/utils.ts (shared with timeline)

// ─── Constants ────────────────────────────────────────────────────────────────

// Continuity tuning — overridable at build time via Vite env.
// (El antiguo umbral VITE_RECORDINGS_CONTINUITY_GAP_MS quedó obsoleto: la
// continuidad ya NO se decide por tamaño del hueco — 1x1 siempre continúa
// adelantando el reloj; multicámara espera al reloj. Ver continuity.ts.)
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

// Formatea una fecha en hora LOCAL del navegador estilo datetime-local
// (YYYY-MM-DDTHH:mm:ss), para instrumentar el desfase horario en el backend.
// No se usa para ninguna conversión: es sólo lo que el usuario ve en pantalla.
function formatBrowserLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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
  const startPreviewInSlotRef = useRef<(si: number, rec: RecordingWithCamera, playheadTime: Date, opts?: { forceTranscode?: boolean; noClockAnchor?: boolean; continuityJump?: boolean }) => void>(() => {})
  const previewStartTimesRef  = useRef<{ [k: number]: number | null }>({})
  const previewRetriedRef     = useRef<{ [k: number]: boolean }>({})
  const recordingsRef         = useRef<RecordingWithCamera[]>([])
  const nextRecBySlotRef      = useRef<{ [k: number]: RecordingWithCamera | null }>({})
  const errorCategoryBySlotRef = useRef<{ [k: number]: string | null }>({})
  const errorDetailBySlotRef   = useRef<{ [k: number]: string | null }>({})
  const clipInfoBySlotRef      = useRef<{ [k: number]: {
    clipStartMs: number; clipEndMs: number; effectiveStartMs: number
    // P1: fin EFECTIVO (recortado a searchEnd) vs fin real del bloque, separados.
    effectiveEndMs: number; originalRecordingStartMs: number; originalRecordingEndMs: number
  } | null }>({})
  // Guarda de "un solo arranque en vuelo por slot": guarda el myKey de la
  // generación que está iniciando ese slot. Evita el doble preview_start (deep
  // link + autostart del playhead disparando el mismo slot a la vez).
  const startingSlotsRef       = useRef<{ [k: number]: string | null }>({})
  // Timers de detección de estancamiento (currentTime sigue en 0 tras el arranque)
  const stallTimersRef         = useRef<{ [k: number]: ReturnType<typeof setTimeout> | null }>({})
  // Sessions already deleted — avoids duplicate DELETE from error/ended/unmount/slot-change
  const deletedSessionsRef    = useRef<Set<string>>(new Set())
  // Cameras manually closed (slot X / unchecked) — blocked from autostart
  // until the user selects or assigns them again
  const closedCamerasRef      = useRef<Set<string>>(new Set())
  // Search cache: `${cameraId}|${startIso}|${endIso}` already fetched — avoids
  // re-querying the NVR when a camera is re-selected for the same range
  const searchedKeysRef       = useRef<Set<string>>(new Set())
  const searchRangeIsoRef     = useRef<{ start: string; end: string } | null>(null)
  // Rango buscado ACTIVO en epoch ms (hora de pared del NVR). Evita closures
  // obsoletos: la selección de bloque/playhead, la continuidad, el clic en la
  // línea de tiempo y el deep-link recortan SIEMPRE contra este rango (P1).
  const activeSearchRangeRef  = useRef<{ startMs: number; endMs: number } | null>(null)
  const continuityTimerRef    = useRef<{ [k: number]: ReturnType<typeof setTimeout> | null }>({})
  // ── Continuidad UNIFICADA (P1) ──────────────────────────────────────────────
  // Lock por slot: clave (transitionKey) de la transición YA reclamada. Impide que
  // dos caminos (timer de continuidad, evento ended/error, watcher del reloj)
  // arranquen dos previews para la MISMA transición de bloque → session_init
  // duplicados/cancelados. Se limpia al re-arrancar por acción del usuario
  // (stopSlot / seek manual) para permitir re-reproducir el mismo tramo.
  const slotTransitionRef     = useRef<{ [k: number]: string | null }>({})
  // Bloque siguiente EN ESPERA (multicámara): se arranca UNA vez cuando el reloj
  // global alcanza effectiveStartMs. El watcher del reloj es el ÚNICO disparador.
  const waitingNextBySlotRef  = useRef<{ [k: number]: { rec: RecordingWithCamera; effectiveStartMs: number; effectiveEndMs: number } | null }>({})
  // Marca cosmética: el estado 'loading' de este slot proviene de un salto de
  // continuidad → mostrar "Cargando siguiente bloque…" en vez de "Conectando…".
  const continuityJumpBySlotRef = useRef<{ [k: number]: boolean }>({})

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

  // ── Deep link: /recordings?cameraId=<id>&t=<ISO> (desde Analítica) ────────
  // Busca automáticamente un rango alrededor del evento y posiciona el playhead.
  const [searchParams, setSearchParams] = useSearchParams()
  const deepLinkHandledRef = useRef(false)
  useEffect(() => {
    if (deepLinkHandledRef.current) return
    const camId = searchParams.get('cameraId')
    const t     = searchParams.get('t')
    if (!camId || !t) return
    if (cameras.length === 0) return          // esperar a que carguen las cámaras
    if (!cameras.some(c => c.id === camId)) return
    const tMs = new Date(t).getTime()
    if (isNaN(tMs)) return
    deepLinkHandledRef.current = true

    // El evento llega como instante UTC real; el NVR guarda hora de pared.
    // Convención: el navegador está en la misma zona horaria que el NVR, así
    // que la representación local del instante ES la hora de pared del NVR.
    const from = toLocalDatetimeString(new Date(tMs - 2 * 60_000))
    const to   = toLocalDatetimeString(new Date(tMs + 10 * 60_000))
    const seekWallMs = new Date(localInputToNvrIso(toLocalDatetimeString(new Date(tMs)))).getTime()

    console.info(`[recordings-ui] deep_link cameraId=${camId} t=${t} range=${from}→${to}`)
    setStartDate(from)
    setEndDate(to)
    setSelectedCameras(new Set([camId]))
    setSearchParams({}, { replace: true })
    setTimeout(() => handleSearch({ startDate: from, endDate: to, cameraIds: [camId], seekToWallMs: seekWallMs }), 0)
  }, [cameras])

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

  // ── Watcher del reloj global: ÚNICO dueño del arranque por reloj ────────────
  // Dos responsabilidades, sin competir con el timer de continuidad:
  //  1) Continuidad multicámara: un slot en 'waiting_next_recording' arranca
  //     EXACTAMENTE una vez cuando el reloj alcanza el inicio del siguiente bloque
  //     (la transición ya fue reclamada por continueSlotToNextRecording).
  //  2) Autostart legado: una cámara asignada durante la reproducción sin bloque
  //     activo aún (idle/no_recording) — NO es parte de una transición de bloque.
  const autoStartLockRef = useRef<{ [k: number]: number }>({})

  useEffect(() => {
    if (!globalPlaying || !globalPlaybackTime) return
    const playheadMs = globalPlaybackTime.getTime()

    slotsRef.current.forEach(slot => {
      if (!slot.cameraId) return
      // Manually closed cameras never autostart until re-selected/assigned
      if (closedCamerasRef.current.has(slot.cameraId)) return

      // (1) Continuidad multicámara: esperar el reloj y arrancar UNA sola vez.
      if (slot.status === 'waiting_next_recording') {
        const waiting = waitingNextBySlotRef.current[slot.slotIndex]
        if (!waiting) return
        if (!clockReachedNextStart(playheadMs, waiting.effectiveStartMs)) return
        if (startingSlotsRef.current[slot.slotIndex]) return

        // Arrancar en el PLAYHEAD ACTUAL, no en el inicio programado. Si el watcher
        // corre tarde (throttling de pestaña en segundo plano, ended tardío,
        // navegador suspendido) el reloj ya pasó effectiveStart: arrancar en el
        // inicio del bloque dejaría esta cámara ATRÁS del resto (review Codex #123).
        const range = activeSearchRangeRef.current
        let startRec = waiting.rec
        let startAt  = new Date(playheadMs)
        if (playheadMs >= waiting.effectiveEndMs) {
          // Tras una suspensión larga el bloque en espera quedó OBSOLETO (el reloj
          // lo pasó por completo): reseleccionar el que cubre el playhead dentro del
          // rango; si no hay, soltar la espera y dejar al autostart legado.
          const sel = range
            ? selectRecordingForPlayhead(
                recordingsRef.current.filter(r => r.cameraId === slot.cameraId),
                range.startMs, range.endMs, playheadMs, MIN_PREVIEW_DURATION_MS,
              )
            : null
          if (!sel?.targetRecording) {
            waitingNextBySlotRef.current[slot.slotIndex] = null
            slotTransitionRef.current[slot.slotIndex] = null
            setSlots(prev => prev.map((s, i) => i === slot.slotIndex ? { ...s, status: 'no_recording' } : s))
            return
          }
          startRec = sel.targetRecording
          startAt  = new Date(sel.effectiveStartMs)
        }
        waitingNextBySlotRef.current[slot.slotIndex] = null
        console.info(
          `[recordings-ui] continuity_next_started slot=${slot.slotIndex} recId=${startRec.id}` +
          ` startAt=${startAt.toISOString()} advanceClock=false trigger=clock`
        )
        // No re-anclar el reloj: lo maneja(n) la(s) otra(s) cámara(s).
        startPreviewInSlotRef.current(
          slot.slotIndex, startRec, startAt,
          { noClockAnchor: true, continuityJump: true },
        )
        return
      }

      // (2) Autostart legado: sólo slots SIN transición de bloque en curso.
      if (slot.status !== 'no_recording' && slot.status !== 'idle') return
      // Ya hay un arranque en vuelo para este slot (p.ej. el deep link) → no
      // iniciar un segundo preview que cancelaría el primero (doble preview_start).
      if (startingSlotsRef.current[slot.slotIndex]) return

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
            const range = activeSearchRangeRef.current
            const clockMs = clock
              ? clock.playheadMs + (performance.now() - clock.wallMs) * clock.rate
              : null
            // Selección con recorte al rango activo (P1): playhead = reloj actual o
            // inicio del rango; nunca el bloque más nuevo por defecto.
            if (!range) return
            const requestedPlayheadMs = clockMs ?? range.startMs
            const sel = selectRecordingForPlayhead(mapped, range.startMs, range.endMs, requestedPlayheadMs, MIN_PREVIEW_DURATION_MS)
            if (sel.targetRecording) {
              console.info(`[recordings-ui] incremental_autostart slot=${emptySi} cameraId=${cameraId} recId=${sel.targetRecording.id} effectiveStart=${new Date(sel.effectiveStartMs).toISOString()} reason=${sel.reason}`)
              startPreviewInSlotRef.current(emptySi, sel.targetRecording, new Date(sel.effectiveStartMs), { noClockAnchor: true })
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
    // Descartar cualquier transición de continuidad pendiente de este slot.
    slotTransitionRef.current[slotIndex] = null
    waitingNextBySlotRef.current[slotIndex] = null
    continuityJumpBySlotRef.current[slotIndex] = false
    slotKeysRef.current[slotIndex] = null
    previewStartTimesRef.current[slotIndex] = null
    if (videoCleanupRef.current[slotIndex]) {
      videoCleanupRef.current[slotIndex]!()
      videoCleanupRef.current[slotIndex] = null
    }
    const vid = videoRefs.current[slotIndex]
    if (vid) { vid.src = ''; vid.load() }
    resetZoom(slotIndex)
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

    const currentEndMs = new Date(rec.endTime).getTime()
    // La continuidad NO debe pasar de searchEnd: buscar el siguiente bloque DENTRO
    // del rango activo, con el playhead recortado (P1). Se toma como playhead el fin
    // efectivo del bloque actual (recortado a searchEnd por clipInfo).
    const range = activeSearchRangeRef.current
    const rangeStartMs = range?.startMs ?? -Infinity
    const rangeEndMs   = range?.endMs   ??  Infinity
    const clip = clipInfoBySlotRef.current[slotIndex]
    const currentEffectiveEndMs = clip?.effectiveEndMs ?? Math.min(currentEndMs, rangeEndMs)
    const nextSel = selectRecordingForPlayhead(
      recordingsRef.current.filter(r => r.cameraId === cameraId && r.id !== rec.id),
      rangeStartMs === -Infinity ? currentEffectiveEndMs : rangeStartMs,
      rangeEndMs === Infinity ? Number.MAX_SAFE_INTEGER : rangeEndMs,
      currentEffectiveEndMs, MIN_PREVIEW_DURATION_MS,
    )
    const nextRec = nextSel.targetRecording
    // ¿Hay otras cámaras reproduciendo? Determina si este slot MANEJA el reloj
    // (1x1 / única cámara → adelanta el reloj) o debe ESPERARLO (multicámara).
    const otherSlotsPlaying = slotsRef.current.some((s, i) => i !== slotIndex && isLiveSlot(s.status))

    // Decisión ÚNICA y pura de la transición (módulo continuity.ts). Reemplaza el
    // antiguo umbral CONTINUITY_GAP_MS + botón manual: en 1x1 SIEMPRE continúa
    // automáticamente (adelantando el reloj sobre el aire muerto); en multicámara
    // espera al reloj sin adelantarlo.
    const decision = decideContinuity({
      slotIndex,
      currentRecordingId: rec.id,
      currentEffectiveEndMs,
      next: nextRec
        ? { recordingId: nextRec.id, effectiveStartMs: nextSel.effectiveStartMs, effectiveEndMs: nextSel.effectiveEndMs }
        : null,
      otherSlotsPlaying,
    })

    // Sin siguiente bloque en el rango → detener (no hay nada que continuar).
    if (decision.action === 'none') {
      console.info(
        `[recordings-ui] continuity_no_next_clip slot=${slotIndex}` +
        ` playhead=${new Date(endedAtMs).toISOString()}`
      )
      slotTransitionRef.current[slotIndex] = null
      waitingNextBySlotRef.current[slotIndex] = null
      nextRecBySlotRef.current[slotIndex] = null
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s, status: 'no_recording', sessionId: null, sessionType: null, errorMsg: null,
      } : s))
      setGlobalPlaying(false)
      return
    }

    // Lock por slot: si ESTA transición ya fue reclamada (ended + timer + error de
    // cola disparando a la vez, o el watcher del reloj), suprimir el 2.º arranque.
    if (decision.transitionKey && !canClaimTransition(slotTransitionRef.current[slotIndex], decision.transitionKey)) {
      console.info(
        `[recordings-ui] continuity_duplicate_suppressed slot=${slotIndex} reason=${reason}` +
        ` transitionKey=${decision.transitionKey}`
      )
      return
    }
    slotTransitionRef.current[slotIndex] = decision.transitionKey
    console.info(
      `[recordings-ui] continuity_transition_claimed slot=${slotIndex} reason=${reason}` +
      ` action=${decision.action} decisionReason=${decision.reason} gapMs=${decision.gapMs}` +
      ` transitionKey=${decision.transitionKey}`
    )

    if (decision.action === 'wait_clock') {
      // Multicámara: NO adelantar el reloj (otras cámaras lo manejan). Guardar el
      // siguiente bloque y esperar: el watcher del reloj (único dueño) lo arranca
      // UNA vez al alcanzar effectiveStart. UI: "Esperando siguiente bloque…".
      waitingNextBySlotRef.current[slotIndex] = {
        rec: nextRec!, effectiveStartMs: nextSel.effectiveStartMs, effectiveEndMs: nextSel.effectiveEndMs,
      }
      nextRecBySlotRef.current[slotIndex] = nextRec
      console.info(
        `[recordings-ui] continuity_waiting_gap slot=${slotIndex} gapMs=${decision.gapMs}` +
        ` nextStart=${new Date(nextSel.effectiveStartMs).toISOString()} recId=${nextRec!.id}`
      )
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s, status: 'waiting_next_recording', sessionId: null, sessionType: null, errorMsg: null,
      } : s))
      return
    }

    // start_now: 1x1 adelanta el reloj al siguiente bloque (advanceClock) o solape
    // multicámara inmediato. Un ÚNICO startPreviewInSlot / session_init.
    waitingNextBySlotRef.current[slotIndex] = null
    nextRecBySlotRef.current[slotIndex] = null
    if (decision.advanceClock) {
      console.info(
        `[recordings-ui] continuity_auto_jump slot=${slotIndex} gapMs=${decision.gapMs}` +
        ` from=${rec.endTime} to=${new Date(nextSel.effectiveStartMs).toISOString()} recId=${nextRec!.id}`
      )
    }
    console.info(
      `[recordings-ui] continuity_next_started slot=${slotIndex} recId=${nextRec!.id}` +
      ` effectiveStart=${new Date(nextSel.effectiveStartMs).toISOString()} advanceClock=${decision.advanceClock} trigger=${reason}`
    )
    // advanceClock ⇒ anclar el reloj (noClockAnchor=false) para saltar el hueco;
    // solape multicámara ⇒ no re-anclar (noClockAnchor=true).
    startPreviewInSlotRef.current(
      slotIndex, nextRec!, new Date(nextSel.effectiveStartMs),
      { noClockAnchor: !decision.advanceClock, continuityJump: true },
    )
  }

  // (Re)programs the continuity timer for a slot from the REMAINING clip time,
  // adjusted by playback rate. Called on preview start, resume, rate change and
  // manual seeks — pause clears it so a paused clip never advances.
  const scheduleContinuityTimer = (slotIndex: number, sessionId: string) => {
    if (continuityTimerRef.current[slotIndex]) {
      clearTimeout(continuityTimerRef.current[slotIndex]!)
      continuityTimerRef.current[slotIndex] = null
    }
    const clip = clipInfoBySlotRef.current[slotIndex]
    const previewStart = previewStartTimesRef.current[slotIndex]
    if (!clip || previewStart == null) return
    const vid = videoRefs.current[slotIndex]
    const playedMs = (vid?.currentTime ?? 0) * 1000
    // Usar el fin EFECTIVO (recortado a searchEnd), no el fin real del bloque:
    // la reproducción debe detenerse en searchEnd (P1).
    const remainingMs = clip.effectiveEndMs - (previewStart + playedMs)
    const rate = globalPlaybackRateRef.current || 1
    const fireInMs = Math.max(0, remainingMs / rate) + 1000
    continuityTimerRef.current[slotIndex] = setTimeout(() => {
      continuityTimerRef.current[slotIndex] = null
      const currentSlot = slotsRef.current[slotIndex]
      if (currentSlot?.sessionId === sessionId && globalPlayingRef.current) {
        continueSlotToNextRecording(slotIndex, 'expected_timer')
      }
    }, fireInMs)
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

    // If we already have recordings for this camera, auto-load via preview.
    // Selección con recorte al rango buscado (P1): cubrir el playhead actual (o el
    // inicio del rango) — NUNCA camRecs[0] (el bloque más nuevo).
    const camRecs = recordingsByCamera.get(cameraId)
    const range = activeSearchRangeRef.current
    if (camRecs && camRecs.length > 0 && range) {
      const requestedPlayheadMs = globalPlaybackTime ? globalPlaybackTime.getTime() : range.startMs
      const sel = selectRecordingForPlayhead(camRecs, range.startMs, range.endMs, requestedPlayheadMs, MIN_PREVIEW_DURATION_MS)
      if (sel.targetRecording) {
        console.info(`[recordings-ui] slot_camera_assigned_autoload slot=${activeSlotIndex} cameraId=${cameraId} recId=${sel.targetRecording.id} effectiveStart=${new Date(sel.effectiveStartMs).toISOString()} reason=${sel.reason}`)
        const target = sel.targetRecording
        const playhead = new Date(sel.effectiveStartMs)
        setTimeout(() => startPreviewInSlotRef.current(activeSlotIndex, target, playhead), 0)
      } else {
        setSlots(prev => prev.map((s, i) => i === activeSlotIndex ? { ...s, status: 'no_recording' } : s))
      }
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  const handleSearch = async (dateOverride?: { startDate: string; endDate: string; cameraIds?: string[]; seekToWallMs?: number }) => {
    const assignedCameraIds = new Set(slotsRef.current.filter(s => s.cameraId).map(s => s.cameraId!))
    // cameraIds override: used by deep links (/recordings?cameraId=&t=) where
    // React state hasn't committed yet when the search fires
    const effectiveCameraIds = new Set([...(dateOverride?.cameraIds ?? [...selectedCameras]), ...assignedCameraIds])

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
    const searchStartMs = start.getTime()
    const searchEndMs   = end.getTime()
    setSearchRangeMs({ start: searchStartMs, end: searchEndMs })
    activeSearchRangeRef.current = { startMs: searchStartMs, endMs: searchEndMs }

    // Playhead inicial: el punto del deep-link, o el INICIO del rango buscado —
    // NUNCA earliest.startTime (el bloque más viejo). Antes se usaba earliest y se
    // arrancaba en camRecs[0] (el más NUEVO), produciendo previews en 14:58 / 12:54
    // para una búsqueda 14:14→15:14 (P1).
    const seekMs = dateOverride?.seekToWallMs ?? null
    const requestedPlayheadMs = seekMs ?? searchStartMs
    if (all.length > 0) {
      setGlobalPlaybackTime(new Date(Math.min(Math.max(requestedPlayheadMs, searchStartMs), searchEndMs)))
    }

    // Auto-assign: if exactly 1 camera searched and no slot has a camera assigned, assign to active slot
    const searchedCams = dateOverride?.cameraIds ?? [...selectedCameras]
    if (all.length > 0 && searchedCams.length === 1 && assignedCameraIds.size === 0) {
      const singleCamId = searchedCams[0]
      const cam = cameras.find(c => c.id === singleCamId)
      const nvrObj = cam ? nvrs.find(n => n.id === cam.nvrId) : null
      const camRecs = all.filter(r => r.cameraId === singleCamId)
      // Selección CORRECTA: bloque que cubre el playhead (o el siguiente dentro del
      // rango), con start/end recortados al rango y al bloque. Nunca el último bloque.
      const sel = selectRecordingForPlayhead(camRecs, searchStartMs, searchEndMs, requestedPlayheadMs, MIN_PREVIEW_DURATION_MS)
      console.info(
        `[recordings-ui] initial_playhead cameraId=${singleCamId} searchStart=${new Date(searchStartMs).toISOString()}` +
        ` searchEnd=${new Date(searchEndMs).toISOString()} requestedPlayhead=${new Date(requestedPlayheadMs).toISOString()}` +
        ` targetRecStart=${sel.targetRecording?.startTime ?? 'none'} targetRecEnd=${sel.targetRecording?.endTime ?? 'none'}` +
        ` effectiveStart=${sel.reason !== 'none' ? new Date(sel.effectiveStartMs).toISOString() : 'none'}` +
        ` effectiveEnd=${sel.reason !== 'none' ? new Date(sel.effectiveEndMs).toISOString() : 'none'} selectionReason=${sel.reason}`
      )
      if (cam && sel.targetRecording) {
        console.info(`[recordings-ui] search_auto_assign cameraId=${singleCamId} slot=${activeSlotIndex} seek=${seekMs ?? 'none'}`)
        stopSlot(activeSlotIndex)
        setSlots(prev => prev.map((s, i) => i === activeSlotIndex ? {
          ...s,
          cameraId: cam.id, cameraName: cam.name, nvrId: cam.nvrId, nvrName: nvrObj?.name ?? '',
          recording: null, status: 'idle', playbackUrl: null, sessionId: null, sessionType: null,
          downloadUrl: null, errorMsg: null, vodProgress: null, mimeType: null,
        } : s))
        // Deep link (Ver grabación desde un evento): activar el estado global de
        // reproducción ANTES de iniciar el preview. Sin esto, startPreviewInSlot ve
        // globalPlayingRef.current=false y nunca ejecuta play() → el video queda en
        // 0:00. Se setea el ref de forma síncrona (no depender de que React confirme
        // el estado) además de setGlobalPlaying para la UI.
        if (seekMs !== null) {
          globalPlayingRef.current = true
          setGlobalPlaying(true)
          console.info('[recordings-ui] recordings_deep_link_autoplay_armed')
        }
        const target = sel.targetRecording
        const playhead = new Date(sel.effectiveStartMs)
        setTimeout(() => startPreviewInSlotRef.current(activeSlotIndex, target, playhead), 0)
      } else if (cam) {
        // Sin bloque en este punto del rango → no iniciar preview.
        setSlots(prev => prev.map((s, i) => i === activeSlotIndex ? {
          ...s, cameraId: cam.id, cameraName: cam.name, nvrId: cam.nvrId, nvrName: nvrObj?.name ?? '',
          recording: null, status: 'no_recording', playbackUrl: null, sessionId: null, sessionType: null,
          downloadUrl: null, errorMsg: null,
        } : s))
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

  // Arma un detector de estancamiento para un slot: si tras `ms` el video no
  // avanzó (currentTime sigue en 0) y sigue siendo la misma sesión, lo pasa a
  // 'stalled'. A nivel de componente para usarse tanto al iniciar el preview como
  // al presionar Play sobre un slot que ya está en 'buffering'.
  const armStallTimer = (slotIndex: number, sessionId: string | null, ms = 5000) => {
    if (stallTimersRef.current[slotIndex]) clearTimeout(stallTimersRef.current[slotIndex]!)
    stallTimersRef.current[slotIndex] = setTimeout(() => {
      const v = videoRefs.current[slotIndex]
      if (v && v.currentTime > 0) return                 // ya avanza
      const s = slotsRef.current[slotIndex]
      if (!s || (sessionId && s.sessionId !== sessionId)) return  // otra sesión reemplazó
      if (s.status === 'playing') return
      console.warn(`[recordings-ui] preview_stalled slot=${slotIndex} sessionId=${sessionId} currentTime=0`)
      setSlots(prev => prev.map((x, i) => i === slotIndex
        ? { ...x, status: 'stalled', errorMsg: 'El video no avanzó — el origen puede no estar entregando datos.' } : x))
    }, ms)
  }

  // ── Preview streaming ─────────────────────────────────────────────────────
  // Starts an fMP4 stream directly from NVR RTSP → browser <video>.
  // Starts in 1-3s instead of waiting for full MP4 generation.
  const startPreviewInSlot = async (
    slotIndex:    number,
    rec:          RecordingWithCamera,
    playheadTime: Date,
    opts?:        { forceTranscode?: boolean; noClockAnchor?: boolean; continuityJump?: boolean },
  ) => {
    const forceTranscode = opts?.forceTranscode ?? false
    // Clave de arranque = grabación + punto efectivo (a nivel de segundo). El
    // dedupe idempotente descarta un segundo arranque SÓLO si apunta a la misma
    // grabación Y al mismo punto — así cubre la carrera deep link + autostart del
    // playhead (mismo tiempo → doble preview_start), pero NO descarta un seek
    // legítimo de la línea de tiempo a la misma grabación en otro momento (que sí
    // debe re-arrancar en el nuevo punto). Un retry H.264 (forceTranscode) también.
    const recStartMs0 = new Date(rec.startTime).getTime()
    const recEndMs0   = new Date(rec.endTime).getTime()
    const effKey = `${rec.id}:${Math.round(Math.max(recStartMs0, Math.min(playheadTime.getTime(), recEndMs0 - 1000)) / 1000)}`
    if (!forceTranscode && startingSlotsRef.current[slotIndex] === effKey) {
      console.info(`[recordings-ui] preview_start_deduped slot=${slotIndex} effKey=${effKey} reason=already_starting_same_point`)
      return
    }
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
    // Recortar SIEMPRE al rango buscado activo (P1): el preview no puede empezar
    // antes de searchStart ni terminar después de searchEnd. Sin esto, un bloque
    // que empieza antes del rango arrancaba en su propio inicio (12:54) y uno que
    // termina después seguía hasta rec.endTime (15:14:41 en vez de 15:14:00).
    const range = activeSearchRangeRef.current
    const rangeStartMs = range?.startMs ?? -Infinity
    const rangeEndMs   = range?.endMs   ??  Infinity
    const effectiveEndMs = Math.min(recEndMs, rangeEndMs)
    const effectiveMs    = Math.max(recStartMs, rangeStartMs, Math.min(playheadMs, effectiveEndMs - 1000))
    const effectiveStart = new Date(effectiveMs).toISOString()
    const effectiveEnd   = new Date(effectiveEndMs).toISOString()

    // Never open a preview shorter than MIN_PREVIEW_DURATION_MS — the playhead
    // is at the tail of this block (o del rango), so jump to the next block instead
    const remainingMs = effectiveEndMs - effectiveMs
    if (remainingMs < MIN_PREVIEW_DURATION_MS) {
      console.info(`[recordings-ui] continuity_skip_short_clip slot=${slotIndex} durationMs=${remainingMs} recId=${rec.id}`)
      // Siguiente bloque DENTRO del rango buscado (no arrancar uno posterior a searchEnd).
      const nextSel = selectRecordingForPlayhead(
        recordingsRef.current.filter(r => r.cameraId === rec.cameraId),
        rangeStartMs === -Infinity ? recStartMs : rangeStartMs,
        rangeEndMs === Infinity ? recEndMs : rangeEndMs,
        effectiveMs + 1000, MIN_PREVIEW_DURATION_MS,
      )
      if (nextSel.targetRecording && nextSel.targetRecording.id !== rec.id) {
        startPreviewInSlotRef.current(slotIndex, nextSel.targetRecording, new Date(nextSel.effectiveStartMs), opts)
        return
      }
      nextRecBySlotRef.current[slotIndex] = null
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s, status: 'no_recording', sessionId: null, sessionType: null, errorMsg: null,
      } : s))
      return
    }

    // El slot recuerda los límites del bloque ORIGINAL y los EFECTIVOS (recortados
    // al rango). Los timers de continuidad usan effectiveEndMs, no el fin del bloque.
    clipInfoBySlotRef.current[slotIndex] = {
      clipStartMs: recStartMs, clipEndMs: recEndMs, effectiveStartMs: effectiveMs,
      effectiveEndMs, originalRecordingStartMs: recStartMs, originalRecordingEndMs: recEndMs,
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
    // Marca de arranque en vuelo (síncrona, antes de cualquier await): guarda la
    // effKey (rec+punto) para el dedupe de arriba y para que el autostart del
    // playhead no dispare un segundo preview del mismo slot en el mismo punto.
    startingSlotsRef.current[slotIndex] = effKey
    previewStartTimesRef.current[slotIndex] = null
    // Rótulo de carga: "Cargando siguiente bloque…" sólo si este arranque es un
    // salto de continuidad; un arranque manual/seek lo pone en false.
    continuityJumpBySlotRef.current[slotIndex] = opts?.continuityJump ?? false
    if (!forceTranscode) previewRetriedRef.current[slotIndex] = false
    // Cancelar cualquier detector de estancamiento previo del slot
    if (stallTimersRef.current[slotIndex]) { clearTimeout(stallTimersRef.current[slotIndex]!); stallTimersRef.current[slotIndex] = null }

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
      noAudio: false,
    } : s))

    try {
      const result = await apiPost<{ sessionId: string; streamUrl: string }>(
        '/recordings/preview/start',
        {
          cameraId:       rec.cameraId,
          slotIndex,
          startTime:      effectiveStart,
          // endTime EFECTIVO recortado a searchEnd — NO rec.endTime cuando el bloque
          // excede el rango buscado (P1: el video debe detenerse en searchEnd).
          endTime:        effectiveEnd,
          playbackURI:    (rec as any).playbackURI,
          forceTranscode,
          canPlayHevcMp4,
          // Instrumentación de zona horaria (P1): lo que el navegador ve en local
          // + su offset UTC, para auditar el desfase de punta a punta en el backend.
          browserLocal:          formatBrowserLocal(new Date(effectiveStart)),
          browserTimezoneOffset: new Date().getTimezoneOffset(),
        }
      )

      if (slotKeysRef.current[slotIndex] !== myKey) {
        // Generación obsoleta: otra llamada reemplazó este slot mientras
        // esperábamos. La sesión que el backend acaba de crear quedaría huérfana
        // (consumiendo RTSP del NVR hasta expirar) → eliminarla explícitamente.
        console.info(`[recordings-ui] preview_stale_generation slot=${slotIndex} discardedSessionId=${result.sessionId}`)
        deleteSessionOnce('preview', result.sessionId)
        // Si el arranque fue cancelado (stopSlot/cierre/cambio de layout) sin un
        // reemplazo, el marcador in-flight quedaría seteado a NUESTRA effKey y
        // trabaría futuros intentos de la misma grabación en el mismo punto.
        // Limpiarlo sólo si sigue siendo el nuestro (un reemplazo ya lo habría
        // sobrescrito con su propia clave).
        if (startingSlotsRef.current[slotIndex] === effKey) startingSlotsRef.current[slotIndex] = null
        return
      }
      if (startingSlotsRef.current[slotIndex] === effKey) startingSlotsRef.current[slotIndex] = null

      const { sessionId, streamUrl } = result
      // Track when this preview starts (video.currentTime = 0 → effectiveMs)
      previewStartTimesRef.current[slotIndex] = effectiveMs

      const vid = videoRefs.current[slotIndex]
      if (!vid) {
        // No hay elemento de video: liberar la sesión recién creada y la guarda.
        deleteSessionOnce('preview', sessionId)
        if (startingSlotsRef.current[slotIndex] === effKey) startingSlotsRef.current[slotIndex] = null
        return
      }

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
          // Comparar contra el fin EFECTIVO (recortado a searchEnd), igual que el
          // timer de continuidad: si el rango termina antes del fin del bloque, el
          // stream cierra en effectiveEnd — usar clipEndMs lo tomaría como fallo de
          // codec y reintentaría H.264 en vez de continuar (review Codex #121).
          const remainingMs = clipInfo.effectiveEndMs - positionMs
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
          RTSP_PLAYBACK_URI_REJECTED:     'El NVR rechazó la URL de reproducción. VisionCore intentó las estrategias compatibles sin recibir video.',
          CODEC_UNSUPPORTED:              'Codec de video no soportado. Probá convertir a H.264.',
          // Fallos EXCLUSIVOS de audio: el preview intenta automáticamente
          // video-only. Estos mensajes sólo se muestran si video-only TAMPOCO
          // produjo video (no son problemas de códec de video → sin retry H.264).
          AUDIO_SYNC_OR_MUX_FAILURE:      'La grabación no pudo reproducirse. La pista de audio no es compatible y el intento sin audio tampoco produjo video.',
          AUDIO_STREAM_INVALID:           'La grabación no pudo reproducirse. La pista de audio no es compatible y el intento sin audio tampoco produjo video.',
        }
        // H.264 transcode only fixes VIDEO codec problems — never retry it for
        // bandwidth/auth/track/offline NI para fallos exclusivos de audio (esos
        // se resuelven con video-only en el backend, no transcodificando video).
        const AUDIO_CATEGORIES = new Set(['AUDIO_SYNC_OR_MUX_FAILURE', 'AUDIO_STREAM_INVALID'])
        const isCodecIssue = (!category || category === 'CODEC_UNSUPPORTED' || category === 'UNKNOWN')
          && !AUDIO_CATEGORIES.has(category ?? '')

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

      // Cambia el estado del slot sólo si esta generación sigue vigente.
      const setSlotStatusIfCurrent = (status: PlaybackSlot['status'], extra?: Partial<PlaybackSlot>) => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        setSlots(prev => prev.map((s, i) => i === slotIndex ? { ...s, status, ...extra } : s))
      }
      const clearStall = () => {
        if (stallTimersRef.current[slotIndex]) { clearTimeout(stallTimersRef.current[slotIndex]!); stallTimersRef.current[slotIndex] = null }
      }

      // preview_ready del backend NO significa video reproduciéndose: sólo que se
      // creó la sesión y entregó una URL. Marcamos el slot como 'buffering' y sólo
      // pasamos a 'playing' cuando el video AVANZA de verdad (evento playing /
      // timeupdate con currentTime>0). Si nunca avanza, el stall timer lo detecta.
      const onMetadata = () => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        console.info(`[recordings-ui] media_attached slot=${slotIndex} sessionId=${sessionId} metadata_loaded`)
        // El detector de estancamiento se arma RECIÉN cuando hay media adjunto
        // (metadata), no mientras el backend espera el primer byte del NVR (que
        // puede tardar ~13-15 s). Antes se armaba al iniciar y marcaba 'stalled'
        // falsamente a los 5 s, mostrando error y luego reproduciendo.
        if (globalPlayingRef.current) armStallTimer(slotIndex, sessionId)
      }
      let noAudioChecked = false
      const onPlaying = () => {
        if (slotKeysRef.current[slotIndex] !== myKey) return
        clearStall()
        console.info(`[recordings-ui] preview_playing slot=${slotIndex} sessionId=${sessionId}`)
        setSlotStatusIfCurrent('playing')
        // Fetch único: ¿el backend cayó a video-only? → badge discreto "Sin audio"
        // (el video reproduce normalmente; NO es un error).
        if (!noAudioChecked) {
          noAudioChecked = true
          apiGet<{ videoOnly?: boolean | null }>(`/recordings/preview/${sessionId}/status`, {})
            .then((st) => {
              if (slotKeysRef.current[slotIndex] !== myKey) return
              if (st.videoOnly) {
                setSlots(prev => prev.map((s, i) => i === slotIndex ? { ...s, noAudio: true } : s))
              }
            })
            .catch(() => { /* status opcional: si falla, sin badge */ })
        }
      }
      const onTimeUpdate = () => {
        if (vid.currentTime > 0) { clearStall(); setSlotStatusIfCurrent('playing') }
      }
      const onCanPlay = () => {
        // Media lista. Si NO hay intención de reproducir (pausado), queda 'ready';
        // si hay intención, asegurar el detector de estancamiento (por si no llegó
        // loadedmetadata primero).
        if (!globalPlayingRef.current) setSlotStatusIfCurrent('ready')
        else if (!stallTimersRef.current[slotIndex]) armStallTimer(slotIndex, sessionId)
      }

      ;(videoCleanupRef.current[slotIndex] as (() => void) | null)?.()
      vid.addEventListener('error', handleError)
      vid.addEventListener('ended', handleEnded)
      vid.addEventListener('loadedmetadata', onMetadata)
      vid.addEventListener('playing', onPlaying)
      vid.addEventListener('timeupdate', onTimeUpdate)
      vid.addEventListener('canplay', onCanPlay)
      videoCleanupRef.current[slotIndex] = () => {
        vid.removeEventListener('error', handleError)
        vid.removeEventListener('ended', handleEnded)
        vid.removeEventListener('loadedmetadata', onMetadata)
        vid.removeEventListener('playing', onPlaying)
        vid.removeEventListener('timeupdate', onTimeUpdate)
        vid.removeEventListener('canplay', onCanPlay)
        clearStall()
      }

      // Slot con URL pero aún sin datos confirmados de FFmpeg → 'buffering'.
      setSlots(prev => prev.map((s, i) => i === slotIndex ? {
        ...s,
        status: 'buffering',
        playbackUrl: streamUrl,
        mimeType: 'video/mp4',
        sessionId,
        sessionType: 'preview',
        downloadUrl: null,
        vodProgress: null,
      } : s))
      console.info(`[recordings-ui] preview_ready slot=${slotIndex} sessionId=${sessionId} (session created — awaiting real playback)`)

      vid.src = streamUrl
      vid.playbackRate = globalPlaybackRateRef.current

      if (globalPlayingRef.current) {
        // play() con manejo REAL de errores. Un AbortError cuando esta generación
        // ya fue reemplazada (seek/continuidad/cambio de cámara) es una transición
        // ESPERADA, no un fallo: no se registra como error ni marca el slot.
        const tryPlay = (phase: string) =>
          vid.play()
            .then(() => console.info(`[recordings-ui] preview_play_ok slot=${slotIndex} phase=${phase} sessionId=${sessionId}`))
            .catch((e: Error) => {
              const superseded = slotKeysRef.current[slotIndex] !== myKey
              if (e.name === 'AbortError' && superseded) {
                console.info(`[recordings-ui] play_aborted_superseded slot=${slotIndex} phase=${phase} — transición esperada`)
                return
              }
              console.warn(`[recordings-ui] preview_play_failed slot=${slotIndex} phase=${phase} reason=${e.name}:${e.message}`)
              if (phase === 'immediate' && !superseded) {
                const retry = () => { vid.removeEventListener('canplay', retry); if (slotKeysRef.current[slotIndex] === myKey && globalPlayingRef.current) tryPlay('canplay') }
                vid.addEventListener('canplay', retry)
              } else if (e.name === 'NotAllowedError') {
                // Autoplay bloqueado por el navegador → estado accionable
                setSlotStatusIfCurrent('stalled', { errorMsg: 'Reproducción automática bloqueada — presioná Play' })
              }
            })
        tryPlay('immediate')

        // Watchdog PRE-metadata con deadline largo (30 s): cubre el caso en que
        // FFmpeg emite un chunk inicial pero se estanca antes de que el navegador
        // llegue a loadedmetadata/canplay (que limpian los timers del backend) —
        // sin esto el slot podría quedar en 'buffering' sin watchdog. onMetadata/
        // onCanPlay lo REEMPLAZAN por el detector corto (5 s) ya con media adjunto.
        armStallTimer(slotIndex, sessionId, 30_000)
        scheduleContinuityTimer(slotIndex, sessionId)
      } else {
        // Sin intención de reproducir: cargar metadatos para poder mostrar frame.
        vid.load()
      }

      if (startingSlotsRef.current[slotIndex] === effKey) startingSlotsRef.current[slotIndex] = null

    } catch (err: any) {
      if (startingSlotsRef.current[slotIndex] === effKey) startingSlotsRef.current[slotIndex] = null
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
      slotsRef.current.forEach((_, i) => {
        videoRefs.current[i]?.pause()
        // A paused clip must never advance to the next block
        if (continuityTimerRef.current[i]) {
          clearTimeout(continuityTimerRef.current[i]!)
          continuityTimerRef.current[i] = null
        }
      })
      setGlobalPlaying(false)
      return
    }

    // Activar la intención de reproducción de forma SÍNCRONA antes de iniciar
    // cualquier preview. globalPlayingRef se sincroniza vía useEffect (tras el
    // render); si arrancamos un preview antes, startPreviewInSlot leería false y
    // nunca llamaría a play() → el slot quedaría cargado pero en 0:00.
    globalPlayingRef.current = true

    const currentSlots   = slotsRef.current
    // Slots ya con media (URL) que sólo necesitan play() — incluye pausados
    // ('ready') y los que estaban esperando datos ('buffering'/'stalled').
    const readySlots     = currentSlots.filter(s => s.playbackUrl && (s.status === 'ready' || s.status === 'buffering' || s.status === 'playing' || s.status === 'stalled'))
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

    // Play all slots that are already ready and re-arm their continuity
    // timers from the remaining clip time
    readySlots.forEach(s => {
      // No ocultar el error de play(): registrar la causa (AbortError, autoplay
      // bloqueado, formato, etc.) en vez de tragarla silenciosamente.
      videoRefs.current[s.slotIndex]?.play()
        .catch((e: Error) => console.warn(`[recordings-ui] manual_play_failed slot=${s.slotIndex} reason=${e.name}:${e.message}`))
      if (s.sessionType === 'preview' && s.sessionId) {
        scheduleContinuityTimer(s.slotIndex, s.sessionId)
      }
      // Si el slot ya tiene media adjunto (metadata) pero no avanza, armar el
      // detector de estancamiento. NO armarlo si todavía está esperando el primer
      // byte (readyState < HAVE_METADATA) para no marcar 'stalled' prematuro.
      const vEl = videoRefs.current[s.slotIndex]
      if (s.status !== 'playing' && vEl && vEl.readyState >= 1) armStallTimer(s.slotIndex, s.sessionId)
    })

    // For assigned-but-not-ready slots: start at the playhead if a recording
    // covers it, otherwise jump to that camera's NEXT block in range.
    // Los slots en 'waiting_next_recording' quedan a cargo del watcher del reloj
    // (dueño único de la continuidad) — no arrancarlos aquí para no competir.
    let clockAnchored = readySlots.length > 0
    assignedSlots
      .filter(s => !isLiveSlot(s.status) && s.status !== 'waiting_next_recording')
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
        // Selección con recorte al rango activo (P1): cubre el playhead del reloj o
        // toma el siguiente bloque dentro del rango.
        const range = activeSearchRangeRef.current
        const sel = range
          ? selectRecordingForPlayhead(camRecs, range.startMs, range.endMs, playheadMs!, MIN_PREVIEW_DURATION_MS)
          : { targetRecording: null as RecordingWithCamera | null, effectiveStartMs: 0, reason: 'none' as const }
        const target = sel.targetRecording

        if (target) {
          console.info(`[recordings-ui] play_auto_assign slot=${si} cameraId=${cameraId} recId=${target.id} effectiveStart=${new Date(sel.effectiveStartMs).toISOString()} reason=${sel.reason}`)
          const startAt = new Date(sel.effectiveStartMs)
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
    // globalPlaybackRateRef syncs via effect after render — set it now so the
    // re-armed timers below already use the new rate
    globalPlaybackRateRef.current = rate
    slotsRef.current.forEach((s, i) => {
      const vid = videoRefs.current[i]
      if (vid && isLiveSlot(s.status)) {
        vid.playbackRate = rate
        if ('preservesPitch' in vid) (vid as any).preservesPitch = false
        if (globalPlayingRef.current && s.sessionType === 'preview' && s.sessionId) {
          scheduleContinuityTimer(i, s.sessionId)
        }
      }
    })
    setGlobalPlaybackRate(rate)
  }

  const syncedJump = (seconds: number) => {
    slotsRef.current.forEach((s, i) => {
      const vid = videoRefs.current[i]
      if (vid && isLiveSlot(s.status)) {
        vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + seconds))
        if (globalPlayingRef.current && s.sessionType === 'preview' && s.sessionId) {
          scheduleContinuityTimer(i, s.sessionId)
        }
      }
    })
  }

  const syncedFrameForward = () => {
    slotsRef.current.forEach((s, i) => {
      const vid = videoRefs.current[i]
      if (vid && isLiveSlot(s.status)) {
        vid.pause()
        vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 1 / 25)
      }
      // Frame-step is a pause: a stepped clip must not auto-advance
      if (continuityTimerRef.current[i]) {
        clearTimeout(continuityTimerRef.current[i]!)
        continuityTimerRef.current[i] = null
      }
    })
    setGlobalPlaying(false)
  }

  // ── Snapshot: capture the current frame of a slot to a PNG download ───────
  const captureSnapshot = (slotIndex: number) => {
    const vid  = videoRefs.current[slotIndex]
    const slot = slotsRef.current[slotIndex]
    if (!vid || !slot || vid.videoWidth === 0) {
      toast.error('No hay video para capturar en este canal')
      return
    }
    const canvas  = document.createElement('canvas')
    canvas.width  = vid.videoWidth
    canvas.height = vid.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(vid, 0, 0)
    const previewStart = previewStartTimesRef.current[slotIndex]
    const posMs = previewStart != null ? previewStart + vid.currentTime * 1000 : Date.now()
    const stamp = formatNvrTime(posMs, 'yyyyMMdd_HHmmss')
    const name  = `${(slot.cameraName ?? 'camara').replace(/[^\w-]+/g, '_')}_${stamp}.png`
    canvas.toBlob(blob => {
      if (!blob) { toast.error('No se pudo generar la captura'); return }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5_000)
      console.info(`[recordings-ui] snapshot_captured slot=${slotIndex} file=${name}`)
      toast.success(`Captura guardada: ${name}`)
    }, 'image/png')
  }

  // ── Digital zoom: wheel to zoom toward cursor, drag to pan, dblclick reset ─
  // State lives in refs and applies as a CSS transform on the <video> —
  // no React re-render per wheel/drag event.
  const zoomBySlotRef = useRef<{ [k: number]: { scale: number; x: number; y: number } }>({})
  const zoomDragRef   = useRef<{ idx: number; startX: number; startY: number; origX: number; origY: number } | null>(null)

  const applyZoom = (idx: number) => {
    const vid = videoRefs.current[idx]
    if (!vid) return
    const { scale = 1, x = 0, y = 0 } = zoomBySlotRef.current[idx] ?? {}
    vid.style.transform       = scale > 1 ? `translate(${x}px, ${y}px) scale(${scale})` : ''
    vid.style.transformOrigin = 'center center'
    vid.style.cursor          = scale > 1 ? 'grab' : ''
  }

  const resetZoom = (idx: number) => {
    zoomBySlotRef.current[idx] = { scale: 1, x: 0, y: 0 }
    applyZoom(idx)
  }

  const handleSlotWheel = (idx: number, e: React.WheelEvent<HTMLDivElement>) => {
    if (!slotsRef.current[idx] || !isLiveSlot(slotsRef.current[idx]!.status)) return
    const cur  = zoomBySlotRef.current[idx] ?? { scale: 1, x: 0, y: 0 }
    const dir  = e.deltaY < 0 ? 1.2 : 1 / 1.2
    const next = Math.min(8, Math.max(1, cur.scale * dir))
    if (next === cur.scale) return
    // Zoom toward the cursor position
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left - rect.width / 2
    const cy = e.clientY - rect.top - rect.height / 2
    const k  = next / cur.scale
    zoomBySlotRef.current[idx] = next === 1
      ? { scale: 1, x: 0, y: 0 }
      : { scale: next, x: (cur.x - cx) * k + cx, y: (cur.y - cy) * k + cy }
    applyZoom(idx)
  }

  const handleSlotMouseDown = (idx: number, e: React.MouseEvent<HTMLDivElement>) => {
    const z = zoomBySlotRef.current[idx]
    if (!z || z.scale <= 1) return
    e.preventDefault()
    zoomDragRef.current = { idx, startX: e.clientX, startY: e.clientY, origX: z.x, origY: z.y }
    const move = (ev: MouseEvent) => {
      const d = zoomDragRef.current
      if (!d) return
      const zz = zoomBySlotRef.current[d.idx]
      if (!zz) return
      zoomBySlotRef.current[d.idx] = { ...zz, x: d.origX + ev.clientX - d.startX, y: d.origY + ev.clientY - d.startY }
      applyZoom(d.idx)
    }
    const up = () => {
      zoomDragRef.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
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
    // Clic manual: recortar el punto al rango buscado activo (P1) antes de nada.
    const range = activeSearchRangeRef.current
    const rangeStartMs = range?.startMs ?? -Infinity
    const rangeEndMs   = range?.endMs   ??  Infinity
    const timeMs    = Math.min(Math.max(time.getTime(), rangeStartMs), rangeEndMs)
    const wasPlaying = globalPlayingRef.current
    console.info(`[recordings-ui] timeline_seek_commit playhead=${new Date(timeMs).toISOString()} wasPlaying=${wasPlaying}`)

    // Un seek manual invalida CUALQUIER transición de continuidad pendiente: libera
    // los locks por slot para poder re-reproducir el mismo tramo desde el nuevo punto.
    slotTransitionRef.current = {}
    waitingNextBySlotRef.current = {}
    // Un slot en espera (multicámara) ya no tiene bloque pendiente: si NO se
    // reproduce (seek en pausa), el path de abajo hace return temprano y lo dejaría
    // atascado en "Esperando…" (su waitingNextBySlotRef quedó vacío y Play excluye
    // ese estado). Volverlo a 'no_recording' para que Play/el watcher lo resuelvan
    // en el NUEVO punto (review Codex #123).
    setSlots(prev => prev.map(s => s.status === 'waiting_next_recording'
      ? { ...s, status: 'no_recording' } : s))

    // Re-anchor master clock to the new seek position
    if (masterClockRef.current) {
      masterClockRef.current = { ...masterClockRef.current, wallMs: performance.now(), playheadMs: timeMs }
    }
    setGlobalPlaybackTime(new Date(timeMs))

    if (!wasPlaying) return

    // Playing: restart preview from new seek point for each assigned slot
    slotsRef.current.forEach((slot, slotIndex) => {
      if (!slot.cameraId) return

      const camRecs = recordingsByCamera.get(slot.cameraId) ?? []
      // Selección con recorte al rango: cubre el punto o toma el siguiente bloque.
      const sel = selectRecordingForPlayhead(
        camRecs,
        rangeStartMs === -Infinity ? Math.min(...camRecs.map(r => new Date(r.startTime).getTime()), timeMs) : rangeStartMs,
        rangeEndMs === Infinity ? Number.MAX_SAFE_INTEGER : rangeEndMs,
        timeMs, MIN_PREVIEW_DURATION_MS,
      )

      if (!sel.targetRecording) {
        stopSlot(slotIndex)
        setSlots(prev => prev.map((s, i) => i === slotIndex ? {
          ...s, status: 'no_recording', recording: null, playbackUrl: null, sessionId: null,
        } : s))
        return
      }

      // Preview streams don't support random seek — restart from the new point
      startPreviewInSlotRef.current(slotIndex, sel.targetRecording, new Date(sel.effectiveStartMs))
    })
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  const anySlotReady   = slots.some(s => isLiveSlot(s.status))
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
                const loadLabel = continuityJumpBySlotRef.current[idx]
                  ? 'Cargando siguiente bloque…'
                  : (vodPct !== null && vodPct >= 95)
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
                    onWheel={e => handleSlotWheel(idx, e)}
                    onMouseDown={e => handleSlotMouseDown(idx, e)}
                    onDoubleClick={() => resetZoom(idx)}
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
                      {slot.status === 'playing' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-green-700/60 text-green-300">● Play</span>
                      )}
                      {slot.noAudio && isLiveSlot(slot.status) && (
                        <span
                          className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-surface-700/70 text-surface-300"
                          title="La grabación no tiene audio compatible; se reproduce sin audio."
                        >Sin audio</span>
                      )}
                      {slot.status === 'ready' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-surface-700/70 text-surface-300">Pausado</span>
                      )}
                      {slot.status === 'buffering' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-amber-800/60 text-amber-300">Buffering…</span>
                      )}
                      {slot.status === 'stalled' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-red-800/60 text-red-300" title={slot.errorMsg ?? undefined}>Sin avance</span>
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
                      {slot.status === 'waiting_next_recording' && (
                        <span className="flex-shrink-0 text-[8px] px-1 py-0.5 rounded bg-brand-800/60 text-brand-300">Esperando…</span>
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
                    {/* muted by default so autoplay/continuity is never blocked
                        by the browser audio policy — unmute via controls */}
                    <video
                      ref={el => { videoRefs.current[idx] = el }}
                      controls
                      muted
                      controlsList="nodownload"
                      className={clsx(
                        'absolute inset-0 w-full h-full bg-black',
                        isLiveSlot(slot.status) ? 'block' : 'hidden'
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

                    {slot.status === 'waiting_next_recording' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black px-3">
                        <Loader2 size={18} className="text-brand-400 animate-spin" />
                        <span className="text-[9px] text-surface-400 text-center">Esperando siguiente bloque…</span>
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

                    {slot.status === 'buffering' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 pointer-events-none">
                        <Loader2 size={20} className="text-brand-400 animate-spin" />
                        <p className="text-[10px] text-surface-300">Preparando origen de grabación…</p>
                      </div>
                    )}

                    {slot.status === 'stalled' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/70 px-3">
                        <AlertTriangle size={18} className="text-amber-500 flex-shrink-0" />
                        <p className="text-[9px] text-surface-300 text-center line-clamp-2">
                          {slot.errorMsg ?? 'El video no avanzó.'}
                        </p>
                        {slot.recording && (
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              startPreviewInSlotRef.current(idx, slot.recording!, globalPlaybackTime ?? new Date(slot.recording!.startTime))
                            }}
                            className="text-[9px] px-2 py-0.5 rounded bg-brand-700/60 hover:bg-brand-600/70 border border-brand-600/50 text-brand-300 transition-colors"
                          >
                            Reintentar
                          </button>
                        )}
                      </div>
                    )}

                    {slot.status === 'error' && (() => {
                      const errCategory = errorCategoryBySlotRef.current[idx] ?? null
                      // H.264 sólo corrige códec de VIDEO. Nunca para fallos de audio
                      // (el backend ya cae a video-only) ni para límites/auth/offline.
                      const isAudioCat = errCategory === 'AUDIO_SYNC_OR_MUX_FAILURE' || errCategory === 'AUDIO_STREAM_INVALID'
                      const showH264 = (!errCategory || errCategory === 'CODEC_UNSUPPORTED' || errCategory === 'UNKNOWN') && !isAudioCat
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

            {/* Snapshot of the active slot's current frame */}
            {isLiveSlot(activeSlot.status) && (
              <button
                onClick={() => captureSnapshot(activeSlotIndex)}
                title="Capturar imagen del canal activo (PNG)"
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md bg-surface-700 text-surface-400 hover:bg-surface-600 hover:text-surface-200 transition-colors flex-shrink-0"
              >
                <CameraIcon size={11} />
                Captura
              </button>
            )}

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
