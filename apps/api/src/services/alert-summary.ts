// Semántica ÚNICA de los contadores de alertas (P1).
//
// Antes cada pantalla derivaba sus cifras de un mismo arreglo global cargado con
// consultas distintas → Dashboard "200 activas", AlertsPage "0 activas / 3
// reconocidas / 197 resueltas", campana "2". Este módulo fija la semántica y la
// deriva de conteos server-side (no de un arreglo compartido):
//
//   Nuevas       (unread)       = NO resuelta  Y  readAt = null
//   Reconocidas  (acknowledged) = NO resuelta  Y  readAt != null
//   Pendientes   (pending)      = NO resuelta            (= unread + acknowledged)
//   Resueltas    (resolved)     = resuelta
//   Total        (total)        = pending + resolved
//   Críticas pendientes (criticalPending) = pendiente Y severidad HIGH/CRITICAL
//
// Campana y menú lateral = unread. Dashboard = pending.

export interface AlertCountInputs {
  unread: number
  acknowledged: number
  resolved: number
  criticalPending: number
}

export interface AlertSummary {
  unread: number
  acknowledged: number
  pending: number
  resolved: number
  total: number
  criticalPending: number
}

/** Deriva el resumen completo desde conteos independientes (no negativos). */
export function deriveAlertSummary(c: AlertCountInputs): AlertSummary {
  const unread = Math.max(0, c.unread | 0)
  const acknowledged = Math.max(0, c.acknowledged | 0)
  const resolved = Math.max(0, c.resolved | 0)
  const criticalPending = Math.max(0, c.criticalPending | 0)
  const pending = unread + acknowledged
  return { unread, acknowledged, pending, resolved, total: pending + resolved, criticalPending }
}

export interface ActivityBucket {
  /** Inicio de la hora (epoch ms, alineado a la hora en punto). */
  hourStartMs: number
  /** Nº de alertas creadas en esa hora. */
  alerts: number
}

/**
 * Serie temporal REAL de alertas por hora (reemplaza el Math.random del Dashboard).
 * Devuelve exactamente `hours` cubetas consecutivas terminando en la hora actual,
 * cada una con el conteo de createdAt que cae en [hourStart, hourStart+1h).
 * Determinista: la hora "ahora" se alinea hacia abajo a la hora en punto.
 */
export function bucketAlertsByHour(createdAtMs: readonly number[], nowMs: number, hours = 24): ActivityBucket[] {
  const HOUR = 3_600_000
  const currentHourStart = Math.floor(nowMs / HOUR) * HOUR
  const firstHourStart = currentHourStart - (hours - 1) * HOUR
  const buckets: ActivityBucket[] = []
  const counts = new Map<number, number>()
  for (const ts of createdAtMs) {
    if (!Number.isFinite(ts)) continue
    const h = Math.floor(ts / HOUR) * HOUR
    if (h < firstHourStart || h > currentHourStart) continue
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  for (let h = firstHourStart; h <= currentHourStart; h += HOUR) {
    buckets.push({ hourStartMs: h, alerts: counts.get(h) ?? 0 })
  }
  return buckets
}
