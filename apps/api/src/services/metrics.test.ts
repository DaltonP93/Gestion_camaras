// Tests del registro de métricas Prometheus (formato de exposición).
import { describe, it, expect } from 'vitest'
import { Counter, Gauge, renderMetrics, registerMetricsCollector } from './metrics'

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
