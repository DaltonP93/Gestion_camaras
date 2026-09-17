// Tests del módulo único de cifrado de credenciales NVR.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import CryptoJS from 'crypto-js'
import {
  encryptNvrPassword, decryptNvrPassword, decryptNvrPasswordOrNull,
  isMaskedPassword, validateNvrCredentialKey,
} from './credentials'

const originalNvrCredentialKey = process.env.NVR_CREDENTIAL_KEY
const originalJwtSecret = process.env.JWT_SECRET

// Clave de cifrado para los tests (no es un secreto real). Debe estar definida
// antes de invocar encrypt/decrypt porque la resolución de clave es perezosa.
// JWT_SECRET se elimina para que la cadena legacy no dependa del orden de otros
// archivos de test que modifiquen process.env.
beforeAll(() => {
  process.env.NVR_CREDENTIAL_KEY = 'clave-de-cifrado-solo-para-tests-0123456789'
  delete process.env.JWT_SECRET
})

afterAll(() => {
  if (originalNvrCredentialKey === undefined) delete process.env.NVR_CREDENTIAL_KEY
  else process.env.NVR_CREDENTIAL_KEY = originalNvrCredentialKey

  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
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

  it('rechaza de forma determinista una entrada legacy malformada', () => {
    const observed = new Set<string | null>()

    for (let i = 0; i < 5_000; i += 1) {
      observed.add(decryptNvrPasswordOrNull('no-es-un-cifrado-valido'))
    }

    expect([...observed]).toEqual([null])
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

  it.each([
    'a',
    'x'.repeat(15),
    'x'.repeat(16),
    'x'.repeat(17),
    'contraseña-legacy-Ñandutí-🔐',
  ])('preserva el formato OpenSSL legacy para %j', (plain) => {
    const legacy = CryptoJS.AES.encrypt(plain, process.env.NVR_CREDENTIAL_KEY!).toString()
    expect(Buffer.from(legacy, 'base64').subarray(0, 8).toString('ascii')).toBe('Salted__')
    expect(decryptNvrPasswordOrNull(legacy)).toBe(plain)
  })

  it('descifra un ciphertext legacy cifrado con el literal por defecto "visioncore_key"', () => {
    const legacy = CryptoJS.AES.encrypt('viejo-default', 'visioncore_key').toString()
    const testKey = process.env.NVR_CREDENTIAL_KEY
    delete process.env.NVR_CREDENTIAL_KEY
    try {
      expect(decryptNvrPassword(legacy)).toBe('viejo-default')
    } finally {
      if (testKey === undefined) delete process.env.NVR_CREDENTIAL_KEY
      else process.env.NVR_CREDENTIAL_KEY = testKey
    }
  })

  it.each([
    ['texto arbitrario', 'no-es-un-cifrado-valido'],
    ['base64 sin cabecera OpenSSL', Buffer.alloc(32, 1).toString('base64')],
    ['sólo cabecera y salt, sin ciphertext', Buffer.from('Salted__12345678').toString('base64')],
    [
      'ciphertext con longitud fuera de bloque AES',
      Buffer.concat([Buffer.from('Salted__12345678'), Buffer.alloc(15, 2)]).toString('base64'),
    ],
    ['base64 con espacios', ` ${Buffer.alloc(32, 1).toString('base64')} `],
  ])('rechaza %s antes del descifrado legacy', (_case, malformed) => {
    expect(decryptNvrPasswordOrNull(malformed)).toBeNull()
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
