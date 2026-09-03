// Tests del módulo único de cifrado de credenciales NVR.
import { describe, it, expect, beforeAll } from 'vitest'
import CryptoJS from 'crypto-js'
import {
  encryptNvrPassword, decryptNvrPassword, decryptNvrPasswordOrNull,
  isMaskedPassword, validateNvrCredentialKey,
} from './credentials'

// Clave de cifrado para los tests (no es un secreto real). Debe estar definida
// antes de invocar encrypt/decrypt porque la resolución de clave es perezosa.
beforeAll(() => {
  process.env.NVR_CREDENTIAL_KEY = 'clave-de-cifrado-solo-para-tests-0123456789'
})

describe('AES-256-GCM roundtrip', () => {
  it('descifra lo que cifra (formato gcm.v1)', () => {
    const enc = encryptNvrPassword('Sup3r$ecreta!')
    expect(enc).not.toContain('Sup3r$ecreta!')
    expect(enc.startsWith('gcm.v1.')).toBe(true)
    expect(decryptNvrPassword(enc)).toBe('Sup3r$ecreta!')
    expect(decryptNvrPasswordOrNull(enc)).toBe('Sup3r$ecreta!')
  })

  it('usa IV/salt aleatorios: dos cifrados del mismo texto difieren', () => {
    const a = encryptNvrPassword('misma-contraseña')
    const b = encryptNvrPassword('misma-contraseña')
    expect(a).not.toBe(b)
    expect(decryptNvrPassword(a)).toBe('misma-contraseña')
    expect(decryptNvrPassword(b)).toBe('misma-contraseña')
  })

  it('variante estricta devuelve null con datos corruptos', () => {
    expect(decryptNvrPasswordOrNull('no-es-un-cifrado-valido')).toBeNull()
    expect(decryptNvrPasswordOrNull('gcm.v1.aaa.bbb.ccc.ddd')).toBeNull()
  })

  it('variante laxa devuelve string vacío con datos corruptos (comportamiento legado)', () => {
    expect(typeof decryptNvrPassword('~~~basura~~~')).toBe('string')
    expect(decryptNvrPassword('~~~basura~~~')).toBe('')
  })
})

describe('retrocompatibilidad de descifrado legacy (crypto-js)', () => {
  it('descifra un ciphertext legacy cifrado con la clave vieja NVR_CREDENTIAL_KEY', () => {
    // Simula un valor guardado antes de la migración a GCM (sin prefijo).
    const legacy = CryptoJS.AES.encrypt('legacy-pass', process.env.NVR_CREDENTIAL_KEY!).toString()
    expect(legacy.startsWith('gcm.')).toBe(false)
    expect(decryptNvrPassword(legacy)).toBe('legacy-pass')
  })

  it('descifra un ciphertext legacy cifrado con el literal por defecto "visioncore_key"', () => {
    const legacy = CryptoJS.AES.encrypt('viejo-default', 'visioncore_key').toString()
    expect(decryptNvrPassword(legacy)).toBe('viejo-default')
  })
})

describe('política de clave (validateNvrCredentialKey)', () => {
  it('en producción sin NVR_CREDENTIAL_KEY: lanza (fail-fast)', () => {
    expect(() =>
      validateNvrCredentialKey({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/NVR_CREDENTIAL_KEY/)
  })

  it('en producción con NVR_CREDENTIAL_KEY: no lanza y no advierte', () => {
    expect(
      validateNvrCredentialKey({ NODE_ENV: 'production', NVR_CREDENTIAL_KEY: 'x'.repeat(32) } as NodeJS.ProcessEnv),
    ).toBeNull()
  })

  it('en dev sin NVR_CREDENTIAL_KEY: no lanza, devuelve aviso', () => {
    const w = validateNvrCredentialKey({ NODE_ENV: 'development', JWT_SECRET: 'jwt' } as NodeJS.ProcessEnv)
    expect(w).toMatch(/NVR_CREDENTIAL_KEY/)
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
