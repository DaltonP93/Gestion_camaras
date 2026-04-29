// src/stores/alertStore.ts
import { create } from 'zustand'
import toast from 'react-hot-toast'
import type { Alert } from '@/types'

interface AlertState {
  alerts: Alert[]
  unreadCount: number
  isLoading: boolean

  setAlerts: (alerts: Alert[]) => void
  addAlert: (alert: Alert) => void
  markResolved: (id: string) => void
  markAllRead: () => void
}

const SEVERITY_ICONS: Record<string, string> = {
  CRITICAL: '🚨',
  HIGH: '⚠️',
  MEDIUM: '⚡',
  LOW: 'ℹ️',
}

export const useAlertStore = create<AlertState>((set, get) => ({
  alerts: [],
  unreadCount: 0,
  isLoading: false,

  setAlerts: (alerts) => {
    const unreadCount = alerts.filter((a) => !a.resolved).length
    set({ alerts, unreadCount })
  },

  addAlert: (alert) => {
    set((state) => ({
      alerts: [alert, ...state.alerts].slice(0, 200),
      unreadCount: state.unreadCount + 1,
    }))

    // Mostrar notificación toast
    const icon = SEVERITY_ICONS[alert.severity] || '⚡'
    const toastFn = ['CRITICAL', 'HIGH'].includes(alert.severity) ? toast.error : toast
    toastFn(`${icon} ${alert.message}`, {
      duration: alert.severity === 'CRITICAL' ? 10000 : 5000,
    })
  },

  markResolved: (id) => {
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id ? { ...a, resolved: true, resolvedAt: new Date().toISOString() } : a
      ),
      unreadCount: Math.max(0, state.unreadCount - 1),
    }))
  },

  markAllRead: () => {
    set({ unreadCount: 0 })
  },
}))
