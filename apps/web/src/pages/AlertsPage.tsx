// src/pages/AlertsPage.tsx
import { useEffect, useState, useCallback } from 'react'
import { AlertTriangle, CheckCircle2, Bell, Filter, Eye, Square, CheckSquare, Loader2 } from 'lucide-react'
import { useAlertStore } from '@/stores/alertStore'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { clsx } from 'clsx'
import type { Alert, AlertSeverity } from '@/types'
import { format, formatDistanceStrict, formatDistanceToNow } from 'date-fns'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

const SEVERITY_CONFIG: Record<AlertSeverity, { label: string; color: string; bg: string }> = {
  CRITICAL: { label: 'Crítico', color: 'text-red-400',    bg: 'bg-red-900/30' },
  HIGH:     { label: 'Alto',    color: 'text-orange-400', bg: 'bg-orange-900/30' },
  MEDIUM:   { label: 'Medio',   color: 'text-amber-400',  bg: 'bg-amber-900/30' },
  LOW:      { label: 'Bajo',    color: 'text-blue-400',   bg: 'bg-blue-900/30' },
}

const TYPE_LABELS: Record<string, string> = {
  CAMERA_OFFLINE:          'Sin señal de cámara',
  CAMERA_RECOVERED:        'Cámara recuperada',
  CAMERA_STREAM_ERROR:     'Error de pipeline de streaming',
  CAMERA_STREAM_RECOVERED: 'Pipeline recuperado',
  NVR_OFFLINE:             'NVR no disponible',
  HDD_FULL:                'Disco lleno',
  HDD_ERROR:               'Error de disco',
  MOTION_DETECTED:         'Movimiento detectado',
  RECORDING_ERROR:         'Error de grabación',
  AUTH_FAILED:             'Fallo de autenticación',
}

type FilterTab = 'active' | 'acknowledged' | 'resolved' | 'all'

export function AlertsPage() {
  const { alerts, setAlerts, markResolved, markRead } = useAlertStore()
  const { user } = useAuthStore()
  const [filter, setFilter]           = useState<FilterTab>('active')
  const [severityFilter, setSeverityFilter] = useState<string>('all')
  const [isLoading, setIsLoading]     = useState(true)
  const [selected, setSelected]       = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy]       = useState(false)

  const isPrivileged = ['ADMIN', 'SUPERVISOR'].includes(user?.role || '')

  const loadAlerts = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await apiGet<Alert[]>('/alerts?limit=200')
      setAlerts(data)
      setSelected(new Set())
    } catch (err: any) {
      // Un 401 lo maneja el interceptor de axios: refresca el token y
      // reintenta; si la sesión venció de verdad, dispara auth-expired y
      // redirige al login. No lo tratamos como error acá — solo evitamos
      // la promesa rechazada sin manejar (spam en consola). Otros errores sí
      // se informan.
      if (err?.response?.status !== 401) {
        toast.error('No se pudieron cargar las alertas')
      }
    } finally {
      setIsLoading(false)
    }
  }, [setAlerts])

  useEffect(() => { loadAlerts() }, [loadAlerts])

  const handleAcknowledge = useCallback(async (alert: Alert) => {
    try {
      await apiPost(`/alerts/${alert.id}/read`, {})
      markRead(alert.id)
      toast.success('Alerta reconocida')
    } catch { toast.error('No se pudo reconocer') }
  }, [markRead])

  const handleResolve = useCallback(async (alert: Alert) => {
    if (!isPrivileged) return
    try {
      await apiPut(`/alerts/${alert.id}/resolve`)
      markResolved(alert.id)
      toast.success('Alerta resuelta')
    } catch { toast.error('No se pudo resolver') }
  }, [isPrivileged, markResolved])

  // ─── Bulk actions ─────────────────────────────────────────────────────────
  const toggleSelect = (id: string) =>
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map(a => a.id)))
  }

  const bulkAcknowledge = async () => {
    if (selected.size === 0) return
    setBulkBusy(true)
    try {
      await Promise.allSettled([...selected].map(id => apiPost(`/alerts/${id}/read`, {})))
      selected.forEach(id => markRead(id))
      setSelected(new Set())
      toast.success(`${selected.size} alerta(s) reconocida(s)`)
    } finally { setBulkBusy(false) }
  }

  const bulkResolve = async () => {
    if (selected.size === 0 || !isPrivileged) return
    setBulkBusy(true)
    try {
      await Promise.allSettled([...selected].map(id => apiPut(`/alerts/${id}/resolve`)))
      selected.forEach(id => markResolved(id))
      setSelected(new Set())
      toast.success(`${selected.size} alerta(s) resuelta(s)`)
    } finally { setBulkBusy(false) }
  }

  // ─── Filtering ────────────────────────────────────────────────────────────
  const filtered = alerts.filter((a) => {
    if (filter === 'active'       && (a.resolved || a.readAt)) return false
    if (filter === 'acknowledged' && (a.resolved || !a.readAt)) return false
    if (filter === 'resolved'     && !a.resolved) return false
    if (severityFilter !== 'all'  && a.severity !== severityFilter) return false
    return true
  })

  const counts = {
    active:       alerts.filter(a => !a.resolved && !a.readAt).length,
    acknowledged: alerts.filter(a => !a.resolved && !!a.readAt).length,
    resolved:     alerts.filter(a => a.resolved).length,
    all:          alerts.length,
  }

  const tabs: Array<{ id: FilterTab; label: string }> = [
    { id: 'active',       label: 'Activas' },
    { id: 'acknowledged', label: 'Reconocidas' },
    { id: 'resolved',     label: 'Resueltas' },
    { id: 'all',          label: 'Todas' },
  ]

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-surface-100">Alertas del sistema</h2>
          <p className="text-xs text-surface-400 mt-0.5">{counts.active} activas · {counts.acknowledged} reconocidas</p>
        </div>
        <button onClick={loadAlerts} className="btn-secondary text-xs" disabled={isLoading}>
          Actualizar
        </button>
      </div>

      {/* Tabs + severity filter */}
      <div className="flex flex-wrap gap-3">
        <div className="flex gap-1 bg-surface-800 border border-surface-600 rounded-lg p-0.5">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => { setFilter(id); setSelected(new Set()) }}
              className={clsx(
                'px-3 py-1.5 rounded-md text-xs transition-colors',
                filter === id ? 'bg-surface-700 text-surface-100' : 'text-surface-400 hover:text-surface-200'
              )}
            >
              {label}
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-surface-700/60 text-surface-400 text-[10px]">
                {counts[id]}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <Filter size={12} className="text-surface-500" />
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-lg bg-surface-800 border border-surface-600 text-surface-300 focus:outline-none"
          >
            <option value="all">Todas las severidades</option>
            <option value="CRITICAL">Crítico</option>
            <option value="HIGH">Alto</option>
            <option value="MEDIUM">Medio</option>
            <option value="LOW">Bajo</option>
          </select>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm">
          <span className="text-surface-300 text-xs">{selected.size} seleccionada(s)</span>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={bulkAcknowledge}
              disabled={bulkBusy}
              className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md bg-surface-700 hover:bg-surface-600 text-surface-200 transition-colors disabled:opacity-50"
            >
              {bulkBusy ? <Loader2 size={11} className="animate-spin" /> : <Eye size={11} />}
              Reconocer
            </button>
            {isPrivileged && (
              <button
                onClick={bulkResolve}
                disabled={bulkBusy}
                className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md bg-green-900/40 hover:bg-green-900/60 text-green-300 transition-colors disabled:opacity-50"
              >
                {bulkBusy ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                Resolver
              </button>
            )}
            <button onClick={() => setSelected(new Set())} className="text-xs text-surface-500 hover:text-surface-300 transition-colors">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Lista */}
      <div className="card divide-y divide-surface-700">
        {/* Select-all header */}
        {!isLoading && filtered.length > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 bg-surface-800/50">
            <button onClick={toggleSelectAll} className="text-surface-400 hover:text-surface-200 transition-colors">
              {selected.size === filtered.length && filtered.length > 0
                ? <CheckSquare size={13} className="text-brand-400" />
                : <Square size={13} />
              }
            </button>
            <span className="text-xs text-surface-500">Seleccionar todas ({filtered.length})</span>
          </div>
        )}

        {isLoading ? (
          <div className="py-12 text-center text-sm text-surface-500">Cargando alertas...</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <Bell size={28} className="text-surface-700 mx-auto mb-3" />
            <p className="text-sm text-surface-500">
              {filter === 'active'       ? 'No hay alertas activas ✓' :
               filter === 'acknowledged' ? 'No hay alertas reconocidas' :
               'Sin alertas en este filtro'}
            </p>
          </div>
        ) : filtered.map((alert) => {
          const sev        = SEVERITY_CONFIG[alert.severity]
          const isSelected = selected.has(alert.id)
          return (
            <div
              key={alert.id}
              className={clsx(
                'flex items-start gap-3 px-4 py-3 transition-colors',
                isSelected ? 'bg-brand-900/20' : alert.resolved ? 'opacity-50' : 'hover:bg-surface-700/30'
              )}
            >
              {/* Checkbox */}
              <button onClick={() => toggleSelect(alert.id)} className="mt-1 flex-shrink-0 text-surface-400 hover:text-surface-200 transition-colors">
                {isSelected
                  ? <CheckSquare size={13} className="text-brand-400" />
                  : <Square size={13} />
                }
              </button>

              {/* Severity icon */}
              <div className={clsx('p-1.5 rounded-lg flex-shrink-0 mt-0.5', sev.bg)}>
                {alert.resolved
                  ? <CheckCircle2 size={14} className="text-green-400" />
                  : alert.readAt
                    ? <Eye size={14} className="text-surface-400" />
                    : <AlertTriangle size={14} className={sev.color} />
                }
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={clsx('text-xs font-semibold px-1.5 py-0.5 rounded', sev.bg, sev.color)}>
                    {sev.label}
                  </span>
                  <span className="text-xs text-surface-500">{TYPE_LABELS[alert.type] || alert.type}</span>
                  {/* Estado Activa / Recuperada (TASK 7) */}
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded',
                    alert.resolved ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400')}>
                    {alert.resolved ? 'Recuperada' : 'Activa'}
                  </span>
                  {alert.readAt && !alert.resolved && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-700 text-surface-400">Reconocida</span>
                  )}
                </div>
                <p className="text-xs text-surface-200 mt-1">{alert.message}</p>
                {/* Cámara / NVR / canal / causa (TASK 7) */}
                <div className="flex items-center gap-2 mt-1 text-[11px] text-surface-500 flex-wrap">
                  {(alert.cameraName || (alert.detail as any)?.cameraName) && (
                    <span>📷 {alert.cameraName || (alert.detail as any)?.cameraName}</span>
                  )}
                  {alert.nvrName && <span>🗄 {alert.nvrName}</span>}
                  {(alert.detail as any)?.channel != null && <span>Canal {(alert.detail as any).channel}</span>}
                  {(alert.detail as any)?.detectedBy && <span>Detectado por: {(alert.detail as any).detectedBy}</span>}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-surface-500">
                  <span>{format(new Date(alert.createdAt), 'dd/MM/yyyy HH:mm:ss')}</span>
                  {/* Duración de la incidencia */}
                  {alert.resolved && alert.resolvedAt
                    ? <span className="text-green-600">Duración: {formatDistanceStrict(new Date(alert.createdAt), new Date(alert.resolvedAt))}</span>
                    : <span className="text-amber-500">Activa hace {formatDistanceToNow(new Date(alert.createdAt))}</span>}
                  {alert.readAt && (
                    <span className="text-surface-400">Reconoc: {format(new Date(alert.readAt), 'HH:mm')}</span>
                  )}
                  {alert.resolved && alert.resolvedAt && (
                    <span className="text-green-600">Resuelto: {format(new Date(alert.resolvedAt), 'HH:mm')}</span>
                  )}
                </div>
              </div>

              {/* Per-row actions */}
              {!alert.resolved && (
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!alert.readAt && (
                    <button
                      onClick={() => handleAcknowledge(alert)}
                      className="btn-ghost text-xs py-1 text-surface-400 hover:text-surface-200"
                      title="Reconocer alerta"
                    >
                      <Eye size={12} /> Reconocer
                    </button>
                  )}
                  {isPrivileged && (
                    <button
                      onClick={() => handleResolve(alert)}
                      className="btn-ghost text-xs py-1"
                      title="Marcar como resuelta"
                    >
                      <CheckCircle2 size={12} /> Resolver
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
