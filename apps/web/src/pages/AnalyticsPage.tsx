// apps/web/src/pages/AnalyticsPage.tsx
// Analítica de video: configuración por cámara (clases, confianza, zonas de
// intrusión dibujadas sobre un snapshot) y navegador de eventos detectados
// con salto directo a la grabación en Grabaciones.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Loader2, Save, Trash2, Play, RefreshCw, Plus } from 'lucide-react'
import toast from 'react-hot-toast'
import { clsx } from 'clsx'
import { api, apiGet, apiPut, resolveAssetUrl } from '@/lib/api'
import { useCameraStore } from '@/stores/cameraStore'

interface AnalyticsZone {
  name: string
  points: [number, number][]
  classes?: string[]
}

interface AnalyticsConfig {
  cameraId: string
  enabled: boolean
  classes: string[]
  minConfidence: number
  sampleFps: number
  cooldownSec: number
  zones: AnalyticsZone[] | null
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
  snapshotUrl: string | null
  occurredAt: string
}

interface Summary {
  totalEvents: number
  byType: { type: string; count: number }[]
  byCamera: { cameraId: string; cameraName: string; count: number }[]
}

const CLASS_LABELS: Record<string, string> = {
  person: 'Personas', car: 'Autos', truck: 'Camiones',
  bus: 'Buses', motorcycle: 'Motos', bicycle: 'Bicicletas',
}
const TYPE_LABELS: Record<string, string> = {
  person: 'Persona', vehicle: 'Vehículo',
  zone_intrusion: 'Intrusión en zona', line_crossing: 'Cruce de línea',
}

const DEFAULT_CONFIG = (cameraId: string): AnalyticsConfig => ({
  cameraId, enabled: false, classes: ['person'],
  minConfidence: 0.5, sampleFps: 2, cooldownSec: 60, zones: null,
})

export function AnalyticsPage() {
  const navigate = useNavigate()
  const { cameras, nvrs, loadCameras, loadNVRs } = useCameraStore()

  const [configs, setConfigs] = useState<Map<string, AnalyticsConfig>>(new Map())
  const [supportedClasses, setSupportedClasses] = useState<string[]>(Object.keys(CLASS_LABELS))
  const [serviceConfigured, setServiceConfigured] = useState(true)
  const [selectedCameraId, setSelectedCameraId] = useState<string>('')
  const [draft, setDraft] = useState<AnalyticsConfig | null>(null)
  const [saving, setSaving] = useState(false)

  // Zone editor
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([])
  const snapshotObjectUrlRef = useRef<string | null>(null)

  // Events
  const [events, setEvents] = useState<AnalyticsEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventFilterType, setEventFilterType] = useState('')
  const [summary, setSummary] = useState<Summary | null>(null)

  useEffect(() => { loadCameras(); loadNVRs() }, [])

  const loadConfigs = async () => {
    try {
      const res = await apiGet<{ configs: any[]; supportedClasses: string[]; serviceConfigured: boolean }>('/analytics/config')
      setConfigs(new Map(res.configs.map(c => [c.cameraId, {
        cameraId: c.cameraId, enabled: c.enabled,
        classes: (c.classes as string[]) ?? ['person'],
        minConfidence: c.minConfidence, sampleFps: c.sampleFps,
        cooldownSec: c.cooldownSec, zones: (c.zones as AnalyticsZone[] | null) ?? null,
      }])))
      setSupportedClasses(res.supportedClasses)
      setServiceConfigured(res.serviceConfigured)
    } catch { /* toast global ya avisa */ }
  }

  const loadEvents = async () => {
    setEventsLoading(true)
    try {
      const res = await apiGet<{ events: AnalyticsEvent[] }>('/analytics/events', {
        limit: 50,
        ...(eventFilterType ? { type: eventFilterType } : {}),
        ...(selectedCameraId ? { cameraId: selectedCameraId } : {}),
      })
      setEvents(res.events)
    } catch { /* noop */ } finally { setEventsLoading(false) }
  }

  const loadSummary = async () => {
    try { setSummary(await apiGet<Summary>('/analytics/summary')) } catch { /* noop */ }
  }

  useEffect(() => { loadConfigs(); loadSummary() }, [])
  useEffect(() => { loadEvents() }, [eventFilterType, selectedCameraId])

  // Selección de cámara → draft de config + snapshot para el editor de zonas
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

  useEffect(() => () => {
    if (snapshotObjectUrlRef.current) URL.revokeObjectURL(snapshotObjectUrlRef.current)
  }, [])

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
      })
      setConfigs(prev => new Map(prev).set(draft.cameraId, draft))
      toast.success('Configuración de analítica guardada')
    } catch { /* toast global */ } finally { setSaving(false) }
  }

  // ── Zone editor handlers ───────────────────────────────────────────────
  const handleSnapshotClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    setDraftPoints(prev => prev.length >= 30 ? prev : [...prev, [Number(x.toFixed(4)), Number(y.toFixed(4))]])
  }

  const finishZone = () => {
    if (!draft || draftPoints.length < 3) { toast.error('Una zona necesita al menos 3 puntos'); return }
    const name = window.prompt('Nombre de la zona:', `Zona ${(draft.zones?.length ?? 0) + 1}`)
    if (!name) return
    setDraft({ ...draft, zones: [...(draft.zones ?? []), { name: name.slice(0, 60), points: draftPoints }] })
    setDraftPoints([])
  }

  const removeZone = (idx: number) => {
    if (!draft?.zones) return
    setDraft({ ...draft, zones: draft.zones.filter((_, i) => i !== idx) })
  }

  const camerasByNvr = useMemo(() => {
    return nvrs.map(nvr => ({ nvr, cams: cameras.filter(c => c.nvrId === nvr.id) }))
      .filter(g => g.cams.length > 0)
  }, [nvrs, cameras])

  const enabledCount = [...configs.values()].filter(c => c.enabled).length

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      {/* Header + resumen 24h */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-brand-400" />
          <h1 className="text-lg font-semibold text-surface-100">Analítica de video</h1>
        </div>
        <span className="text-xs text-surface-500">{enabledCount} cámara(s) con analítica activa</span>
        <div className="flex-1" />
        {summary && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-surface-500 uppercase tracking-wide">Últimas 24 h:</span>
            <span className="text-xs px-2 py-0.5 rounded bg-surface-800 text-surface-300">{summary.totalEvents} eventos</span>
            {summary.byType.map(t => (
              <span key={t.type} className="text-xs px-2 py-0.5 rounded bg-surface-800 text-surface-400">
                {TYPE_LABELS[t.type] ?? t.type}: {t.count}
              </span>
            ))}
          </div>
        )}
      </div>

      {!serviceConfigured && (
        <div className="px-3 py-2 rounded-lg bg-amber-900/20 border border-amber-700/40 text-amber-300 text-xs">
          El servicio de analítica no está configurado: define <code className="font-mono">ANALYTICS_SECRET</code> en el
          API y en el contenedor <code className="font-mono">analytics</code> (ver apps/analytics/README.md).
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Configuración por cámara ─────────────────────────────────── */}
        <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-surface-200">Configuración por cámara</h2>

          <select
            value={selectedCameraId}
            onChange={e => setSelectedCameraId(e.target.value)}
            className="w-full text-sm bg-surface-800 border border-surface-700 rounded-lg px-3 py-2 text-surface-200"
          >
            <option value="">Selecciona una cámara…</option>
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

          {draft && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-surface-300">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={e => setDraft({ ...draft, enabled: e.target.checked })}
                  className="accent-brand-500"
                />
                Analítica habilitada en esta cámara
              </label>

              <div>
                <p className="text-[10px] text-surface-500 uppercase tracking-wide mb-1.5">Clases a detectar</p>
                <div className="flex flex-wrap gap-2">
                  {supportedClasses.map(cls => {
                    const on = draft.classes.includes(cls)
                    return (
                      <button
                        key={cls}
                        onClick={() => setDraft({
                          ...draft,
                          classes: on
                            ? draft.classes.filter(c => c !== cls)
                            : [...draft.classes, cls],
                        })}
                        className={clsx(
                          'text-xs px-2.5 py-1 rounded-full border transition-colors',
                          on ? 'bg-brand-800/60 border-brand-600 text-brand-200'
                             : 'bg-surface-800 border-surface-700 text-surface-500 hover:text-surface-300'
                        )}
                      >
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
                  <span>Cooldown (seg)</span>
                  <input type="number" min={5} max={3600} value={draft.cooldownSec}
                    onChange={e => setDraft({ ...draft, cooldownSec: Number(e.target.value) })}
                    className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-200" />
                </label>
              </div>

              {/* ── Editor de zonas ────────────────────────────────────── */}
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <p className="text-[10px] text-surface-500 uppercase tracking-wide">
                    Zonas de intrusión (clic sobre la imagen para dibujar)
                  </p>
                  <div className="flex-1" />
                  {draftPoints.length > 0 && (
                    <>
                      <button onClick={finishZone}
                        className="text-[10px] px-2 py-0.5 rounded bg-brand-700/60 text-brand-200 flex items-center gap-1">
                        <Plus size={10} /> Cerrar zona ({draftPoints.length} pts)
                      </button>
                      <button onClick={() => setDraftPoints([])}
                        className="text-[10px] px-2 py-0.5 rounded bg-surface-700 text-surface-400">
                        Cancelar
                      </button>
                    </>
                  )}
                </div>

                <div
                  className="relative w-full rounded-lg overflow-hidden border border-surface-700 bg-black cursor-crosshair select-none"
                  onClick={handleSnapshotClick}
                >
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
                  <svg className="absolute inset-0 w-full h-full pointer-events-none"
                       viewBox="0 0 100 100" preserveAspectRatio="none">
                    {(draft.zones ?? []).map((z, i) => (
                      <polygon key={i}
                        points={z.points.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}
                        fill="rgba(220,38,38,0.18)" stroke="#dc2626" strokeWidth="0.4" />
                    ))}
                    {draftPoints.length > 0 && (
                      <polyline
                        points={draftPoints.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}
                        fill="none" stroke="#f59e0b" strokeWidth="0.4" />
                    )}
                    {draftPoints.map(([x, y], i) => (
                      <circle key={i} cx={x * 100} cy={y * 100} r="0.8" fill="#f59e0b" />
                    ))}
                  </svg>
                </div>

                {(draft.zones ?? []).length > 0 && (
                  <div className="mt-2 space-y-1">
                    {(draft.zones ?? []).map((z, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-surface-300 bg-surface-800 rounded px-2 py-1">
                        <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                        <span className="flex-1 truncate">{z.name} · {z.points.length} puntos</span>
                        <button onClick={() => removeZone(i)} className="text-surface-500 hover:text-red-400">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={saveDraft}
                disabled={saving || draft.classes.length === 0}
                className="w-full flex items-center justify-center gap-2 text-sm px-3 py-2 rounded-lg bg-brand-700 hover:bg-brand-600 text-white transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Guardar configuración
              </button>
            </div>
          )}
        </div>

        {/* ── Eventos recientes ────────────────────────────────────────── */}
        <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-surface-200">Eventos detectados</h2>
            <div className="flex-1" />
            <select
              value={eventFilterType}
              onChange={e => setEventFilterType(e.target.value)}
              className="text-xs bg-surface-800 border border-surface-700 rounded px-2 py-1 text-surface-300"
            >
              <option value="">Todos los tipos</option>
              {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button onClick={loadEvents} className="p-1.5 rounded bg-surface-700 hover:bg-surface-600 text-surface-300">
              <RefreshCw size={12} className={clsx(eventsLoading && 'animate-spin')} />
            </button>
          </div>

          {events.length === 0 ? (
            <p className="text-xs text-surface-600 py-8 text-center">
              {eventsLoading ? 'Cargando…' : 'Sin eventos todavía. Habilita analítica en una cámara.'}
            </p>
          ) : (
            <div className="space-y-2 max-h-[calc(100vh-16rem)] overflow-y-auto pr-1">
              {events.map(ev => (
                <div key={ev.id} className="flex gap-3 rounded-lg bg-surface-800 border border-surface-700/60 p-2">
                  {ev.snapshotUrl ? (
                    <img
                      src={resolveAssetUrl(ev.snapshotUrl) ?? undefined}
                      alt=""
                      loading="lazy"
                      className="w-28 h-16 object-cover rounded flex-shrink-0 bg-black"
                    />
                  ) : (
                    <div className="w-28 h-16 rounded bg-black flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-surface-200 truncate">
                      <span className={clsx(
                        'inline-block px-1.5 py-0.5 rounded text-[9px] mr-1.5',
                        ev.type === 'zone_intrusion' ? 'bg-red-900/60 text-red-300' : 'bg-surface-700 text-surface-300'
                      )}>
                        {TYPE_LABELS[ev.type] ?? ev.type}
                      </span>
                      {ev.cameraName} · {ev.nvrName}
                    </p>
                    <p className="text-[10px] text-surface-500 mt-0.5">
                      {CLASS_LABELS[ev.className] ?? ev.className} · {(ev.confidence * 100).toFixed(0)}%
                      {ev.zoneName ? ` · zona "${ev.zoneName}"` : ''}
                    </p>
                    <p className="text-[10px] text-surface-500 font-mono">
                      {new Date(ev.occurredAt).toLocaleString('es')}
                    </p>
                  </div>
                  <button
                    onClick={() => navigate(`/recordings?cameraId=${ev.cameraId}&t=${encodeURIComponent(ev.occurredAt)}`)}
                    title="Ver la grabación de este momento"
                    className="self-center flex-shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-brand-800/60 hover:bg-brand-700/70 text-brand-300 transition-colors"
                  >
                    <Play size={10} /> Ver grabación
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
