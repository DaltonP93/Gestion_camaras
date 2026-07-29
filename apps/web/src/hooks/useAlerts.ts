// src/hooks/useAlerts.ts
import { useEffect, useCallback } from 'react'
import { useAlertStore } from '@/stores/alertStore'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import type { Alert } from '@/types'

export function useAlerts(autoRefresh = false) {
  const { alerts, unreadCount, setAlerts, markResolved, markRead, markAllRead } = useAlertStore()

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ items: Alert[] }>('/alerts?limit=200')
      setAlerts(data.items)
    } catch {}
  }, [setAlerts])

  useEffect(() => {
    load()
    if (!autoRefresh) return
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [autoRefresh, load])

  const resolveAlert = useCallback(async (id: string) => {
    await apiPut(`/alerts/${id}/resolve`)
    markResolved(id)
  }, [markResolved])

  const readAlert = useCallback(async (id: string) => {
    markRead(id)
    apiPost(`/alerts/${id}/read`, {}).catch(() => {})
  }, [markRead])

  const readAll = useCallback(async () => {
    markAllRead()
    await apiPost('/alerts/read-all', {}).catch(() => {})
  }, [markAllRead])

  return { alerts, unreadCount, reload: load, resolveAlert, readAlert, readAll }
}
