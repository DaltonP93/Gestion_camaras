// Reproducción multicámara sincronizada del prototipo (lógica pura, sin video).
//
// Criterio de pistas (corrige el supuesto "grilla = substream"): NO se asume que el
// NVR grabó el subflujo. Cada cámara declara las pistas ARCHIVADAS que devolvió la
// búsqueda (principal canal*100+1 y, si existe, subflujo canal*100+2) y cada celda
// usa una pista que tenga grabación EN EL INSTANTE del reloj común:
//   - grilla: subflujo si está archivado en ese instante; si no, principal (con
//     aviso: más ancho de banda del NVR);
//   - 1×1: principal; si sólo hay subflujo en ese instante, subflujo (con aviso);
//   - ninguna pista en ese instante ⇒ hueco visible (no se abre sesión).
// Las sesiones se admiten por NVR hasta su límite (maxConcurrentPlaybackSessions);
// el resto queda "en cola" con su posición, nunca se supera el límite.
import { NVRS, WINDOW, cameraById, type Camera, type ProtoUser, type Segment } from '../sim/mock'
import { canPlayback } from './permissions'

export type TrackId = 'main' | 'sub'
export type PlaybackMode = 'single' | 'grid'

export type TrackReason =
  | 'principal'            // 1×1 con principal archivada
  | 'solo-subflujo'        // 1×1 sin principal en ese instante: usa subflujo
  | 'subflujo-archivado'   // grilla con subflujo archivado
  | 'sin-subflujo'         // grilla sin subflujo en ese instante: usa principal
  | 'hueco'                // sin grabación en ninguna pista

export interface TrackChoice { track: TrackId | null; reason: TrackReason }

export function covers(segments: Segment[], t: number): boolean {
  return segments.some(s => t >= s.start && t < s.end)
}

export function chooseTrack(camera: Camera, t: number, mode: PlaybackMode): TrackChoice {
  const main = covers(camera.archived.main, t)
  const sub = covers(camera.archived.sub, t)
  if (mode === 'grid') {
    if (sub) return { track: 'sub', reason: 'subflujo-archivado' }
    if (main) return { track: 'main', reason: 'sin-subflujo' }
    return { track: null, reason: 'hueco' }
  }
  if (main) return { track: 'main', reason: 'principal' }
  if (sub) return { track: 'sub', reason: 'solo-subflujo' }
  return { track: null, reason: 'hueco' }
}

/** Unión ordenada de tramos de ambas pistas (lo que el timeline muestra como grabado). */
export function recordedUnion(camera: Camera): Segment[] {
  const all = [...camera.archived.main, ...camera.archived.sub].sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  for (const s of all) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Huecos dentro de la ventana (complemento de recordedUnion). */
export function gaps(camera: Camera, window: Segment = WINDOW): Segment[] {
  const out: Segment[] = []
  let cursor = window.start
  for (const s of recordedUnion(camera)) {
    if (s.end <= window.start || s.start >= window.end) continue
    if (s.start > cursor) out.push({ start: cursor, end: Math.min(s.start, window.end) })
    cursor = Math.max(cursor, s.end)
  }
  if (cursor < window.end) out.push({ start: cursor, end: window.end })
  return out
}

/** Próximo instante con grabación estrictamente después de t (o null). */
export function nextRecordedAt(camera: Camera, t: number): number | null {
  const next = recordedUnion(camera).find(s => s.start > t)
  return next ? next.start : null
}

export type CellState =
  | { kind: 'vacia' }
  | { kind: 'sin-permiso'; cameraId: string }
  | { kind: 'hueco'; cameraId: string; nextAt: number | null }
  | { kind: 'activa'; cameraId: string; nvrId: string; track: TrackId; reason: TrackReason }
  | { kind: 'en-cola'; cameraId: string; nvrId: string; track: TrackId; reason: TrackReason; position: number; limit: number }

export interface NvrUsage { nvrId: string; name: string; active: number; queued: number; limit: number }

export function planCells(
  user: ProtoUser,
  cameraIds: Array<string | null>,
  t: number,
  mode: PlaybackMode,
  limits: Record<string, number> = Object.fromEntries(NVRS.map(n => [n.id, n.maxConcurrentPlaybackSessions])),
): { cells: CellState[]; usage: NvrUsage[] } {
  const active = new Map<string, number>()
  const queued = new Map<string, number>()
  const cells: CellState[] = cameraIds.map(id => {
    if (!id) return { kind: 'vacia' }
    const cam = cameraById(id)
    if (!cam || !canPlayback(user, cam)) return { kind: 'sin-permiso', cameraId: id }
    const choice = chooseTrack(cam, t, mode)
    if (!choice.track) return { kind: 'hueco', cameraId: id, nextAt: nextRecordedAt(cam, t) }
    const limit = limits[cam.nvrId] ?? 1
    const used = active.get(cam.nvrId) ?? 0
    if (used < limit) {
      active.set(cam.nvrId, used + 1)
      return { kind: 'activa', cameraId: id, nvrId: cam.nvrId, track: choice.track, reason: choice.reason }
    }
    const pos = (queued.get(cam.nvrId) ?? 0) + 1
    queued.set(cam.nvrId, pos)
    return { kind: 'en-cola', cameraId: id, nvrId: cam.nvrId, track: choice.track, reason: choice.reason, position: pos, limit }
  })
  const usage: NvrUsage[] = NVRS
    .filter(n => active.has(n.id) || queued.has(n.id))
    .map(n => ({ nvrId: n.id, name: n.name, active: active.get(n.id) ?? 0, queued: queued.get(n.id) ?? 0, limit: limits[n.id] ?? 1 }))
  return { cells, usage }
}

// ─── Reloj común ──────────────────────────────────────────────────────────────

export const SPEEDS = [0.5, 1, 2, 4] as const
export type Speed = typeof SPEEDS[number]

export interface ClockState {
  t: number
  playing: boolean
  speed: Speed
  /** Sincronía estricta: el reloj espera mientras alguna celda activa carga. */
  strictSync: boolean
}

export type ClockAction =
  | { type: 'play' } | { type: 'pause' } | { type: 'toggle' }
  | { type: 'speed'; speed: number }
  | { type: 'seek'; t: number }
  | { type: 'step'; seconds: number }
  | { type: 'strict'; value: boolean }
  | { type: 'tick'; dtMs: number; anyBuffering: boolean }

export function initialClock(t: number = WINDOW.start): ClockState {
  return { t, playing: false, speed: 1, strictSync: true }
}

const clamp = (t: number) => Math.min(WINDOW.end, Math.max(WINDOW.start, t))

export function clockReducer(s: ClockState, a: ClockAction): ClockState {
  switch (a.type) {
    case 'play': return s.t >= WINDOW.end ? s : { ...s, playing: true }
    case 'pause': return { ...s, playing: false }
    case 'toggle': return clockReducer(s, { type: s.playing ? 'pause' : 'play' })
    case 'speed': return (SPEEDS as readonly number[]).includes(a.speed) ? { ...s, speed: a.speed as Speed } : s
    case 'seek': return { ...s, t: clamp(a.t) }
    case 'step': return { ...s, t: clamp(s.t + a.seconds) }
    case 'strict': return { ...s, strictSync: a.value }
    case 'tick': {
      if (!s.playing || a.dtMs <= 0) return s
      if (s.strictSync && a.anyBuffering) return s
      const t = clamp(s.t + (a.dtMs / 1000) * s.speed)
      return t >= WINDOW.end ? { ...s, t, playing: false } : { ...s, t }
    }
  }
}

/**
 * Carga simulada (ms) de una celda al iniciar, buscar o cambiar de pista: la
 * principal tarda más que el subflujo. Determinista para que las pruebas no
 * dependan del azar. En la integración real es el tiempo hasta el primer frame.
 */
export function simulatedLoadMs(cellIndex: number, track: TrackId): number {
  return (track === 'main' ? 900 : 500) + 250 * (cellIndex % 3)
}
