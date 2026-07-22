import { describe, it, expect } from 'vitest'
import {
  stepDebounce, initialDebounceState, DEFAULT_DEBOUNCE,
  isHardStreamFailure, streamReportToObservation,
  type DebounceState, type HealthObservation,
} from './camera-health-debounce'

// Reloj simulado: aplica una secuencia de observaciones con un paso de tiempo fijo
// y devuelve las acciones emitidas.
function run(seq: Array<{ obs: HealthObservation; dt?: number }>, cfg = DEFAULT_DEBOUNCE) {
  let state: DebounceState = initialDebounceState()
  let now = 1_000_000
  const actions: string[] = []
  for (const { obs, dt } of seq) {
    now += dt ?? 60_000   // por defecto 60s entre lecturas (intervalo del cron)
    const r = stepDebounce(state, obs, now, cfg)
    state = r.state
    actions.push(r.action)
  }
  return { state, actions }
}

describe('stepDebounce — debounce de offline', () => {
  // TEST 9.5 — endpoint caído: lecturas UNKNOWN NO crean alertas.
  it('UNKNOWN nunca confirma offline ni mueve contadores', () => {
    const { state, actions } = run(Array.from({ length: 10 }, () => ({ obs: 'UNKNOWN' as const })))
    expect(actions.every(a => a === 'none')).toBe(true)
    expect(state.phase).toBe('ONLINE')
    expect(state.offlineStreak).toBe(0)
  })

  // TEST 9.6 — tres fallos consecutivos: UNA sola confirmación.
  it('3 offline consecutivos => offline_pending y luego confirm_offline (una vez)', () => {
    const { actions, state } = run([{ obs: 'OFFLINE' }, { obs: 'OFFLINE' }, { obs: 'OFFLINE' }])
    expect(actions).toEqual(['offline_pending', 'none', 'confirm_offline'])
    expect(state.phase).toBe('OFFLINE_CONFIRMED')
    expect(state.confirmedAt).not.toBeNull()
  })

  // TEST 9.7 — siguiente ciclo offline: NO duplica.
  it('offline tras confirmar NO vuelve a emitir confirm', () => {
    const { actions } = run([
      { obs: 'OFFLINE' }, { obs: 'OFFLINE' }, { obs: 'OFFLINE' }, // confirm en la 3ª
      { obs: 'OFFLINE' }, { obs: 'OFFLINE' },                     // no debe reconfirmar
    ])
    expect(actions.filter(a => a === 'confirm_offline')).toHaveLength(1)
    expect(actions.slice(3)).toEqual(['none', 'none'])
  })

  it('confirma por TIEMPO (90s) aunque no haya 3 lecturas, con pasos de 60s', () => {
    // 2 lecturas offline separadas 60s → a la 2ª han pasado 60s (<90s) → aún pending;
    // 3ª lectura a 120s del 1er fallo → confirma por tiempo igualmente (>=90s).
    const cfg = { ...DEFAULT_DEBOUNCE, offlineConfirmChecks: 99 }  // desactiva el conteo
    const { actions } = run([{ obs: 'OFFLINE' }, { obs: 'OFFLINE' }, { obs: 'OFFLINE' }], cfg)
    expect(actions).toContain('confirm_offline')
  })

  // TEST 9.8 — dos éxitos consecutivos: resolver.
  it('2 online consecutivos tras confirmar => recover (una vez)', () => {
    const { actions, state } = run([
      { obs: 'OFFLINE' }, { obs: 'OFFLINE' }, { obs: 'OFFLINE' }, // confirm
      { obs: 'ONLINE' },                                          // 1er online → aún no
      { obs: 'ONLINE' },                                          // 2º online → recover
      { obs: 'ONLINE' },                                          // ya online → none
    ])
    expect(actions.filter(a => a === 'recover')).toHaveLength(1)
    expect(actions[3]).toBe('none')
    expect(actions[4]).toBe('recover')
    expect(actions[5]).toBe('none')
    expect(state.phase).toBe('ONLINE')
  })

  it('un solo offline aislado seguido de online NO crea alerta (sólo pending→reset)', () => {
    const { actions } = run([{ obs: 'OFFLINE' }, { obs: 'ONLINE' }, { obs: 'ONLINE' }])
    expect(actions).not.toContain('confirm_offline')
    expect(actions).not.toContain('recover')   // nunca se confirmó, no hay nada que resolver
  })

  it('UNKNOWN intercalado no reinicia la racha de offline', () => {
    const { actions } = run([
      { obs: 'OFFLINE' }, { obs: 'UNKNOWN' }, { obs: 'OFFLINE' }, { obs: 'UNKNOWN' }, { obs: 'OFFLINE' },
    ])
    // 3 offline reales (los UNKNOWN no cuentan ni reinician) => confirma en el 3er offline
    expect(actions.filter(a => a === 'confirm_offline')).toHaveLength(1)
  })
})

describe('isHardStreamFailure / streamReportToObservation (TASK 4 / TEST 9.10)', () => {
  it('razones blandas (cleanup/navegación/cierre) NO son fallo duro', () => {
    for (const r of ['url_cleared', 'effect_cleanup', 'cleanup', 'navigation', 'viewer_closed', 'no_consumers', 'user_stopped']) {
      expect(isHardStreamFailure(r)).toBe(false)
      expect(streamReportToObservation({ ok: false, reason: r })).toBe('UNKNOWN')
    }
  })
  it('un error real de HLS/RTSP SÍ es fallo duro => OFFLINE', () => {
    expect(isHardStreamFailure('MEDIAMTX_NOT_READY')).toBe(true)
    expect(streamReportToObservation({ ok: false, reason: 'hls_500' })).toBe('OFFLINE')
  })
  it('ok=true => ONLINE', () => {
    expect(streamReportToObservation({ ok: true })).toBe('ONLINE')
  })
})

// TEST 9.11 — cámara en mantenimiento (el healthWorker no debe alertar).
import { isCameraInMaintenance } from './camera-health-debounce'
describe('isCameraInMaintenance (TASK 6 / TEST 9.11)', () => {
  const now = 2_000_000
  it('maintenanceMode=true => en mantenimiento', () => {
    expect(isCameraInMaintenance({ maintenanceMode: true }, now)).toBe(true)
  })
  it('maintenanceUntil futuro => en mantenimiento; pasado => no', () => {
    expect(isCameraInMaintenance({ maintenanceUntil: new Date(now + 60_000) }, now)).toBe(true)
    expect(isCameraInMaintenance({ maintenanceUntil: new Date(now - 60_000) }, now)).toBe(false)
  })
  it('sin flags => no en mantenimiento', () => {
    expect(isCameraInMaintenance({}, now)).toBe(false)
    expect(isCameraInMaintenance({ maintenanceMode: false, maintenanceUntil: null }, now)).toBe(false)
  })
})
