import { describe, it, expect } from 'vitest'
import { pickDeliveryTimestamp, formatAsuncionDateTime, isBackfilled } from './deliveryHistory'

describe('isBackfilled — distingue reconstruido de envío real (PR C)', () => {
  it('source=backfill → true', () => {
    expect(isBackfilled({ status: 'sent', source: 'backfill' })).toBe(true)
  })
  it('source=live → false', () => {
    expect(isBackfilled({ status: 'sent', source: 'live' })).toBe(false)
  })
  it('sin source (filas previas) → false', () => {
    expect(isBackfilled({ status: 'sent' })).toBe(false)
  })
})

describe('pickDeliveryTimestamp — los fallidos NO caen a "—" (P1)', () => {
  it('enviado usa sentAt', () => {
    expect(pickDeliveryTimestamp({ status: 'sent', sentAt: '2026-07-29T10:00:00Z', createdAt: '2026-07-29T09:59:00Z' }))
      .toEqual({ iso: '2026-07-29T10:00:00Z', kind: 'sent' })
  })
  it('fallido usa failedAt (no sentAt=null)', () => {
    expect(pickDeliveryTimestamp({ status: 'failed', sentAt: null, failedAt: '2026-07-29T10:05:00Z', createdAt: '2026-07-29T10:04:00Z' }))
      .toEqual({ iso: '2026-07-29T10:05:00Z', kind: 'failed' })
  })
  it('sin sentAt ni failedAt cae a attemptedAt', () => {
    expect(pickDeliveryTimestamp({ status: 'pending', attemptedAt: '2026-07-29T10:06:00Z', createdAt: '2026-07-29T10:05:00Z' }))
      .toEqual({ iso: '2026-07-29T10:06:00Z', kind: 'attempted' })
  })
  it('último recurso: createdAt (siempre presente)', () => {
    expect(pickDeliveryTimestamp({ status: 'failed', sentAt: null, createdAt: '2026-07-29T10:04:00Z' }))
      .toEqual({ iso: '2026-07-29T10:04:00Z', kind: 'created' })
  })
})

describe('formatAsuncionDateTime', () => {
  it('formatea fecha COMPLETA + hora (no sólo hora) en la TZ configurada', () => {
    const s = formatAsuncionDateTime('2026-07-29T13:14:35Z')
    // Debe incluir la fecha (dd/mm/yyyy) y una hora HH:MM:SS de 24h — el offset
    // exacto depende de la tzdata del entorno, así que no fijamos la hora puntual.
    expect(s).toMatch(/29\/07\/2026/)
    expect(s).toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(s).toContain(':14:35')   // minutos/segundos son estables entre offsets horarios
  })
  it('devuelve "—" para nulo o inválido', () => {
    expect(formatAsuncionDateTime(null)).toBe('—')
    expect(formatAsuncionDateTime('no-date')).toBe('—')
  })
})
