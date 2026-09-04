import { describe, expect, it } from 'vitest'
import { buildClientStartupReport } from './firstFrameTiming'

describe('buildClientStartupReport', () => {
  it('calcula manifiesto → primer frame en segundos', () => {
    expect(buildClientStartupReport('manifest_to_first_frame', 1000, 3500)).toEqual({
      stage: 'manifest_to_first_frame', seconds: 2.5, outcome: 'first_frame',
    })
  })

  it('soporta el tramo nativo con outcome explícito', () => {
    expect(buildClientStartupReport('native_start_to_first_frame', 0, 800, 'first_frame')).toMatchObject({
      stage: 'native_start_to_first_frame', seconds: 0.8,
    })
  })

  it('null si falta un timestamp o el tramo es negativo', () => {
    expect(buildClientStartupReport('manifest_to_first_frame', null, 3500)).toBeNull()
    expect(buildClientStartupReport('manifest_to_first_frame', 1000, undefined)).toBeNull()
    expect(buildClientStartupReport('manifest_to_first_frame', 5000, 4000)).toBeNull()
  })

  it('el reporte no incluye identificadores de alta cardinalidad', () => {
    const r = buildClientStartupReport('manifest_to_first_frame', 1000, 2000)!
    expect(Object.keys(r).sort()).toEqual(['outcome', 'seconds', 'stage'])
  })
})
