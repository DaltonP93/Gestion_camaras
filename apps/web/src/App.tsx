// src/App.tsx
import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { apiGet, resolveAssetUrl } from '@/lib/api'
import type { AppearanceSettings } from '@/types'
import { Layout } from '@/components/layout/Layout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { LiveViewPage } from '@/pages/LiveViewPage'
import { RecordingsPage } from '@/pages/RecordingsPage'
import { UsersPage } from '@/pages/UsersPage'
import { NVRsPage } from '@/pages/NVRsPage'
import { NVRDetailPage } from '@/pages/NVRDetailPage'
import { AlertsPage } from '@/pages/AlertsPage'
import { ActivityPage } from '@/pages/ActivityPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { ViewsPage } from '@/pages/ViewsPage'
import { ViewPlayerPage } from '@/pages/ViewPlayerPage'
import { AppearancePage } from '@/pages/AppearancePage'
import { ProfilePage } from '@/pages/ProfilePage'
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage'
import { ResetPasswordPage } from '@/pages/ResetPasswordPage'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'

export default function App() {
  const { isAuthenticated, loadUser } = useAuthStore()

  // Always validate/rehydrate session on page load — not just when already authenticated.
  // This repairs the token header after a hard refresh and validates the token is still valid.
  useEffect(() => {
    loadUser()
  }, [])

  // Apply saved appearance settings on initial load
  useEffect(() => {
    apiGet<AppearanceSettings>('/appearance').then((data) => {
      if (data.siteName) document.title = data.siteName
      const resolvedFavicon = resolveAssetUrl(data.faviconUrl)
      if (resolvedFavicon) {
        let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
        if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
        link.href = resolvedFavicon
      }
      const styleId = 'visioncore-custom-css'
      let style = document.getElementById(styleId) as HTMLStyleElement | null
      if (!style) { style = document.createElement('style'); style.id = styleId; document.head.appendChild(style) }
      style.textContent = data.customCss || ''
      if (data.primaryColor) {
        document.documentElement.style.setProperty('--brand-500', data.primaryColor)
        document.documentElement.style.setProperty('--brand-600', data.accentColor || data.primaryColor)
      }
    }).catch(() => {})
  }, [])

  // Limpiar sesión sin recargar la página cuando el refresh falla.
  // window.location.href causaba: reload → Zustand rehidrata user → dashboard
  // → API 401 → reload → bucle infinito.
  useEffect(() => {
    const handler = () => {
      useAuthStore.setState({ user: null, isAuthenticated: false })
    }
    window.addEventListener('visioncore:auth-expired', handler)
    return () => window.removeEventListener('visioncore:auth-expired', handler)
  }, [])

  return (
    <Routes>
      <Route path="/login" element={
        isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />
      } />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="live" element={<LiveViewPage />} />
          <Route path="views" element={<ViewsPage />} />
          <Route path="views/:id" element={<ViewPlayerPage />} />
          <Route path="recordings" element={
            <ProtectedRoute roles={['ADMIN', 'SUPERVISOR', 'AUDITOR']}>
              <RecordingsPage />
            </ProtectedRoute>
          } />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="nvrs" element={
            <ProtectedRoute roles={['ADMIN', 'SUPERVISOR']}>
              <NVRsPage />
            </ProtectedRoute>
          } />
          <Route path="nvrs/:id" element={
            <ProtectedRoute roles={['ADMIN', 'SUPERVISOR']}>
              <NVRDetailPage />
            </ProtectedRoute>
          } />
          <Route path="users" element={
            <ProtectedRoute roles={['ADMIN']}>
              <UsersPage />
            </ProtectedRoute>
          } />
          <Route path="activity" element={
            <ProtectedRoute roles={['ADMIN']}>
              <ActivityPage />
            </ProtectedRoute>
          } />
          <Route path="appearance" element={
            <ProtectedRoute roles={['ADMIN']}>
              <AppearancePage />
            </ProtectedRoute>
          } />
          <Route path="settings" element={
            <ProtectedRoute roles={['ADMIN']}>
              <SettingsPage />
            </ProtectedRoute>
          } />
          <Route path="profile" element={<ProfilePage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
