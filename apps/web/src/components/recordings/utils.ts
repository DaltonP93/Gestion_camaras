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
