import { describe, it, expect } from 'vitest'
import { createQualitySwitchController, decideRequest, initialState, settle } from './qualitySwitchController'

describe('qualitySwitchController — un solo POST efectivo ante clics rápidos (P1)', () => {
  it('Alta→Trans→Trans→Baja: 3 POST (Trans repetido se ignora), sólo Baja queda vigente', () => {
    const c = createQualitySwitchController()
    const cam = 'camA'

    const d1 = c.request(cam, 'main')       // Alta
    const d2 = c.request(cam, 'main_h264')  // Trans (supersede Alta)
    const d3 = c.request(cam, 'main_h264')  // Trans repetido → ignorar
    const d4 = c.request(cam, 'sub')        // Baja (supersede Trans)

    expect(d1).toEqual({ action: 'proceed', seq: 1 })
    expect(d2).toEqual({ action: 'proceed', seq: 2 })
    expect(d3).toEqual({ action: 'ignore', reason: 'same-pending' })
    expect(d4).toEqual({ action: 'proceed', seq: 3 })

    // Sólo la última selección (Baja, seq 3) sigue vigente.
    expect(c.isCurrent(cam, 1)).toBe(false)
    expect(c.isCurrent(cam, 2)).toBe(false)
    expect(c.isCurrent(cam, 3)).toBe(true)
  })

  it('respuestas fuera de orden: sólo se aplica la de la última selección', () => {
    const c = createQualitySwitchController()
    const cam = 'camB'
    const s1 = (c.request(cam, 'main') as any).seq       // 1
    const s2 = (c.request(cam, 'main_h264') as any).seq  // 2

    // Llega primero la respuesta de la selección MÁS NUEVA...
    expect(c.isCurrent(cam, s2)).toBe(true)
    // ...y después, tardía, la de la selección vieja → debe descartarse.
    expect(c.isCurrent(cam, s1)).toBe(false)
  })

  it('mismo tipo repetido sin pendiente resuelto: settle libera el mutex', () => {
    const c = createQualitySwitchController()
    const cam = 'camC'
    const seq = (c.request(cam, 'main') as any).seq
    expect(c.isPending(cam)).toBe(true)
    c.settle(cam, seq)
    expect(c.isPending(cam)).toBe(false)
    // Tras liberar, el mismo tipo vuelve a poder solicitarse.
    expect(c.request(cam, 'main')).toEqual({ action: 'proceed', seq: seq + 1 })
  })

  it('cámaras distintas no comparten estado', () => {
    const c = createQualitySwitchController()
    c.request('cam1', 'main')
    expect(c.isPending('cam1')).toBe(true)
    expect(c.isPending('cam2')).toBe(false)
  })

  it('pendingQuality refleja la selección en vuelo', () => {
    const c = createQualitySwitchController()
    c.request('x', 'main_h264')
    expect(c.pendingQuality('x')).toBe('main_h264')
  })
})

describe('funciones puras', () => {
  it('decideRequest ignora el mismo tipo pendiente', () => {
    const s0 = initialState()
    const { state: s1 } = decideRequest(s0, 'main')
    const { decision } = decideRequest(s1, 'main')
    expect(decision).toEqual({ action: 'ignore', reason: 'same-pending' })
  })
  it('settle no limpia si seq ya no es vigente', () => {
    const s0 = initialState()
    const { state: s1 } = decideRequest(s0, 'main')       // seq 1
    const { state: s2 } = decideRequest(s1, 'main_h264')  // seq 2 vigente
    const after = settle(s2, 1)  // intentar resolver la vieja
    expect(after.pending).not.toBeNull()  // sigue pendiente la nueva
  })
})
