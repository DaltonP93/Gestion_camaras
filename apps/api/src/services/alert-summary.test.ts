import { describe, it, expect } from 'vitest'
import { deriveAlertSummary, bucketAlertsByHour } from './alert-summary'

describe('deriveAlertSummary — semántica única (req 2)', () => {
  it('pending = unread + acknowledged; total = pending + resolved', () => {
    const s = deriveAlertSummary({ unread: 0, acknowledged: 3, resolved: 197, criticalPending: 0 })
    expect(s).toEqual({ unread: 0, acknowledged: 3, pending: 3, resolved: 197, total: 200, criticalPending: 0 })
  })

  // El caso exacto de las capturas: NO debe existir "200 activas" ni campana en 2.
  it('reproduce las cifras esperadas de la captura', () => {
    const s = deriveAlertSummary({ unread: 0, acknowledged: 3, resolved: 197, criticalPending: 0 })
    expect(s.unread).toBe(0)          // campana = 0
    expect(s.acknowledged).toBe(3)
    expect(s.pending).toBe(3)         // dashboard = 3 (no 200)
    expect(s.resolved).toBe(197)
    expect(s.total).toBe(200)
  })

  it('críticas pendientes se preservan', () => {
    const s = deriveAlertSummary({ unread: 5, acknowledged: 2, resolved: 10, criticalPending: 4 })
    expect(s.pending).toBe(7)
    expect(s.criticalPending).toBe(4)
  })

  it('nunca negativo', () => {
    const s = deriveAlertSummary({ unread: -1, acknowledged: -2, resolved: -3, criticalPending: -4 })
    expect(s).toEqual({ unread: 0, acknowledged: 0, pending: 0, resolved: 0, total: 0, criticalPending: 0 })
  })
})

describe('bucketAlertsByHour — serie real (req 9)', () => {
  const HOUR = 3_600_000
  const now = 1_700_000_000_000

  it('devuelve exactamente `hours` cubetas consecutivas alineadas a la hora', () => {
    const b = bucketAlertsByHour([], now, 24)
    expect(b).toHaveLength(24)
    for (let i = 1; i < b.length; i++) {
      expect(b[i].hourStartMs - b[i - 1].hourStartMs).toBe(HOUR)
    }
    // la última cubeta es la hora actual alineada
    expect(b[b.length - 1].hourStartMs).toBe(Math.floor(now / HOUR) * HOUR)
  })

  it('cuenta createdAt en su hora y descarta lo fuera de rango', () => {
    const currentHour = Math.floor(now / HOUR) * HOUR
    const list = [
      currentHour + 10,             // hora actual
      currentHour + 20,             // hora actual
      currentHour - HOUR + 5,       // hora anterior
      currentHour - 25 * HOUR,      // fuera de la ventana de 24h → descartado
      currentHour + 5 * HOUR,       // futuro → descartado
    ]
    const b = bucketAlertsByHour(list, now, 24)
    expect(b[b.length - 1].alerts).toBe(2)
    expect(b[b.length - 2].alerts).toBe(1)
    expect(b.reduce((a, x) => a + x.alerts, 0)).toBe(3)  // los 2 descartados no cuentan
  })

  it('ignora timestamps no finitos', () => {
    const b = bucketAlertsByHour([NaN, Infinity, now], now, 24)
    expect(b.reduce((a, x) => a + x.alerts, 0)).toBe(1)
  })
})
