// src/pages/AlertsPage.tsx
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Bell, Filter } from 'lucide-react'
import { useAlertStore } from '@/stores/alertStore'
import { apiGet, apiPut } from '@/lib/api'
import { clsx } from 'clsx'
import type { Alert, AlertSeverity } from '@/types'
import { format } from 'date-fns'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

const SEVERITY_CONFIG: Record<AlertSeverity, { label: string; color: string; bg: string }> = {
  CRITICAL: { label: 'Crítico', color: 'text-red-400',    bg: 'bg-red-900/30' },
  HIGH:     { label: 'Alto',    color: 'text-orange-400', bg: 'bg-orange-900/30' },
  MEDIUM:   { label: 'Medio',   color: 'text-amber-400',  bg: 'bg-amber-900/30' },
  LOW:      { label: 'Bajo',    color: 'text-blue-400',   bg: 'bg-blue-900/30' },
}

const TYPE_LABELS: Record<string, string> = {
  CAMERA_OFFLINE: 'Cámara offline',
  NVR_OFFLINE: 'NVR offline',
  HDD_FULL: 'Disco lleno',
  HDD_ERROR: 'Error de disco',
  MOTION_DETECTED: 'Movimiento detectado',
  RECORDING_ERROR: 'Error de grabación',
  AUTH_FAILED: 'Fallo de autenticación',
}

export function AlertsPage() {
  const { alerts, setAlerts, markResolved } = useAlertStore()
  const { user } = useAuthStore()
  const [filter, setFilter] = useState<'all' | 'active' | 'resolved'>('active')
  const [severityFilter, setSeverityFilter] = useState<string>('all')
  const [isLoading, setIsLoading] = useState(true)

  const loadAlerts = async () => {
    setIsLoading(true)
    try {
      const data = await apiGet<Alert[]>('/alerts?limit=200')
      setAlerts(data)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { loadAlerts() }, [])

  const handleResolve = async (alert: Alert) => {
    if (!['ADMIN', 'SUPERVISOR'].includes(user?.role || '')) return
    try {
      await apiPut(`/alerts/${alert.id}/resolve`)
      markResolved(alert.id)
      toast.success('Alerta resuelta')
    } catch {}
  }

  const filtered = alerts.filter((a) => {
    if (filter === 'active' && a.resolved) return false
    if (filter === 'resolved' && !a.resolved) return false
    if (severityFilter !== 'all' && a.severity !== severityFilter) return false
    return true
  })

  const counts = {
    all: alerts.length,
    active: alerts.filter((a) => !a.resolved).length,
    resolved: alerts.filter((a) => a.resolved).length,
  }

  return (
    <div className="p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-surface-100">Alertas del sistema</h2>
          <p className="text-xs text-surface-400 mt-0.5">{counts.active} alertas activas</p>
        </div>
        <button onClick={loadAlerts} className="btn-secondary text-xs">
          Actualizar
        </button>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3">
        <div className="flex gap-1 bg-surface-800 border border-surface-600 rounded-lg p-0.5">
          {(['active', 'all', 'resolved'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx(
                'px-3 py-1.5 rounded-md text-xs transition-colors',
                filter === f ? 'bg-surface-700 text-surface-100' : 'text-surface-400 hover:text-surface-200'
              )}
            >
              {f === 'active' ? 'Activas' : f === 'resolved' ? 'Resueltas' : 'Todas'}
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-surface-700 text-surface-400 text-xs">
                {counts[f]}
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

      {/* Lista */}
      <div className="card divide-y divide-surface-700">
        {isLoading ? (
          <div className="py-12 text-center text-sm text-surface-500">Cargando alertas...</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <Bell size={28} className="text-surface-700 mx-auto mb-3" />
            <p className="text-sm text-surface-500">
              {filter === 'active' ? 'No hay alertas activas ✓' : 'Sin alertas en este filtro'}
            </p>
          </div>
        ) : filtered.map((alert) => {
          const sev = SEVERITY_CONFIG[alert.severity]
          return (
            <div key={alert.id} className={clsx(
              'flex items-start gap-3 px-4 py-3 transition-colors',
              alert.resolved ? 'opacity-50' : 'hover:bg-surface-700/30'
            )}>
              <div className={clsx('p-1.5 rounded-lg flex-shrink-0 mt-0.5', sev.bg)}>
                {alert.resolved
                  ? <CheckCircle2 size={14} className="text-green-400" />
                  : <AlertTriangle size={14} className={sev.color} />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={clsx('text-xs font-semibold px-1.5 py-0.5 rounded', sev.bg, sev.color)}>
                    {sev.label}
                  </span>
                  <span className="text-xs text-surface-500">{TYPE_LABELS[alert.type] || alert.type}</span>
                </div>
                <p className="text-xs text-surface-200 mt-1">{alert.message}</p>
                <div className="flex items-center gap-3 mt-1 text-xs text-surface-500">
                  <span>{format(new Date(alert.createdAt), 'dd/MM/yyyy HH:mm:ss')}</span>
                  {alert.resolved && alert.resolvedAt && (
                    <span className="text-green-600">Resuelto: {format(new Date(alert.resolvedAt), 'HH:mm')}</span>
                  )}
                </div>
              </div>
              {!alert.resolved && ['ADMIN', 'SUPERVISOR'].includes(user?.role || '') && (
                <button
                  onClick={() => handleResolve(alert)}
                  className="btn-ghost text-xs py-1 flex-shrink-0"
                >
                  <CheckCircle2 size={12} /> Resolver
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
