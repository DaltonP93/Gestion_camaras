// apps/api/src/services/ai/pipeline.ts
//
// Pipeline de eventos de IA (C22, Hito 5). Orquesta proveedor + cola con
// backpressure + circuit breaker + timeout + deduplicación, SIN bloquear el
// video: `submit` es O(1) y no lanza; `drainOne` está aislado con try/catch, de
// modo que un proveedor caído nunca propaga error al camino del stream. Todo
// detrás de `AI_EVENTS_ENABLED` (apagado por defecto). Consume la identidad del
// restream compartido (InferenceInput.streamPath), nunca una 2.ª conexión al NVR.

import {
  AI_CONTRACT_VERSION,
  type AnalyticsEvent,
  type AiEventType,
  type AiObjectClass,
  type InferenceProvider,
  type InferenceInput,
  type Track,
} from './contracts'
import { BoundedQueue, type QueueDropReason } from './queue'
import { CircuitBreaker } from './circuit-breaker'

export type SubmitReason = QueueDropReason | 'DISABLED'
export interface SubmitResult { accepted: boolean; reason?: SubmitReason }

export type DrainStatus =
  | 'disabled' | 'idle' | 'busy' | 'processed' | 'timeout' | 'error' | 'circuit_open'

export type AiMetricKind =
  | 'submitted' | 'dropped' | 'processed' | 'timeout' | 'error'
  | 'circuit_open' | 'deduped' | 'emitted'

export interface AiPipelineOptions {
  enabled: boolean
  inferTimeoutMs: number
  dedupeWindowMs: number
  /** Máximo de inferencias simultáneas (P0-5). Default 2. */
  maxConcurrent?: number
  /** Cota dura del mapa de deduplicación (P0-5). Default 10000. */
  maxDedupEntries?: number
  clock?: () => number
  emitId?: () => string
  onEvent?: (e: AnalyticsEvent) => void
  onMetric?: (kind: AiMetricKind) => void
}

const VEHICLE_CLASSES = new Set<AiObjectClass>(['car', 'truck', 'bus', 'motorcycle', 'bicycle'])

function eventTypeFor(cls: AiObjectClass): AiEventType | null {
  if (cls === 'person') return 'person'
  if (VEHICLE_CLASSES.has(cls)) return 'vehicle'
  return null
}

class TimeoutError extends Error { readonly isTimeout = true }

export class AiEventPipeline {
  private readonly dedup = new Map<string, number>()
  private emitCounter = 0
  // P0-7: slots REALES ocupados por trabajo del proveedor que aún NO se asentó.
  // Un proveedor que ignora abort sigue ocupando un slot hasta que su Promise
  // termine; así la concurrencia real no crece sin límite aunque el drain venza.
  private realInFlight = 0

  constructor(
    private readonly provider: InferenceProvider,
    private readonly queue: BoundedQueue<InferenceInput>,
    private readonly breaker: CircuitBreaker,
    private readonly opts: AiPipelineOptions,
  ) {}

  private now(): number { return (this.opts.clock ?? (() => Date.now()))() }
  private nextId(): string { return this.opts.emitId ? this.opts.emitId() : `evt_${++this.emitCounter}` }
  private get maxConcurrent(): number { return this.opts.maxConcurrent ?? 2 }

  /** Trabajo subyacente del proveedor aún en vuelo (no la respuesta del drain). */
  get realInFlightCount(): number { return this.realInFlight }
  /** Alias histórico (respuesta del drain ≈ trabajo real para un proveedor cooperativo). */
  get inFlightCount(): number { return this.realInFlight }
  /** Tamaño del mapa de deduplicación (P0-5: acotado, no crece sin límite). */
  get dedupSize(): number { return this.dedup.size }

  /** Encola una entrada (no bloquea, no lanza). Con la flag apagada, DISABLED. */
  submit(input: InferenceInput): SubmitResult {
    if (!this.opts.enabled) return { accepted: false, reason: 'DISABLED' }
    const r = this.queue.enqueue(input.cameraId, input)
    this.opts.onMetric?.(r.accepted ? 'submitted' : 'dropped')
    return r
  }

  /** Procesa UNA entrada encolada. Aislado: nunca lanza al llamador. */
  async drainOne(): Promise<DrainStatus> {
    if (!this.opts.enabled) return 'disabled'
    // Concurrencia acotada por el trabajo REAL en vuelo (no por la respuesta del drain).
    if (this.realInFlight >= this.maxConcurrent) return 'busy'
    const entry = this.queue.dequeue()
    if (!entry) return 'idle'
    if (!this.breaker.tryAcquire()) {
      this.opts.onMetric?.('circuit_open')
      return 'circuit_open'
    }
    const controller = new AbortController()
    // El slot real se libera cuando el TRABAJO SUBYACENTE se asienta, no al vencer
    // el timeout del drain. Un proveedor que ignora abort mantiene el slot ocupado.
    const work = this.provider.infer(entry.item, controller.signal)
    this.realInFlight++
    void work.then(() => {}, () => {}).finally(() => { this.realInFlight-- })

    let tracks: Track[]
    try {
      tracks = await this.withTimeout(work, this.opts.inferTimeoutMs, controller)
    } catch (err) {
      this.breaker.onFailure()  // repetidos ⇒ el circuito aísla (quarantine) al proveedor
      const isTimeout = err instanceof TimeoutError
      this.opts.onMetric?.(isTimeout ? 'timeout' : 'error')
      return isTimeout ? 'timeout' : 'error'
    }
    this.breaker.onSuccess()
    this.emitFromTracks(entry.item, tracks)
    this.opts.onMetric?.('processed')
    return 'processed'
  }

  /** Drena hasta N entradas (o hasta vaciar/deshabilitar). */
  async drain(max: number): Promise<DrainStatus[]> {
    const out: DrainStatus[] = []
    for (let i = 0; i < max; i++) {
      const s = await this.drainOne()
      out.push(s)
      if (s === 'idle' || s === 'disabled') break
    }
    return out
  }

  /** Poda entradas de dedup vencidas y aplica una cota dura (P0-5: mapa acotado). */
  private pruneDedup(now: number): void {
    for (const [k, ts] of this.dedup) {
      if (now - ts >= this.opts.dedupeWindowMs) this.dedup.delete(k)
    }
    const cap = this.opts.maxDedupEntries ?? 10_000
    if (this.dedup.size > cap) {
      // El Map preserva orden de inserción: elimina los más viejos primero.
      const excess = this.dedup.size - cap
      let i = 0
      for (const k of this.dedup.keys()) { if (i++ >= excess) break; this.dedup.delete(k) }
    }
  }

  private emitFromTracks(input: InferenceInput, tracks: Track[]): void {
    const now = this.now()
    for (const t of tracks) {
      const type = eventTypeFor(t.className)
      if (!type) continue
      const key = `${input.cameraId}|${type}|${t.trackId}`
      const last = this.dedup.get(key)
      if (last !== undefined && now - last < this.opts.dedupeWindowMs) {
        this.opts.onMetric?.('deduped')
        continue
      }
      this.dedup.set(key, now)
      const status = this.provider.status()
      const event: AnalyticsEvent = {
        contractVersion: AI_CONTRACT_VERSION,
        eventId: this.nextId(),
        cameraId: input.cameraId,
        type,
        className: t.className,
        confidence: t.confidence,
        trackId: t.trackId,
        occurredAt: now,
        detections: [{ className: t.className, confidence: t.confidence, bbox: t.bbox }],
        modelId: status.modelId,
        modelVersion: status.modelVersion,
      }
      this.opts.onEvent?.(event)
      this.opts.onMetric?.('emitted')
    }
    // Poda al final: la decisión de dedup ya usa la comparación temporal, así que
    // podar aquí sólo acota la memoria (mapa nunca crece sin límite).
    this.pruneDedup(now)
  }

  private withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()  // P0-5: aborta el trabajo del proveedor, no sólo la espera.
        reject(new TimeoutError('inference timeout'))
      }, ms)
      p.then(
        (v) => { clearTimeout(timer); resolve(v) },
        (e) => { clearTimeout(timer); reject(e) },
      )
    })
  }
}
