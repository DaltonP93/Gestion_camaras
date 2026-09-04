// Tests del registro de métricas Prometheus (formato de exposición).
import { describe, it, expect } from 'vitest'
import { Counter, Gauge, Histogram, renderMetrics, registerMetricsCollector } from './metrics'

describe('Counter', () => {
  it('acumula y renderiza con labels', () => {
    const c = new Counter('vc_test_total', 'ayuda')
    c.inc({ type: 'a' })
    c.inc({ type: 'a' })
    c.inc({ type: 'b' }, 3)
    const out = c.render()
    expect(out).toContain('# TYPE vc_test_total counter')
    expect(out).toContain('vc_test_total{type="a"} 2')
    expect(out).toContain('vc_test_total{type="b"} 3')
  })

  it('renderiza 0 cuando no hubo incrementos', () => {
    expect(new Counter('vc_empty_total', 'h').render()).toContain('vc_empty_total 0')
  })
})

describe('Gauge', () => {
  it('set reemplaza el valor por label', () => {
    const g = new Gauge('vc_gauge', 'h')
    g.set({ s: 'x' }, 5)
    g.set({ s: 'x' }, 9)
    expect(g.render()).toContain('vc_gauge{s="x"} 9')
  })

  it('escapa comillas y backslashes en labels', () => {
    const g = new Gauge('vc_g2', 'h')
    g.set({ msg: 'a"b\\c' }, 1)
    expect(g.render()).toContain('vc_g2{msg="a\\"b\\\\c"} 1')
  })
})

describe('Histogram', () => {
  it('renderiza buckets acumulativos, suma y conteo por labels', () => {
    const h = new Histogram('vc_seconds', 'latencia', [1, 5, 10])
    h.observe({ result: 'ready' }, 0.5)
    h.observe({ result: 'ready' }, 7)
    h.observe({ result: 'timeout' }, 12)

    const out = h.render()
    expect(out).toContain('# TYPE vc_seconds histogram')
    expect(out).toContain('vc_seconds_bucket{result="ready",le="1"} 1')
    expect(out).toContain('vc_seconds_bucket{result="ready",le="5"} 1')
    expect(out).toContain('vc_seconds_bucket{result="ready",le="10"} 2')
    expect(out).toContain('vc_seconds_bucket{result="ready",le="+Inf"} 2')
    expect(out).toContain('vc_seconds_sum{result="ready"} 7.5')
    expect(out).toContain('vc_seconds_count{result="timeout"} 1')
  })

  it('ignora valores no finitos y expone cero antes de observar', () => {
    const h = new Histogram('vc_empty_seconds', 'latencia', [1])
    h.observe(undefined, Number.NaN)
    const out = h.render()
    expect(out).toContain('vc_empty_seconds_bucket{le="+Inf"} 0')
    expect(out).toContain('vc_empty_seconds_count 0')
  })
})

describe('renderMetrics', () => {
  it('incluye collectors dinámicos y tolera collectors que fallan', async () => {
    registerMetricsCollector(() => {
      const g = new Gauge('vc_dyn', 'h'); g.set(undefined, 42); return [g]
    })
    registerMetricsCollector(() => { throw new Error('boom') })
    const out = await renderMetrics()
    expect(out).toContain('vc_dyn 42')
    expect(out.endsWith('\n')).toBe(true)
  })
})
