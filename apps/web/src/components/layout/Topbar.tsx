// src/components/layout/Topbar.tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Search, Bell, RefreshCw, X, CheckCircle, AlertTriangle, Clock } from 'lucide-react'
import { useAlertStore } from '@/stores/alertStore'
import { useCameraStore } from '@/stores/cameraStore'
import { apiGet, apiPost } from '@/lib/api'
import { clsx } from 'clsx'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import type { Alert } from '@/types'

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: 'text-red-400',
  HIGH:     'text-orange-400',
  MEDIUM:   'text-amber-400',
  LOW:      'text-blue-400',
}

const PAGE_TITLES: Record<string, string> = {
  '/':           'Dashboard',
  '/live':       'Vista en vivo',
  '/views':      'Vistas',
  '/recordings': 'Grabaciones',
  '/alerts':     'Alertas del sistema',
  '/nvrs':       'Gestión de NVRs',
  '/users':      'Gestión de usuarios',
  '/activity':   'Registro de actividad',
}

// ─── Notification Panel ──────────────────────────────────────────────────────
function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { alerts, markRead, markAllRead } = useAlertStore()
  const navigate = useNavigate()
  const [savingAll, setSavingAll] = useState(false)

  const unread = alerts.filter((a) => !a.resolved && !a.readAt).slice(0, 20)

  const handleMarkRead = useCallback(async (id: string) => {
    markRead(id)
    apiPost(`/alerts/${id}/read`, {}).catch(() => {})
  }, [markRead])

  const handleMarkAllRead = useCallback(async () => {
    setSavingAll(true)
    markAllRead()
    await apiPost('/alerts/read-all', {}).catch(() => {})
    setSavingAll(false)
  }, [markAllRead])

  const handleGoAlerts = () => {
    navigate('/alerts')
    onClose()
  }

  return (
    <div className="absolute right-0 top-full mt-1.5 w-80 bg-surface-800 border border-surface-600 rounded-xl shadow-2xl z-50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
        <div className="flex items-center gap-2">
          <Bell size={13} className="text-surface-400" />
          <span className="text-sm font-medium text-surface-100">Notificaciones</span>
          {unread.length > 0 && (
            <span className="text-[10px] bg-brand-600 text-white px-1.5 py-0.5 rounded-full font-bold leading-none">
              {unread.length}
            </span>
          )}
        </div>
        {unread.length > 0 && (
          <button
            onClick={handleMarkAllRead}
            disabled={savingAll}
            className="text-xs text-brand-400 hover:text-brand-300 disabled:opacity-50 transition-colors"
          >
            Marcar todo leído
          </button>
        )}
      </div>

      {/* Alert list */}
      <div className="max-h-80 overflow-y-auto divide-y divide-surface-700/50">
        {unread.length === 0 ? (
          <div className="py-10 flex flex-col items-center gap-2.5">
            <CheckCircle size={26} className="text-green-500" />
            <p className="text-sm text-surface-400">Sin alertas pendientes</p>
          </div>
        ) : (
          unread.map((alert) => (
            <div
              key={alert.id}
              className="flex items-start gap-3 px-4 py-3 hover:bg-surface-750 transition-colors group"
            >
              <AlertTriangle
                size={13}
                className={clsx('mt-0.5 shrink-0', SEVERITY_COLOR[alert.severity] ?? 'text-surface-400')}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-surface-100 leading-snug">{alert.message}</p>
                {alert.nvrName && (
                  <p className="text-[10px] text-surface-500 mt-0.5">{alert.nvrName}</p>
                )}
                <p className="text-[10px] text-surface-600 mt-0.5 flex items-center gap-1">
                  <Clock size={8} />
                  {formatDistanceToNow(new Date(alert.createdAt), { locale: es, addSuffix: true })}
                </p>
              </div>
              <button
                onClick={() => handleMarkRead(alert.id)}
                title="Marcar como leída"
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-surface-500 hover:text-surface-200 transition-all shrink-0 mt-0.5"
              >
                <X size={11} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-surface-700 bg-surface-750/50">
        <button
          onClick={handleGoAlerts}
          className="w-full text-xs text-center text-brand-400 hover:text-brand-300 transition-colors"
        >
          Ver todas las alertas →
        </button>
      </div>
    </div>
  )
}

// ─── Topbar ───────────────────────────────────────────────────────────────────
export function Topbar() {
  const location = useLocation()
  const { unreadCount, setUnreadCount } = useAlertStore()
  const { nvrs, loadNVRs, loadCameras } = useCameraStore()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [search, setSearch] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const bellRef = useRef<HTMLDivElement>(null)

  // Load NVRs and fetch initial unread count from API
  useEffect(() => {
    if (nvrs.length === 0) loadNVRs()
    apiGet<{ count: number }>('/alerts/unread-count')
      .then(({ count }) => setUnreadCount(count))
      .catch(() => {})
  }, [])

  // Close panel on outside click
  useEffect(() => {
    if (!panelOpen) return
    const handler = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [panelOpen])

  const title = Object.entries(PAGE_TITLES).find(([path]) =>
    location.pathname === path || location.pathname.startsWith(path + '/')
  )?.[1] ?? 'VisionCore'

  const onlineNVRs = nvrs.filter((n) => n.online).length
  const totalCameras = nvrs.reduce((acc, n) => acc + (n.cameras?.length ?? n.channels), 0)

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await Promise.all([loadNVRs(), loadCameras()])
    setTimeout(() => setIsRefreshing(false), 500)
  }

  return (
    <header className="h-12 flex-shrink-0 bg-surface-800 border-b border-surface-600 flex items-center px-4 gap-3">
      <h1 className="text-sm font-medium text-surface-100 mr-2">{title}</h1>

      {/* Status pills */}
      <div className="flex items-center gap-2 flex-1">
        <span className="hidden sm:flex items-center gap-1 text-xs text-green-400 bg-green-900/30 px-2 py-0.5 rounded-full">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
          {onlineNVRs} NVRs online
        </span>
        <span className="hidden md:flex items-center gap-1 text-xs text-surface-400">
          {totalCameras} cámaras
        </span>
      </div>

      {/* Search */}
      <div className="relative hidden md:block">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
        <input
          type="text"
          placeholder="Buscar cámara..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-48 pl-8 pr-3 py-1.5 rounded-lg bg-surface-900 border border-surface-600 text-surface-100 text-xs
                     placeholder-surface-500 focus:outline-none focus:border-brand-500 transition-colors"
        />
      </div>

      {/* Refresh */}
      <button
        onClick={handleRefresh}
        className={clsx(
          'p-1.5 rounded-lg text-surface-400 hover:text-surface-100 hover:bg-surface-700 transition-colors',
          isRefreshing && 'animate-spin'
        )}
        title="Actualizar"
      >
        <RefreshCw size={14} />
      </button>

      {/* Bell + notification panel */}
      <div className="relative" ref={bellRef}>
        <button
          onClick={() => setPanelOpen((o) => !o)}
          className={clsx(
            'relative p-1.5 rounded-lg text-surface-400 hover:text-surface-100 hover:bg-surface-700 transition-colors',
            panelOpen && 'bg-surface-700 text-surface-100'
          )}
          title="Notificaciones"
        >
          <Bell size={14} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-brand-600 text-white text-[9px] flex items-center justify-center font-bold">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>

        {panelOpen && (
          <NotificationPanel onClose={() => setPanelOpen(false)} />
        )}
      </div>
    </header>
  )
}
