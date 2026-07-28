// apps/web/src/components/recordings/utils.ts
// Helpers puros del módulo Grabaciones — extraídos de RecordingsPage.tsx.
// La convención de zona horaria es central aquí: los NVR guardan la hora de
// pared en los campos UTC, así que mostrar y buscar se hace SIEMPRE en ese
// marco, nunca a través de la zona horaria del navegador.
import { format } from 'date-fns'

export function toLocalDatetimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Convert a datetime-local input value into NVR wall-clock ISO (UTC components).
export function localInputToNvrIso(s: string): string {
  if (!s) return s
  return s.length === 16 ? `${s}:00Z` : `${s}Z`
}

// Display NVR timestamps in UTC — shifting by the local timezone offset makes
// date-fns render UTC components correctly regardless of the browser timezone.
export function nvrTimeMs(epochMs: number): number {
  return epochMs + new Date(epochMs).getTimezoneOffset() * 60_000
}

export function formatNvrTime(isoOrMs: string | number | Date, fmt: string): string {
  const ms = isoOrMs instanceof Date ? isoOrMs.getTime()
    : typeof isoOrMs === 'number' ? isoOrMs
    : new Date(isoOrMs as string).getTime()
  return format(new Date(nvrTimeMs(ms)), fmt)
}

export function classifyError(err: any): 'ISAPI_UNSUPPORTED' | 'AUTH_FAILED' | 'NVR_OFFLINE' | 'UNKNOWN' {
  const msg = (err?.response?.data?.message || err?.message || '').toLowerCase()
  if (msg.includes('isapi') || msg.includes('no soporta') || msg.includes('unsupported')) return 'ISAPI_UNSUPPORTED'
  if (msg.includes('401') || msg.includes('auth') || msg.includes('credencial'))           return 'AUTH_FAILED'
  if (msg.includes('offline') || msg.includes('unreachable') || msg.includes('econnrefused')) return 'NVR_OFFLINE'
  return 'UNKNOWN'
}

export function formatDuration(start: string, end: string) {
  const diff = new Date(end).getTime() - new Date(start).getTime()
  const mins = Math.floor(diff / 60000)
  const secs = Math.floor((diff % 60000) / 1000)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function formatSize(bytes: number) {
  if (bytes === 0) return '—'
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`
  return `${(bytes / 1048576).toFixed(0)} MB`
}

// ── Selección de bloque + playhead para una búsqueda de grabaciones ──────────
// P1 confirmado: el frontend elegía el bloque MÁS NUEVO (camRecs[0] tras orden
// descendente) y/o el playhead earliest.startTime, produciendo previews que
// arrancaban en 14:58 o incluso 12:54 para una búsqueda 14:14→15:14. Este helper
// PURO fija el contrato: nunca antes de searchStart, nunca después de searchEnd,
// nunca el bloque equivocado.
export interface PlayheadSelection<R> {
  targetRecording: R | null
  effectiveStartMs: number
  effectiveEndMs: number
  reason: 'covering' | 'next' | 'none'
}

export function selectRecordingForPlayhead<R extends { startTime: string; endTime: string }>(
  recordings: readonly R[],
  searchStartMs: number,
  searchEndMs: number,
  requestedPlayheadMs: number,
  minDurationMs = 3_000,
): PlayheadSelection<R> {
  const none: PlayheadSelection<R> = { targetRecording: null, effectiveStartMs: 0, effectiveEndMs: 0, reason: 'none' }
  if (!(searchEndMs > searchStartMs)) return none
  // El playhead nunca puede estar antes del inicio del rango buscado.
  const playhead = Math.min(Math.max(requestedPlayheadMs, searchStartMs), searchEndMs)

  // Copia ordenada ASCENDENTE (no mutar el arreglo del caller); descartar bloques
  // con fechas inválidas o de duración no positiva.
  const blocks = recordings
    .map((r) => ({ r, s: new Date(r.startTime).getTime(), e: new Date(r.endTime).getTime() }))
    .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e) && x.e > x.s)
    .sort((a, b) => a.s - b.s)

  // a) bloque que CUBRE el playhead
  let pick = blocks.find((x) => x.s <= playhead && x.e > playhead)
  let reason: 'covering' | 'next' = 'covering'
  // b) si no, el SIGUIENTE bloque dentro del rango
  if (!pick) {
    pick = blocks.find((x) => x.s > playhead && x.s < searchEndMs)
    reason = 'next'
  }
  if (!pick) return none

  // c) recortar al bloque Y al rango buscado
  const effectiveStartMs = Math.max(playhead, pick.s, searchStartMs)
  const effectiveEndMs   = Math.min(pick.e, searchEndMs)
  if (effectiveEndMs - effectiveStartMs < minDurationMs) return none

  return { targetRecording: pick.r, effectiveStartMs, effectiveEndMs, reason }
}
