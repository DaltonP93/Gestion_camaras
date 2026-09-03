import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiEventPipeline, type AiMetricKind } from './pipeline'
import { BoundedQueue } from './queue'
import { CircuitBreaker } from './circuit-breaker'
import { MockInferenceProvider } from './mock-provider'
import type { AnalyticsEvent, InferenceInput, Track } from './contracts'

function input(cameraId = 'cam-1'): InferenceInput {
  return { cameraId, streamPath: `nvr_${cameraId}_sub`, frameId: 1, capturedAt: 0 }
}

function personTrack(trackId = 1): Track {
  return { trackId, className: 'person', confidence: 0.9, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, ageMs: 100 }
}

function makePipeline(opts: {
  enabled?: boolean
  provider?: MockInferenceProvider
  breaker?: CircuitBreaker
  queue?: BoundedQueue<InferenceInput>
  clock?: () => number
  dedupeWindowMs?: number
  inferTimeoutMs?: number
  maxConcurrent?: number
  maxDedupEntries?: number
} = {}) {
  const events: AnalyticsEvent[] = []
  const metrics: AiMetricKind[] = []
  const provider = opts.provider ?? new MockInferenceProvider({ tracks: () => [personTrack()] })
  const queue = opts.queue ?? new BoundedQueue<InferenceInput>({ maxPerKey: 50, maxTotal: 200 })
  const breaker = opts.breaker ?? new CircuitBreaker({ failureThreshold: 3, openMs: 1000 }, opts.clock)
  let id = 0
  const p = new AiEventPipeline(provider, queue, breaker, {
    enabled: opts.enabled ?? true,
    inferTimeoutMs: opts.inferTimeoutMs ?? 1000,
    dedupeWindowMs: opts.dedupeWindowMs ?? 5000,
    maxConcurrent: opts.maxConcurrent,
    maxDedupEntries: opts.maxDedupEntries,
    clock: opts.clock ?? (() => 0),
    emitId: () => `evt_${++id}`,
    onEvent: (e) => events.push(e),
    onMetric: (m) => metrics.push(m),
  })
  return { p, events, metrics, provider, queue, breaker }
}

afterEach(() => { vi.useRealTimers() })

describe('AiEventPipeline · flag AI_EVENTS_ENABLED', () => {
  it('con la flag apagada: submit=DISABLED, drainOne=disabled, el proveedor no se llama', async () => {
    let called = 0
    const provider = new MockInferenceProvider({ tracks: () => { called++; return [personTrack()] } })
    const { p } = makePipeline({ enabled: false, provider })
    expect(p.submit(input())).toEqual({ accepted: false, reason: 'DISABLED' })
    expect(await p.drainOne()).toBe('disabled')
    expect(called).toBe(0)
  })
})

describe('AiEventPipeline · camino feliz + dedup', () => {
  it('emite un evento por track de persona', async () => {
    const { p, events } = makePipeline()
    expect(p.submit(input()).accepted).toBe(true)
    expect(await p.drainOne()).toBe('processed')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ cameraId: 'cam-1', type: 'person', className: 'person', modelId: 'mock' })
  })

  it('deduplica el mismo track dentro de la ventana; emite fuera de ella', async () => {
    let t = 0
    const provider = new MockInferenceProvider({ tracks: () => [personTrack(7)] })
    const { p, events, metrics } = makePipeline({ provider, clock: () => t, dedupeWindowMs: 5000 })
    p.submit(input()); await p.drainOne()               // emite
    p.submit(input()); await p.drainOne()               // mismo track, misma ventana ⇒ dedup
    expect(events).toHaveLength(1)
    expect(metrics.filter(m => m === 'deduped')).toHaveLength(1)
    t = 6000
    p.submit(input()); await p.drainOne()               // fuera de ventana ⇒ emite
    expect(events).toHaveLength(2)
  })

  it('ignora clases desconocidas (no fuerza tipo de evento)', async () => {
    const provider = new MockInferenceProvider({ tracks: () => [{ trackId: 1, className: 'unknown', confidence: 0.5, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, ageMs: 0 }] })
    const { p, events } = makePipeline({ provider })
    p.submit(input()); expect(await p.drainOne()).toBe('processed')
    expect(events).toHaveLength(0)
  })
})

describe('AiEventPipeline · resiliencia (no bloquea el video)', () => {
  it('proveedor que lanza ⇒ error manejado, sin throw, sin evento, cuenta como fallo', async () => {
    const provider = new MockInferenceProvider({ fail: true })
    const { p, events, breaker } = makePipeline({ provider })
    p.submit(input())
    await expect(p.drainOne()).resolves.toBe('error')   // resuelve, no rechaza
    expect(events).toHaveLength(0)
    // un fallo no abre aún (threshold 3), pero quedó registrado
    expect(breaker.state()).toBe('closed')
  })

  it('circuito abierto ⇒ no llama al proveedor', async () => {
    let called = 0
    const provider = new MockInferenceProvider({ tracks: () => { called++; return [] } })
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 100000 })
    breaker.onFailure() // abre
    const { p } = makePipeline({ provider, breaker })
    p.submit(input())
    expect(await p.drainOne()).toBe('circuit_open')
    expect(called).toBe(0)
  })

  it('P0-5 · timeout ABORTA la inferencia y inFlight vuelve a 0 (fake timers)', async () => {
    vi.useFakeTimers()
    const provider = new MockInferenceProvider({ hangMs: 10_000, tracks: () => [personTrack()] })
    const { p } = makePipeline({ provider, inferTimeoutMs: 1000 })
    p.submit(input())
    const pending = p.drainOne()
    expect(p.inFlightCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await pending).toBe('timeout')
    expect(p.inFlightCount).toBe(0)          // el trabajo en vuelo se liberó
    expect(provider.lastSignal?.aborted).toBe(true) // el timeout ejecutó abort()
  })

  it('P0-7 · provider que IGNORA abort ⇒ segundo drain busy y UNA sola inferencia subyacente', async () => {
    vi.useFakeTimers()
    const bad = {
      providerId: 'bad',
      status: () => ({ providerId: 'bad', modelId: 'm', modelVersion: '0', state: 'ready' as const, updatedAt: 0 }),
      infer: () => new Promise<never>(() => {}),  // nunca resuelve; ignora AbortSignal
    }
    const { p } = makePipeline({ provider: bad as any, maxConcurrent: 1, inferTimeoutMs: 1000 })
    p.submit(input('c1')); p.submit(input('c2'))
    const d1 = p.drainOne()
    await vi.advanceTimersByTimeAsync(1001)
    expect(await d1).toBe('timeout')
    expect(p.realInFlightCount).toBe(1)          // el trabajo subyacente sigue ocupando el slot
    expect(await p.drainOne()).toBe('busy')      // no se inicia otra inferencia
    expect(p.realInFlightCount).toBe(1)          // sigue habiendo UNA sola inferencia real
  })

  it('P0-5 · concurrencia acotada: con maxConcurrent=1 el segundo drain es busy', async () => {
    vi.useFakeTimers()
    const provider = new MockInferenceProvider({ hangMs: 10_000, tracks: () => [] })
    const { p } = makePipeline({ provider, maxConcurrent: 1, inferTimeoutMs: 1000 })
    p.submit(input('cam-1')); p.submit(input('cam-2'))
    const c1 = p.drainOne()               // toma el único cupo
    expect(await p.drainOne()).toBe('busy')
    await vi.advanceTimersByTimeAsync(1001)
    await c1
    expect(p.inFlightCount).toBe(0)
  })

  it('P0-5 · el mapa de dedup se poda (vencidos) y respeta la cota dura', async () => {
    let t = 0
    let id = 0
    const provider = new MockInferenceProvider({ tracks: () => [{ trackId: ++id, className: 'person', confidence: 0.9, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, ageMs: 0 }] })
    const { p } = makePipeline({ provider, clock: () => t, dedupeWindowMs: 1000, maxDedupEntries: 5 })
    for (let i = 0; i < 20; i++) { p.submit(input()); await p.drainOne() }
    expect(p.dedupSize).toBeLessThanOrEqual(5)   // cota dura
    t = 10_000                                    // pasa la ventana
    p.submit(input()); await p.drainOne()
    expect(p.dedupSize).toBe(1)                    // los vencidos se podaron
  })

  it('backpressure: sobre una cola pequeña, los extras se descartan (dropped)', async () => {
    const queue = new BoundedQueue<InferenceInput>({ maxPerKey: 2, maxTotal: 2 })
    const { p, metrics } = makePipeline({ queue })
    expect(p.submit(input()).accepted).toBe(true)
    expect(p.submit(input()).accepted).toBe(true)
    expect(p.submit(input()).accepted).toBe(false)      // lleno ⇒ drop
    expect(metrics.filter(m => m === 'dropped')).toHaveLength(1)
  })
})
