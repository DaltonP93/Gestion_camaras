// Historial de entregas de correo — helpers PUROS (P1).
//
// El bug: la fila mostraba `sentAt ? time : '—'`, así que TODA entrega FALLIDA
// aparecía sin fecha (sentAt=null en fallidos) y sólo con la HORA (sin día) en la
// zona del navegador. Aquí se elige un timestamp SIEMPRE presente y se formatea la
// fecha+hora completa en America/Asuncion.

export interface DeliveryRecord {
  status?: string | null
  sentAt?: string | null
  failedAt?: string | null
  attemptedAt?: string | null
  createdAt?: string | null
  source?: string | null   // 'live' (envío real) | 'backfill' (reconstruido por migración)
}

/**
 * True si la fila fue RECONSTRUIDA por el backfill (0030) y no proviene de un envío
 * real verificado. La UI la marca como tal para no confundirla con una entrega real.
 */
export function isBackfilled(d: DeliveryRecord): boolean {
  return d.source === 'backfill'
}

export type DeliveryTimeKind = 'sent' | 'failed' | 'attempted' | 'created'

/**
 * Timestamp representativo de la entrega, NUNCA null salvo que no exista ninguno.
 * Prioridad: enviado→sentAt, fallido→failedAt, si no attemptedAt, si no createdAt.
 * Los fallidos ya NO caen a "—" por tener sentAt=null.
 */
export function pickDeliveryTimestamp(d: DeliveryRecord): { iso: string | null; kind: DeliveryTimeKind } {
  if (d.sentAt)   return { iso: d.sentAt,   kind: 'sent' }
  if (d.failedAt) return { iso: d.failedAt, kind: 'failed' }
  if (d.attemptedAt) return { iso: d.attemptedAt, kind: 'attempted' }
  return { iso: d.createdAt ?? null, kind: 'created' }
}

export const ASUNCION_TZ = 'America/Asuncion'

/** Fecha y hora completas en America/Asuncion (es-PY). '—' si no hay timestamp. */
export function formatAsuncionDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('es-PY', {
    timeZone: ASUNCION_TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}
