// src/pages/DashboardPage.tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Video, Server, HardDrive, Bell, Activity,
  ChevronRight, AlertTriangle, CheckCircle2, Database
} from 'lucide-react'
import { useCameraStore } from '@/stores/cameraStore'
import { useAlertStore } from '@/stores/alertStore'
import { useAuthStore } from '@/stores/authStore'
import { apiGet } from '@/lib/api'
import { clsx } from 'clsx'
import type { NVRStatus, DashboardOverview, Alert } from '@/types'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

function StatCard({
  icon, label, value, sub, subColor, to
}: {
  icon: React.ReactNode; label: string; value: string | number
  sub?: string; subColor?: string; to?: string
}) {
  const content = (
    <div className="card p-4 hover:border-surface-500 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div className="p-2 rounded-lg bg-surface-700 text-surface-300">{icon}</div>
        {to && <ChevronRight size={14} className="text-surface-500 mt-1" />}
      </div>
      <div className="text-2xl font-semibold text-surface-50 mb-0.5">{value}</div>
      <div className="text-xs text-surface-400">{label}</div>
      {sub && (
        <div className={clsx('text-xs mt-1', subColor || 'text-surface-500')}>{sub}</div>
      )}
    </div>
  )
  return to ? <Link to={to}>{content}</Link> : content
}

export function DashboardPage() {
  const { nvrs, loadNVRs, loadCameras, loadNVRStatus, nvrStatuses } = useCameraStore()
  const { refreshSummary } = useAlertStore()
  const { user } = useAuthStore()
  // Resumen ÚNICO server-side (P1): totales de cámaras, alertas y actividad REAL.
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  // Lista de alertas recientes SOLO para este widget — estado local, NO el arreglo
  // global compartido (que causaba contadores contradictorios entre pantallas).
  const [recentAlerts, setRecentAlerts] = useState<Alert[]>([])

  const loadOverview = () => apiGet<DashboardOverview>('/dashboard/overview').then(setOverview).catch(() => {})

  useEffect(() => {
    loadNVRs()
    loadCameras()
    loadOverview()
    apiGet<Alert[]>('/alerts?status=active&limit=8').then(setRecentAlerts).catch(() => {})
    void refreshSummary()   // mantiene campana/menú consistentes al entrar al Dashboard
  }, [])

  useEffect(() => {
    nvrs.forEach((nvr) => loadNVRStatus(nvr.id))
  }, [nvrs])

  // Contadores desde el resumen server-side — NO desde un arreglo compartido.
  const totalCameras  = overview?.cameras.total ?? 0
  const onlineCameras = overview?.cameras.online ?? 0
  const pendingAlerts  = overview?.alerts.pending ?? 0
  const criticalPending = overview?.alerts.criticalPending ?? 0
  // Serie temporal REAL de alertas por hora (reemplaza Math.random).
  const activityData = (overview?.activity ?? []).map((b) => ({
    time: format(new Date(b.hourStart), 'HH:mm'),
    alertas: b.alerts,
  }))
  const avgDiskUsage = nvrs.length > 0
    ? Math.round(Object.values(nvrStatuses).reduce((acc, s) => acc + s.diskUsage, 0) / Math.max(Object.keys(nvrStatuses).length, 1))
    : 0

  return (
    <div className="p-5 space-y-5 animate-fade-in">
      {/* Saludo */}
      <div>
        <h2 className="text-base font-semibold text-surface-100">
          Bienvenido, {user?.fullName?.split(' ')[0]}
        </h2>
        <p className="text-xs text-surface-400 mt-0.5">
          {format(new Date(), "EEEE d 'de' MMMM yyyy", { locale: es })}
        </p>
      </div>

      {/* Stats principales */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<Video size={16} />}
          label="Cámaras totales"
          value={totalCameras}
          sub={`${onlineCameras} en línea`}
          subColor="text-green-400"
          to="/live"
        />
        <StatCard
          icon={<Server size={16} />}
          label="NVRs activos"
          value={nvrs.length}
          sub={`${nvrs.filter(n => n.active).length} conectados`}
          subColor="text-green-400"
          to="/nvrs"
        />
        <StatCard
          icon={<HardDrive size={16} />}
          label="Uso de almacenamiento"
          value={`${avgDiskUsage}%`}
          sub={`${nvrs.reduce((a, n) => a + n.hddCount, 0)} HDDs en total`}
          subColor={avgDiskUsage > 85 ? 'text-red-400' : avgDiskUsage > 70 ? 'text-amber-400' : 'text-surface-400'}
        />
        <StatCard
          icon={<Bell size={16} />}
          label="Alertas pendientes"
          value={pendingAlerts}
          sub={
            criticalPending > 0
              ? `${criticalPending} críticas/altas`
              : pendingAlerts > 0 ? 'Revisar alertas' : 'Todo OK'
          }
          subColor={criticalPending > 0 ? 'text-red-400' : pendingAlerts > 0 ? 'text-amber-400' : 'text-green-400'}
          to="/alerts"
        />
      </div>

      {/* Gráfico de actividad */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-medium text-surface-100">Alertas últimas 24h</h3>
            <p className="text-xs text-surface-400 mt-0.5">Alertas generadas por hora (datos reales)</p>
          </div>
          <Activity size={14} className="text-surface-500" />
        </div>
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={activityData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="alertGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#e51d1d" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#e51d1d" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" tick={{ fill: '#6e7681', fontSize: 10 }} tickLine={false} axisLine={false} interval={5} />
            <YAxis allowDecimals={false} tick={{ fill: '#6e7681', fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ background: '#21262d', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#c9d1d9' }}
            />
            <Area type="monotone" dataKey="alertas" stroke="#e51d1d" strokeWidth={2} fill="url(#alertGrad)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* NVRs y Alertas recientes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Estado de NVRs */}
        <div className="card">
          <div className="px-4 py-3 border-b border-surface-600 flex items-center justify-between">
            <h3 className="text-sm font-medium text-surface-100">Estado de NVRs</h3>
            <Link to="/nvrs" className="text-xs text-brand-400 hover:text-brand-300">Ver todos →</Link>
          </div>
          <div className="divide-y divide-surface-700">
            {nvrs.map((nvr) => {
              const status = nvrStatuses[nvr.id]
              const hdds = nvr.hdds ?? []
              // Prefer live status disk usage, fall back to saved hdds
              const diskPct = status?.diskUsage != null
                ? status.diskUsage
                : hdds.length > 0
                  ? Math.round(hdds.reduce((a, h) => a + (h.usedPercent ?? 0), 0) / hdds.length)
                  : null
              const hddsSynced = hdds.length > 0
              return (
                <div key={nvr.id} className="px-4 py-3 flex items-start gap-3">
                  <span className={clsx(
                    'w-2 h-2 rounded-full flex-shrink-0 mt-1.5',
                    status?.online ? 'bg-green-400' : nvr.active ? 'bg-amber-400' : 'bg-surface-500'
                  )} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-surface-100 truncate">{nvr.name}</div>
                    <div className="text-xs text-surface-400">{nvr.model} · {nvr.channels} canales</div>
                    {hddsSynced && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {hdds.map((hdd) => (
                          <div key={hdd.id} className="flex items-center gap-1 text-[10px] text-surface-500">
                            <Database size={8} className="flex-shrink-0" />
                            <span>HDD{hdd.diskNumber}</span>
                            {hdd.usedPercent != null && (
                              <span className={clsx(
                                'font-medium',
                                hdd.usedPercent > 85 ? 'text-red-400' : hdd.usedPercent > 70 ? 'text-amber-400' : 'text-surface-400'
                              )}>{hdd.usedPercent}%</span>
                            )}
                            {hdd.capacityGb != null && (
                              <span className="text-surface-600">{hdd.capacityGb >= 1000 ? `${(hdd.capacityGb / 1000).toFixed(1)}TB` : `${hdd.capacityGb}GB`}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {!hddsSynced && !status && (
                      <Link to="/nvrs" className="text-[10px] text-surface-600 mt-1 block hover:text-brand-400">
                        Sin datos de almacenamiento · Ver NVR →
                      </Link>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    {diskPct != null ? (
                      <div className={clsx(
                        'text-xs font-medium',
                        diskPct > 85 ? 'text-red-400' : diskPct > 70 ? 'text-amber-400' : 'text-surface-400'
                      )}>
                        {diskPct}%
                      </div>
                    ) : (
                      <div className="text-xs text-surface-600">—</div>
                    )}
                    {status?.firmware && (
                      <div className="text-xs text-surface-500 mt-0.5">{status.firmware}</div>
                    )}
                  </div>
                </div>
              )
            })}
            {nvrs.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-surface-500">
                No hay NVRs configurados
              </div>
            )}
          </div>
        </div>

        {/* Alertas recientes */}
        <div className="card">
          <div className="px-4 py-3 border-b border-surface-600 flex items-center justify-between">
            <h3 className="text-sm font-medium text-surface-100">Alertas recientes</h3>
            <Link to="/alerts" className="text-xs text-brand-400 hover:text-brand-300">Ver todas →</Link>
          </div>
          <div className="divide-y divide-surface-700 max-h-64 overflow-auto">
            {recentAlerts.slice(0, 8).map((alert) => (
              <div key={alert.id} className="px-4 py-3 flex items-start gap-3">
                {alert.resolved ? (
                  <CheckCircle2 size={14} className="text-green-400 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertTriangle size={14} className={clsx(
                    'mt-0.5 flex-shrink-0',
                    alert.severity === 'CRITICAL' ? 'text-red-400' :
                    alert.severity === 'HIGH' ? 'text-orange-400' : 'text-amber-400'
                  )} />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-surface-200">{alert.message}</div>
                  <div className="text-xs text-surface-500 mt-0.5">
                    {format(new Date(alert.createdAt), 'dd/MM HH:mm')}
                  </div>
                </div>
              </div>
            ))}
            {recentAlerts.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-green-400">
                ✓ Sin alertas activas
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
