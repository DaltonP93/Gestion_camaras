// src/components/layout/Topbar.tsx
import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Search, Bell, RefreshCw } from 'lucide-react'
import { useAlertStore } from '@/stores/alertStore'
import { useAuthStore } from '@/stores/authStore'
import { useCameraStore } from '@/stores/cameraStore'
import { clsx } from 'clsx'

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/live': 'Vista en vivo',
  '/recordings': 'Grabaciones',
  '/alerts': 'Alertas del sistema',
  '/nvrs': 'Gestión de NVRs',
  '/users': 'Gestión de usuarios',
  '/activity': 'Registro de actividad',
}

export function Topbar() {
  const location = useLocation()
  const { unreadCount, markAllRead } = useAlertStore()
  const { nvrs, loadNVRs, loadCameras } = useCameraStore()
  const { user } = useAuthStore()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [search, setSearch] = useState('')

  // Ensure NVRs are loaded regardless of which page the user lands on
  useEffect(() => {
    if (nvrs.length === 0) loadNVRs()
  }, [])

  const title = PAGE_TITLES[location.pathname] || 'VisionCore'

  // online=true means reachable at last sync; active=true means enabled in DB
  const onlineNVRs = nvrs.filter((n) => n.online).length
  // Use actual synced camera count when available, fall back to configured channel capacity
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

      {/* Búsqueda */}
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

      {/* Alertas */}
      <button
        onClick={markAllRead}
        className="relative p-1.5 rounded-lg text-surface-400 hover:text-surface-100 hover:bg-surface-700 transition-colors"
        title="Alertas"
      >
        <Bell size={14} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-brand-600 text-white text-[9px] flex items-center justify-center font-bold">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
    </header>
  )
}
