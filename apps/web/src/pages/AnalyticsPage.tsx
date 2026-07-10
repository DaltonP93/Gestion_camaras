// apps/web/src/pages/AnalyticsPage.tsx
// Analítica de video con 5 pestañas: Configuración (clases/zonas/líneas/alertas
// por evento), Vista en vivo (frame anotado + estado de workers), Eventos
// (auto-refresh), Dashboard (conteos) y Forense (búsqueda con filtros).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity, Loader2, Save, Trash2, Play, RefreshCw, Plus,
  Settings, MonitorPlay, ListVideo, BarChart3, SearchCode,
  CheckCircle2, XCircle, AlertTriangle,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { clsx } from 'clsx'
import { api, apiGet, apiPut, resolveAssetUrl } from '@/lib/api'
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
  snapshotUrl: string | null
  occurredAt: string
}
interface Summary {
  totalEvents: number
  byType: { type: string; count: number }[]
  byCamera: { cameraId: string; cameraName: string; count: number }[]
  lineCounts: { cameraId: string; cameraName: string; lineName: string; direction: string; count: number }[]
  byHour: { hour: string; count: number }[]
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
}
const EVENT_TYPES = Object.keys(TYPE_LABELS)
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

type Tab = 'config' | 'live' | 'events' | 'dashboard' | 'forensic'

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
  const liveFrameObjectUrlRef = useRef<string | null>(null)

  // Eventos / forense
  const [events, setEvents] = useState<AnalyticsEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventFilterType, setEventFilterType] = useState('')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [forensic, setForensic] = useState<AnalyticsEvent[]>([])
  const [forensicLoading, setForensicLoading] = useState(false)
  const [ff, setFf] = useState({ cameraId: '', type: '', className: '', zoneName: '', direction: '', from: '', to: '' })

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

  const loadServiceStatus = async () => {
    try { setService(await apiGet<ServiceStatus>('/analytics/service-status')) }
    catch { setService({ connected: false, error: 'sin conexión' }) }
  }

  const loadEvents = async () => {
    setEventsLoading(true)
    try {
      const res = await apiGet<{ events: AnalyticsEvent[] }>('/analytics/events', {
        limit: 50,
        ...(eventFilterType ? { type: eventFilterType } : {}),
      })
      setEvents(res.events)
    } catch { /* noop */ } finally { setEventsLoading(false) }
  }

  const loadSummary = async () => {
    try { setSummary(await apiGet<Summary>('/analytics/summary')) } catch { /* noop */ }
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

  useEffect(() => { loadConfigs(); loadServiceStatus() }, [])
  useEffect(() => { if (tab === 'dashboard') loadSummary() }, [tab])

  // Eventos: auto-refresh cada 10 s mientras la pestaña está activa
  useEffect(() => {
    if (tab !== 'events') return
    loadEvents()
    const t = setInterval(loadEvents, 10_000)
    return () => clearInterval(t)
  }, [tab, eventFilterType])

  // Estado del servicio: refresh cada 10 s en las pestañas que lo muestran
  useEffect(() => {
    if (tab !== 'live' && tab !== 'config') return
    const t = setInterval(loadServiceStatus, 10_000)
    return () => clearInterval(t)
  }, [tab])

  // Vista en vivo: frame anotado cada 2 s (fetch con auth → objectURL)
  useEffect(() => {
    if (tab !== 'live' || !liveCameraId) return
    let cancelled = false
    const fetchFrame = async () => {
      try {
        const res = await api.get(`/analytics/live-frame/${liveCameraId}`, {
          responseType: 'blob', timeout: 6_000,
        })
        if (cancelled) return
        const url = URL.createObjectURL(res.data)
        if (liveFrameObjectUrlRef.current) URL.revokeObjectURL(liveFrameObjectUrlRef.current)
        liveFrameObjectUrlRef.current = url
        setLiveFrameUrl(url)
      } catch { /* frame aún no disponible */ }
    }
    fetchFrame()
    const t = setInterval(fetchFrame, 2_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [tab, liveCameraId])

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

  const cameraSelect = (value: string, onChange: (v: string) => void, emptyLabel: string) => (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="text-sm bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-surface-200">
      <option value="">{emptyLabel}</option>
      {camerasByNvr.map(({ nvr, cams }) => (
        <optgroup key={nvr.id} label={nvr.name}>
          {cams.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}{configs.get(c.id)?.enabled ? ' ● analítica activa' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )

  const eventCard = (ev: AnalyticsEvent) => (
    <div key={ev.id} className="flex gap-3 rounded-lg bg-surface-800 border border-surface-700/60 p-2">
      {ev.snapshotUrl ? (
        <img src={resolveAssetUrl(ev.snapshotUrl) ?? undefined} alt="" loading="lazy"
          className="w-28 h-16 object-cover rounded flex-shrink-0 bg-black" />
      ) : <div className="w-28 h-16 rounded bg-black flex-shrink-0" />}
      <div className="min-w-0 flex-1">
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
        onClick={() => navigate(`/recordings?cameraId=${ev.cameraId}&t=${encodeURIComponent(ev.occurredAt)}`)}
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
    { key: 'forensic',  label: 'Forense',       icon: <SearchCode size={13} /> },
  ]

  const maxHour = Math.max(1, ...(summary?.byHour ?? []).map(h => h.count))

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
            {service.connected
              ? service.modelLoaded ? `Servicio activo · ${service.workers?.length ?? 0} worker(s)` : `Servicio degradado: ${service.modelError ?? 'modelo no cargado'}`
              : `Servicio desconectado${service.error ? `: ${service.error}` : ''}`}
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
              <select value={liveCameraId} onChange={e => setLiveCameraId(e.target.value)}
                className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300">
                <option value="">Elegir cámara con analítica…</option>
                {enabledCameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="rounded-lg overflow-hidden bg-black border border-surface-700 aspect-video flex items-center justify-center">
              {liveFrameUrl
                ? <img src={liveFrameUrl} alt="frame anotado" className="w-full h-full object-contain" />
                : <p className="text-xs text-surface-600 px-4 text-center">
                    {liveCameraId ? 'Esperando el primer frame anotado del worker…' : 'Selecciona una cámara con analítica habilitada'}
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
            <button onClick={loadEvents} className="p-1.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-300">
              <RefreshCw size={12} className={clsx(eventsLoading && 'animate-spin')} />
            </button>
          </div>
          {events.length === 0
            ? <p className="text-xs text-surface-600 py-8 text-center">{eventsLoading ? 'Cargando…' : 'Sin eventos todavía.'}</p>
            : <div className="space-y-2">{events.map(eventCard)}</div>}
        </div>
      )}

      {/* ══ DASHBOARD ══════════════════════════════════════════════════ */}
      {tab === 'dashboard' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-2">
            <h2 className="text-sm font-semibold text-surface-200">Últimas 24 horas</h2>
            <p className="text-2xl font-bold text-surface-100">{summary?.totalEvents ?? 0} <span className="text-xs font-normal text-surface-500">eventos</span></p>
            <div className="flex flex-wrap gap-2">
              {(summary?.byType ?? []).map(t => (
                <span key={t.type} className="text-xs px-2 py-0.5 rounded bg-surface-800 text-surface-400 border border-surface-700">
                  {TYPE_LABELS[t.type] ?? t.type}: <b className="text-surface-200">{t.count}</b>
                </span>
              ))}
            </div>
            {/* Eventos por hora — barras simples */}
            <div className="pt-2 space-y-0.5">
              {(summary?.byHour ?? []).map(h => (
                <div key={h.hour} className="flex items-center gap-2">
                  <span className="text-[9px] text-surface-500 font-mono w-10 flex-shrink-0">
                    {new Date(h.hour).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div className="flex-1 bg-surface-800 rounded h-3 overflow-hidden">
                    <div className="h-full bg-brand-600/70 rounded" style={{ width: `${(h.count / maxHour) * 100}%` }} />
                  </div>
                  <span className="text-[9px] text-surface-400 w-8 text-right">{h.count}</span>
                </div>
              ))}
              {(summary?.byHour ?? []).length === 0 && <p className="text-xs text-surface-600">Sin datos.</p>}
            </div>
          </div>

          <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-3">
            <div>
              <h2 className="text-sm font-semibold text-surface-200 mb-1">Cámaras con más actividad</h2>
              {(summary?.byCamera ?? []).slice(0, 8).map((c, i) => (
                <div key={c.cameraId} className="flex items-center gap-2 text-xs py-0.5">
                  <span className="text-surface-600 w-4">{i + 1}.</span>
                  <span className="text-surface-300 flex-1 truncate">{c.cameraName}</span>
                  <span className="text-surface-200 font-mono">{c.count}</span>
                </div>
              ))}
            </div>
            <div>
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

          <div className="lg:col-span-2 rounded-xl border border-surface-700 bg-surface-800/50 p-4">
            <h2 className="text-sm font-semibold text-surface-200 mb-2">Últimos snapshots</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {events.filter(e => e.snapshotUrl).slice(0, 8).map(e => (
                <button key={e.id} onClick={() => navigate(`/recordings?cameraId=${e.cameraId}&t=${encodeURIComponent(e.occurredAt)}`)}
                  className="relative rounded-lg overflow-hidden border border-surface-700 group">
                  <img src={resolveAssetUrl(e.snapshotUrl!) ?? undefined} alt="" className="w-full aspect-video object-cover" />
                  <span className="absolute bottom-0 inset-x-0 bg-black/70 text-[9px] text-surface-300 px-1 py-0.5 truncate">
                    {e.cameraName} · {TYPE_LABELS[e.type] ?? e.type}
                  </span>
                </button>
              ))}
            </div>
            {events.filter(e => e.snapshotUrl).length === 0 && (
              <p className="text-xs text-surface-600">Todavía no hay snapshots. (Este panel usa los eventos de la pestaña Eventos — abrila primero si está vacío.)</p>
            )}
          </div>
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
            : <div className="space-y-2">{forensic.map(eventCard)}</div>}
        </div>
      )}
    </div>
  )
}
