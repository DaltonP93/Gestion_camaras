import { describe, it, expect } from 'vitest'
import {
  evaluatePasswordPolicy, sessionsToPrune, accessTokenTtl, DEFAULT_SECURITY_SETTINGS,
} from './security-policy'

describe('evaluatePasswordPolicy (P0: mínimo real 12)', () => {
  it('por defecto exige 12 caracteres + complejidad', () => {
    expect(DEFAULT_SECURITY_SETTINGS.passwordMinLength).toBe(12)
    const short = evaluatePasswordPolicy('Ab1!xyz')   // 7 chars
    expect(short.valid).toBe(false)
    expect(short.errors).toContain('Mínimo 12 caracteres')
  })
  it('acepta una contraseña fuerte de 12+', () => {
    expect(evaluatePasswordPolicy('Abcdef1!ghij').valid).toBe(true)
  })
  it('respeta minLength configurable', () => {
    expect(evaluatePasswordPolicy('Abcdef1!gh', { minLength: 10 }).valid).toBe(true)
    expect(evaluatePasswordPolicy('Abcdef1!gh', { minLength: 16 }).valid).toBe(false)
  })
  it('requireStrong=false sólo exige longitud', () => {
    const r = evaluatePasswordPolicy('abcdefghijkl', { requireStrong: false })
    expect(r.valid).toBe(true)
  })
  it('enumera todos los faltantes de complejidad', () => {
    const r = evaluatePasswordPolicy('aaaaaaaaaaaa')  // 12, sólo minúsculas
    expect(r.valid).toBe(false)
    expect(r.errors).toEqual(expect.arrayContaining([
      'Al menos 1 letra mayúscula', 'Al menos 1 número', 'Al menos 1 carácter especial (!@#$%...)',
    ]))
  })
})

describe('sessionsToPrune (maxSessions)', () => {
  const S = (id: string, t: number) => ({ id, lastUsedAt: new Date(t) })
  it('no poda si no se supera el máximo', () => {
    expect(sessionsToPrune([S('a', 1), S('b', 2)], 5)).toEqual([])
  })
  it('revoca las MÁS ANTIGUAS conservando `max` recientes', () => {
    const sessions = [S('old', 100), S('mid', 200), S('new', 300), S('newest', 400)]
    // max=2 → conservar newest(400) y new(300); revocar mid(200) y old(100)
    expect(sessionsToPrune(sessions, 2).sort()).toEqual(['mid', 'old'])
  })
  it('cae a createdAt si falta lastUsedAt', () => {
    const sessions = [
      { id: 'a', createdAt: new Date(100) },
      { id: 'b', createdAt: new Date(300) },
      { id: 'c', createdAt: new Date(200) },
    ]
    expect(sessionsToPrune(sessions, 1)).toEqual(['c', 'a'])  // conserva b(300)
  })
})

describe('accessTokenTtl', () => {
  // Debe ser CADENA de duración ("<m>m"): fast-jwt trata un expiresIn numérico como
  // milisegundos (review Codex #129 P1).
  it('devuelve una cadena de minutos con límites', () => {
    expect(accessTokenTtl(60)).toBe('60m')
    expect(accessTokenTtl(1)).toBe('5m')       // clamp inferior 5 min
    expect(accessTokenTtl(99999)).toBe('1440m') // clamp superior 24 h
  })
})
