// apps/api/src/services/metrics.ts
// Registro de métricas mínimo y sin dependencias, con exposición en formato
// texto Prometheus. Cubre contadores (monótonos) y gauges (valor instantáneo),
// más "collectors" dinámicos que se evalúan en cada scrape de /metrics.
//
// Se eligió una implementación propia (sin prom-client) para no agregar una
// dependencia; el formato de salida es el estándar de Prometheus.

type Labels = Record<string, string>

function fmtLabels(labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return ''
  const inner = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .join(',')
  return `{${inner}}`
}

class Series {
  readonly values = new Map<string, { labels: Labels; value: number }>()
  add(labels: Labels | undefined, delta: number): void {
    const key = fmtLabels(labels)
    const cur = this.values.get(key)
    if (cur) cur.value += delta
    else this.values.set(key, { labels: labels ?? {}, value: delta })
  }
  set(labels: Labels | undefined, value: number): void {
    this.values.set(fmtLabels(labels), { labels: labels ?? {}, value })
  }
}

export class Counter {
  private s = new Series()
  constructor(readonly name: string, readonly help: string) {}
  inc(labels?: Labels, value = 1): void { this.s.add(labels, value) }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const { labels, value } of this.s.values.values()) {
      lines.push(`${this.name}${fmtLabels(labels)} ${value}`)
    }
    if (this.s.values.size === 0) lines.push(`${this.name} 0`)
    return lines.join('\n')
  }
}

export class Gauge {
  private s = new Series()
  constructor(readonly name: string, readonly help: string) {}
  set(labels: Labels | undefined, value: number): void { this.s.set(labels, value) }
  reset(): void { this.s.values.clear() }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    for (const { labels, value } of this.s.values.values()) {
      lines.push(`${this.name}${fmtLabels(labels)} ${value}`)
    }
    if (this.s.values.size === 0) lines.push(`${this.name} 0`)
    return lines.join('\n')
  }
}

/**
 * Histograma Prometheus mínimo. Los buckets son acumulativos, como exige el
 * formato de exposición, y se separan por el conjunto exacto de labels.
 *
 * Se mantiene aquí —en vez de agregar prom-client— para que las latencias del
 * pipeline de video usen el mismo registro liviano que el resto del API.
 */
export class Histogram {
  private readonly series = new Map<string, {
    labels: Labels
    count: number
    sum: number
    buckets: number[]
  }>()

  readonly buckets: readonly number[]

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: readonly number[],
  ) {
    const normalized = Array.from(new Set(buckets))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
    if (normalized.length === 0) throw new Error('Histogram requires at least one finite bucket')
    this.buckets = normalized
  }

  observe(labels: Labels | undefined, value: number): void {
    if (!Number.isFinite(value)) return
    const key = fmtLabels(labels)
    let current = this.series.get(key)
    if (!current) {
      current = { labels: labels ?? {}, count: 0, sum: 0, buckets: this.buckets.map(() => 0) }
      this.series.set(key, current)
    }
    current.count += 1
    current.sum += value
    this.buckets.forEach((upper, index) => {
      if (value <= upper) current!.buckets[index] += 1
    })
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    if (this.series.size === 0) {
      lines.push(`${this.name}_bucket{le="+Inf"} 0`)
      lines.push(`${this.name}_sum 0`)
      lines.push(`${this.name}_count 0`)
      return lines.join('\n')
    }
    for (const current of this.series.values()) {
      this.buckets.forEach((upper, index) => {
        lines.push(`${this.name}_bucket${fmtLabels({ ...current.labels, le: String(upper) })} ${current.buckets[index]}`)
      })
      lines.push(`${this.name}_bucket${fmtLabels({ ...current.labels, le: '+Inf' })} ${current.count}`)
      lines.push(`${this.name}_sum${fmtLabels(current.labels)} ${current.sum}`)
      lines.push(`${this.name}_count${fmtLabels(current.labels)} ${current.count}`)
    }
    return lines.join('\n')
  }
}

// ─── Métricas del dominio ───────────────────────────────────────────
export const analyticsEventsTotal = new Counter(
  'visioncore_analytics_events_total', 'Eventos de analítica recibidos por el API, por tipo')
export const analyticsEventsRejectedTotal = new Counter(
  'visioncore_analytics_events_rejected_total', 'Eventos de analítica rechazados por el API')
export const analyticsAlertsCreatedTotal = new Counter(
  'visioncore_analytics_alerts_created_total', 'Alertas creadas a partir de eventos de analítica')
export const liveTranscodeStartupTotal = new Counter(
  'visioncore_live_transcode_startup_total',
  'Arranques de transcodificacion HD observados, por desenlace')
export const liveTranscodeHlsReadySeconds = new Histogram(
  'visioncore_live_transcode_hls_ready_seconds',
  'Tiempo desde el spawn de FFmpeg hasta el resultado de preparacion HLS',
  [1, 2, 3, 5, 7, 10, 15, 30, 60],
)
// C22 · desglose por etapa del arranque de LiveView. Cardinalidad ACOTADA:
// labels {stage, outcome} de conjuntos fijos (ver live-startup-timing.ts).
// NUNCA se usan cameraId/userId/token/URI como labels.
export const liveStartupStageSeconds = new Histogram(
  'visioncore_live_startup_stage_seconds',
  'Duracion por etapa del arranque de LiveView, por etapa (stage) y desenlace (outcome)',
  [0.1, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 15, 30, 60],
)

const counters: Counter[] = [
  analyticsEventsTotal,
  analyticsEventsRejectedTotal,
  analyticsAlertsCreatedTotal,
  liveTranscodeStartupTotal,
]
const histograms: Histogram[] = [liveTranscodeHlsReadySeconds, liveStartupStageSeconds]

// Gauges dinámicos: se completan en cada scrape vía collectors registrados.
type Collector = () => Promise<Gauge[]> | Gauge[]
const collectors: Collector[] = []
export function registerMetricsCollector(c: Collector): void { collectors.push(c) }

export async function renderMetrics(): Promise<string> {
  const blocks: string[] = [
    ...counters.map(c => c.render()),
    ...histograms.map(h => h.render()),
  ]
  for (const collect of collectors) {
    try {
      const gauges = await collect()
      for (const g of gauges) blocks.push(g.render())
    } catch { /* un collector caído no debe romper el scrape */ }
  }
  return blocks.join('\n\n') + '\n'
}
