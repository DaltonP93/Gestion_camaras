// Construcción de filtros de alertas (PR A). Fuente ÚNICA de las condiciones de estado:
// tanto GET /alerts (lista paginada) como GET /alerts/summary (contadores) usan
// alertStatusWhere, de modo que lista y contadores NUNCA puedan divergir (antes la lista
// se filtraba en el cliente sobre sólo 200 filas y ocultaba unread fuera de esa ventana).
import type { Prisma } from '@prisma/client'

export type AlertStatusFilter = 'unread' | 'acknowledged' | 'resolved' | 'all' | 'active'
export const ALERT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type AlertSeverityFilter = 'all' | (typeof ALERT_SEVERITIES)[number]

// Condición de ESTADO — idéntica a los conteos de /alerts/summary:
//   unread       = resolved:false, readAt:null
//   acknowledged = resolved:false, readAt != null
//   resolved     = resolved:true
//   all          = sin filtro
//   active       = resolved:false (pendientes = unread+acknowledged; usado por el dashboard)
export function alertStatusWhere(status: AlertStatusFilter): Prisma.AlertWhereInput {
  switch (status) {
    case 'unread':       return { resolved: false, readAt: null }
    case 'acknowledged': return { resolved: false, readAt: { not: null } }
    case 'resolved':     return { resolved: true }
    case 'active':       return { resolved: false }
    case 'all':
    default:             return {}
  }
}

export function parseAlertStatus(raw: unknown): AlertStatusFilter {
  return raw === 'unread' || raw === 'acknowledged' || raw === 'resolved' || raw === 'active'
    ? raw
    : 'all'
}

export function parseAlertSeverity(raw: unknown): AlertSeverityFilter {
  return (ALERT_SEVERITIES as readonly string[]).includes(raw as string)
    ? (raw as AlertSeverityFilter)
    : 'all'
}

// page es 0-indexado (el contrato del PR usa page=0 como primera página).
export function parseAlertPage(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function parseAlertLimit(raw: unknown, def = 50, max = 200): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(max, n)
}

// Where combinado estado + severidad, para la lista paginada.
export function alertWhere(status: AlertStatusFilter, severity: AlertSeverityFilter): Prisma.AlertWhereInput {
  const where = alertStatusWhere(status)
  if (severity !== 'all') (where as Prisma.AlertWhereInput).severity = severity
  return where
}
