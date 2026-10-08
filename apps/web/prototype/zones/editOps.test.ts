import { describe, it, expect } from 'vitest'
import { ZONES } from '../sim/mock'
import { newPolygon, rescale, resetPolygon, toCanvasPolygons, toZoneDefs, undoLastPoint } from './editOps'

const W = 800, H = 450

describe('operaciones del editor de zonas', () => {
  it('ida y vuelta 0–1 → píxeles → 0–1 conserva las zonas guardadas', () => {
    const polys = toCanvasPolygons('cam-a4', ZONES['cam-a4'], W, H)
    expect(polys[0].points[0]).toEqual([40, 225])
    expect(toZoneDefs(polys, W, H)).toEqual(ZONES['cam-a4'])
  })

  it('deshacer quita el ÚLTIMO punto agregado (mayor pointsOrder), no el último del arreglo', () => {
    const p = { ...newPolygon('c', 'zone', []), points: [[0, 0], [10, 0], [5, 5], [0, 10]], pointsOrder: [1, 2, 4, 3], isFinished: true }
    const [after] = undoLastPoint([p], 0)
    expect(after.points).toEqual([[0, 0], [10, 0], [0, 10]])
    expect(after.pointsOrder).toEqual([1, 2, 3])
    expect(after.isFinished).toBe(true) // tenía 4 puntos
    const [again] = undoLastPoint([after], 0)
    expect(again.isFinished).toBe(false) // con 3 puntos deja de estar cerrado
  })

  it('deshacer/reiniciar sin polígono activo no cambian nada', () => {
    const polys = toCanvasPolygons('cam-a1', ZONES['cam-a1'], W, H)
    expect(undoLastPoint(polys, undefined)).toBe(polys)
    expect(resetPolygon(polys, undefined)).toBe(polys)
    expect(resetPolygon(polys, 0)[0]).toMatchObject({ points: [], isFinished: false })
  })

  it('al reescalar (PC → tablet) los puntos relativos no cambian', () => {
    const polys = toCanvasPolygons('cam-a1', ZONES['cam-a1'], W, H)
    const half = rescale(polys, { w: W, h: H }, { w: 400, h: 225 })
    expect(toZoneDefs(half, 400, 225)).toEqual(ZONES['cam-a1'])
  })

  it('no se guardan polígonos sin cerrar ni con menos de 3 puntos', () => {
    const open = { ...newPolygon('c', 'zone', []), points: [[0, 0], [10, 0], [10, 10]], pointsOrder: [1, 2, 3], isFinished: false }
    expect(toZoneDefs([open], W, H)).toEqual([])
  })

  it('nombres nuevos por tipo', () => {
    const z1 = newPolygon('c', 'zone', [])
    expect(z1.name).toBe('zona_1')
    expect(newPolygon('c', 'zone', [z1]).name).toBe('zona_2')
    expect(newPolygon('c', 'motion_mask', [z1]).name).toBe('mascara_1')
  })
})
