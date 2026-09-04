// apps/api/src/routes/metrics.ts
// Endpoint /metrics (Prometheus). Protegido por METRICS_TOKEN opcional:
//   - si METRICS_TOKEN está definido, requiere Authorization: Bearer <token>
//     o ?token=<token>.
//   - si NO está definido, se asume red interna (scrape sin auth) y se advierte.
// Nunca expone secretos ni URLs RTSP: solo conteos y estados agregados.
import type { FastifyPluginAsync } from 'fastify'
import {
  renderMetrics, registerMetricsCollector, Gauge,
  analyticsAlertsCreatedTotal,
} from '../services/metrics'
import { getStreamConsumerRegistry } from '../services/stream-consumer-registry'
import { getRecordingsMetrics } from './recordings'
import { getTranscodeSlots } from '../services/stream-manager'
import { timingSafeEqualHex, sha256Hex } from '../services/media/media-grants'

const METRICS_TOKEN = process.env.METRICS_TOKEN || ''
const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://analytics:8500'

let collectorsRegistered = false

function registerCollectorsOnce(): void {
  if (collectorsRegistered) return
  collectorsRegistered = true

  // Consumidores de MediaMTX por tipo (desde el StreamConsumerRegistry).
  registerMetricsCollector(async () => {
    const g = new Gauge('visioncore_mediamtx_consumers', 'Consumidores activos de paths de MediaMTX por tipo')
    const consumers = await getStreamConsumerRegistry().list()
    const byType = new Map<string, number>()
    for (const c of consumers) byType.set(c.consumerType, (byType.get(c.consumerType) ?? 0) + 1)
    for (const t of ['live', 'analytics', 'recording', 'diagnostic']) g.set({ type: t }, byType.get(t) ?? 0)
    return [g]
  })

  // Sesiones de grabaciones (preview streaming + generación VOD).
  registerMetricsCollector(() => {
    const m = getRecordingsMetrics()
    const preview = new Gauge('visioncore_recordings_preview_sessions', 'Sesiones de preview de grabaciones activas')
    const vod = new Gauge('visioncore_recordings_vod_sessions', 'Sesiones de generación/descarga MP4 activas')
    preview.set(undefined, m.previewSessions)
    vod.set(undefined, m.vodSessions)
    return [preview, vod]
  })

  // Capacidad de transcodificación de LiveView. `activeProcessCount` incluye
  // procesos retenidos porque también ocupan un slot físico; así el tablero no
  // puede afirmar que hay cupo cuando FFmpeg todavía lo consume.
  registerMetricsCollector(() => {
    const slots = getTranscodeSlots()
    const capacity = new Gauge('visioncore_live_transcode_capacity', 'Capacidad maxima de FFmpeg para LiveView')
    const active = new Gauge('visioncore_live_transcode_processes', 'Procesos FFmpeg que ocupan capacidad de LiveView')
    const available = new Gauge('visioncore_live_transcode_available', 'Cupos de transcodificacion LiveView disponibles')
    const starting = new Gauge('visioncore_live_transcode_starting', 'Transcodificaciones esperando HLS')
    const retained = new Gauge('visioncore_live_transcode_retained', 'Procesos transcodificados retenidos sin sesion activa')
    capacity.set(undefined, slots.maxTranscodes)
    active.set(undefined, slots.activeProcessCount)
    available.set(undefined, Math.max(0, slots.maxTranscodes - slots.activeProcessCount))
    starting.set(undefined, slots.startingCount)
    retained.set(undefined, slots.retainedCount)
    return [capacity, active, available, starting, retained]
  })

  // Estado del servicio de analítica (best-effort, timeout corto).
  registerMetricsCollector(async () => {
    const workers = new Gauge('visioncore_analytics_workers', 'Workers de analítica por estado')
    const frames = new Gauge('visioncore_analytics_frames_processed', 'Frames procesados por worker (acumulado)')
    const sent = new Gauge('visioncore_analytics_events_sent', 'Eventos enviados por worker (acumulado)')
    const up = new Gauge('visioncore_analytics_up', 'Servicio de analítica alcanzable (1) o no (0)')
    try {
      const res = await fetch(`${ANALYTICS_URL}/status`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) { up.set(undefined, 0); return [up] }
      const s = (await res.json()) as { workers?: Array<{ status: string; framesProcessed?: number; eventsSent?: number }> }
      up.set(undefined, 1)
      const byStatus = new Map<string, number>()
      let totalFrames = 0, totalSent = 0
      for (const w of s.workers ?? []) {
        byStatus.set(w.status, (byStatus.get(w.status) ?? 0) + 1)
        totalFrames += w.framesProcessed ?? 0
        totalSent += w.eventsSent ?? 0
      }
      for (const [st, n] of byStatus) workers.set({ status: st }, n)
      frames.set(undefined, totalFrames)
      sent.set(undefined, totalSent)
      return [up, workers, frames, sent]
    } catch {
      up.set(undefined, 0)
      return [up]
    }
  })
}

export const metricsRoutes: FastifyPluginAsync = async (server) => {
  registerCollectorsOnce()
  if (!METRICS_TOKEN) {
    server.log.warn('[metrics] METRICS_TOKEN no definido — /metrics abierto (asume red interna)')
  }

  server.get('/metrics', async (request, reply) => {
    if (METRICS_TOKEN) {
      const auth = request.headers.authorization || ''
      const q = (request.query as { token?: string })?.token || ''
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : q
      // Comparación timing-safe con longitudes normalizadas (sha256 hex de 64
      // chars): evita el canal lateral de tiempo de `!==`. Comportamiento
      // idéntico: token vacío ⇒ no se entra aquí (red interna); match ⇒ pasa.
      if (!timingSafeEqualHex(sha256Hex(provided), sha256Hex(METRICS_TOKEN))) {
        return reply.status(401).type('text/plain').send('unauthorized')
      }
    }
    const body = await renderMetrics()
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body)
  })
}

// Reexport para instrumentar desde otros módulos sin acoplarlos a la ruta.
export { analyticsAlertsCreatedTotal }
