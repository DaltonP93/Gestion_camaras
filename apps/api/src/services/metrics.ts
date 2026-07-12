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

// ─── Métricas del dominio ───────────────────────────────────────────
export const analyticsEventsTotal = new Counter(
  'visioncore_analytics_events_total', 'Eventos de analítica recibidos por el API, por tipo')
export const analyticsEventsRejectedTotal = new Counter(
  'visioncore_analytics_events_rejected_total', 'Eventos de analítica rechazados por el API')
export const analyticsAlertsCreatedTotal = new Counter(
  'visioncore_analytics_alerts_created_total', 'Alertas creadas a partir de eventos de analítica')

const counters: Counter[] = [analyticsEventsTotal, analyticsEventsRejectedTotal, analyticsAlertsCreatedTotal]

// Gauges dinámicos: se completan en cada scrape vía collectors registrados.
type Collector = () => Promise<Gauge[]> | Gauge[]
const collectors: Collector[] = []
export function registerMetricsCollector(c: Collector): void { collectors.push(c) }

export async function renderMetrics(): Promise<string> {
  const blocks: string[] = counters.map(c => c.render())
  for (const collect of collectors) {
    try {
      const gauges = await collect()
      for (const g of gauges) blocks.push(g.render())
    } catch { /* un collector caído no debe romper el scrape */ }
  }
  return blocks.join('\n\n') + '\n'
}
