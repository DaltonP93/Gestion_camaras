import { describe, expect, it } from 'vitest'
import { buildDemoEvent, RecentRing, type DemoEvent } from './aiDemo'

describe('buildDemoEvent', () => {
  it('marca source=demo y usa occurredAt provisto o now', () => {
    const e1 = buildDemoEvent({ cameraId: 'cam-1', type: 'person', className: 'person', confidence: 0.9 }, 5000, 'demo_1')
    expect(e1).toMatchObject({ source: 'demo', cameraId: 'cam-1', type: 'person', occurredAt: 5000, eventId: 'demo_1' })
    const e2 = buildDemoEvent({ cameraId: 'cam-1', type: 'vehicle', className: 'car', confidence: 0.7, occurredAt: 123 }, 5000, 'demo_2')
    expect(e2.occurredAt).toBe(123)
  })
})

describe('RecentRing', () => {
  it('conserva sólo los últimos N y devuelve del más reciente al más viejo', () => {
    const ring = new RecentRing<DemoEvent>(3)
    for (let i = 1; i <= 5; i++) {
      ring.push(buildDemoEvent({ cameraId: 'c', type: 'person', className: 'person', confidence: 0.5 }, i, `demo_${i}`))
    }
    expect(ring.size).toBe(3)
    expect(ring.recent().map(e => e.eventId)).toEqual(['demo_5', 'demo_4', 'demo_3'])
  })
})
