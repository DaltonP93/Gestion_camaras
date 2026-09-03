// src/components/layout/Sidebar.tsx
import { NavLink, useNavigate } from 'react-router-dom'
import { useRef, useState, useEffect } from 'react'
import {
  LayoutDashboard, Video, Clock, Bell, Server, Users,
  Activity, Shield, Settings, LayoutGrid, Palette,
  LogOut, UserCircle, ChevronUp, ChevronRight, Menu, X, Radar, Globe,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useAlertStore } from '@/stores/alertStore'
import { useCameraStore } from '@/stores/cameraStore'
import { useAppearanceStore } from '@/stores/appearanceStore'
import { resolveAssetUrl } from '@/lib/api'
import { clsx } from 'clsx'

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrador',
  SUPERVISOR: 'Supervisor',
  OPERATOR: 'Operador',
  AUDITOR: 'Auditor',
}

const ROLE_COLOR: Record<string, string> = {
  ADMIN: 'text-brand-400',
  SUPERVISOR: 'text-blue-400',
  OPERATOR: 'text-green-400',
  AUDITOR: 'text-amber-400',
}

const SIDEBAR_OPEN_KEY = 'sidebar_open'

function getSavedSidebarState(): boolean {
  try { return localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false' } catch { return true }
}

interface SidebarProps {
  /** Controlled from Layout — open/close on mobile */
  mobileOpen: boolean
  onMobileClose: () => void
}

export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const { user, logout } = useAuthStore()
  const { unreadCount } = useAlertStore()
  const { nvrs } = useCameraStore()
  const { settings: appearance } = useAppearanceStore()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // Desktop collapsed state (icons-only)
  const [collapsed, setCollapsed] = useState(() => !getSavedSidebarState())

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(SIDEBAR_OPEN_KEY, String(!next)) } catch { /* ignore */ }
  }

  const navItem = (
    to: string,
    icon: React.ReactNode,
    label: string,
    badge?: number,
    roles?: string[]
  ) => {
    if (roles && user && !roles.includes(user.role)) return null
    return (
      <NavLink
        to={to}
        end={to === '/'}
        onClick={onMobileClose}
        className={({ isActive }) =>
          clsx(
            'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors group relative',
            isActive
              ? 'bg-surface-700 text-surface-50'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/50'
          )
        }
        title={collapsed ? label : undefined}
      >
        <span className="w-4 h-4 flex-shrink-0">{icon}</span>
        {!collapsed && <span className="flex-1 truncate">{label}</span>}
        {!collapsed && badge != null && badge > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-brand-600 text-white text-xs font-medium">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        {collapsed && badge != null && badge > 0 && (
          <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-brand-500" />
        )}
      </NavLink>
    )
  }

  const sidebarContent = (
    <aside className={clsx(
      'flex flex-col bg-surface-800 border-r border-surface-600 h-full transition-all duration-200',
      collapsed ? 'w-14' : 'w-56',
    )}>
      {/* Logo + collapse toggle */}
      <div className="px-3 py-4 border-b border-surface-600 flex items-center gap-2.5 min-h-[60px]">
        {resolveAssetUrl(appearance.sidebarLogoUrl) ? (
          <img
            src={resolveAssetUrl(appearance.sidebarLogoUrl)!}
            alt="logo"
            className="w-8 h-8 object-contain rounded-lg flex-shrink-0"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center flex-shrink-0">
            <Shield size={16} className="text-white" />
          </div>
        )}
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-surface-50 truncate">
              {appearance.logoText || appearance.siteName || 'VisionCore'}
            </div>
            <div className="text-xs text-surface-400">NVR Management</div>
          </div>
        )}
        <button
          onClick={toggleCollapsed}
          className="hidden md:flex ml-auto p-1 rounded text-surface-500 hover:text-surface-300 hover:bg-surface-700 flex-shrink-0 transition-colors"
          title={collapsed ? 'Expandir sidebar' : 'Colapsar sidebar'}
        >
          <ChevronRight size={13} className={clsx('transition-transform', collapsed ? '' : 'rotate-180')} />
        </button>
      </div>

      {/* Nav principal */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto overflow-x-hidden">
        {!collapsed && (
          <div className="text-xs font-medium text-surface-500 uppercase tracking-wider px-3 pb-2">
            Principal
          </div>
        )}

        {navItem('/', <LayoutDashboard size={14} />, 'Dashboard')}
        {navItem('/live', <Video size={14} />, 'Vista en vivo')}
        {navItem('/views', <LayoutGrid size={14} />, 'Visores')}
        {navItem('/recordings', <Clock size={14} />, 'Grabaciones', undefined, ['ADMIN', 'SUPERVISOR', 'AUDITOR'])}
        {navItem('/alerts', <Bell size={14} />, 'Alertas', unreadCount)}
        {navItem('/analytics', <Radar size={14} />, 'Analítica', undefined, ['ADMIN', 'SUPERVISOR'])}

        {/* NVRs individuales — solo cuando expandido */}
        {!collapsed && nvrs.length > 0 && (
          <>
            <div className="text-xs font-medium text-surface-500 uppercase tracking-wider px-3 pt-4 pb-2">
              NVRs
            </div>
            {nvrs.map((nvr) => (
              <NavLink
                key={nvr.id}
                to={`/live?nvr=${nvr.id}`}
                onClick={onMobileClose}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors',
                    isActive
                      ? 'bg-surface-700 text-surface-50'
                      : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/50'
                  )
                }
              >
                <span
                  className={clsx(
                    'w-1.5 h-1.5 rounded-full flex-shrink-0',
                    nvr.online ? 'bg-green-400' : 'bg-red-500'
                  )}
                />
                <span className="truncate">{nvr.name}</span>
                <span className="ml-auto text-surface-500">{nvr.channels}ch</span>
              </NavLink>
            ))}
          </>
        )}

        {/* Admin */}
        {user?.role === 'ADMIN' && (
          <>
            {!collapsed && (
              <div className="text-xs font-medium text-surface-500 uppercase tracking-wider px-3 pt-4 pb-2">
                Administración
              </div>
            )}
            {!collapsed && <div className="pt-1" />}
            {navItem('/nvrs', <Server size={14} />, 'NVRs', undefined, ['ADMIN'])}
            {navItem('/users', <Users size={14} />, 'Usuarios', undefined, ['ADMIN'])}
            {navItem('/activity', <Activity size={14} />, 'Actividad', undefined, ['ADMIN'])}
            {navItem('/appearance', <Palette size={14} />, 'Apariencia', undefined, ['ADMIN'])}
            {navItem('/integrations', <Globe size={14} />, 'Integraciones', undefined, ['ADMIN'])}
            {navItem('/settings', <Settings size={14} />, 'Configuración', undefined, ['ADMIN'])}
          </>
        )}
      </nav>

      {/* Usuario — perfil con dropdown */}
      <div className="px-2 py-3 border-t border-surface-600 relative" ref={menuRef}>
        {/* Dropdown menu */}
        {menuOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-1 bg-surface-700 border border-surface-600 rounded-lg shadow-xl overflow-hidden z-50">
            <div className="px-3 py-2.5 border-b border-surface-600">
              <div className="text-xs font-medium text-surface-100 truncate">{user?.fullName}</div>
              <div className="text-xs text-surface-400 truncate">{user?.email}</div>
            </div>
            <button
              onClick={() => { setMenuOpen(false); onMobileClose(); navigate('/profile') }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-surface-300 hover:bg-surface-600 hover:text-surface-100 transition-colors"
            >
              <UserCircle size={14} />
              {!collapsed && 'Mi perfil'}
            </button>
            <button
              onClick={() => { setMenuOpen(false); logout() }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-900/20 hover:text-red-300 transition-colors"
            >
              <LogOut size={14} />
              {!collapsed && 'Cerrar sesión'}
            </button>
          </div>
        )}

        {/* User row */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className={clsx(
            'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-700 transition-colors cursor-pointer',
            collapsed && 'justify-center px-0'
          )}
          title={collapsed ? user?.fullName : undefined}
        >
          {user?.avatarUrl ? (
            <img src={resolveAssetUrl(user.avatarUrl) ?? user.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 text-white text-xs font-semibold">
              {user?.fullName?.charAt(0).toUpperCase() || 'U'}
            </div>
          )}
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-xs font-medium text-surface-100 truncate">{user?.fullName}</div>
                <div className={clsx('text-xs', ROLE_COLOR[user?.role || ''])}>
                  {ROLE_LABEL[user?.role || '']}
                </div>
              </div>
              <ChevronUp
                size={13}
                className={clsx('text-surface-500 transition-transform flex-shrink-0', menuOpen ? 'rotate-180' : '')}
              />
            </>
          )}
        </button>
      </div>
    </aside>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden md:flex flex-shrink-0 h-full">
        {sidebarContent}
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={onMobileClose}
          />
          {/* Drawer */}
          <div className="relative z-50 flex flex-col w-56 h-full bg-surface-800 border-r border-surface-600">
            {/* Close button */}
            <button
              onClick={onMobileClose}
              className="absolute top-3 right-3 p-1.5 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors"
            >
              <X size={16} />
            </button>
            {/* Reuse full sidebar without collapse logic on mobile */}
            <div className="flex-1 overflow-hidden">
              {sidebarContent}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Hamburger button for the Topbar — exported so Layout can place it
export function HamburgerButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="md:hidden p-2 rounded-lg text-surface-400 hover:text-surface-200 hover:bg-surface-700 transition-colors"
      aria-label="Abrir menú"
    >
      <Menu size={18} />
    </button>
  )
}
