// apps/api/src/services/credentials.ts
// Única fuente de cifrado de credenciales de NVR. Antes había 7 copias de la
// clave y de las funciones (server.ts, nvr.ts, recordings.ts, stream-manager,
// stream-validator, healthWorker, seed) con variantes sutiles — incluida una
// en seed.ts que omitía NVR_CREDENTIAL_KEY y cifraba con otra clave.
import CryptoJS from 'crypto-js'

export const NVR_ENCRYPTION_KEY =
  process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'

export function encryptNvrPassword(plain: string): string {
  return CryptoJS.AES.encrypt(plain, NVR_ENCRYPTION_KEY).toString()
}

/** Variante estricta: null si la clave es incorrecta o el valor no descifra. */
export function decryptNvrPasswordOrNull(enc: string): string | null {
  try {
    const plain = CryptoJS.AES.decrypt(enc, NVR_ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)
    return plain || null // CryptoJS devuelve '' con clave incorrecta
  } catch {
    return null
  }
}

/** Variante laxa (comportamiento legado): '' cuando no se puede descifrar. */
export function decryptNvrPassword(enc: string): string {
  try {
    return CryptoJS.AES.decrypt(enc, NVR_ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)
  } catch {
    return ''
  }
}

/** Rechaza valores que claramente son máscaras/placeholders, no contraseñas. */
export function isMaskedPassword(value: string): boolean {
  if (!value) return false
  // Solo puntos, bullets o asteriscos → placeholder visual
  if (/^[•\*•]+$/.test(value)) return true
  // 12 caracteres o menos, todos iguales → placeholder
  if (value.length <= 12 && new Set(value.split('')).size === 1) return true
  return false
}
