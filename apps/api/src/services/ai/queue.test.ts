import { describe, expect, it } from 'vitest'
import { BoundedQueue, type QueueDropReason } from './queue'

describe('BoundedQueue', () => {
  it('respeta el límite por clave (backpressure KEY_FULL)', () => {
    const q = new BoundedQueue<number>({ maxPerKey: 2, maxTotal: 100 })
    expect(q.enqueue('cam-1', 1).accepted).toBe(true)
    expect(q.enqueue('cam-1', 2).accepted).toBe(true)
    expect(q.enqueue('cam-1', 3)).toEqual({ accepted: false, reason: 'KEY_FULL' })
    // otra clave sigue teniendo cupo
    expect(q.enqueue('cam-2', 9).accepted).toBe(true)
  })

  it('respeta el límite total (TOTAL_FULL)', () => {
    const q = new BoundedQueue<number>({ maxPerKey: 100, maxTotal: 2 })
    q.enqueue('a', 1); q.enqueue('b', 2)
    expect(q.enqueue('c', 3)).toEqual({ accepted: false, reason: 'TOTAL_FULL' })
  })

  it('FIFO y contadores por clave decrementan al drenar', () => {
    const q = new BoundedQueue<string>({ maxPerKey: 5, maxTotal: 5 })
    q.enqueue('cam', 'a'); q.enqueue('cam', 'b')
    expect(q.sizeForKey('cam')).toBe(2)
    expect(q.dequeue()).toEqual({ key: 'cam', item: 'a' })
    expect(q.dequeue()).toEqual({ key: 'cam', item: 'b' })
    expect(q.sizeForKey('cam')).toBe(0)
    expect(q.dequeue()).toBeNull()
  })

  it('invoca onDrop con la razón', () => {
    const drops: QueueDropReason[] = []
    const q = new BoundedQueue<number>({ maxPerKey: 1, maxTotal: 1, onDrop: (_k, r) => drops.push(r) })
    q.enqueue('cam', 1)
    q.enqueue('cam', 2)   // TOTAL_FULL (total=1)
    expect(drops).toEqual(['TOTAL_FULL'])
  })

  it('no crece sin límite bajo un pico (memoria acotada)', () => {
    const q = new BoundedQueue<number>({ maxPerKey: 10, maxTotal: 10 })
    let accepted = 0
    for (let i = 0; i < 1000; i++) if (q.enqueue('cam', i).accepted) accepted++
    expect(accepted).toBe(10)
    expect(q.size).toBe(10)
  })
})
