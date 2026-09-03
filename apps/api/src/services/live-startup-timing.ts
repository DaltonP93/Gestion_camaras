// apps/api/src/services/live-startup-timing.ts
//
// Medición por ETAPAS del arranque de LiveView (C22, Hito 4). C21 ya expone el
// tramo dominante (spawn de FFmpeg → HLS listo, ~5–7 s). Este módulo modela el
// desglose completo y GARANTIZA cardinalidad acotada en las métricas: los únicos
// labels permitidos son `stage` y `outcome`, ambos de conjuntos fijos. NUNCA se
// usan cameraId/userId/token/URI como labels.

export type LiveStartupStage =
  | 'request_to_admission'          // llegada de la solicitud → admisión (cupo concedido)
  | 'admission_to_spawn'            // admisión → spawn de FFmpeg
  | 'spawn_to_hls_ready'            // spawn → manifiesto HLS usable (server-side)
  | 'manifest_to_first_frame'       // manifiesto → primer frame (client-side)
  | 'close_to_slot_free'            // cierre → cupo disponible
  | 'wait_for_slot'                 // espera por cupo cuando los 2 estaban ocupados
  | 'native_start_to_first_frame'   // inicio nativo → primer frame (client-side)

export type LiveStartupOutcome =
  | 'ready' | 'process_exited' | 'partial_manifest' | 'timeout' | 'cancelled'

export const LIVE_STARTUP_STAGES: readonly LiveStartupStage[] = [
  'request_to_admission',
  'admission_to_spawn',
  'spawn_to_hls_ready',
  'manifest_to_first_frame',
  'close_to_slot_free',
  'wait_for_slot',
  'native_start_to_first_frame',
]

export const LIVE_STARTUP_OUTCOMES: readonly LiveStartupOutcome[] = [
  'ready', 'process_exited', 'partial_manifest', 'timeout', 'cancelled',
]

export interface StageObservation {
  stage: LiveStartupStage
  seconds: number
  outcome: LiveStartupOutcome
}

/**
 * Cronómetro de marcas para medir tramos. El reloj es inyectable para tests.
 * `measure` devuelve segundos, o null si falta una marca o el tramo es negativo
 * (evita métricas absurdas si los relojes se cruzan).
 */
export class LiveStartupTimer {
  private readonly marks = new Map<string, number>()
  constructor(private readonly clock: () => number = () => Date.now()) {}

  mark(name: string): void { this.marks.set(name, this.clock()) }
  markAt(name: string, ts: number): void { this.marks.set(name, ts) }

  measure(from: string, to: string): number | null {
    const a = this.marks.get(from)
    const b = this.marks.get(to)
    if (a === undefined || b === undefined) return null
    const s = (b - a) / 1000
    return s >= 0 ? s : null
  }

  observation(
    stage: LiveStartupStage,
    from: string,
    to: string,
    outcome: LiveStartupOutcome,
  ): StageObservation | null {
    const seconds = this.measure(from, to)
    return seconds === null ? null : { stage, seconds, outcome }
  }
}

/**
 * Verifica que un conjunto de labels sea de cardinalidad ACOTADA: sólo las
 * claves `stage`/`outcome` y sólo valores de los conjuntos fijos. Sirve de
 * guarda en pruebas para que nunca se cuele un cameraId/userId/token.
 */
export function isBoundedStageLabels(labels: Record<string, string>): boolean {
  for (const key of Object.keys(labels)) {
    if (key !== 'stage' && key !== 'outcome') return false
  }
  if (labels.stage !== undefined && !LIVE_STARTUP_STAGES.includes(labels.stage as LiveStartupStage)) return false
  if (labels.outcome !== undefined && !LIVE_STARTUP_OUTCOMES.includes(labels.outcome as LiveStartupOutcome)) return false
  return true
}
