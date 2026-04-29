// src/components/layout/Sidebar.tsx
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Video, Clock, Bell, Server, Users,
  Activity, ChevronRight, Shield, Settings
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useAlertStore } from '@/stores/alertStore'
import { useCameraStore } from '@/stores/cameraStore'
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
          <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center flex-shrink-0">
            <Shield size={16} className="text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold text-surface-50">VisionCore</div>
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
                    nvr.active ? 'bg-green-400' : 'bg-surface-500'
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
            {navItem('/settings', <Settings size={14} />, 'Configuración', undefined, ['ADMIN'])}
          </>
        )}
      </nav>

      {/* Usuario */}
      <div className="px-3 py-3 border-t border-surface-600">
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-700 transition-colors cursor-pointer group">
          <div className="w-7 h-7 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 text-white text-xs font-semibold">
            {user?.fullName?.charAt(0).toUpperCase() || 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-surface-100 truncate">{user?.fullName}</div>
            <div className={clsx('text-xs', ROLE_COLOR[user?.role || ''])}>
              {ROLE_LABEL[user?.role || '']}
            </div>
          </div>
          <button
            onClick={logout}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-surface-500 hover:text-brand-400"
            title="Cerrar sesión"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}
