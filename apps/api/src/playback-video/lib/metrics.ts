// apps/api/src/playback-video/lib/metrics.ts
//
// Análisis PURO de lo que mostró el navegador. La entrada son muestras por cuadro
// presentado (requestVideoFrameCallback) con el instante de grabación leído de la
// franja; la salida son las métricas del reporte (saltos, tiempo detenido, error de
// seek, tasa por velocidad, error del reloj de la UI). Sin I/O: se prueba aparte
// (metrics.test.ts) y corre en `npm test`.

/** Muestra de un cuadro presentado en una celda. */
export interface FrameSample {
  /** Reloj de pared (ms) del navegador cuando se presentó el cuadro. */
  wall: number
  /** Índice de la celda (orden del DOM de los <video>). */
  slot: number
  /** currentTime del <video> (s). */
  ct: number
  /** duration del <video>: null = NaN, -1 = Infinity. */
  dur?: number | null
  rate: number
  /** sessionId del preview (de la URL del stream) o '' si no hay src. */
  sid: string
  /** Instante de grabación del cuadro (ms, hora de pared del NVR en UTC) o null si no se pudo leer. */
  recMs: number | null
  ch: number | null
  /** Texto del reloj de la UI ("dd/MM HH:mm:ss") en ese momento. */
  clock: string | null
}

export interface Segment { startMs: number; endMs: number }

export interface Run {
  sid: string
  slot: number
  samples: FrameSample[]
  /** Cuadros DISTINTOS decodificados (primera presentación de cada recMs). */
  frames: FrameSample[]
}

export interface RunStats {
  sid: string
  decoded: number
  decodeFailures: number
  firstRecMs: number | null
  lastRecMs: number | null
  firstFrameWall: number | null
  lastFrameWall: number | null
  /** Retrocesos del instante mostrado dentro de la sesión. */
  backSteps: number
  maxBackMs: number
  /** Saltos hacia adelante sin explicación por huecos (ms de grabación salteados). */
  skippedMs: number
  forwardJumps: Array<{ fromRecMs: number; toRecMs: number; wall: number }>
  /** Mayor intervalo de pared sin un cuadro nuevo (imagen congelada) dentro de la sesión. */
  maxFreezeMs: number
}

export interface Border {
  fromSid: string
  toSid: string
  lastRecMs: number
  firstRecMs: number
  /** Salto de grabación entre el último cuadro de una sesión y el primero de la siguiente. */
  recJumpMs: number
  /** Parte del salto que es hueco REAL de grabación. */
  realGapMs: number
  /** Video grabado que no se mostró (salto − hueco real − 1 cuadro); negativo = repetición. */
  lostMs: number
  /** Pared entre el último cuadro nuevo de una sesión y el primero de la siguiente. */
  frozenMs: number
}

export const FRAME_MS = 40

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

export function round(v: number | null | undefined, digits = 0): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/** Tiempo (ms) de [a, b) que NO cubre ninguna grabación. */
export function uncoveredMs(a: number, b: number, segments: Segment[]): number {
  if (!(b > a)) return 0
  const parts = segments
    .map((s) => [Math.max(a, s.startMs), Math.min(b, s.endMs)] as const)
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0])
  let covered = 0
  let cursor = a
  for (const [s, e] of parts) {
    if (e <= cursor) continue
    covered += e - Math.max(s, cursor)
    cursor = Math.max(cursor, e)
  }
  return (b - a) - covered
}

/** ¿El instante pertenece a alguna grabación (con tolerancia de 1 cuadro)? */
export function isRecorded(recMs: number, segments: Segment[], tolMs = FRAME_MS): boolean {
  return segments.some((s) => recMs >= s.startMs - tolMs && recMs < s.endMs + tolMs)
}

/** Agrupa las muestras de una celda en corridas consecutivas por sesión. */
export function runsForSlot(samples: FrameSample[], slot: number): Run[] {
  const runs: Run[] = []
  for (const s of samples) {
    if (s.slot !== slot || !s.sid) continue
    let run = runs.at(-1)
    if (!run || run.sid !== s.sid) { run = { sid: s.sid, slot, samples: [], frames: [] }; runs.push(run) }
    run.samples.push(s)
    if (s.recMs !== null && run.frames.at(-1)?.recMs !== s.recMs) run.frames.push(s)
  }
  return runs
}

/**
 * Estadísticas de una corrida. `jumpToleranceMs` es lo que puede avanzar el
 * contenido entre dos cuadros presentados sin considerarse salto (a velocidades
 * > 1× el navegador presenta cuadros salteados por diseño: a 16× y 60 Hz, ~270 ms).
 */
export function runStats(run: Run, segments: Segment[], jumpToleranceMs = 500): RunStats {
  const f = run.frames
  let backSteps = 0
  let maxBackMs = 0
  let skippedMs = 0
  let maxFreezeMs = 0
  const forwardJumps: RunStats['forwardJumps'] = []
  for (let i = 1; i < f.length; i++) {
    const d = (f[i].recMs as number) - (f[i - 1].recMs as number)
    maxFreezeMs = Math.max(maxFreezeMs, f[i].wall - f[i - 1].wall)
    if (d < 0) { backSteps++; maxBackMs = Math.max(maxBackMs, -d); continue }
    // Entre dos cuadros PRESENTADOS consecutivos el contenido avanza ~1 cuadro (a
    // 4× con 60 Hz, ~4 cuadros). Más de `jumpToleranceMs` sin hueco real es video
    // que no se mostró, aunque haya pasado tiempo de pared (congelado + salto).
    const gap = uncoveredMs(f[i - 1].recMs as number, f[i].recMs as number, segments)
    const unexplained = d - gap - FRAME_MS
    if (unexplained > jumpToleranceMs) {
      skippedMs += unexplained
      forwardJumps.push({ fromRecMs: f[i - 1].recMs as number, toRecMs: f[i].recMs as number, wall: f[i].wall })
    }
  }
  return {
    sid: run.sid,
    decoded: f.length,
    decodeFailures: run.samples.filter((s) => s.recMs === null).length,
    firstRecMs: f[0]?.recMs ?? null,
    lastRecMs: f.at(-1)?.recMs ?? null,
    firstFrameWall: f[0]?.wall ?? null,
    lastFrameWall: f.at(-1)?.wall ?? null,
    backSteps, maxBackMs, skippedMs, forwardJumps, maxFreezeMs,
  }
}

/** Bordes entre corridas consecutivas de una celda (relevo de bloque, seek, etc.). */
export function bordersBetween(runs: Run[], segments: Segment[]): Border[] {
  const out: Border[] = []
  const withFrames = runs.filter((r) => r.frames.length > 0)
  for (let i = 1; i < withFrames.length; i++) {
    const a = withFrames[i - 1].frames.at(-1)!
    const b = withFrames[i].frames[0]
    const last = a.recMs as number
    const first = b.recMs as number
    const realGap = uncoveredMs(last + FRAME_MS, first, segments)
    out.push({
      fromSid: withFrames[i - 1].sid, toSid: withFrames[i].sid,
      lastRecMs: last, firstRecMs: first,
      recJumpMs: first - last,
      realGapMs: realGap,
      lostMs: first - last - FRAME_MS - realGap,
      frozenMs: b.wall - a.wall,
    })
  }
  return out
}

/** "dd/MM HH:mm:ss" (hora de pared del NVR, componentes UTC) → ms. */
export function parseClock(text: string | null, year: number): number | null {
  const m = text?.match(/^(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)$/)
  if (!m) return null
  return Date.UTC(year, Number(m[2]) - 1, Number(m[1]), Number(m[3]), Number(m[4]), Number(m[5]))
}

/**
 * Error del reloj de la UI respecto del cuadro mostrado. El reloj tiene
 * resolución de 1 s (trunca): se toma el punto medio del segundo, así que la
 * cuantización sola aporta hasta ±0,5 s.
 */
export function clockErrors(samples: FrameSample[], year: number): number[] {
  const out: number[] = []
  for (const s of samples) {
    if (s.recMs === null) continue
    const c = parseClock(s.clock, year)
    if (c === null) continue
    out.push(c + 500 - s.recMs)
  }
  return out
}

export function clockStats(errors: number[]): { n: number; p50: number | null; p95Abs: number | null; maxAbs: number | null } {
  const abs = errors.map(Math.abs)
  return { n: errors.length, p50: round(percentile(errors, 50)), p95Abs: round(percentile(abs, 95)), maxAbs: round(abs.length ? Math.max(...abs) : null) }
}

export interface RateWindow {
  fromWall: number
  toWall: number
  nominal: number
  frames: number
  /** Avance de grabación mostrado / pared. */
  effectiveRate: number | null
  /** Grabación salteada (sin contar huecos reales). */
  skippedMs: number
  backSteps: number
  /** Mayor pared sin cuadro nuevo. */
  maxFreezeMs: number
  clock: ReturnType<typeof clockStats>
}

/** Mide una ventana de pared en una celda a una velocidad nominal. */
export function rateWindow(samples: FrameSample[], slot: number, fromWall: number, toWall: number, nominal: number, segments: Segment[], year: number): RateWindow {
  const inWin = samples.filter((s) => s.slot === slot && s.wall >= fromWall && s.wall <= toWall)
  const frames: FrameSample[] = []
  for (const s of inWin) if (s.recMs !== null && frames.at(-1)?.recMs !== s.recMs) frames.push(s)
  let skippedMs = 0
  let backSteps = 0
  let maxFreezeMs = 0
  for (let i = 1; i < frames.length; i++) {
    const d = (frames[i].recMs as number) - (frames[i - 1].recMs as number)
    const dw = frames[i].wall - frames[i - 1].wall
    maxFreezeMs = Math.max(maxFreezeMs, dw)
    if (d < 0) { backSteps++; continue }
    const gap = uncoveredMs(frames[i - 1].recMs as number, frames[i].recMs as number, segments)
    const unexplained = d - gap - FRAME_MS
    if (unexplained > 500) skippedMs += unexplained
  }
  const first = frames[0]
  const last = frames.at(-1)
  const effectiveRate = first && last && last.wall > first.wall
    ? ((last.recMs as number) - (first.recMs as number) - uncoveredMs(first.recMs as number, last.recMs as number, segments)) / (last.wall - first.wall)
    : null
  if (first) maxFreezeMs = Math.max(maxFreezeMs, first.wall - fromWall)
  if (last) maxFreezeMs = Math.max(maxFreezeMs, toWall - last.wall)
  return {
    fromWall, toWall, nominal, frames: frames.length,
    effectiveRate: round(effectiveRate, 2), skippedMs: Math.round(skippedMs), backSteps, maxFreezeMs,
    clock: clockStats(clockErrors(inWin, year)),
  }
}
