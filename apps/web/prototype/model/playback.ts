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
  /**
   * Sincronía estricta ("Esperar a todas"): el reloj espera mientras alguna celda
   * activa carga o está bloqueada. APAGADA por defecto: una cámara lenta o
   * bloqueada no detiene a las demás; se atrasa sola y muestra su desfase.
   */
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
  return { t, playing: false, speed: 1, strictSync: false }
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

// ─── Sincronía por celda ──────────────────────────────────────────────────────
//
// Cada celda activa tiene su PROPIA posición (`pos`) además del reloj común:
//   - al abrir, buscar o resincronizar, la celda carga; al terminar se alinea al
//     reloj común (el reproductor pidió desde ese instante y tiene datos por
//     delante: se ubica en la hora actual del reloj);
//   - un BLOQUEO (el NVR deja de entregar datos a mitad de la reproducción) congela
//     su posición; al liberarse sigue desde donde quedó, ATRASADA respecto del reloj
//     común, y muestra el desfase con "Resincronizar" sólo para esa celda;
//   - con "Esperar a todas" (sincronía estricta) el reloj no avanza mientras haya
//     una celda cargando o bloqueada: nadie se atrasa, pero todas esperan.

/** Desfase a partir del cual una celda se muestra "desfasada" (segundos). */
export const SYNC_TOLERANCE_S = 0.5

export interface CellSync {
  /** Posición propia de la celda (segundos del día). */
  pos: number
  /** >0: cargando hasta ese instante (ms del reloj de la página); al terminar se alinea al reloj común. */
  loadingUntil: number
  /** Bloqueo simulado: el NVR no entrega datos; la posición queda congelada. */
  stalled: boolean
}

export interface SyncState {
  clock: ClockState
  cells: Record<number, CellSync>
}

export type SyncAction =
  | Exclude<ClockAction, { type: 'tick' } | { type: 'seek' } | { type: 'step' }>
  | { type: 'tick'; dtMs: number; nowMs: number; active: number[] }
  /**
   * Abre (o reabre por cambio de pista) la celda: carga desde el reloj común.
   * `sameCamera`: reabre la MISMA cámara (cambio de pista) y conserva su bloqueo
   * simulado; otra cámara en esa celda arranca sin bloqueo.
   */
  | { type: 'open'; index: number; nowMs: number; loadMs: number; sameCamera?: boolean }
  /** La celda deja de estar activa (hueco, cola, sin cámara). */
  | { type: 'close'; index: number }
  /** Seek del reloj común: todas las celdas activas en ese instante recargan. */
  | { type: 'seekAll'; t: number; nowMs: number; loads: Record<number, number> }
  /** Lleva UNA celda al reloj común (recarga y se alinea al terminar). */
  | { type: 'resync'; index: number; nowMs: number; loadMs: number }
  /** Simulación: bloquea o libera una celda (el NVR deja de entregar datos). */
  | { type: 'stall'; index: number; value: boolean }

export function initialSync(t: number = WINDOW.start): SyncState {
  return { clock: initialClock(t), cells: {} }
}

export function isCellLoading(c: CellSync | undefined): boolean {
  return !c || c.loadingUntil > 0
}

/** Celda que impide avanzar en modo estricto: carga pendiente o bloqueo. */
function isCellWaiting(c: CellSync | undefined, nowMs: number): boolean {
  if (!c) return true
  return c.stalled || (c.loadingUntil > 0 && nowMs < c.loadingUntil)
}

/** Desfase de la celda respecto del reloj común (positivo = atrasada). */
export function cellOffset(c: CellSync | undefined, clockT: number): number {
  if (!c || c.loadingUntil > 0) return 0
  return clockT - c.pos
}

export function isOutOfSync(c: CellSync | undefined, clockT: number): boolean {
  return Math.abs(cellOffset(c, clockT)) >= SYNC_TOLERANCE_S
}

export function syncReducer(s: SyncState, a: SyncAction): SyncState {
  switch (a.type) {
    case 'tick': {
      const anyWaiting = a.active.some(i => isCellWaiting(s.cells[i], a.nowMs))
      const clock = clockReducer(s.clock, { type: 'tick', dtMs: a.dtMs, anyBuffering: anyWaiting })
      const delta = clock.t - s.clock.t
      let changed = clock !== s.clock
      const cells = { ...s.cells }
      for (const i of a.active) {
        const c = cells[i]
        if (!c || c.stalled) continue // bloqueada: posición congelada
        if (c.loadingUntil > 0) {
          if (a.nowMs >= c.loadingUntil) { cells[i] = { ...c, pos: clock.t, loadingUntil: 0 }; changed = true }
          continue
        }
        if (delta !== 0) { cells[i] = { ...c, pos: clamp(c.pos + delta) }; changed = true }
      }
      return changed ? { clock, cells } : s
    }
    case 'open': {
      const prev = s.cells[a.index]
      const stalled = a.sameCamera ? (prev?.stalled ?? false) : false
      return { ...s, cells: { ...s.cells, [a.index]: { pos: s.clock.t, loadingUntil: a.nowMs + a.loadMs, stalled } } }
    }
    case 'close': {
      if (!(a.index in s.cells)) return s
      const cells = { ...s.cells }
      delete cells[a.index]
      return { ...s, cells }
    }
    case 'seekAll': {
      const clock = clockReducer(s.clock, { type: 'seek', t: a.t })
      const cells: Record<number, CellSync> = {}
      for (const [k, loadMs] of Object.entries(a.loads)) {
        const i = Number(k)
        cells[i] = { pos: clock.t, loadingUntil: a.nowMs + loadMs, stalled: s.cells[i]?.stalled ?? false }
      }
      return { clock, cells }
    }
    case 'resync': {
      const c = s.cells[a.index]
      if (!c) return s
      return { ...s, cells: { ...s.cells, [a.index]: { ...c, loadingUntil: a.nowMs + a.loadMs } } }
    }
    case 'stall': {
      const c = s.cells[a.index]
      if (!c || c.stalled === a.value) return s
      return { ...s, cells: { ...s.cells, [a.index]: { ...c, stalled: a.value } } }
    }
    default: {
      const clock = clockReducer(s.clock, a)
      return clock === s.clock ? s : { ...s, clock }
    }
  }
}

// ─── Timeline: zoom, marcas horarias y huecos ─────────────────────────────────

export interface ZoomLevel {
  id: '24h' | '6h' | '1h' | '15m'
  label: string
  /** Duración visible (s). */
  span: number
  /** Intervalo de las marcas con hora HH:MM (s). */
  major: number
  /** Intervalo de las marcas menores sin texto (s). */
  minor: number
}

/** De menor a mayor acercamiento. "+" avanza en la lista; "−" retrocede. */
export const ZOOM_LEVELS: readonly ZoomLevel[] = [
  { id: '24h', label: '24 h', span: 24 * 3600, major: 2 * 3600, minor: 3600 },
  { id: '6h', label: '6 h', span: 6 * 3600, major: 30 * 60, minor: 10 * 60 },
  { id: '1h', label: '1 h', span: 3600, major: 5 * 60, minor: 60 },
  { id: '15m', label: '15 min', span: 15 * 60, major: 60, minor: 15 },
]
export const DEFAULT_ZOOM = 1 // 6 h

export function zoomIn(level: number): number { return Math.min(ZOOM_LEVELS.length - 1, level + 1) }
export function zoomOut(level: number): number { return Math.max(0, level - 1) }

/** Rango de `span` segundos centrado en `t`, siempre dentro del día. */
export function centeredRange(t: number, span: number): Segment {
  const total = WINDOW.end - WINDOW.start
  if (span >= total) return { start: WINDOW.start, end: WINDOW.end }
  const start = Math.min(WINDOW.end - span, Math.max(WINDOW.start, t - span / 2))
  return { start, end: start + span }
}

/**
 * Mantiene el rango visible mientras el cabezal siga dentro; si sale (reproducción,
 * seek, salto a otro tramo), lo vuelve a centrar en el cabezal. El cabezal nunca
 * queda fuera de la vista.
 */
export function followPlayhead(viewStart: number, span: number, t: number): Segment {
  const current = centeredRange(viewStart + span / 2, span)
  return t >= current.start && t <= current.end ? current : centeredRange(t, span)
}

/** HH:MM (o HH:MM:SS si no cae en minuto exacto). 24:00 para el fin del día. */
export function fmtTime(seconds: number, withSeconds = false): string {
  const s = Math.round(seconds)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = s % 60
  return withSeconds || ss !== 0 ? `${hh}:${mm}:${String(ss).padStart(2, '0')}` : `${hh}:${mm}`
}

export interface Tick { t: number; major: boolean; label?: string }

/** Marcas del rango: mayores (con HH:MM) cada `major`, menores cada `minor`. */
export function timelineTicks(range: Segment, level: ZoomLevel): Tick[] {
  const out: Tick[] = []
  const first = Math.ceil(range.start / level.minor) * level.minor
  for (let t = first; t <= range.end; t += level.minor) {
    const major = t % level.major === 0
    out.push(major ? { t, major, label: fmtTime(t) } : { t, major })
  }
  return out
}

export interface VisibleGap {
  /** Hueco completo (para el texto: hora de inicio y fin reales). */
  start: number
  end: number
  /** Parte visible en el rango (para dibujar). */
  visibleStart: number
  visibleEnd: number
}

/** Huecos de la cámara que se ven en el rango, con su rango completo. */
export function gapsInRange(camera: Camera, range: Segment): VisibleGap[] {
  return gaps(camera)
    .filter(g => g.end > range.start && g.start < range.end)
    .map(g => ({ start: g.start, end: g.end, visibleStart: Math.max(g.start, range.start), visibleEnd: Math.min(g.end, range.end) }))
}

export function gapLabel(g: { start: number; end: number }): string {
  return `Sin grabación de ${fmtTime(g.start)} a ${fmtTime(g.end)}`
}

// ─── Grilla 16:9 ──────────────────────────────────────────────────────────────

export const VIDEO_ASPECT = 16 / 9

/** Columnas y filas de la grilla según cantidad de celdas (1, 4, 9, 16). */
export function gridShape(cells: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(cells)))
  return { cols, rows: Math.max(1, Math.ceil(cells / cols)) }
}

/** Ancho mínimo de una celda de video en la grilla ajustada (px): debajo de eso, la página se desplaza. */
export const MIN_FIT_CELL_PX = 220

/**
 * Grilla de celdas 16:9 que entra en el ALTO REAL que le queda (PC y tablet
 * horizontal). La grilla vive en un contenedor flexible con `container-type: size`
 * que ocupa el alto sobrante entre los controles y el timeline; el ancho se calcula
 * en unidades de contenedor (cqw/cqh), así que se adapta a lo que mida la pantalla
 * (controles en dos renglones, más filas en el timeline, etc.) sin constantes de
 * reserva.
 *   - `width`: el menor entre el ancho disponible y el ancho con el que las filas
 *     16:9 llenan el alto; si sobra ancho, quedan bandas a los costados (letterbox),
 *     nunca celdas estiradas.
 *   - `minHeight`: alto mínimo del contenedor para celdas de `minCellPx` de ancho;
 *     antes que celdas ilegibles, la página se desplaza.
 */
export function gridFit(cells: number, gapPx = 8, minCellPx = MIN_FIT_CELL_PX): { width: string; minHeight: string } {
  const { cols, rows } = gridShape(cells)
  const ratio = VIDEO_ASPECT.toFixed(6)
  const fit = `calc((100cqh - ${(rows - 1) * gapPx}px) / ${rows} * ${ratio} * ${cols} + ${(cols - 1) * gapPx}px)`
  const minWidth = cols * minCellPx + (cols - 1) * gapPx
  const minHeight = Math.ceil(rows * (minCellPx / VIDEO_ASPECT) + (rows - 1) * gapPx)
  return { width: `min(100cqw, max(${minWidth}px, ${fit}))`, minHeight: `${minHeight}px` }
}
