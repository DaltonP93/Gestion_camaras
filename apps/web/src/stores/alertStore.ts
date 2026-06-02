// src/stores/alertStore.ts
import { create } from 'zustand'
import toast from 'react-hot-toast'
import type { Alert } from '@/types'

interface AlertState {
  alerts: Alert[]
  unreadCount: number
  isLoading: boolean

  setAlerts: (alerts: Alert[]) => void
  setUnreadCount: (count: number) => void
  addAlert: (alert: Alert) => void
  markResolved: (id: string) => void
  markRead: (id: string) => void
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
    const unreadCount = alerts.filter((a) => !a.resolved && !a.readAt).length
    set({ alerts, unreadCount })
  },

  setUnreadCount: (count) => set({ unreadCount: count }),

  addAlert: (alert) => {
    set((state) => ({
      alerts: [alert, ...state.alerts].slice(0, 200),
      // New WebSocket alerts are always unread
      unreadCount: state.unreadCount + 1,
    }))
    const icon = SEVERITY_ICONS[alert.severity] || '⚡'
    const toastFn = ['CRITICAL', 'HIGH'].includes(alert.severity) ? toast.error : toast
    toastFn(`${icon} ${alert.message}`, {
      duration: alert.severity === 'CRITICAL' ? 10000 : 5000,
    })
  },

  markResolved: (id) => {
    set((state) => {
      const alert = state.alerts.find((a) => a.id === id)
      const wasUnread = alert && !alert.readAt && !alert.resolved
      return {
        alerts: state.alerts.map((a) =>
          a.id === id
            ? { ...a, resolved: true, resolvedAt: new Date().toISOString(), readAt: a.readAt ?? new Date().toISOString() }
            : a
        ),
        unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
      }
    })
  },

  markRead: (id) => {
    set((state) => {
      const alert = state.alerts.find((a) => a.id === id)
      const wasUnread = alert && !alert.readAt && !alert.resolved
      return {
        alerts: state.alerts.map((a) =>
          a.id === id && !a.readAt ? { ...a, readAt: new Date().toISOString() } : a
        ),
        unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
      }
    })
  },

  markAllRead: () => {
    const now = new Date().toISOString()
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.readAt || a.resolved ? a : { ...a, readAt: now }
      ),
      unreadCount: 0,
    }))
  },
}))
