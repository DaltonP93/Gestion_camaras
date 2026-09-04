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

// Scope de VISIBILIDAD por cámara para alertas (RBAC / DEV14):
//   ADMIN          → sin restricción ({}).
//   resto de roles → sólo alertas de sus cámaras `canView`, MÁS las alertas sin
//                    cameraId (sistema/NVR, no específicas de cámara) que siguen
//                    visibles para todos. Filtro: cameraId IN (allowed) OR cameraId IS NULL.
// `allowedCameraIds` proviene de getViewableCameraIds (camera-scope.ts).
export function alertCameraScopeWhere(isAdmin: boolean, allowedCameraIds: string[]): Prisma.AlertWhereInput {
  if (isAdmin) return {}
  return { OR: [{ cameraId: { in: allowedCameraIds } }, { cameraId: null }] }
}

// Combina un `where` de estado/severidad con el scope de cámara sin que uno pise al
// otro (el scope usa OR; usar AND evita clobber si el where tuviera su propio OR).
// scope vacío (ADMIN) ⇒ devuelve el where sin tocar.
export function withAlertScope(
  where: Prisma.AlertWhereInput,
  scope: Prisma.AlertWhereInput,
): Prisma.AlertWhereInput {
  if (!scope || Object.keys(scope).length === 0) return where
  return { AND: [where, scope] }
}
