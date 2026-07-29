import { describe, it, expect } from 'vitest'
import {
  alertStatusWhere, alertWhere, parseAlertStatus, parseAlertSeverity,
  parseAlertPage, parseAlertLimit,
} from './alert-query'

// Estas condiciones DEBEN coincidir exactamente con los conteos de /alerts/summary.
describe('alertStatusWhere (idéntico a summary)', () => {
  it('unread = resolved:false, readAt:null', () => {
    expect(alertStatusWhere('unread')).toEqual({ resolved: false, readAt: null })
  })
  it('acknowledged = resolved:false, readAt != null', () => {
    expect(alertStatusWhere('acknowledged')).toEqual({ resolved: false, readAt: { not: null } })
  })
  it('resolved = resolved:true', () => {
    expect(alertStatusWhere('resolved')).toEqual({ resolved: true })
  })
  it('all = sin filtro', () => {
    expect(alertStatusWhere('all')).toEqual({})
  })
  it('active (legacy dashboard) = resolved:false', () => {
    expect(alertStatusWhere('active')).toEqual({ resolved: false })
  })
})

describe('alertWhere (estado + severidad)', () => {
  it('combina severidad con el estado', () => {
    expect(alertWhere('unread', 'CRITICAL')).toEqual({ resolved: false, readAt: null, severity: 'CRITICAL' })
  })
  it('severity=all no agrega filtro de severidad', () => {
    expect(alertWhere('resolved', 'all')).toEqual({ resolved: true })
  })
})

describe('parsers robustos', () => {
  it('status desconocido → all', () => {
    expect(parseAlertStatus('bogus')).toBe('all')
    expect(parseAlertStatus(undefined)).toBe('all')
    expect(parseAlertStatus('unread')).toBe('unread')
  })
  it('severity inválida → all; válida se respeta', () => {
    expect(parseAlertSeverity('HIGH')).toBe('HIGH')
    expect(parseAlertSeverity('x')).toBe('all')
  })
  it('page: 0-indexado, negativos/NaN → 0', () => {
    expect(parseAlertPage('0')).toBe(0)
    expect(parseAlertPage('3')).toBe(3)
    expect(parseAlertPage('-2')).toBe(0)
    expect(parseAlertPage('abc')).toBe(0)
  })
  it('limit: default 50, cap 200', () => {
    expect(parseAlertLimit(undefined)).toBe(50)
    expect(parseAlertLimit('25')).toBe(25)
    expect(parseAlertLimit('9999')).toBe(200)
    expect(parseAlertLimit('0')).toBe(50)
  })
})
