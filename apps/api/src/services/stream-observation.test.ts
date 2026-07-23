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

// ═══ Paths EFECTIVOS (P1 falsos positivos por path equivocado) ═══════════════
import {
  observeCameraPaths, applyProbeResult, selectProbeTargets,
  type DemandedPathState, type CameraDemandEvidence,
} from './stream-observation'

const P = (over: Partial<DemandedPathState>): DemandedPathState => ({
  path: 'nvr_x_ch09_sub', streamType: 'sub', sessions: 0,
  configured: true, runtimeFound: true, ready: false,
  bytesReceived: 0, readers: 0, bytesProgressed: null, ...over,
})
const D = (over: Partial<CameraDemandEvidence>): CameraDemandEvidence => ({
  activeSessions: 0, lastStreamFailureAt: null, lastStreamStartAcceptedAt: null, lastHlsSuccessAt: null, ...over,
})

describe('observeCameraPaths — paths efectivos', () => {
  // TEST 11.1 — sub falla + main reproduce => ONLINE degradado, sin CAMERA_STREAM_ERROR.
  it('sub caído + main entregando (fallback) => ONLINE + degraded, jamás OFFLINE', () => {
    const paths = [
      P({ path: 'nvr_x_ch09_main', streamType: 'main', sessions: 1, ready: true, bytesReceived: 90_000, readers: 1, bytesProgressed: true }),
    ]
    const r = observeCameraPaths(paths, D({ activeSessions: 1 }), /*subKnownDown*/ true, NOW)
    expect(r.observation).toBe('ONLINE')
    expect(r.degraded).toBe(true)
    expect(r.reason).toBe('delivering_via_fallback')
  })

  // TEST 11.2 — main_h264 reproduce => sin CAMERA_STREAM_ERROR (caso Salida UTI).
  it('main_h264 entregando (Salida UTI real) => ONLINE aunque el _sub no esté ready', () => {
    const paths = [
      P({ path: 'nvr_x_ch09_main_h264', streamType: 'main_h264', sessions: 1, ready: true, bytesReceived: 50_000, readers: 1, bytesProgressed: true }),
      P({ path: 'nvr_x_ch09_sub', streamType: 'sub', sessions: 0, ready: false }),
    ]
    const r = observeCameraPaths(paths, D({ activeSessions: 1 }), false, NOW)
    expect(r.observation).toBe('ONLINE')
    expect(r.degraded).toBe(true)   // sub demandado-no-ready + fallback entregando
  })

  // TEST 11.4 — TODOS los paths efectivos fallan => OFFLINE (y con debounce, UNA alerta).
  it('todos los paths demandados fallan => OFFLINE; 3 ciclos => una sola confirmación', () => {
    const paths = [
      P({ path: 'nvr_x_ch09_main_h264', streamType: 'main_h264', sessions: 1, ready: false }),
      P({ path: 'nvr_x_ch09_sub', streamType: 'sub', sessions: 1, ready: false }),
    ]
    let state = initialDebounceState()
    const actions: string[] = []
    let now = NOW
    for (let i = 0; i < 4; i++) {
      now += 60_000
      const r = observeCameraPaths(paths, D({ activeSessions: 2 }), false, now)
      expect(r.observation).toBe('OFFLINE')
      const st = stepDebounce(state, r.observation, now, DEFAULT_DEBOUNCE)
      state = st.state
      actions.push(st.action)
    }
    expect(actions.filter(a => a === 'confirm_offline')).toHaveLength(1)
  })

  // TEST 11.5 — recuperación: el path efectivo vuelve a entregar => recover.
  it('recuperación del path efectivo resuelve (recover tras 2 ONLINE)', () => {
    let state = initialDebounceState()
    let now = NOW
    const failing = [P({ path: 'p', streamType: 'main_h264', sessions: 1, ready: false })]
    const okPaths = [P({ path: 'p', streamType: 'main_h264', sessions: 1, ready: true, bytesProgressed: true, readers: 1 })]
    const actions: string[] = []
    for (const paths of [failing, failing, failing, okPaths, okPaths]) {
      now += 60_000
      const r = observeCameraPaths(paths, D({ activeSessions: 1 }), false, now)
      const st = stepDebounce(state, r.observation, now, DEFAULT_DEBOUNCE)
      state = st.state; actions.push(st.action)
    }
    expect(actions.filter(a => a === 'recover')).toHaveLength(1)
  })

  // Req 9 — stream CONGELADO: ready con lectores pero bytes sin progresar.
  it('path ready con lectores y bytes SIN progresar = congelado => OFFLINE', () => {
    const paths = [P({ path: 'p', streamType: 'sub', sessions: 1, ready: true, readers: 2, bytesReceived: 1000, bytesProgressed: false })]
    const r = observeCameraPaths(paths, D({ activeSessions: 1 }), false, NOW)
    expect(r.observation).toBe('OFFLINE')
    expect(r.reason).toContain('frozen_stream')
  })
  it('path ready SIN lectores con bytes estancados NO es congelado (nadie consume)', () => {
    const paths = [P({ path: 'p', streamType: 'sub', ready: true, readers: 0, bytesProgressed: false })]
    expect(observeCameraPaths(paths, D({}), false, NOW).observation).toBe('ONLINE')
  })
})

describe('applyProbeResult — status=0 aislado (regla 6)', () => {
  const prior = { observation: 'OFFLINE' as const, reason: 'source_not_ready_with_demand' }
  // TEST 11.3 — status=0 aislado => UNKNOWN (no fuerza OFFLINE).
  it('status=0 sin evidencia adicional => UNKNOWN', () => {
    const r = applyProbeResult(prior, { playable: false, status: 0 }, { anyPathReady: true, hardStartFailure: false })
    expect(r.observation).toBe('UNKNOWN')
  })
  it('status=0 CON evidencia (no ready + start-stream fallido real) => OFFLINE', () => {
    const r = applyProbeResult(prior, { playable: false, status: 0 }, { anyPathReady: false, hardStartFailure: true })
    expect(r.observation).toBe('OFFLINE')
  })
  it('status HTTP real (500) no playable => OFFLINE; playable => ONLINE', () => {
    expect(applyProbeResult(prior, { playable: false, status: 500 }, { anyPathReady: false, hardStartFailure: false }).observation).toBe('OFFLINE')
    expect(applyProbeResult(prior, { playable: true, status: 200 }, { anyPathReady: false, hardStartFailure: false }).observation).toBe('ONLINE')
  })
})

describe('selectProbeTargets — fairness round-robin (TEST 11.6)', () => {
  it('con más cámaras que presupuesto, todas reciben sonda en ciclos sucesivos', () => {
    const cams = ['a', 'b', 'c', 'd', 'e', 'f']
    const last = new Map<string, number>()
    const probed = new Set<string>()
    let now = NOW
    for (let cycle = 0; cycle < 2; cycle++) {
      now += 60_000
      const targets = selectProbeTargets(cams, last, 3)
      expect(targets).toHaveLength(3)
      for (const t of targets) { last.set(t, now); probed.add(t) }
    }
    expect(probed.size).toBe(6)   // NO siempre las tres primeras
  })
  it('prioriza las nunca sondeadas y luego las más antiguas', () => {
    const last = new Map([['a', 100], ['b', 50]])
    expect(selectProbeTargets(['a', 'b', 'c'], last, 2)).toEqual(['c', 'b'])
  })
})

// Review Codex #116 (P1): un fallo viejo NO debe sobrevivir a una recuperación
// verificada por sonda (lastHlsSuccessAt posterior al fallo).
describe('observeCameraPaths — el fallo se retira tras recuperación HLS verificada', () => {
  it('fallo viejo + sonda exitosa posterior + path ocioso => UNKNOWN (no OFFLINE)', () => {
    const paths = [P({ path: 'p', streamType: 'sub', sessions: 0, ready: false })]
    const demand = D({
      activeSessions: 0,
      lastStreamFailureAt: NOW - 5 * 60_000,   // falló hace 5 min (dentro de ventana)
      lastHlsSuccessAt:    NOW - 2 * 60_000,   // …pero la sonda verificó entrega DESPUÉS
    })
    const r = observeCameraPaths(paths, demand, false, NOW)
    expect(r.observation).toBe('UNKNOWN')      // demanda retirada: no reclasificar OFFLINE
    expect(r.demandActive).toBe(false)
  })
  it('fallo POSTERIOR a la última entrega verificada sí mantiene la demanda', () => {
    const paths = [P({ path: 'p', streamType: 'sub', sessions: 0, ready: false })]
    const demand = D({
      lastHlsSuccessAt:    NOW - 5 * 60_000,
      lastStreamFailureAt: NOW - 2 * 60_000,   // volvió a fallar tras la recuperación
    })
    expect(observeCameraPaths(paths, demand, false, NOW).observation).toBe('OFFLINE')
  })
})
