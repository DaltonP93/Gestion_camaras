import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { clsx } from 'clsx'
import { Bell, Clock, Menu, Settings, Video, X } from 'lucide-react'
import { USERS } from './sim/mock'
import { canSeeEventsModule, canSeeRecordingsModule, canSeeSettings } from './model/permissions'
import { ROLE_LABEL, SessionProvider, useSession } from './session'
import { LivePage } from './pages/LivePage'
import { PlaybackPage } from './pages/PlaybackPage'
import { EventsPage } from './pages/EventsPage'
import { SettingsPage } from './pages/SettingsPage'

export function App() {
  return (
    <SessionProvider>
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Shell />
      </HashRouter>
    </SessionProvider>
  )
}

function Shell() {
  const { user, setUserId } = useSession()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  useEffect(() => { setDrawerOpen(false) }, [location.pathname])

  const nav = [
    { to: '/vivo', label: 'Vivo', icon: Video, show: true },
    { to: '/grabaciones', label: 'Grabaciones', icon: Clock, show: canSeeRecordingsModule(user) },
    { to: '/eventos', label: 'Eventos', icon: Bell, show: canSeeEventsModule(user) },
    { to: '/configuracion', label: 'Configuración', icon: Settings, show: canSeeSettings(user) },
  ].filter(n => n.show)

  const navList = (
    <ul className="flex flex-col gap-1 p-2" aria-label="Navegación principal">
      {nav.map(n => (
        <li key={n.to}>
          <NavLink
            to={n.to}
            className={({ isActive }) => clsx(
              'flex items-center gap-3 rounded-lg px-3 min-h-[44px] text-sm',
              isActive ? 'bg-brand-600/20 text-brand-300' : 'text-surface-200 hover:bg-surface-700',
            )}
          >
            <n.icon className="h-4 w-4 shrink-0" />
            {n.label}
          </NavLink>
        </li>
      ))}
    </ul>
  )

  return (
    <div className="flex h-full flex-col">
      <div role="note" data-testid="sim-banner" className="bg-amber-900/60 px-4 py-1 text-center text-xs text-amber-200">
        Prototipo con datos simulados — no se conecta a la API, NVR ni cámaras.
      </div>
      <header className="flex items-center gap-3 border-b border-surface-600 bg-surface-800 px-3 py-2">
        <button
          type="button"
          className="btn-ghost min-h-[44px] min-w-[44px] justify-center lg:hidden"
          aria-label="Abrir menú"
          data-testid="menu-button"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold text-surface-50">VisionCore</span>
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor="role-switch" className="hidden text-xs text-surface-300 sm:inline">Simular usuario</label>
          <select
            id="role-switch"
            data-testid="role-switch"
            className="input min-h-[44px] w-auto"
            value={user.id}
            onChange={e => setUserId(e.target.value)}
          >
            {USERS.map(u => <option key={u.id} value={u.id}>{ROLE_LABEL[u.role]} — {u.name}</option>)}
          </select>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-52 shrink-0 border-r border-surface-600 bg-surface-800 lg:block" data-testid="sidebar">
          {navList}
        </nav>
        {drawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
            <button type="button" aria-label="Cerrar menú" className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
            <nav className="absolute inset-y-0 left-0 w-64 bg-surface-800 shadow-xl" data-testid="drawer">
              <div className="flex justify-end p-2">
                <button type="button" className="btn-ghost min-h-[44px] min-w-[44px] justify-center" aria-label="Cerrar" onClick={() => setDrawerOpen(false)}>
                  <X className="h-5 w-5" />
                </button>
              </div>
              {navList}
            </nav>
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-auto" data-testid="main">
          <Routes>
            <Route path="/" element={<Navigate to="/vivo" replace />} />
            <Route path="/vivo" element={<LivePage />} />
            <Route path="/grabaciones" element={canSeeRecordingsModule(user) ? <PlaybackPage /> : <NoAccess />} />
            <Route path="/eventos" element={canSeeEventsModule(user) ? <EventsPage /> : <NoAccess />} />
            <Route path="/configuracion" element={<Navigate to="/configuracion/general" replace />} />
            <Route path="/configuracion/:section" element={canSeeSettings(user) ? <SettingsPage /> : <NoAccess />} />
            <Route path="*" element={<Navigate to="/vivo" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

export function NoAccess() {
  return (
    <div className="p-6" data-testid="no-access">
      <p className="text-sm text-surface-300">Tu rol no tiene acceso a esta sección.</p>
    </div>
  )
}
