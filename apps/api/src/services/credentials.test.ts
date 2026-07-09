// Tests del módulo único de cifrado de credenciales NVR.
import { describe, it, expect } from 'vitest'
import {
  encryptNvrPassword, decryptNvrPassword, decryptNvrPasswordOrNull,
  isMaskedPassword,
} from './credentials'

describe('encrypt/decrypt roundtrip', () => {
  it('descifra lo que cifra', () => {
    const enc = encryptNvrPassword('Sup3r$ecreta!')
    expect(enc).not.toContain('Sup3r$ecreta!')
    expect(decryptNvrPassword(enc)).toBe('Sup3r$ecreta!')
    expect(decryptNvrPasswordOrNull(enc)).toBe('Sup3r$ecreta!')
  })

  it('variante estricta devuelve null con datos corruptos', () => {
    expect(decryptNvrPasswordOrNull('no-es-un-cifrado-valido')).toBeNull()
  })

  it('variante laxa devuelve string vacío con datos corruptos (comportamiento legado)', () => {
    expect(typeof decryptNvrPassword('~~~basura~~~')).toBe('string')
  })
})

describe('isMaskedPassword', () => {
  it('rechaza placeholders de bullets/asteriscos', () => {
    expect(isMaskedPassword('••••••••')).toBe(true)
    expect(isMaskedPassword('********')).toBe(true)
  })
  it('rechaza repeticiones cortas de un solo carácter', () => {
    expect(isMaskedPassword('aaaaaaaa')).toBe(true)
  })
  it('acepta contraseñas reales', () => {
    expect(isMaskedPassword('Sup3r$ecreta!')).toBe(false)
    expect(isMaskedPassword('')).toBe(false)
  })
})
