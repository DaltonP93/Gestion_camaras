// apps/web/src/pages/AnalyticsPage.tsx
// Analítica de video con 5 pestañas: Configuración (clases/zonas/líneas/alertas
// por evento), Vista en vivo (frame anotado + estado de workers), Eventos
// (auto-refresh), Dashboard (conteos) y Forense (búsqueda con filtros).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity, Loader2, Save, Trash2, Play, RefreshCw, Plus,
  Settings, MonitorPlay, ListVideo, BarChart3, SearchCode,
  CheckCircle2, XCircle, AlertTriangle, Image as ImageIcon,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { clsx } from 'clsx'
import { api, apiGet, apiPut, resolveAssetUrl } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { SearchableCombobox, type ComboOption } from '@/components/ui/SearchableCombobox'
import { AnalyticsEventDetailModal } from '@/components/analytics/AnalyticsEventDetailModal'
import { useCameraStore } from '@/stores/cameraStore'

// ─── Tipos ────────────────────────────────────────────────────────────────

interface AnalyticsZone {
  name: string
  points: [number, number][]
  classes?: string[]
  loiteringSec?: number
  occupancyLimit?: number
}
interface AnalyticsLine {
  name: string
  start: [number, number]
  end: [number, number]
  classes?: string[]
}
interface EventAlertCfg {
  generateAlert?: boolean
  sendEmail?: boolean
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  cooldownSec?: number
}
interface AnalyticsConfig {
  cameraId: string
  enabled: boolean
  classes: string[]
  minConfidence: number
  sampleFps: number
  cooldownSec: number
  zones: AnalyticsZone[] | null
  lines: AnalyticsLine[] | null
  alertConfig: Record<string, EventAlertCfg> | null
}
interface AnalyticsEvent {
  id: string
  cameraId: string
  cameraName: string
  nvrName: string
  type: string
  className: string
  confidence: number
  zoneName: string | null
  direction: string | null
  trackId: number | null
  incidentId: string | null
  snapshotUrl: string | null
  occurredAt: string
}
interface Summary {
  totalEvents: number
  granularity: string
  kpis: {
    totalEvents: number; uniqueIncidents: number; uniqueTracks: number
    persons: number; vehicles: number; intrusions: number
    loitering: number; occupancy: number; lineCrossings: number; activeCameras: number
  }
  byType: { type: string; count: number }[]
  byClass: { className: string; count: number }[]
  byCamera: { cameraId: string; cameraName: string; count: number }[]
  lineCounts: { cameraId: string; cameraName: string; lineName: string; direction: string; count: number }[]
  series: { bucket: string; count: number }[]
}
interface WorkerStatus {
  cameraId: string
  cameraName: string
  status: string
  framesProcessed: number
  eventsSent: number
  fpsActual: number
  usingFallback: boolean
  lastError: string | null
  lastDetectionAt: number | null
  zoneOccupancy: Record<string, number>
  lineCounts: Record<string, { in: number; out: number }>
}
interface ServiceStatus {
  connected: boolean
  serviceStatus?: string
  modelLoaded?: boolean
  modelError?: string | null
  lastRefreshError?: string | null
  // Diagnóstico granular del servicio analytics
  dependenciesLoaded?: boolean | null
  importError?: string | null
  configError?: string | null
  provider?: string | null
  hint?: string | null
  bootStartedAt?: string | null
  lastBootAt?: string | null
  workersRunning?: number
  workersError?: number
  workers?: WorkerStatus[]
  error?: string
}

const CLASS_LABELS: Record<string, string> = {
  person: 'Personas', car: 'Autos', truck: 'Camiones',
  bus: 'Buses', motorcycle: 'Motos', bicycle: 'Bicicletas',
}
const TYPE_LABELS: Record<string, string> = {
  person: 'Persona', vehicle: 'Vehículo',
  zone_intrusion: 'Intrusión en zona', line_crossing: 'Cruce de línea',
  loitering: 'Permanencia', occupancy_limit: 'Aforo superado',
  zone_exit: 'Salida de zona', zone_reminder: 'Recordatorio de zona',
}
// Tipos que el usuario puede configurar como alerta (excluye los derivados de la
// máquina de estado de zona, que se emiten automáticamente).
const EVENT_TYPES = ['person', 'vehicle', 'zone_intrusion', 'line_crossing', 'loitering', 'occupancy_limit']

// Presets de rango temporal para el Dashboard (desde ahora hacia atrás).
const RANGE_PRESETS: { key: string; label: string; ms: number }[] = [
  { key: '1h',  label: 'Última hora', ms: 60 * 60 * 1000 },
  { key: '24h', label: 'Últimas 24 h', ms: 24 * 60 * 60 * 1000 },
  { key: '7d',  label: '7 días',  ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '30 días', ms: 30 * 24 * 60 * 60 * 1000 },
]
const WORKER_STATUS_LABELS: Record<string, string> = {
  running: 'En ejecución', starting: 'Iniciando', rtsp_down: 'Stream caído',
  reconnecting: 'Reconectando', disabled_due_errors: 'Deshabilitado por errores',
  stopped: 'Detenido',
}

const DEFAULT_CONFIG = (cameraId: string): AnalyticsConfig => ({
  cameraId, enabled: false, classes: ['person'],
  minConfidence: 0.5, sampleFps: 2, cooldownSec: 60,
  zones: null, lines: null, alertConfig: null,
})

type Tab = 'config' | 'live' | 'events' | 'dashboard' | 'snapshots' | 'forensic'

// Ítem de una capa del diagnóstico del servicio: ✓ ok, ✗ fallo, — desconocido.
function StatusItem({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {ok === true
        ? <CheckCircle2 size={11} className="text-green-400 flex-shrink-0" />
        : ok === false
          ? <XCircle size={11} className="text-red-400 flex-shrink-0" />
          : <span className="text-surface-500">—</span>}
      <span className="text-surface-300 truncate">{label}</span>
    </span>
  )
}

export function AnalyticsPage() {
  const navigate = useNavigate()
  const { cameras, nvrs, loadCameras, loadNVRs } = useCameraStore()
  const [tab, setTab] = useState<Tab>('config')

  const [configs, setConfigs] = useState<Map<string, AnalyticsConfig>>(new Map())
  const [supportedClasses, setSupportedClasses] = useState<string[]>(Object.keys(CLASS_LABELS))
  const [serviceConfigured, setServiceConfigured] = useState(true)
  const [selectedCameraId, setSelectedCameraId] = useState<string>('')
  const [draft, setDraft] = useState<AnalyticsConfig | null>(null)
  const [saving, setSaving] = useState(false)

  // Editor de zonas/líneas
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [drawMode, setDrawMode] = useState<'zone' | 'line'>('zone')
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([])
  const snapshotObjectUrlRef = useRef<string | null>(null)

  // Estado del servicio + vista en vivo
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [liveCameraId, setLiveCameraId] = useState<string>('')
  const [liveFrameUrl, setLiveFrameUrl] = useState<string | null>(null)
  const [liveFrameMsg, setLiveFrameMsg] = useState<string | null>(null)
  const liveFrameObjectUrlRef = useRef<string | null>(null)
  // Guards de "una sola llamada en vuelo por recurso" — evitan que el botón
  // manual y el polling automático disparen la misma request en paralelo.
  const eventsInFlight = useRef(false)

  // Eventos / forense
  const [events, setEvents] = useState<AnalyticsEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventFilterType, setEventFilterType] = useState('')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  // Filtros del Dashboard (global, desacoplado de la pestaña Eventos)
  const [dash, setDash] = useState({ range: '24h', granularity: 'hour', nvrId: '', cameraId: '', type: '' })
  const [forensic, setForensic] = useState<AnalyticsEvent[]>([])
  const [forensicLoading, setForensicLoading] = useState(false)
  const [ff, setFf] = useState({ cameraId: '', type: '', className: '', zoneName: '', direction: '', from: '', to: '' })
  // Snapshots (módulo independiente)
  const [snaps, setSnaps] = useState<AnalyticsEvent[]>([])
  const [snapsLoading, setSnapsLoading] = useState(false)
  const [snapsPage, setSnapsPage] = useState(1)
  const [snapsTotal, setSnapsTotal] = useState(0)
  const [snapFilter, setSnapFilter] = useState({ cameraId: '', type: '', order: 'desc' })
  // Visor de detalle de evento reutilizable (Eventos/Snapshots/Forense).
  // detailList = la lista a la que pertenece, para navegar anterior/siguiente.
  const [detail, setDetail] = useState<{ list: AnalyticsEvent[]; index: number } | null>(null)

  useEffect(() => { loadCameras(); loadNVRs() }, [])

  // ── Cargas ────────────────────────────────────────────────────────────
  const loadConfigs = async () => {
    try {
      const res = await apiGet<{ configs: any[]; supportedClasses: string[]; serviceConfigured: boolean }>('/analytics/config')
      setConfigs(new Map(res.configs.map(c => [c.cameraId, {
        cameraId: c.cameraId, enabled: c.enabled,
        classes: (c.classes as string[]) ?? ['person'],
        minConfidence: c.minConfidence, sampleFps: c.sampleFps,
        cooldownSec: c.cooldownSec,
        zones: (c.zones as AnalyticsZone[] | null) ?? null,
        lines: (c.lines as AnalyticsLine[] | null) ?? null,
        alertConfig: (c.alertConfig as Record<string, EventAlertCfg> | null) ?? null,
      }])))
      setSupportedClasses(res.supportedClasses)
      setServiceConfigured(res.serviceConfigured)
    } catch { /* toast global */ }
  }

  const loadServiceStatus = async (signal?: AbortSignal) => {
    try { setService((await api.get<ServiceStatus>('/analytics/service-status', { signal })).data) }
    catch (e: any) {
      if (e?.code === 'ERR_CANCELED') return
      if (e?.response?.status === 429) throw e   // deja que usePolling aplique backoff
      setService({ connected: false, error: 'sin conexión' })
    }
  }

  const loadEvents = async (signal?: AbortSignal) => {
    // Una sola carga de eventos en vuelo (botón manual + polling no se solapan).
    if (eventsInFlight.current) return
    eventsInFlight.current = true
    setEventsLoading(true)
    try {
      const res = await api.get<{ events: AnalyticsEvent[] }>('/analytics/events', {
        params: { limit: 50, ...(eventFilterType ? { type: eventFilterType } : {}) },
        signal,
      })
      setEvents(res.data.events)
    } catch (e: any) {
      if (e?.code === 'ERR_CANCELED') return
      // Re-lanzar 429 para que el poller respete Retry-After (si no, la tormenta
      // seguiría en silencio porque el interceptor suprime el toast de /analytics).
      if (e?.response?.status === 429) throw e
      /* otros errores: silencioso */
    } finally { setEventsLoading(false); eventsInFlight.current = false }
  }

  const loadSummary = async () => {
    setSummaryLoading(true)
    try {
      const preset = RANGE_PRESETS.find(p => p.key === dash.range) ?? RANGE_PRESETS[1]
      const params: Record<string, string> = {
        from: new Date(Date.now() - preset.ms).toISOString(),
        to: new Date().toISOString(),
        granularity: dash.granularity,
      }
      if (dash.nvrId) params.nvrIds = dash.nvrId
      if (dash.cameraId) params.cameraIds = dash.cameraId
      if (dash.type) params.types = dash.type
      setSummary(await apiGet<Summary>('/analytics/summary', params))
    } catch { /* noop */ } finally { setSummaryLoading(false) }
  }

  const loadSnapshots = async (page = snapsPage) => {
    setSnapsLoading(true)
    try {
      const params: Record<string, string | number> = { hasSnapshot: 'true', page, limit: 24, order: snapFilter.order }
      if (snapFilter.cameraId) params.cameraId = snapFilter.cameraId
      if (snapFilter.type) params.type = snapFilter.type
      const res = await apiGet<{ events: AnalyticsEvent[]; total: number }>('/analytics/events', params)
      setSnaps(res.events)
      setSnapsTotal(res.total)
      setSnapsPage(page)
    } catch { /* noop */ } finally { setSnapsLoading(false) }
  }

  const runForensic = async () => {
    setForensicLoading(true)
    try {
      const params: Record<string, string | number> = { limit: 100 }
      if (ff.cameraId) params.cameraId = ff.cameraId
      if (ff.type) params.type = ff.type
      if (ff.className) params.className = ff.className
      if (ff.zoneName) params.zoneName = ff.zoneName
      if (ff.direction) params.direction = ff.direction
      if (ff.from) params.from = new Date(ff.from).toISOString()
      if (ff.to) params.to = new Date(ff.to).toISOString()
      const res = await apiGet<{ events: AnalyticsEvent[] }>('/analytics/events', params)
      setForensic(res.events)
    } catch { /* noop */ } finally { setForensicLoading(false) }
  }

  // Sólo cargar configs al montar. El estado del servicio lo trae usePolling
  // (tab inicial 'config' ya lo tiene habilitado) — no llamarlo acá también,
  // evitaría la doble request inicial simultánea.
  useEffect(() => { loadConfigs() }, [])
  // Dashboard: recarga al entrar y al cambiar cualquier filtro.
  useEffect(() => { if (tab === 'dashboard') loadSummary() }, [tab, dash]) // eslint-disable-line react-hooks/exhaustive-deps
  // Snapshots: recarga al entrar y al cambiar filtros (vuelve a la página 1).
  useEffect(() => { if (tab === 'snapshots') loadSnapshots(1) }, [tab, snapFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  // Eventos: polling secuencial (10 s) sólo en la pestaña activa. Pausa oculto,
  // backoff en 429, sin solapamiento. Reemplaza setInterval fijo.
  usePolling(loadEvents, { intervalMs: 10_000, enabled: tab === 'events' })
  // Refetch inmediato al cambiar el filtro (el polling maneja la recurrencia).
  useEffect(() => { if (tab === 'events') loadEvents().catch(() => {}) }, [eventFilterType]) // eslint-disable-line react-hooks/exhaustive-deps

  // Estado del servicio: polling secuencial (10 s) en pestañas que lo muestran.
  usePolling(loadServiceStatus, { intervalMs: 10_000, enabled: tab === 'live' || tab === 'config' })

  // Vista en vivo: frame anotado cada 2 s (fetch con auth → objectURL).
  // Contrato: 200 jpeg · 204 esperando frame · 404 sin worker · 409 deshabilitada
  // · 503 servicio arrancando. 204 NO es error → no ensucia la consola.
  const fetchFrame = async (signal?: AbortSignal) => {
    if (!liveCameraId) return
    try {
      const res = await api.get(`/analytics/live-frame/${liveCameraId}`, {
        responseType: 'blob', timeout: 6_000, signal,
        // 2xx y 4xx/503 esperados se resuelven (no throw) para manejar el contrato
        validateStatus: (s) => s === 200 || s === 204 || s === 404 || s === 409 || s === 503,
      })
      if (res.status === 200) {
        const url = URL.createObjectURL(res.data)
        if (liveFrameObjectUrlRef.current) URL.revokeObjectURL(liveFrameObjectUrlRef.current)
        liveFrameObjectUrlRef.current = url
        setLiveFrameUrl(url)
        setLiveFrameMsg(null)
        return
      }
      // Sin imagen (204/404/409/503): limpiar el frame anterior para que el
      // render muestre el mensaje de estado y no una imagen vieja congelada
      // (el render prioriza liveFrameUrl sobre el mensaje).
      if (liveFrameObjectUrlRef.current) { URL.revokeObjectURL(liveFrameObjectUrlRef.current); liveFrameObjectUrlRef.current = null }
      setLiveFrameUrl(null)
      setLiveFrameMsg(
        res.status === 204 ? 'Esperando el primer frame anotado del worker…'
        : res.status === 404 ? 'Sin worker de analítica para esta cámara todavía.'
        : res.status === 409 ? 'La analítica está deshabilitada para esta cámara.'
        : 'Servicio de analítica arrancando…')
    } catch (e: any) {
      if (e?.code === 'ERR_CANCELED') return
      if (e?.response?.status === 429) throw e   // backoff en el poller
      setLiveFrameMsg('No se pudo obtener el frame.')
    }
  }
  // Polling sólo en la pestaña En vivo, con una cámara seleccionada y worker
  // no deshabilitado. Una sola request en vuelo (garantizado por usePolling).
  usePolling(fetchFrame, { intervalMs: 2_000, enabled: tab === 'live' && !!liveCameraId })
  // Al cambiar de cámara: limpiar el frame anterior y el mensaje de estado.
  useEffect(() => { setLiveFrameUrl(null); setLiveFrameMsg(null) }, [liveCameraId])

  useEffect(() => () => {
    if (snapshotObjectUrlRef.current) URL.revokeObjectURL(snapshotObjectUrlRef.current)
    if (liveFrameObjectUrlRef.current) URL.revokeObjectURL(liveFrameObjectUrlRef.current)
  }, [])

  // ── Configuración ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedCameraId) { setDraft(null); setSnapshotUrl(null); return }
    setDraft(configs.get(selectedCameraId) ?? DEFAULT_CONFIG(selectedCameraId))
    setDraftPoints([])
    setSnapshotLoading(true)
    if (snapshotObjectUrlRef.current) {
      URL.revokeObjectURL(snapshotObjectUrlRef.current)
      snapshotObjectUrlRef.current = null
    }
    setSnapshotUrl(null)
    api.get(`/cameras/${selectedCameraId}/snapshot`, { responseType: 'blob', timeout: 20_000 })
      .then(res => {
        const url = URL.createObjectURL(res.data)
        snapshotObjectUrlRef.current = url
        setSnapshotUrl(url)
      })
      .catch(() => setSnapshotUrl(null))
      .finally(() => setSnapshotLoading(false))
  }, [selectedCameraId, configs])

  const saveDraft = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await apiPut(`/analytics/config/${draft.cameraId}`, {
        enabled: draft.enabled,
        classes: draft.classes,
        minConfidence: draft.minConfidence,
        sampleFps: draft.sampleFps,
        cooldownSec: draft.cooldownSec,
        zones: draft.zones && draft.zones.length > 0 ? draft.zones : null,
        lines: draft.lines && draft.lines.length > 0 ? draft.lines : null,
        alertConfig: draft.alertConfig && Object.keys(draft.alertConfig).length > 0 ? draft.alertConfig : null,
      })
      setConfigs(prev => new Map(prev).set(draft.cameraId, draft))
      toast.success('Configuración de analítica guardada')
    } catch { /* toast global */ } finally { setSaving(false) }
  }

  const handleSnapshotClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    const pt: [number, number] = [Number(x.toFixed(4)), Number(y.toFixed(4))]
    if (drawMode === 'line') {
      if (!draft) return
      if (draftPoints.length === 0) { setDraftPoints([pt]); return }
      const name = window.prompt('Nombre de la línea de conteo:', `Línea ${(draft.lines?.length ?? 0) + 1}`)
      if (!name) { setDraftPoints([]); return }
      setDraft({ ...draft, lines: [...(draft.lines ?? []), { name: name.slice(0, 60), start: draftPoints[0], end: pt }] })
      setDraftPoints([])
      return
    }
    setDraftPoints(prev => prev.length >= 30 ? prev : [...prev, pt])
  }

  const finishZone = () => {
    if (!draft || draftPoints.length < 3) { toast.error('Una zona necesita al menos 3 puntos'); return }
    const name = window.prompt('Nombre de la zona:', `Zona ${(draft.zones?.length ?? 0) + 1}`)
    if (!name) return
    setDraft({ ...draft, zones: [...(draft.zones ?? []), { name: name.slice(0, 60), points: draftPoints }] })
    setDraftPoints([])
  }

  const setZoneField = (idx: number, field: 'loiteringSec' | 'occupancyLimit', value: string) => {
    if (!draft?.zones) return
    const n = value === '' ? undefined : Math.max(1, parseInt(value))
    setDraft({
      ...draft,
      zones: draft.zones.map((z, i) => i === idx ? { ...z, [field]: n } : z),
    })
  }

  const setAlertCfg = (evType: string, patch: Partial<EventAlertCfg>) => {
    if (!draft) return
    const cur = draft.alertConfig?.[evType] ?? {}
    setDraft({ ...draft, alertConfig: { ...(draft.alertConfig ?? {}), [evType]: { ...cur, ...patch } } })
  }

  const camerasByNvr = useMemo(() =>
    nvrs.map(nvr => ({ nvr, cams: cameras.filter(c => c.nvrId === nvr.id) }))
      .filter(g => g.cams.length > 0),
    [nvrs, cameras])

  const enabledCameras = useMemo(() =>
    [...configs.values()].filter(c => c.enabled)
      .map(c => ({ id: c.cameraId, name: cameras.find(x => x.id === c.cameraId)?.name ?? c.cameraId })),
    [configs, cameras])

  // Opciones para el combobox buscable de cámaras (agrupadas por NVR, con canal
  // y estado como texto buscable). Reemplaza el <select> nativo, inusable con 144.
  const cameraOptions: ComboOption[] = useMemo(() =>
    camerasByNvr.flatMap(({ nvr, cams }) => cams.map(c => ({
      value: c.id,
      label: c.name,
      group: nvr.name,
      sublabel: [c.channel != null ? `ch ${c.channel}` : '', c.online === false ? 'offline' : 'online']
        .filter(Boolean).join(' · '),
      badge: configs.get(c.id)?.enabled ? '● analítica activa' : undefined,
      keywords: `${nvr.name} ${c.channel ?? ''}`,
    }))),
    [camerasByNvr, configs])

  const nvrOptions: ComboOption[] = useMemo(() =>
    nvrs.map(n => ({ value: n.id, label: n.name })), [nvrs])

  const cameraSelect = (value: string, onChange: (v: string) => void, emptyLabel: string) => (
    <SearchableCombobox
      value={value}
      onChange={onChange}
      options={cameraOptions}
      emptyLabel={emptyLabel}
      placeholder={emptyLabel}
      searchPlaceholder="Buscar por cámara, NVR o canal…"
    />
  )

  // Abre el visor de detalle sobre una lista concreta (para prev/siguiente).
  const openDetail = (list: AnalyticsEvent[], ev: AnalyticsEvent) => {
    const index = list.findIndex(e => e.id === ev.id)
    setDetail({ list, index: index >= 0 ? index : 0 })
  }
  const openRecordingFor = (ev: { cameraId: string; occurredAt: string }) =>
    navigate(`/recordings?cameraId=${ev.cameraId}&t=${encodeURIComponent(ev.occurredAt)}`)

  const eventCard = (ev: AnalyticsEvent, list: AnalyticsEvent[]) => (
    <div key={ev.id} className="flex gap-3 rounded-lg bg-surface-800 border border-surface-700/60 p-2">
      {ev.snapshotUrl ? (
        <img src={resolveAssetUrl(ev.snapshotUrl) ?? undefined} alt="" loading="lazy"
          onClick={() => openDetail(list, ev)}
          className="w-28 h-16 object-cover rounded flex-shrink-0 bg-black cursor-pointer" />
      ) : <div className="w-28 h-16 rounded bg-black flex-shrink-0" />}
      <div className="min-w-0 flex-1 cursor-pointer" onClick={() => openDetail(list, ev)}>
        <p className="text-xs text-surface-200 truncate">
          <span className={clsx('inline-block px-1.5 py-0.5 rounded text-[9px] mr-1.5',
            ['zone_intrusion', 'loitering', 'occupancy_limit'].includes(ev.type)
              ? 'bg-red-900/60 text-red-300' : 'bg-surface-700 text-surface-300')}>
            {TYPE_LABELS[ev.type] ?? ev.type}
          </span>
          {ev.cameraName} · {ev.nvrName}
        </p>
        <p className="text-[10px] text-surface-500 mt-0.5">
          {CLASS_LABELS[ev.className] ?? ev.className} · {(ev.confidence * 100).toFixed(0)}%
          {ev.zoneName ? ` · ${ev.type === 'line_crossing' ? 'línea' : 'zona'} "${ev.zoneName}"` : ''}
          {ev.direction ? ` · ${ev.direction === 'in' ? 'entrada' : 'salida'}` : ''}
        </p>
        <p className="text-[10px] text-surface-500 font-mono">{new Date(ev.occurredAt).toLocaleString('es')}</p>
      </div>
      <button
        onClick={() => openRecordingFor(ev)}
        title="Ver la grabación de este momento"
        className="self-center flex-shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-brand-800/60 hover:bg-brand-700/70 text-brand-300 transition-colors"
      >
        <Play size={10} /> Ver grabación
      </button>
    </div>
  )

  const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'config',    label: 'Configuración', icon: <Settings size={13} /> },
    { key: 'live',      label: 'En vivo',       icon: <MonitorPlay size={13} /> },
    { key: 'events',    label: 'Eventos',       icon: <ListVideo size={13} /> },
    { key: 'dashboard', label: 'Dashboard',     icon: <BarChart3 size={13} /> },
    { key: 'snapshots', label: 'Snapshots',     icon: <ImageIcon size={13} /> },
    { key: 'forensic',  label: 'Forense',       icon: <SearchCode size={13} /> },
  ]

  const maxSeries = Math.max(1, ...(summary?.series ?? []).map(h => h.count))

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      {/* Header + estado del servicio */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-brand-400" />
          <h1 className="text-lg font-semibold text-surface-100">Analítica de video</h1>
        </div>
        {service && (
          <span className={clsx('flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border',
            service.connected && service.modelLoaded
              ? 'border-green-700/50 bg-green-900/20 text-green-400'
              : service.connected
                ? 'border-amber-700/50 bg-amber-900/20 text-amber-400'
                : 'border-red-700/50 bg-red-900/20 text-red-400')}>
            {service.connected && service.modelLoaded ? <CheckCircle2 size={10} /> : service.connected ? <AlertTriangle size={10} /> : <XCircle size={10} />}
            {!service.connected
              ? `Servicio desconectado${service.error ? `: ${service.error}` : ''}`
              : service.modelLoaded
                ? `Servicio activo · ${service.workersRunning ?? service.workers?.length ?? 0} worker(s)`
                : service.dependenciesLoaded === false
                  ? 'Degradado: dependencias no cargadas'
                  : `Degradado: ${service.modelError ?? 'modelo no cargado'}`}
          </span>
        )}
        <div className="flex-1" />
        <div className="flex rounded-lg overflow-hidden border border-surface-700">
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={clsx('flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors',
                tab === t.key ? 'bg-brand-800/60 text-brand-200' : 'bg-surface-800 text-surface-400 hover:text-surface-200')}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>
      </div>

      {!serviceConfigured && (
        <div className="px-3 py-2 rounded-lg bg-amber-900/20 border border-amber-700/40 text-amber-300 text-xs">
          Define <code className="font-mono">ANALYTICS_SECRET</code> en el API y en el contenedor analytics.
        </div>
      )}

      {/* Panel de diagnóstico: se muestra sólo cuando el servicio está conectado
          pero degradado (dependencias/modelo). Diferencia capas y sugiere acción,
          sin toasts repetidos (el estado se refleja aquí, no en un toast por ciclo). */}
      {service?.connected && !service.modelLoaded && (
        <div className="px-3 py-2.5 rounded-lg bg-amber-900/15 border border-amber-700/40 text-xs space-y-1.5">
          <div className="flex items-center gap-2 text-amber-300 font-medium">
            <AlertTriangle size={13} /> Servicio analítico degradado
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[11px]">
            <StatusItem ok={service.connected} label="Servicio conectado" />
            <StatusItem ok={service.dependenciesLoaded ?? undefined} label="Dependencias (cv2/onnx)" />
            <StatusItem ok={service.modelLoaded} label="Modelo cargado" />
            <StatusItem ok={(service.workersRunning ?? 0) > 0}
              label={`Workers (${service.workersRunning ?? 0} ok / ${service.workersError ?? 0} err)`} />
          </div>
          {service.provider && <p className="text-surface-400">Provider: <span className="text-surface-200">{service.provider}</span></p>}
          {(service.importError || service.modelError || service.configError) && (
            <p className="text-red-400 break-words">
              Último error: {service.importError || service.modelError || service.configError}
            </p>
          )}
          {service.hint && (
            <p className="text-amber-200 bg-amber-950/40 rounded px-2 py-1">💡 {service.hint}</p>
          )}
          {service.lastBootAt && (
            <p className="text-surface-500 text-[10px]">Último intento de arranque: {new Date(service.lastBootAt).toLocaleString()}</p>
          )}
        </div>
      )}

      {/* ══ CONFIGURACIÓN ══════════════════════════════════════════════ */}
      {tab === 'config' && (
        <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-3 max-w-3xl">
          {cameraSelect(selectedCameraId, setSelectedCameraId, 'Selecciona una cámara…')}

          {draft && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-surface-300">
                <input type="checkbox" checked={draft.enabled}
                  onChange={e => setDraft({ ...draft, enabled: e.target.checked })}
                  className="accent-brand-500" />
                Analítica habilitada en esta cámara
              </label>

              <div>
                <p className="text-[10px] text-surface-500 uppercase tracking-wide mb-1.5">Clases a detectar</p>
                <div className="flex flex-wrap gap-2">
                  {supportedClasses.map(cls => {
                    const on = draft.classes.includes(cls)
                    return (
                      <button key={cls}
                        onClick={() => setDraft({
                          ...draft,
                          classes: on ? draft.classes.filter(c => c !== cls) : [...draft.classes, cls],
                        })}
                        className={clsx('text-xs px-2.5 py-1 rounded-full border transition-colors',
                          on ? 'bg-brand-800/60 border-brand-600 text-brand-200'
                             : 'bg-surface-800 border-surface-700 text-surface-500 hover:text-surface-300')}>
                        {CLASS_LABELS[cls] ?? cls}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <label className="text-xs text-surface-400 space-y-1">
                  <span>Confianza mín. ({Math.round(draft.minConfidence * 100)}%)</span>
                  <input type="range" min={0.2} max={0.9} step={0.05} value={draft.minConfidence}
                    onChange={e => setDraft({ ...draft, minConfidence: Number(e.target.value) })}
                    className="w-full accent-brand-500" />
                </label>
                <label className="text-xs text-surface-400 space-y-1">
                  <span>Muestreo (fps)</span>
                  <input type="number" min={0.5} max={10} step={0.5} value={draft.sampleFps}
                    onChange={e => setDraft({ ...draft, sampleFps: Number(e.target.value) })}
                    className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-200" />
                </label>
                <label className="text-xs text-surface-400 space-y-1">
                  <span>Cooldown global (seg)</span>
                  <input type="number" min={5} max={3600} value={draft.cooldownSec}
                    onChange={e => setDraft({ ...draft, cooldownSec: Number(e.target.value) })}
                    className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-200" />
                </label>
              </div>

              {/* Editor de zonas/líneas */}
              <div>
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <p className="text-[10px] text-surface-500 uppercase tracking-wide">Zonas y líneas (clic sobre la imagen)</p>
                  <div className="flex rounded overflow-hidden border border-surface-700">
                    <button onClick={() => { setDrawMode('zone'); setDraftPoints([]) }}
                      className={clsx('text-[10px] px-2 py-0.5', drawMode === 'zone' ? 'bg-red-800/60 text-red-200' : 'bg-surface-800 text-surface-500')}>Zona</button>
                    <button onClick={() => { setDrawMode('line'); setDraftPoints([]) }}
                      className={clsx('text-[10px] px-2 py-0.5', drawMode === 'line' ? 'bg-amber-800/60 text-amber-200' : 'bg-surface-800 text-surface-500')}>Línea de conteo</button>
                  </div>
                  <div className="flex-1" />
                  {drawMode === 'zone' && draftPoints.length > 0 && (
                    <>
                      <button onClick={finishZone} className="text-[10px] px-2 py-0.5 rounded bg-brand-700/60 text-brand-200 flex items-center gap-1">
                        <Plus size={10} /> Cerrar zona ({draftPoints.length} pts)
                      </button>
                      <button onClick={() => setDraftPoints([])} className="text-[10px] px-2 py-0.5 rounded bg-surface-700 text-surface-400">Cancelar</button>
                    </>
                  )}
                  {drawMode === 'line' && draftPoints.length === 1 && (
                    <span className="text-[10px] text-amber-400">clic en el segundo punto…</span>
                  )}
                </div>

                <div className="relative w-full rounded-lg overflow-hidden border border-surface-700 bg-black cursor-crosshair select-none"
                  onClick={handleSnapshotClick}>
                  {snapshotLoading ? (
                    <div className="aspect-video flex items-center justify-center">
                      <Loader2 size={20} className="animate-spin text-surface-500" />
                    </div>
                  ) : snapshotUrl ? (
                    <img src={snapshotUrl} alt="snapshot" className="w-full block pointer-events-none" />
                  ) : (
                    <div className="aspect-video flex items-center justify-center text-xs text-surface-600">
                      Sin snapshot — las zonas igual pueden dibujarse sobre el área
                    </div>
                  )}
                  <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {(draft.zones ?? []).map((z, i) => (
                      <polygon key={i} points={z.points.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}
                        fill="rgba(220,38,38,0.18)" stroke="#dc2626" strokeWidth="0.4" />
                    ))}
                    {(draft.lines ?? []).map((l, i) => (
                      <line key={`l${i}`} x1={l.start[0] * 100} y1={l.start[1] * 100}
                        x2={l.end[0] * 100} y2={l.end[1] * 100} stroke="#f59e0b" strokeWidth="0.6" />
                    ))}
                    {draftPoints.length > 0 && (
                      <polyline points={draftPoints.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}
                        fill="none" stroke="#f59e0b" strokeWidth="0.4" />
                    )}
                    {draftPoints.map(([x, y], i) => (
                      <circle key={i} cx={x * 100} cy={y * 100} r="0.8" fill="#f59e0b" />
                    ))}
                  </svg>
                </div>

                {((draft.zones ?? []).length > 0 || (draft.lines ?? []).length > 0) && (
                  <div className="mt-2 space-y-1">
                    {(draft.zones ?? []).map((z, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-surface-300 bg-surface-800 rounded px-2 py-1 flex-wrap">
                        <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                        <span className="flex-1 truncate min-w-24">{z.name} · zona · {z.points.length} pts</span>
                        <label className="flex items-center gap-1 text-[10px] text-surface-500">
                          Permanencia (s):
                          <input type="number" min={5} value={z.loiteringSec ?? ''} placeholder="—"
                            onChange={e => setZoneField(i, 'loiteringSec', e.target.value)}
                            className="w-14 bg-surface-900 border border-surface-700 rounded px-1 py-0.5 text-surface-300" />
                        </label>
                        <label className="flex items-center gap-1 text-[10px] text-surface-500">
                          Aforo máx:
                          <input type="number" min={1} value={z.occupancyLimit ?? ''} placeholder="—"
                            onChange={e => setZoneField(i, 'occupancyLimit', e.target.value)}
                            className="w-12 bg-surface-900 border border-surface-700 rounded px-1 py-0.5 text-surface-300" />
                        </label>
                        <button onClick={() => setDraft({ ...draft, zones: draft.zones!.filter((_, j) => j !== i) })}
                          className="text-surface-500 hover:text-red-400"><Trash2 size={12} /></button>
                      </div>
                    ))}
                    {(draft.lines ?? []).map((l, i) => (
                      <div key={`l${i}`} className="flex items-center gap-2 text-xs text-surface-300 bg-surface-800 rounded px-2 py-1">
                        <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
                        <span className="flex-1 truncate">{l.name} · línea de conteo</span>
                        <button onClick={() => setDraft({ ...draft, lines: draft.lines!.filter((_, j) => j !== i) })}
                          className="text-surface-500 hover:text-red-400"><Trash2 size={12} /></button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Alertas por tipo de evento */}
              <div>
                <p className="text-[10px] text-surface-500 uppercase tracking-wide mb-1.5">Alertas por tipo de evento</p>
                <div className="space-y-1">
                  {EVENT_TYPES.map(evt => {
                    const cfg = draft.alertConfig?.[evt] ?? {}
                    const defaults: Record<string, boolean> = {
                      person: true, vehicle: true, zone_intrusion: true,
                      line_crossing: false, loitering: true, occupancy_limit: true,
                    }
                    const genAlert = cfg.generateAlert ?? defaults[evt]
                    return (
                      <div key={evt} className="flex items-center gap-3 text-xs bg-surface-800 rounded px-2 py-1.5 flex-wrap">
                        <span className="w-32 text-surface-300 flex-shrink-0">{TYPE_LABELS[evt]}</span>
                        <label className="flex items-center gap-1 text-[10px] text-surface-400">
                          <input type="checkbox" checked={genAlert}
                            onChange={e => setAlertCfg(evt, { generateAlert: e.target.checked })}
                            className="accent-brand-500" /> Alerta
                        </label>
                        <label className="flex items-center gap-1 text-[10px] text-surface-400">
                          <input type="checkbox" checked={cfg.sendEmail ?? ['zone_intrusion', 'loitering', 'occupancy_limit'].includes(evt)}
                            onChange={e => setAlertCfg(evt, { sendEmail: e.target.checked })}
                            className="accent-brand-500" /> Email
                        </label>
                        <select value={cfg.severity ?? (['zone_intrusion', 'loitering', 'occupancy_limit'].includes(evt) ? 'HIGH' : 'LOW')}
                          onChange={e => setAlertCfg(evt, { severity: e.target.value as EventAlertCfg['severity'] })}
                          className="text-[10px] bg-surface-900 border border-surface-700 rounded px-1 py-0.5 text-surface-300">
                          {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <label className="flex items-center gap-1 text-[10px] text-surface-500">
                          Cooldown (s):
                          <input type="number" min={5} value={cfg.cooldownSec ?? ''} placeholder={String(draft.cooldownSec)}
                            onChange={e => setAlertCfg(evt, { cooldownSec: e.target.value === '' ? undefined : parseInt(e.target.value) })}
                            className="w-14 bg-surface-900 border border-surface-700 rounded px-1 py-0.5 text-surface-300" />
                        </label>
                      </div>
                    )
                  })}
                </div>
              </div>

              <button onClick={saveDraft} disabled={saving || draft.classes.length === 0}
                className="w-full flex items-center justify-center gap-2 text-sm px-3 py-2 rounded-lg bg-brand-700 hover:bg-brand-600 text-white transition-colors disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Guardar configuración
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══ EN VIVO ════════════════════════════════════════════════════ */}
      {tab === 'live' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-surface-200">Vista analítica en vivo</h2>
              <div className="flex-1" />
              <SearchableCombobox
                value={liveCameraId}
                onChange={setLiveCameraId}
                options={enabledCameras.map(c => ({ value: c.id, label: c.name }))}
                emptyLabel="Elegir cámara con analítica…"
                placeholder="Elegir cámara con analítica…"
                searchPlaceholder="Buscar cámara…"
                className="w-64"
              />
            </div>
            <div className="rounded-lg overflow-hidden bg-black border border-surface-700 aspect-video flex items-center justify-center">
              {liveFrameUrl
                ? <img src={liveFrameUrl} alt="frame anotado" className="w-full h-full object-contain" />
                : <p className="text-xs text-surface-600 px-4 text-center">
                    {liveCameraId ? (liveFrameMsg ?? 'Esperando el primer frame anotado del worker…') : 'Selecciona una cámara con analítica habilitada'}
                  </p>}
            </div>
            <p className="text-[10px] text-surface-600">
              Frame anotado por el detector (cajas, track IDs, zonas, líneas y contadores) — se actualiza cada 2 s.
            </p>
          </div>

          <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-2">
            <h2 className="text-sm font-semibold text-surface-200">Workers</h2>
            {(service?.workers ?? []).length === 0 && (
              <p className="text-xs text-surface-600">Sin workers activos.</p>
            )}
            {(service?.workers ?? []).map(w => (
              <div key={w.cameraId} className="rounded-lg bg-surface-800 border border-surface-700/60 p-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className={clsx('w-2 h-2 rounded-full flex-shrink-0',
                    w.status === 'running' ? 'bg-green-500'
                    : w.status === 'disabled_due_errors' ? 'bg-red-500' : 'bg-amber-500')} />
                  <span className="text-xs text-surface-200 truncate flex-1">{w.cameraName}</span>
                  <span className="text-[10px] text-surface-500">{WORKER_STATUS_LABELS[w.status] ?? w.status}</span>
                </div>
                <p className="text-[10px] text-surface-500">
                  {w.fpsActual} fps · {w.framesProcessed} frames · {w.eventsSent} eventos
                  {w.usingFallback && <span className="text-amber-400"> · RTSP directo (fallback)</span>}
                </p>
                {Object.entries(w.lineCounts ?? {}).map(([name, c]) => (
                  <p key={name} className="text-[10px] text-amber-400">{name}: ↓{c.in} in · ↑{c.out} out</p>
                ))}
                {Object.entries(w.zoneOccupancy ?? {}).filter(([, n]) => n > 0).map(([name, n]) => (
                  <p key={name} className="text-[10px] text-red-400">{name}: {n} dentro</p>
                ))}
                {w.lastError && <p className="text-[10px] text-red-400 truncate" title={w.lastError}>⚠ {w.lastError}</p>}
              </div>
            ))}
            {service?.modelError && (
              <p className="text-[10px] text-red-400">Modelo: {service.modelError}</p>
            )}
            {service?.lastRefreshError && (
              <p className="text-[10px] text-amber-400">Refresh: {service.lastRefreshError}</p>
            )}
          </div>
        </div>
      )}

      {/* ══ EVENTOS ════════════════════════════════════════════════════ */}
      {tab === 'events' && (
        <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-3 max-w-4xl">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-surface-200">Eventos recientes</h2>
            <span className="text-[10px] text-surface-600">actualiza cada 10 s</span>
            <div className="flex-1" />
            <select value={eventFilterType} onChange={e => setEventFilterType(e.target.value)}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300">
              <option value="">Todos los tipos</option>
              {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button onClick={() => loadEvents().catch(() => {})} className="p-1.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-300">
              <RefreshCw size={12} className={clsx(eventsLoading && 'animate-spin')} />
            </button>
          </div>
          {events.length === 0
            ? <p className="text-xs text-surface-600 py-8 text-center">{eventsLoading ? 'Cargando…' : 'Sin eventos todavía.'}</p>
            : <div className="space-y-2">{events.map(ev => eventCard(ev, events))}</div>}
        </div>
      )}

      {/* ══ DASHBOARD ══════════════════════════════════════════════════ */}
      {/* Global y filtrable — desacoplado de la pestaña Eventos (carga propia). */}
      {tab === 'dashboard' && (
        <div className="space-y-4">
          {/* Barra de filtros */}
          <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg overflow-hidden border border-surface-700">
              {RANGE_PRESETS.map(p => (
                <button key={p.key} onClick={() => setDash(d => ({ ...d, range: p.key }))}
                  className={clsx('text-xs px-2.5 py-1.5', dash.range === p.key ? 'bg-brand-800/60 text-brand-200' : 'bg-surface-800 text-surface-400 hover:text-surface-200')}>
                  {p.label}
                </button>
              ))}
            </div>
            <select value={dash.granularity} onChange={e => setDash(d => ({ ...d, granularity: e.target.value }))}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1.5 text-surface-300">
              <option value="5min">5 min</option>
              <option value="hour">Hora</option>
              <option value="day">Día</option>
              <option value="week">Semana</option>
            </select>
            <div className="w-48"><SearchableCombobox value={dash.nvrId} onChange={v => setDash(d => ({ ...d, nvrId: v }))}
              options={nvrOptions} emptyLabel="Todos los NVRs" placeholder="Todos los NVRs" searchPlaceholder="Buscar NVR…" /></div>
            <div className="w-56"><SearchableCombobox value={dash.cameraId} onChange={v => setDash(d => ({ ...d, cameraId: v }))}
              options={cameraOptions} emptyLabel="Todas las cámaras" placeholder="Todas las cámaras" searchPlaceholder="Buscar cámara…" /></div>
            <select value={dash.type} onChange={e => setDash(d => ({ ...d, type: e.target.value }))}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1.5 text-surface-300">
              <option value="">Todos los eventos</option>
              {EVENT_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
            <div className="flex-1" />
            <button onClick={() => loadSummary()} className="p-1.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-300">
              <RefreshCw size={12} className={clsx(summaryLoading && 'animate-spin')} />
            </button>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
            {([
              ['Eventos (brutos)', summary?.kpis.totalEvents, 'Detecciones/reglas totales — un mismo objeto genera varios eventos'],
              ['Incidentes únicos', summary?.kpis.uniqueIncidents, 'Incidentes de zona distintos (por incidentId)'],
              ['Objetos únicos', summary?.kpis.uniqueTracks, 'Tracks distintos (por trackId)'],
              ['Personas', summary?.kpis.persons, undefined],
              ['Vehículos', summary?.kpis.vehicles, undefined],
              ['Intrusiones', summary?.kpis.intrusions, 'Eventos zone_intrusion (brutos)'],
              ['Permanencias', summary?.kpis.loitering, undefined],
              ['Aforo', summary?.kpis.occupancy, undefined],
              ['Cruces', summary?.kpis.lineCrossings, undefined],
              ['Cámaras', summary?.kpis.activeCameras, 'Cámaras con eventos en el rango'],
            ] as const).map(([label, val, hint]) => (
              <div key={label} className="rounded-xl border border-surface-700 bg-surface-800/50 p-3" title={hint}>
                <p className="text-[10px] text-surface-500 uppercase tracking-wide">{label}</p>
                <p className="text-xl font-bold text-surface-100">{val ?? 0}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-surface-500">
            "Eventos (brutos)" cuenta cada detección/regla; un mismo objeto produce varios (detección + intrusión +
            recordatorio + salida). Para conteos reales usá "Incidentes únicos" y "Objetos únicos".
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Serie temporal */}
            <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-1 lg:col-span-2">
              <h2 className="text-sm font-semibold text-surface-200 mb-2">Evolución temporal ({dash.granularity})</h2>
              <div className="flex items-end gap-0.5 h-40">
                {(summary?.series ?? []).map(s => (
                  <div key={s.bucket} title={`${new Date(s.bucket).toLocaleString('es')}: ${s.count}`}
                    className="flex-1 min-w-[2px] bg-brand-600/70 rounded-t hover:bg-brand-500"
                    style={{ height: `${Math.max(2, (s.count / maxSeries) * 100)}%` }} />
                ))}
              </div>
              {(summary?.series ?? []).length === 0 && <p className="text-xs text-surface-600">Sin datos en el rango.</p>}
            </div>

            {/* Distribución por tipo */}
            <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-1">
              <h2 className="text-sm font-semibold text-surface-200 mb-1">Distribución por tipo</h2>
              {(summary?.byType ?? []).map(t => {
                const max = Math.max(1, ...(summary?.byType ?? []).map(x => x.count))
                return (
                  <div key={t.type} className="flex items-center gap-2 text-xs py-0.5">
                    <span className="text-surface-300 w-28 truncate">{TYPE_LABELS[t.type] ?? t.type}</span>
                    <div className="flex-1 bg-surface-800 rounded h-3 overflow-hidden">
                      <div className="h-full bg-brand-600/70" style={{ width: `${(t.count / max) * 100}%` }} />
                    </div>
                    <span className="text-surface-200 font-mono w-10 text-right">{t.count}</span>
                  </div>
                )
              })}
              {(summary?.byType ?? []).length === 0 && <p className="text-xs text-surface-600">Sin datos.</p>}
            </div>

            {/* Distribución por clase */}
            <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-1">
              <h2 className="text-sm font-semibold text-surface-200 mb-1">Distribución por clase</h2>
              {(summary?.byClass ?? []).map(c => {
                const max = Math.max(1, ...(summary?.byClass ?? []).map(x => x.count))
                return (
                  <div key={c.className} className="flex items-center gap-2 text-xs py-0.5">
                    <span className="text-surface-300 w-28 truncate">{CLASS_LABELS[c.className] ?? c.className}</span>
                    <div className="flex-1 bg-surface-800 rounded h-3 overflow-hidden">
                      <div className="h-full bg-emerald-600/70" style={{ width: `${(c.count / max) * 100}%` }} />
                    </div>
                    <span className="text-surface-200 font-mono w-10 text-right">{c.count}</span>
                  </div>
                )
              })}
              {(summary?.byClass ?? []).length === 0 && <p className="text-xs text-surface-600">Sin datos.</p>}
            </div>

            {/* Cámaras con más actividad */}
            <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4">
              <h2 className="text-sm font-semibold text-surface-200 mb-1">Cámaras con más actividad</h2>
              {(summary?.byCamera ?? []).slice(0, 10).map((c, i) => (
                <div key={c.cameraId} className="flex items-center gap-2 text-xs py-0.5">
                  <span className="text-surface-600 w-4">{i + 1}.</span>
                  <span className="text-surface-300 flex-1 truncate">{c.cameraName}</span>
                  <span className="text-surface-200 font-mono">{c.count}</span>
                </div>
              ))}
              {(summary?.byCamera ?? []).length === 0 && <p className="text-xs text-surface-600">Sin datos.</p>}
            </div>

            {/* Conteos por línea */}
            <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4">
              <h2 className="text-sm font-semibold text-surface-200 mb-1">Conteos por línea (in/out)</h2>
              {(summary?.lineCounts ?? []).map((l, i) => (
                <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                  <span className="text-surface-300 flex-1 truncate">{l.cameraName} · {l.lineName}</span>
                  <span className={clsx('font-mono', l.direction === 'in' ? 'text-green-400' : 'text-amber-400')}>
                    {l.direction === 'in' ? '↓in' : '↑out'} {l.count}
                  </span>
                </div>
              ))}
              {(summary?.lineCounts ?? []).length === 0 && <p className="text-xs text-surface-600">Sin cruces registrados.</p>}
            </div>
          </div>
        </div>
      )}

      {/* ══ SNAPSHOTS ══════════════════════════════════════════════════ */}
      {/* Módulo independiente: no depende de la pestaña Eventos (carga propia). */}
      {tab === 'snapshots' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-3 flex flex-wrap items-center gap-2">
            {/* La cámara se busca por nombre o NVR en el combobox (agrupado por NVR). */}
            <div className="w-64"><SearchableCombobox value={snapFilter.cameraId} onChange={v => setSnapFilter(f => ({ ...f, cameraId: v }))}
              options={cameraOptions} emptyLabel="Todas las cámaras" placeholder="Todas las cámaras" searchPlaceholder="Buscar cámara o NVR…" /></div>
            <select value={snapFilter.type} onChange={e => setSnapFilter(f => ({ ...f, type: e.target.value }))}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1.5 text-surface-300">
              <option value="">Todos los eventos</option>
              {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={snapFilter.order} onChange={e => setSnapFilter(f => ({ ...f, order: e.target.value }))}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1.5 text-surface-300">
              <option value="desc">Más recientes</option>
              <option value="asc">Más antiguos</option>
            </select>
            <div className="flex-1" />
            <span className="text-[10px] text-surface-500">{snapsTotal} snapshots</span>
            <button onClick={() => loadSnapshots(snapsPage)} className="p-1.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-300">
              <RefreshCw size={12} className={clsx(snapsLoading && 'animate-spin')} />
            </button>
          </div>

          {snaps.length === 0
            ? <p className="text-xs text-surface-600 py-10 text-center">{snapsLoading ? 'Cargando…' : 'Sin snapshots para estos filtros.'}</p>
            : <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
                {snaps.map(e => (
                  <button key={e.id} onClick={() => openDetail(snaps, e)}
                    className="relative rounded-lg overflow-hidden border border-surface-700 group text-left">
                    <img src={resolveAssetUrl(e.snapshotUrl!) ?? undefined} alt="" loading="lazy"
                      className="w-full aspect-video object-cover bg-black" />
                    <span className="absolute bottom-0 inset-x-0 bg-black/70 text-[9px] text-surface-300 px-1 py-0.5 truncate">
                      {e.cameraName} · {TYPE_LABELS[e.type] ?? e.type}
                    </span>
                  </button>
                ))}
              </div>}

          {/* Paginación */}
          {snapsTotal > 24 && (
            <div className="flex items-center justify-center gap-3 text-xs text-surface-400">
              <button disabled={snapsPage <= 1} onClick={() => loadSnapshots(snapsPage - 1)}
                className="p-1.5 rounded bg-surface-800 disabled:opacity-40 hover:bg-surface-700"><ChevronLeft size={14} /></button>
              <span>Página {snapsPage} / {Math.max(1, Math.ceil(snapsTotal / 24))}</span>
              <button disabled={snapsPage >= Math.ceil(snapsTotal / 24)} onClick={() => loadSnapshots(snapsPage + 1)}
                className="p-1.5 rounded bg-surface-800 disabled:opacity-40 hover:bg-surface-700"><ChevronRight size={14} /></button>
            </div>
          )}
        </div>
      )}

      {/* ══ FORENSE ════════════════════════════════════════════════════ */}
      {tab === 'forensic' && (
        <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-3 max-w-4xl">
          <h2 className="text-sm font-semibold text-surface-200">Búsqueda forense</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {cameraSelect(ff.cameraId, v => setFf({ ...ff, cameraId: v }), 'Todas las cámaras')}
            <select value={ff.type} onChange={e => setFf({ ...ff, type: e.target.value })}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300">
              <option value="">Todos los eventos</option>
              {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={ff.className} onChange={e => setFf({ ...ff, className: e.target.value })}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300">
              <option value="">Todas las clases</option>
              {Object.entries(CLASS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={ff.direction} onChange={e => setFf({ ...ff, direction: e.target.value })}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300">
              <option value="">Cualquier dirección</option>
              <option value="in">Entrada (in)</option>
              <option value="out">Salida (out)</option>
            </select>
            <input type="text" placeholder="Zona / línea…" value={ff.zoneName}
              onChange={e => setFf({ ...ff, zoneName: e.target.value })}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300" />
            <input type="datetime-local" value={ff.from} onChange={e => setFf({ ...ff, from: e.target.value })}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300" />
            <input type="datetime-local" value={ff.to} onChange={e => setFf({ ...ff, to: e.target.value })}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300" />
            <button onClick={runForensic}
              className="flex items-center justify-center gap-1.5 text-xs px-3 py-1 rounded bg-brand-700 hover:bg-brand-600 text-white transition-colors">
              {forensicLoading ? <Loader2 size={12} className="animate-spin" /> : <SearchCode size={12} />}
              Buscar
            </button>
          </div>
          {forensic.length === 0
            ? <p className="text-xs text-surface-600 py-6 text-center">Sin resultados — ajustá los filtros y buscá.</p>
            : <div className="space-y-2">{forensic.map(ev => eventCard(ev, forensic))}</div>}
        </div>
      )}

      {/* Visor de detalle de evento — compartido por Eventos, Snapshots y Forense */}
      {detail && detail.list[detail.index] && (
        <AnalyticsEventDetailModal
          event={detail.list[detail.index]}
          typeLabels={TYPE_LABELS}
          classLabels={CLASS_LABELS}
          resolveAssetUrl={resolveAssetUrl}
          onClose={() => setDetail(null)}
          onOpenRecording={(ev) => openRecordingFor(ev)}
          onPrev={detail.index > 0 ? () => setDetail(d => d && { ...d, index: d.index - 1 }) : undefined}
          onNext={detail.index < detail.list.length - 1 ? () => setDetail(d => d && { ...d, index: d.index + 1 }) : undefined}
        />
      )}
    </div>
  )
}
