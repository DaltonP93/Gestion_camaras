// src/components/layout/Sidebar.tsx
import { NavLink, useNavigate } from 'react-router-dom'
import { useRef, useState, useEffect } from 'react'
import {
  LayoutDashboard, Video, Clock, Bell, Server, Users,
  Activity, Shield, Settings, LayoutGrid, Palette,
  LogOut, UserCircle, ChevronUp
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

export function Sidebar() {
  const { user, logout } = useAuthStore()
  const { unreadCount } = useAlertStore()
  const { nvrs } = useCameraStore()
  const { settings: appearance } = useAppearanceStore()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

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
        className={({ isActive }) =>
          clsx(
            'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors group',
            isActive
              ? 'bg-surface-700 text-surface-50'
              : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700/50'
          )
        }
      >
        <span className="w-4 h-4 flex-shrink-0">{icon}</span>
        <span className="flex-1">{label}</span>
        {badge != null && badge > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-brand-600 text-white text-xs font-medium">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </NavLink>
    )
  }

  return (
    <aside className="w-56 flex-shrink-0 bg-surface-800 border-r border-surface-600 flex flex-col">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-surface-600">
        <div className="flex items-center gap-2.5">
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
          <div>
            <div className="text-sm font-semibold text-surface-50">
              {appearance.logoText || appearance.siteName || 'VisionCore'}
            </div>
            <div className="text-xs text-surface-400">NVR Management</div>
          </div>
        </div>
      </div>

      {/* Nav principal */}
      <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
        <div className="text-xs font-medium text-surface-500 uppercase tracking-wider px-3 pb-2">
          Principal
        </div>

        {navItem('/', <LayoutDashboard size={14} />, 'Dashboard')}
        {navItem('/live', <Video size={14} />, 'Vista en vivo')}
        {navItem('/views', <LayoutGrid size={14} />, 'Visores')}
        {navItem('/recordings', <Clock size={14} />, 'Grabaciones', undefined, ['ADMIN', 'SUPERVISOR', 'AUDITOR'])}
        {navItem('/alerts', <Bell size={14} />, 'Alertas', unreadCount)}

        {/* NVRs individuales */}
        {nvrs.length > 0 && (
          <>
            <div className="text-xs font-medium text-surface-500 uppercase tracking-wider px-3 pt-4 pb-2">
              NVRs
            </div>
            {nvrs.map((nvr) => (
              <NavLink
                key={nvr.id}
                to={`/live?nvr=${nvr.id}`}
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
            <div className="text-xs font-medium text-surface-500 uppercase tracking-wider px-3 pt-4 pb-2">
              Administración
            </div>
            {navItem('/nvrs', <Server size={14} />, 'NVRs', undefined, ['ADMIN'])}
            {navItem('/users', <Users size={14} />, 'Usuarios', undefined, ['ADMIN'])}
            {navItem('/activity', <Activity size={14} />, 'Actividad', undefined, ['ADMIN'])}
            {navItem('/appearance', <Palette size={14} />, 'Apariencia', undefined, ['ADMIN'])}
            {navItem('/settings', <Settings size={14} />, 'Configuración', undefined, ['ADMIN'])}
          </>
        )}
      </nav>

      {/* Usuario — perfil con dropdown */}
      <div className="px-3 py-3 border-t border-surface-600 relative" ref={menuRef}>
        {/* Dropdown menu */}
        {menuOpen && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-surface-700 border border-surface-600 rounded-lg shadow-xl overflow-hidden z-50">
            <div className="px-3 py-2.5 border-b border-surface-600">
              <div className="text-xs font-medium text-surface-100 truncate">{user?.fullName}</div>
              <div className="text-xs text-surface-400 truncate">{user?.email}</div>
            </div>
            <button
              onClick={() => { setMenuOpen(false); navigate('/profile') }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-surface-300 hover:bg-surface-600 hover:text-surface-100 transition-colors"
            >
              <UserCircle size={14} />
              Mi perfil
            </button>
            <button
              onClick={() => { setMenuOpen(false); logout() }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-900/20 hover:text-red-300 transition-colors"
            >
              <LogOut size={14} />
              Cerrar sesión
            </button>
          </div>
        )}

        {/* User row */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-700 transition-colors cursor-pointer"
        >
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 text-white text-xs font-semibold">
              {user?.fullName?.charAt(0).toUpperCase() || 'U'}
            </div>
          )}
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
        </button>
      </div>
    </aside>
  )
}
