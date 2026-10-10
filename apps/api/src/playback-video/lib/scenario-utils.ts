// apps/api/src/playback-video/lib/scenario-utils.ts
//
// Utilidades comunes de los escenarios: horas del día de prueba, espera, y el
// análisis por sesión de una celda (cruzando las muestras del navegador con los
// arranques de preview capturados en la red).

import type { VideoPage, PreviewStartRec } from './browser-page'
import { bordersBetween, round, runStats, runsForSlot, type Border, type RunStats, type Segment } from './metrics'

/** Día de las grabaciones sintéticas. */
export const DAY_YEAR = 2026
/** 'HH:MM:SS(.mmm)' del 2026-10-01 en hora de pared del NVR (componentes UTC) → ms. */
export function T(hms: string): number {
  return Date.parse(`2026-10-01T${hms}${hms.length === 8 ? '.000' : ''}Z`)
}
export function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString().slice(11, 23)
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface SessionView extends RunStats {
  requestedStart: string | null
  requestedEnd: string | null
  /** Primer cuadro − inicio pedido (ms): >0 = se perdió el principio. */
  headLossMs: number | null
  /** Fin pedido − (último cuadro + 1 cuadro) (ms): >0 = se cortó antes del final. */
  tailLossMs: number | null
  /** Pared desde que la UI pidió el preview hasta el primer cuadro. */
  timeToFirstFrameMs: number | null
  continuityOf: boolean
}

export function previewOf(p: VideoPage, sid: string): PreviewStartRec | undefined {
  return p.previews.find((r) => r.sessionId === sid)
}

/** Sesiones de una celda en orden, con pérdidas al principio y al final. */
export function sessionsOf(p: VideoPage, slot: number, segments: Segment[], fromWall = 0): { sessions: SessionView[]; borders: Border[] } {
  const runs = runsForSlot(p.frames.filter((f) => f.wall >= fromWall), slot)
  const sessions = runs.map((run) => {
    const st = runStats(run, segments)
    const pv = previewOf(p, run.sid)
    const reqStart = pv ? Date.parse(pv.startTime) : null
    const reqEnd = pv ? Date.parse(pv.endTime) : null
    return {
      ...st,
      requestedStart: iso(reqStart), requestedEnd: iso(reqEnd),
      headLossMs: reqStart !== null && st.firstRecMs !== null ? st.firstRecMs - reqStart : null,
      tailLossMs: reqEnd !== null && st.lastRecMs !== null ? reqEnd - (st.lastRecMs + 40) : null,
      timeToFirstFrameMs: pv && st.firstFrameWall !== null ? st.firstFrameWall - pv.wall : null,
      continuityOf: !!pv?.continuityOf,
    }
  })
  return { sessions, borders: bordersBetween(runs, segments) }
}

/** Vista compacta de una sesión para el reporte. */
export function compactSession(s: SessionView): Record<string, unknown> {
  return {
    sid: s.sid.slice(0, 8), pedido: `${s.requestedStart}→${s.requestedEnd}`,
    primerCuadro: iso(s.firstRecMs), ultimoCuadro: iso(s.lastRecMs), cuadros: s.decoded, fallasDecod: s.decodeFailures,
    perdidaInicioMs: s.headLossMs, perdidaFinalMs: s.tailLossMs, ttffMs: s.timeToFirstFrameMs,
    retrocesos: s.backSteps, salteadoMs: Math.round(s.skippedMs), congelMaxMs: s.maxFreezeMs, continuidad: s.continuityOf,
  }
}

export function compactBorder(b: Border): Record<string, unknown> {
  return {
    de: iso(b.lastRecMs), a: iso(b.firstRecMs), saltoMs: b.recJumpMs, huecoRealMs: b.realGapMs,
    perdidoMs: b.lostMs, congeladoMs: b.frozenMs,
  }
}

export function maxOf(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x))
  return v.length ? Math.max(...v) : null
}

export { round }
