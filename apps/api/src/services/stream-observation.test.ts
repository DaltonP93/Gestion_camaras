import { describe, it, expect } from 'vitest'
import { observeStreamPipeline, DEFAULT_DEMAND_WINDOW_MS, type MediaMtxRuntimeSnapshot, type StreamDemandEvidence } from './stream-observation'
import { stepDebounce, initialDebounceState, DEFAULT_DEBOUNCE, type DebounceState } from './camera-health-debounce'

const NOW = 10_000_000

const MTX_READY: MediaMtxRuntimeSnapshot        = { configured: true,  runtimeFound: true,  ready: true,  bytesReceived: 5000, readers: 1 }
const MTX_NOT_READY: MediaMtxRuntimeSnapshot    = { configured: true,  runtimeFound: true,  ready: false, bytesReceived: 0,    readers: 0 }
const MTX_MISSING: MediaMtxRuntimeSnapshot      = { configured: false, runtimeFound: true,  ready: false, bytesReceived: 0,    readers: 0 }
const MTX_API_DOWN: MediaMtxRuntimeSnapshot     = { configured: null,  runtimeFound: null,  ready: false, bytesReceived: 0,    readers: 0 }

const NO_DEMAND: StreamDemandEvidence   = { activeSessions: 0, lastStreamFailureAt: null, lastStreamSuccessAt: null, lastHlsSuccessAt: null }
const WITH_SESSIONS: StreamDemandEvidence = { ...NO_DEMAND, activeSessions: 2 }
const RECENT_FAILURE: StreamDemandEvidence = { ...NO_DEMAND, lastStreamFailureAt: NOW - 60_000 }

describe('observeStreamPipeline', () => {
  it('MediaMTX ready => ONLINE (con o sin lectores)', () => {
    expect(observeStreamPipeline(MTX_READY, NO_DEMAND, NOW).observation).toBe('ONLINE')
    expect(observeStreamPipeline({ ...MTX_READY, readers: 0 }, NO_DEMAND, NOW).observation).toBe('ONLINE')
  })

  // Caso REAL de producción: SOURCE_NOT_READY con demanda (start-stream falló) => OFFLINE.
  it('SOURCE_NOT_READY con demanda (fallo reciente de start-stream) => OFFLINE', () => {
    const r = observeStreamPipeline(MTX_NOT_READY, RECENT_FAILURE, NOW)
    expect(r.observation).toBe('OFFLINE')
    expect(r.reason).toBe('source_not_ready_with_demand')
  })

  it('SOURCE_NOT_READY con sesiones activas => OFFLINE', () => {
    expect(observeStreamPipeline(MTX_NOT_READY, WITH_SESSIONS, NOW).observation).toBe('OFFLINE')
  })

  // El escenario que causaría 140 falsos positivos: path on-demand OCIOSO.
  it('SOURCE_NOT_READY SIN demanda => UNKNOWN (on-demand ocioso, benigno)', () => {
    const r = observeStreamPipeline(MTX_NOT_READY, NO_DEMAND, NOW)
    expect(r.observation).toBe('UNKNOWN')
    expect(r.reason).toBe('idle_on_demand')
  })

  it('viewer se fue tras éxito (fallo viejo < éxito) => UNKNOWN, no OFFLINE', () => {
    const demand: StreamDemandEvidence = {
      activeSessions: 0,
      lastStreamFailureAt: NOW - 120_000,
      lastStreamSuccessAt: NOW - 60_000,   // el ÚLTIMO evento fue un éxito
      lastHlsSuccessAt: NOW - 60_000,
    }
    expect(observeStreamPipeline(MTX_NOT_READY, demand, NOW).observation).toBe('UNKNOWN')
  })

  it('fallo fuera de la ventana de demanda => UNKNOWN', () => {
    const demand = { ...NO_DEMAND, lastStreamFailureAt: NOW - DEFAULT_DEMAND_WINDOW_MS - 1000 }
    expect(observeStreamPipeline(MTX_NOT_READY, demand, NOW).observation).toBe('UNKNOWN')
  })

  it('path sin configurar: OFFLINE sólo con demanda', () => {
    expect(observeStreamPipeline(MTX_MISSING, RECENT_FAILURE, NOW).observation).toBe('OFFLINE')
    expect(observeStreamPipeline(MTX_MISSING, RECENT_FAILURE, NOW).reason).toBe('path_missing_with_demand')
    expect(observeStreamPipeline(MTX_MISSING, NO_DEMAND, NOW).observation).toBe('UNKNOWN')
  })

  it('API de MediaMTX caída => UNKNOWN siempre (jamás falso positivo)', () => {
    expect(observeStreamPipeline(MTX_API_DOWN, WITH_SESSIONS, NOW).observation).toBe('UNKNOWN')
    expect(observeStreamPipeline(MTX_API_DOWN, RECENT_FAILURE, NOW).observation).toBe('UNKNOWN')
  })
})

// ── Integración con el debounce: creación, dedup y recuperación ──────────────
describe('CAMERA_STREAM_ERROR end-to-end con reloj simulado', () => {
  function cycle(state: DebounceState, mtx: MediaMtxRuntimeSnapshot, demand: StreamDemandEvidence, now: number) {
    const obs = observeStreamPipeline(mtx, demand, now)
    return { obs, step: stepDebounce(state, obs.observation, now, DEFAULT_DEBOUNCE) }
  }

  it('InputProxy ONLINE + SOURCE_NOT_READY repetido con demanda => confirma UNA VEZ y recupera con READY', () => {
    let state = initialDebounceState()
    let now = NOW
    const actions: string[] = []
    // 4 ciclos fallando con demanda (el 4º no debe re-confirmar → dedup)
    for (let i = 0; i < 4; i++) {
      now += 60_000
      const { step } = cycle(state, MTX_NOT_READY, { ...NO_DEMAND, lastStreamFailureAt: now - 30_000 }, now)
      state = step.state
      actions.push(step.action)
    }
    expect(actions.filter(a => a === 'confirm_offline')).toHaveLength(1)   // creación única
    expect(state.phase).toBe('OFFLINE_CONFIRMED')
    // Recuperación: MediaMTX vuelve READY (2 ciclos)
    for (let i = 0; i < 2; i++) {
      now += 60_000
      const { step } = cycle(state, MTX_READY, NO_DEMAND, now)
      state = step.state
      actions.push(step.action)
    }
    expect(actions.filter(a => a === 'recover')).toHaveLength(1)
    expect(state.phase).toBe('ONLINE')
  })

  it('UNKNOWN (ocioso o API caída) intercalado nunca genera falsos positivos', () => {
    let state = initialDebounceState()
    let now = NOW
    const actions: string[] = []
    const cases: Array<[MediaMtxRuntimeSnapshot, StreamDemandEvidence]> = [
      [MTX_NOT_READY, NO_DEMAND],   // ocioso
      [MTX_API_DOWN, WITH_SESSIONS],// API caída
      [MTX_NOT_READY, NO_DEMAND],
      [MTX_API_DOWN, NO_DEMAND],
      [MTX_NOT_READY, NO_DEMAND],
    ]
    for (const [mtx, demand] of cases) {
      now += 60_000
      const { step } = cycle(state, mtx, demand, now)
      state = step.state
      actions.push(step.action)
    }
    expect(actions.every(a => a === 'none')).toBe(true)
    expect(state.phase).toBe('ONLINE')
  })
})
