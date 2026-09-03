// apps/web/src/lib/firstFrameTiming.ts
//
// Medición client-side del tramo manifiesto → primer frame (y del inicio nativo
// → primer frame). El servidor mide hasta "HLS listo"; el tiempo que el operador
// percibe incluye además la carga del primer frame en el reproductor. Puro y sin
// DOM: recibe timestamps y produce un reporte de cardinalidad acotada.

export type ClientStartupStage = 'manifest_to_first_frame' | 'native_start_to_first_frame'
export type ClientStartupOutcome = 'first_frame' | 'error' | 'cancelled'

export interface ClientStartupReport {
  stage: ClientStartupStage
  seconds: number
  outcome: ClientStartupOutcome
}

/**
 * Construye el reporte de un tramo client-side. Devuelve null si falta un
 * timestamp o el tramo es negativo (relojes cruzados). El reporte NO incluye
 * cameraId/token: sólo stage/outcome/seconds, para telemetría de baja cardinalidad.
 */
export function buildClientStartupReport(
  stage: ClientStartupStage,
  startMs: number | null | undefined,
  firstFrameMs: number | null | undefined,
  outcome: ClientStartupOutcome = 'first_frame',
): ClientStartupReport | null {
  if (startMs == null || firstFrameMs == null) return null
  const seconds = (firstFrameMs - startMs) / 1000
  if (seconds < 0) return null
  return { stage, seconds, outcome }
}
