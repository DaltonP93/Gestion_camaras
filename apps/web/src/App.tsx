// src/App.tsx
import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { Layout } from '@/components/layout/Layout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { LiveViewPage } from '@/pages/LiveViewPage'
import { RecordingsPage } from '@/pages/RecordingsPage'
import { UsersPage } from '@/pages/UsersPage'
import { NVRsPage } from '@/pages/NVRsPage'
import { AlertsPage } from '@/pages/AlertsPage'
import { ActivityPage } from '@/pages/ActivityPage'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'

export default function App() {
  const { isAuthenticated, loadUser } = useAuthStore()

  useEffect(() => {
    if (isAuthenticated) loadUser()
  }, [])

  return (
    <Routes>
      <Route path="/login" element={
        isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />
      } />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="live" element={<LiveViewPage />} />
          <Route path="recordings" element={
            <ProtectedRoute roles={['ADMIN', 'SUPERVISOR', 'AUDITOR']}>
              <RecordingsPage />
            </ProtectedRoute>
          } />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="nvrs" element={
            <ProtectedRoute roles={['ADMIN']}>
              <NVRsPage />
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
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
