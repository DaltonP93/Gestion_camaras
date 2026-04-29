// src/hooks/useAlerts.ts
import { useEffect, useCallback } from 'react'
import { useAlertStore } from '@/stores/alertStore'
import { apiGet } from '@/lib/api'
import type { Alert } from '@/types'

export function useAlerts(autoRefresh = false) {
  const { alerts, unreadCount, setAlerts, markResolved } = useAlertStore()

  const load = useCallback(async () => {
    try {
      const data = await apiGet<Alert[]>('/alerts?limit=200')
      setAlerts(data)
    } catch {}
  }, [])

  useEffect(() => {
    load()
    if (!autoRefresh) return
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [autoRefresh])

  return { alerts, unreadCount, reload: load, markResolved }
}
