// apps/api/src/routes/aiDemo.ts
//
// Ruta de DEMOSTRACIÓN de la base de IA (C22, Hito 5). Recibe eventos de prueba
// DETERMINISTAS (no detección real) y los expone en un buffer reciente. Sirve
// para validar el contrato de extremo a extremo SIN un modelo productivo. Todo
// detrás de `AI_EVENTS_ENABLED` (apagado por defecto): con la flag apagada las
// rutas responden 404 y el API se comporta idéntico a C21.
//
// No afirma que exista detección real: los eventos se marcan `source: 'demo'`.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AI_CONTRACT_VERSION, type AiEventType, type AiObjectClass } from '../services/ai/contracts'

const AI_EVENTS_ENABLED = process.env.AI_EVENTS_ENABLED === 'true'
const RECENT_MAX = 50

const demoEventSchema = z.object({
  cameraId: z.string().min(1).max(128),
  type: z.enum(['person', 'vehicle', 'zone_intrusion', 'line_crossing', 'loitering', 'occupancy_limit']),
  className: z.enum(['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'unknown']),
  confidence: z.number().min(0).max(1),
  trackId: z.number().int().optional(),
  occurredAt: z.number().int().optional(),
})

export interface DemoEvent {
  contractVersion: typeof AI_CONTRACT_VERSION
  source: 'demo'
  eventId: string
  cameraId: string
  type: AiEventType
  className: AiObjectClass
  confidence: number
  trackId?: number
  occurredAt: number
}

// ── helpers puros (testeables sin servidor) ──────────────────────────
export function buildDemoEvent(
  input: z.infer<typeof demoEventSchema>,
  now: number,
  id: string,
): DemoEvent {
  return {
    contractVersion: AI_CONTRACT_VERSION,
    source: 'demo',
    eventId: id,
    cameraId: input.cameraId,
    type: input.type,
    className: input.className,
    confidence: input.confidence,
    trackId: input.trackId,
    occurredAt: input.occurredAt ?? now,
  }
}

/** Buffer circular en memoria de eventos demo (por proceso). */
export class RecentRing<T> {
  private readonly items: T[] = []
  constructor(private readonly max: number) {}
  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max)
  }
  recent(): T[] { return [...this.items].reverse() }
  get size(): number { return this.items.length }
}

export const aiDemoRoutes: FastifyPluginAsync = async (server) => {
  const ring = new RecentRing<DemoEvent>(RECENT_MAX)
  let counter = 0

  // P0-5 · aislamiento: la demo es estrictamente ADMIN (que tiene acceso a todas
  // las cámaras). Sin esto, un usuario podía leer eventos demo de otra cámara.
  server.post('/demo/event', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    if (!AI_EVENTS_ENABLED) return reply.status(404).send({ code: 'AI_EVENTS_DISABLED' })
    const input = demoEventSchema.parse(request.body)
    const event = buildDemoEvent(input, Date.now(), `demo_${++counter}`)
    ring.push(event)
    server.log.info(`ai_demo_event cam=${event.cameraId.slice(0, 8)} type=${event.type} src=demo`)
    return reply.send({ accepted: true, event })
  })

  server.get('/demo/recent', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    if (!AI_EVENTS_ENABLED) return reply.status(404).send({ code: 'AI_EVENTS_DISABLED' })
    const { cameraId } = request.query as { cameraId?: string }
    const events = cameraId ? ring.recent().filter((e) => e.cameraId === cameraId) : ring.recent()
    return reply.send({ source: 'demo', events })
  })
}
