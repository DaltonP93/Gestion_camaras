// apps/api/src/services/ai/queue.ts
//
// Cola acotada con backpressure para la base de IA (C22, Hito 5). Límite por
// clave (cámara) y global: al llenarse RECHAZA lo nuevo (drop-newest) en vez de
// crecer sin límite. Así un pico de detecciones nunca agota memoria ni bloquea
// el video. FIFO en el drenaje.

export type QueueDropReason = 'KEY_FULL' | 'TOTAL_FULL'

export interface EnqueueResult {
  accepted: boolean
  reason?: QueueDropReason
}

export interface BoundedQueueOptions {
  maxPerKey: number
  maxTotal: number
  onDrop?: (key: string, reason: QueueDropReason) => void
}

export class BoundedQueue<T> {
  private readonly q: Array<{ key: string; item: T }> = []
  private readonly perKey = new Map<string, number>()

  constructor(private readonly opts: BoundedQueueOptions) {}

  get size(): number { return this.q.length }
  sizeForKey(key: string): number { return this.perKey.get(key) ?? 0 }

  enqueue(key: string, item: T): EnqueueResult {
    if (this.q.length >= this.opts.maxTotal) {
      this.opts.onDrop?.(key, 'TOTAL_FULL')
      return { accepted: false, reason: 'TOTAL_FULL' }
    }
    if ((this.perKey.get(key) ?? 0) >= this.opts.maxPerKey) {
      this.opts.onDrop?.(key, 'KEY_FULL')
      return { accepted: false, reason: 'KEY_FULL' }
    }
    this.q.push({ key, item })
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1)
    return { accepted: true }
  }

  dequeue(): { key: string; item: T } | null {
    const entry = this.q.shift()
    if (!entry) return null
    const next = (this.perKey.get(entry.key) ?? 1) - 1
    if (next <= 0) this.perKey.delete(entry.key)
    else this.perKey.set(entry.key, next)
    return entry
  }

  clear(): void {
    this.q.length = 0
    this.perKey.clear()
  }
}
