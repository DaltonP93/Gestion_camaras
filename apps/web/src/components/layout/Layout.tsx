// src/components/layout/Layout.tsx
import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar, HamburgerButton } from './Sidebar'
import { Topbar } from './Topbar'
import { useAppearance } from '@/hooks/useAppearance'

export function Layout() {
  useAppearance()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  return (
    <div className="flex h-[100dvh] bg-surface-900 overflow-hidden">
      <Sidebar
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Topbar hamburger={<HamburgerButton onClick={() => setMobileSidebarOpen(true)} />} />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
