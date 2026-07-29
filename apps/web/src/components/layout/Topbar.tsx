// src/components/layout/Topbar.tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Search, Bell, RefreshCw, X, CheckCircle, AlertTriangle, Clock,
  Camera, Monitor, LayoutGrid, Wifi, WifiOff, ChevronRight,
} from 'lucide-react'
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

// ─── Search result type ───────────────────────────────────────────────────────
interface SearchResult {
  type: 'camera' | 'nvr' | 'view' | 'alert'
  id: string
  title: string
  subtitle: string
  nvrId?: string
  cameraId?: string
  url: string
  status?: string
  metadata?: Record<string, unknown>
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  camera:    <Camera size={12} />,
  nvr:       <Monitor size={12} />,
  view:      <LayoutGrid size={12} />,
  alert:     <AlertTriangle size={12} />,
}
const TYPE_LABEL: Record<string, string> = {
  camera: 'Cámara',
  nvr:    'NVR',
  view:   'Vista',
  alert:  'Alerta',
}

// ─── Command Palette ──────────────────────────────────────────────────────────
function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q.trim().length < 2) { setResults([]); setLoading(false); return }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await apiGet<SearchResult[]>('/search/global', { q })
        setResults(data)
        setActiveIdx(0)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 280)
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value)
    search(e.target.value)
  }

  const handleSelect = useCallback((r: SearchResult) => {
    navigate(r.url)
    onClose()
  }, [navigate, onClose])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)) }
    if (e.key === 'Enter' && results[activeIdx]) handleSelect(results[activeIdx])
    if (e.key === 'Escape') onClose()
  }

  // Group results by type
  const groups: Record<string, SearchResult[]> = {}
  for (const r of results) {
    if (!groups[r.type]) groups[r.type] = []
    groups[r.type].push(r)
  }
  const flatResults = results // for active index tracking

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4" onClick={onClose}>
      <div
        className="w-full max-w-xl bg-surface-800 border border-surface-600 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-700">
          <Search size={15} className="text-surface-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Buscar cámaras, NVRs, vistas, alertas..."
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-sm text-surface-100 placeholder-surface-500 outline-none"
          />
          {loading && (
            <RefreshCw size={13} className="animate-spin text-surface-400 flex-shrink-0" />
          )}
          <kbd className="hidden sm:block text-[10px] text-surface-600 border border-surface-700 rounded px-1 py-0.5">Esc</kbd>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {(Object.entries(groups) as [string, SearchResult[]][]).map(([type, items]) => (
              <div key={type}>
                <div className="px-4 py-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-surface-500 uppercase tracking-wide">
                  {TYPE_ICON[type]}
                  {TYPE_LABEL[type] ?? type}
                  <span className="ml-1 font-normal normal-case text-surface-600">({items.length})</span>
                </div>
                {items.map((r) => {
                  const globalIdx = flatResults.indexOf(r)
                  const isActive = globalIdx === activeIdx
                  return (
                    <button
                      key={r.id}
                      onClick={() => handleSelect(r)}
                      onMouseEnter={() => setActiveIdx(globalIdx)}
                      className={clsx(
                        'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                        isActive ? 'bg-brand-600/20' : 'hover:bg-surface-700/50'
                      )}
                    >
                      {/* Status dot */}
                      <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0 mt-0.5',
                        r.status === 'online'   ? 'bg-green-400' :
                        r.status === 'offline'  ? 'bg-surface-600' :
                        r.status === 'CRITICAL' ? 'bg-red-500' :
                        r.status === 'HIGH'     ? 'bg-orange-400' :
                        r.status === 'MEDIUM'   ? 'bg-amber-400' :
                        'bg-surface-500'
                      )} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-surface-100 truncate">{r.title}</p>
                        <p className="text-[11px] text-surface-500 truncate">{r.subtitle}</p>
                      </div>
                      {r.status === 'online' && (
                        <span className="flex items-center gap-1 text-[10px] text-green-400">
                          <Wifi size={10} /> Online
                        </span>
                      )}
                      {r.status === 'offline' && (
                        <span className="flex items-center gap-1 text-[10px] text-surface-500">
                          <WifiOff size={10} /> Offline
                        </span>
                      )}
                      <ChevronRight size={12} className={clsx('flex-shrink-0 text-surface-600', isActive && 'text-brand-400')} />
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && query.trim().length >= 2 && results.length === 0 && (
          <div className="py-8 text-center text-sm text-surface-500">
            Sin resultados para <span className="text-surface-300">"{query}"</span>
          </div>
        )}

        {/* Hint */}
        {query.trim().length === 0 && (
          <div className="px-4 py-3 text-xs text-surface-600">
            Escribe al menos 2 caracteres para buscar
          </div>
        )}

        {/* Footer shortcuts */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-surface-700 bg-surface-800/50 text-[10px] text-surface-600">
          <span><kbd className="border border-surface-700 rounded px-0.5">↑↓</kbd> navegar</span>
          <span><kbd className="border border-surface-700 rounded px-0.5">Enter</kbd> abrir</span>
          <span><kbd className="border border-surface-700 rounded px-0.5">Esc</kbd> cerrar</span>
        </div>
      </div>
    </div>
  )
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

  const handleAlertClick = useCallback((alert: Alert) => {
    handleMarkRead(alert.id)
    if (alert.cameraId && alert.nvrId) {
      navigate(`/live?nvr=${alert.nvrId}&camera=${alert.cameraId}`)
    } else if (alert.nvrId) {
      navigate(`/nvrs/${alert.nvrId}`)
    } else {
      navigate('/alerts')
    }
    onClose()
  }, [handleMarkRead, navigate, onClose])

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
              onClick={() => handleAlertClick(alert)}
              className="flex items-start gap-3 px-4 py-3 hover:bg-surface-750 transition-colors group cursor-pointer"
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
                onClick={(e) => { e.stopPropagation(); handleMarkRead(alert.id) }}
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
export function Topbar({ hamburger }: { hamburger?: React.ReactNode }) {
  const location = useLocation()
  const { alerts, setAlerts, unreadCount, refreshSummary } = useAlertStore()
  const { nvrs, loadNVRs, loadCameras } = useCameraStore()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const bellRef = useRef<HTMLDivElement>(null)

  // Load NVRs and fetch the authoritative counters from the backend summary.
  // La campana = summary.unread (fuente única); ya NO se recalcula desde la lista.
  useEffect(() => {
    if (nvrs.length === 0) loadNVRs()
    void refreshSummary()
  }, [])

  // Load alert list the first time the panel opens (or if empty on re-open)
  useEffect(() => {
    if (panelOpen && alerts.length === 0) {
      apiGet<{ items: Alert[] }>('/alerts?limit=50').then((d) => setAlerts(d.items)).catch(() => {})
    }
  }, [panelOpen])

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

  // Global keyboard shortcut Ctrl+K / Cmd+K to open palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

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
    <>
      <header className="h-12 flex-shrink-0 bg-surface-800 border-b border-surface-600 flex items-center px-4 gap-3">
        {hamburger}
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

        {/* Search trigger */}
        <button
          onClick={() => setPaletteOpen(true)}
          className="hidden md:flex items-center gap-2 w-48 px-3 py-1.5 rounded-lg bg-surface-900 border border-surface-600 text-surface-500 text-xs hover:border-brand-500 hover:text-surface-300 transition-colors"
        >
          <Search size={12} />
          <span className="flex-1 text-left">Buscar...</span>
          <kbd className="text-[10px] border border-surface-700 rounded px-1 py-0.5 text-surface-600">⌘K</kbd>
        </button>

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

      {/* Command palette overlay */}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  )
}
