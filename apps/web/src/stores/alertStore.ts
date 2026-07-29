// src/stores/alertStore.ts
import { create } from 'zustand'
import toast from 'react-hot-toast'
import { apiGet } from '@/lib/api'
import type { Alert, AlertSummary } from '@/types'

// FUENTE DE VERDAD ÚNICA de contadores (P1): el `summary` viene SIEMPRE del backend
// (/alerts/summary), no de contar el arreglo `alerts` (que cada pantalla llena con
// una consulta distinta). `alerts` es SÓLO la lista de la vista actual; los
// contadores (campana, menú, dashboard, tabs) salen de `summary`.
interface AlertState {
  alerts: Alert[]
  summary: AlertSummary
  // Compat: unreadCount = summary.unread (campana/menú). Se mantiene el nombre para
  // no romper consumidores, pero su valor SIEMPRE proviene del summary del backend.
  unreadCount: number
  // Contador que se incrementa ante CADA evento de alerta llegado por WS (nueva,
  // resuelta, recuperada). Las vistas paginadas (AlertsPage) lo observan para refrescar
  // la página ACTUAL desde el servidor, sin mezclar filas de otros filtros (PR A req 6).
  eventSeq: number
  isLoading: boolean

  setAlerts: (alerts: Alert[]) => void
  setSummary: (summary: AlertSummary) => void
  refreshSummary: () => Promise<void>
  addAlert: (alert: Alert) => void
  resolveById: (id: string) => void
  markResolved: (id: string) => void
  markRead: (id: string) => void
  markAllRead: () => void
}

const EMPTY_SUMMARY: AlertSummary = {
  unread: 0, acknowledged: 0, pending: 0, resolved: 0, total: 0, criticalPending: 0,
}

const SEVERITY_ICONS: Record<string, string> = {
  CRITICAL: '🚨',
  HIGH: '⚠️',
  MEDIUM: '⚡',
  LOW: 'ℹ️',
}

export const useAlertStore = create<AlertState>((set, get) => ({
  alerts: [],
  summary: EMPTY_SUMMARY,
  unreadCount: 0,
  eventSeq: 0,
  isLoading: false,

  // La lista de la vista actual. YA NO recalcula contadores: cargar una consulta
  // filtrada (p.ej. sólo activas, o sólo resueltas) no debe redefinir la campana.
  setAlerts: (alerts) => set({ alerts }),

  setSummary: (summary) => set({ summary, unreadCount: summary.unread }),

  // Re-sincroniza los contadores desde el backend. Se llama al montar cada pantalla,
  // tras cada evento WS y tras cada acción (leer/resolver) → todos los contadores
  // quedan consistentes sin depender de qué arreglo se cargó por última vez.
  refreshSummary: async () => {
    try {
      const summary = await apiGet<AlertSummary>('/alerts/summary')
      set({ summary, unreadCount: summary.unread })
    } catch { /* mantener el último summary conocido */ }
  },

  addAlert: (alert) => {
    // Un registro de recuperación (resolved+read) llega por WS pero NO es "nueva".
    const countsAsUnread = !alert.resolved && !alert.readAt
    set((state) => {
      const exists = state.alerts.some((a) => a.id === alert.id)
      const alerts = exists
        ? state.alerts.map((a) => (a.id === alert.id ? { ...a, ...alert } : a))
        : [alert, ...state.alerts].slice(0, 200)
      return { alerts, eventSeq: state.eventSeq + 1 }
    })
    if (countsAsUnread) {
      const icon = SEVERITY_ICONS[alert.severity] || '⚡'
      const toastFn = ['CRITICAL', 'HIGH'].includes(alert.severity) ? toast.error : toast
      toastFn(`${icon} ${alert.message}`, {
        duration: alert.severity === 'CRITICAL' ? 10000 : 5000,
      })
    }
    // Contadores autoritativos desde el backend (mantiene campana/dashboard/tabs).
    void get().refreshSummary()
  },

  // Resolución empujada por el servidor (WS alert_resolved): actualizar la lista y
  // re-sincronizar contadores.
  resolveById: (id) => {
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id ? { ...a, resolved: true, resolvedAt: a.resolvedAt ?? new Date().toISOString() } : a
      ),
      eventSeq: state.eventSeq + 1,
    }))
    void get().refreshSummary()
  },

  markResolved: (id) => {
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id
          ? { ...a, resolved: true, resolvedAt: new Date().toISOString(), readAt: a.readAt ?? new Date().toISOString() }
          : a
      ),
    }))
    void get().refreshSummary()
  },

  markRead: (id) => {
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id && !a.readAt ? { ...a, readAt: new Date().toISOString() } : a
      ),
    }))
    void get().refreshSummary()
  },

  markAllRead: () => {
    const now = new Date().toISOString()
    set((state) => ({
      alerts: state.alerts.map((a) => (a.readAt || a.resolved ? a : { ...a, readAt: now })),
    }))
    void get().refreshSummary()
  },
}))
