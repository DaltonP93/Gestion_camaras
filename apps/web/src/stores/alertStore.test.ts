import { describe, it, expect, vi, beforeEach } from 'vitest'

// El store hace toast (UI) y apiGet (red) — los aislamos para probar la lógica de
// contadores. La CLAVE del P1: los contadores salen del `summary` server-side, no
// de contar el arreglo `alerts` (que cada pantalla llena con una consulta distinta).
vi.mock('react-hot-toast', () => ({ default: Object.assign(() => {}, { error: () => {}, success: () => {} }) }))
const apiGetMock = vi.fn()
vi.mock('@/lib/api', () => ({ apiGet: (...a: any[]) => apiGetMock(...a) }))

import { useAlertStore } from './alertStore'
import type { AlertSummary } from '@/types'

const EMPTY: AlertSummary = { unread: 0, acknowledged: 0, pending: 0, resolved: 0, total: 0, criticalPending: 0 }

beforeEach(() => {
  useAlertStore.setState({ alerts: [], summary: EMPTY, unreadCount: 0 })
  apiGetMock.mockReset()
})

describe('alertStore — contadores desde summary, no desde la lista (req 5, 6, 11)', () => {
  it('setSummary define unreadCount = summary.unread', () => {
    useAlertStore.getState().setSummary({ ...EMPTY, unread: 5, acknowledged: 2, pending: 7, total: 20, resolved: 13 })
    expect(useAlertStore.getState().unreadCount).toBe(5)
    expect(useAlertStore.getState().summary.pending).toBe(7)
  })

  it('cargar una lista filtrada (setAlerts) NO recalcula la campana', () => {
    useAlertStore.getState().setSummary({ ...EMPTY, unread: 2, pending: 3, total: 13, resolved: 10, acknowledged: 1 })
    expect(useAlertStore.getState().unreadCount).toBe(2)
    // La AlertsPage carga TODAS (incl. 197 resueltas) en el arreglo — no debe poner
    // la campana en 0, ni el Dashboard (que carga sólo activas) subirla a 200.
    useAlertStore.getState().setAlerts([
      { id: 'r1', resolved: true } as any,
      { id: 'r2', resolved: true } as any,
    ])
    expect(useAlertStore.getState().unreadCount).toBe(2)     // intacto
    expect(useAlertStore.getState().summary.pending).toBe(3) // intacto
    expect(useAlertStore.getState().alerts).toHaveLength(2)  // sólo cambió la lista
  })

  it('navegación Dashboard→Alertas→Dashboard: la campana sólo cambia con refreshSummary', async () => {
    // Dashboard entra: summary con 3 pendientes.
    apiGetMock.mockResolvedValueOnce({ ...EMPTY, unread: 1, acknowledged: 2, pending: 3, resolved: 197, total: 200 })
    await useAlertStore.getState().refreshSummary()
    expect(useAlertStore.getState().unreadCount).toBe(1)
    // AlertsPage carga la lista completa (no toca contadores).
    useAlertStore.getState().setAlerts(Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, resolved: i > 2 } as any)))
    expect(useAlertStore.getState().unreadCount).toBe(1)     // NO saltó a 200 ni a 0
    // Vuelve al Dashboard: refresca contadores → sigue coherente.
    apiGetMock.mockResolvedValueOnce({ ...EMPTY, unread: 1, acknowledged: 2, pending: 3, resolved: 197, total: 200 })
    await useAlertStore.getState().refreshSummary()
    expect(useAlertStore.getState().summary.pending).toBe(3)
  })

  it('evento WS (addAlert) re-sincroniza el summary desde el backend', async () => {
    apiGetMock.mockResolvedValue({ ...EMPTY, unread: 1, pending: 1, total: 1 })
    useAlertStore.getState().addAlert({ id: 'x', severity: 'LOW', message: 'm', resolved: false, readAt: null } as any)
    expect(useAlertStore.getState().alerts).toHaveLength(1)
    await Promise.resolve(); await Promise.resolve()   // flush del void refreshSummary()
    expect(apiGetMock).toHaveBeenCalledWith('/alerts/summary')
  })

  it('un registro de recuperación (resolved+read) por WS no es "nuevo" pero refresca contadores', async () => {
    apiGetMock.mockResolvedValue({ ...EMPTY, resolved: 1, total: 1 })
    useAlertStore.getState().addAlert({ id: 'rec', severity: 'LOW', message: 'recuperada', resolved: true, readAt: new Date().toISOString() } as any)
    await Promise.resolve(); await Promise.resolve()
    expect(apiGetMock).toHaveBeenCalledWith('/alerts/summary')
  })
})
