import { describe, it, expect } from 'vitest'
import { canViewDashboard } from './dashboard-policy'

describe('canViewDashboard (#171 · ENFORCED_BACKEND)', () => {
  it('ADMIN siempre puede, incluso con override false', () => {
    expect(canViewDashboard('ADMIN', { canViewDashboard: false })).toBe(true)
    expect(canViewDashboard('ADMIN', null)).toBe(true)
  })

  it('no-ADMIN sin override ⇒ default del rol (true)', () => {
    expect(canViewDashboard('OPERATOR', null)).toBe(true)
    expect(canViewDashboard('SUPERVISOR', undefined)).toBe(true)
    expect(canViewDashboard('AUDITOR', {})).toBe(true)
  })

  it('no-ADMIN con override explícito false ⇒ bloqueado', () => {
    expect(canViewDashboard('OPERATOR', { canViewDashboard: false })).toBe(false)
    expect(canViewDashboard('AUDITOR', { canViewDashboard: false })).toBe(false)
  })

  it('no-ADMIN con override true ⇒ permitido', () => {
    expect(canViewDashboard('OPERATOR', { canViewDashboard: true })).toBe(true)
  })
})
