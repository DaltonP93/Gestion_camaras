import { describe, expect, it } from 'vitest'
import {
  LiveStartupTimer,
  isBoundedStageLabels,
  LIVE_STARTUP_STAGES,
} from './live-startup-timing'
import { liveStartupStageSeconds } from './metrics'

describe('LiveStartupTimer', () => {
  it('mide tramos entre marcas con reloj inyectado', () => {
    let t = 1000
    const timer = new LiveStartupTimer(() => t)
    timer.mark('admission'); t = 1300
    timer.mark('spawn'); t = 6800
    timer.mark('hls_ready')
    expect(timer.measure('admission', 'spawn')).toBeCloseTo(0.3, 5)
    expect(timer.measure('spawn', 'hls_ready')).toBeCloseTo(5.5, 5)
  })

  it('null si falta una marca o el tramo es negativo', () => {
    let t = 5000
    const timer = new LiveStartupTimer(() => t)
    timer.mark('a'); t = 4000
    timer.mark('b')
    expect(timer.measure('a', 'b')).toBeNull()       // negativo
    expect(timer.measure('a', 'c')).toBeNull()       // marca faltante
  })

  it('observation construye {stage, seconds, outcome} o null', () => {
    let t = 0
    const timer = new LiveStartupTimer(() => t)
    timer.mark('spawn'); t = 5000
    timer.mark('ready')
    expect(timer.observation('spawn_to_hls_ready', 'spawn', 'ready', 'ready')).toEqual({
      stage: 'spawn_to_hls_ready', seconds: 5, outcome: 'ready',
    })
    expect(timer.observation('spawn_to_hls_ready', 'spawn', 'missing', 'ready')).toBeNull()
  })
})

describe('cardinalidad acotada de labels', () => {
  it('acepta sólo stage/outcome de los conjuntos fijos', () => {
    expect(isBoundedStageLabels({ stage: 'spawn_to_hls_ready', outcome: 'ready' })).toBe(true)
    expect(isBoundedStageLabels({ stage: 'spawn_to_hls_ready' })).toBe(true)
  })
  it('rechaza labels de alta cardinalidad (cameraId/userId/token)', () => {
    expect(isBoundedStageLabels({ cameraId: 'cam-1' })).toBe(false)
    expect(isBoundedStageLabels({ stage: 'spawn_to_hls_ready', userId: 'u1' })).toBe(false)
    expect(isBoundedStageLabels({ stage: 'no_existe' })).toBe(false)
    expect(isBoundedStageLabels({ outcome: 'no_existe' })).toBe(false)
  })
})

describe('histograma de etapas (cardinalidad en el render real)', () => {
  it('sólo emite labels stage/outcome; nunca cameraId/userId/token/URI', () => {
    for (const stage of LIVE_STARTUP_STAGES) {
      liveStartupStageSeconds.observe({ stage, outcome: 'ready' }, 1.23)
    }
    const out = liveStartupStageSeconds.render()
    expect(out).toContain('visioncore_live_startup_stage_seconds_bucket')
    expect(out).toContain('stage="spawn_to_hls_ready"')
    // Ningún identificador de alta cardinalidad ni URI aparece en el render.
    expect(out).not.toMatch(/cameraid|userid|token|rtsp|@/i)
  })
})
