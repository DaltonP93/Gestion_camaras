// apps/api/src/services/credentials.ts
// Única fuente de cifrado de credenciales de NVR. Antes había copias de la clave
// y de las funciones (server.ts, nvr.ts, recordings.ts, stream-manager,
// stream-validator, healthWorker, seed, nvrSync, nvrConfig, cameras) con
// variantes sutiles. Todo debe importar de este módulo.
//
// Cifrado nuevo: AES-256-GCM (node:crypto) con KDF scrypt derivando de
// NVR_CREDENTIAL_KEY. Formato versionado: gcm.v1.<saltB64>.<ivB64>.<tagB64>.<ctB64>.
// IV aleatorio por cifrado; salt aleatorio por cifrado.
//
// Lectura retrocompatible: los valores existentes fueron cifrados con crypto-js
// (KDF OpenSSL-MD5, sin prefijo). decrypt() detecta el formato: si es GCM lo
// descifra con la clave resuelta; si es legacy prueba la cadena de claves
// disponibles [NVR_CREDENTIAL_KEY, JWT_SECRET, 'visioncore_key'] SOLO para lectura
// de compatibilidad. Al re-guardar una credencial se re-cifra a GCM.
import crypto from 'node:crypto'
import CryptoJS from 'crypto-js'

const GCM_PREFIX = 'gcm.v1.'
// Literal legacy: SOLO se usa para descifrar valores viejos, NUNCA para cifrar.
const LEGACY_DEFAULT_KEY = 'visioncore_key'

/**
 * Valida la política de clave de cifrado de credenciales NVR.
 * - En producción: NVR_CREDENTIAL_KEY es obligatoria (fail-fast si falta).
 * - En dev/test: si falta, se advierte y se hará fallback a JWT_SECRET.
 * Devuelve un aviso (o null) para que el arranque lo registre; lanza en prod.
 * Se testea de forma aislada sin arrancar el servidor.
 */
export function validateNvrCredentialKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const isProd = env.NODE_ENV === 'production'
  if (env.NVR_CREDENTIAL_KEY && env.NVR_CREDENTIAL_KEY.length > 0) {
    return null
  }
  if (isProd) {
    throw new Error(
      '[startup] FATAL: NVR_CREDENTIAL_KEY no está definida en producción. ' +
        'Es obligatoria para cifrar las credenciales de los NVR con una clave ' +
        'separada de JWT_SECRET. Genera una con `openssl rand -hex 32` y ' +
        'defínela en .env antes de arrancar.',
    )
  }
  return (
    '[startup] NVR_CREDENTIAL_KEY no definida — en dev/test se usará JWT_SECRET ' +
    'como fallback para cifrar credenciales del NVR. Define NVR_CREDENTIAL_KEY en .env.'
  )
}

/**
 * Resuelve la clave usada para CIFRAR (GCM). Nunca devuelve el literal legacy.
 * - Si NVR_CREDENTIAL_KEY está definida, se usa.
 * - En producción sin ella: lanza (defensa en profundidad; el arranque ya falla).
 * - En dev/test sin ella: fallback a JWT_SECRET.
 */
function resolveEncryptionKey(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NVR_CREDENTIAL_KEY && env.NVR_CREDENTIAL_KEY.length > 0) {
    return env.NVR_CREDENTIAL_KEY
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'NVR_CREDENTIAL_KEY es obligatoria en producción para cifrar credenciales del NVR.',
    )
  }
  if (env.JWT_SECRET && env.JWT_SECRET.length > 0) {
    return env.JWT_SECRET
  }
  throw new Error(
    'No hay clave de cifrado disponible: define NVR_CREDENTIAL_KEY (o JWT_SECRET en dev).',
  )
}

/** Cadena de claves candidatas para descifrar valores LEGACY (crypto-js). */
function legacyKeyChain(env: NodeJS.ProcessEnv = process.env): string[] {
  const chain: string[] = []
  if (env.NVR_CREDENTIAL_KEY) chain.push(env.NVR_CREDENTIAL_KEY)
  if (env.JWT_SECRET) chain.push(env.JWT_SECRET)
  chain.push(LEGACY_DEFAULT_KEY)
  // Únicos, preservando orden.
  return [...new Set(chain)]
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // scrypt del módulo nativo; parámetros por defecto (N=16384) + keylen 32.
  return crypto.scryptSync(passphrase, salt, 32)
}

/** Cifra en AES-256-GCM con salt+IV aleatorios y formato versionado. */
export function encryptNvrPassword(plain: string): string {
  const passphrase = resolveEncryptionKey()
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    GCM_PREFIX.slice(0, -1), // 'gcm.v1'
    salt.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
    ct.toString('base64'),
  ].join('.')
}

function isGcm(enc: string): boolean {
  return typeof enc === 'string' && enc.startsWith(GCM_PREFIX)
}

function decryptGcm(enc: string): string | null {
  // gcm.v1.<salt>.<iv>.<tag>.<ct>
  const parts = enc.split('.')
  if (parts.length !== 6) return null
  const [, , saltB64, ivB64, tagB64, ctB64] = parts
  try {
    const salt = Buffer.from(saltB64, 'base64')
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ct = Buffer.from(ctB64, 'base64')
    const key = deriveKey(resolveEncryptionKey(), salt)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const out = Buffer.concat([decipher.update(ct), decipher.final()])
    return out.toString('utf8')
  } catch {
    return null
  }
}

function decryptLegacy(enc: string): string | null {
  for (const key of legacyKeyChain()) {
    try {
      const plain = CryptoJS.AES.decrypt(enc, key).toString(CryptoJS.enc.Utf8)
      if (plain) return plain
    } catch {
      // probar siguiente clave
    }
  }
  return null
}

/** Variante estricta: null si no se puede descifrar por ninguna vía. */
export function decryptNvrPasswordOrNull(enc: string): string | null {
  if (!enc) return null
  if (isGcm(enc)) return decryptGcm(enc)
  return decryptLegacy(enc)
}

/** Variante laxa (comportamiento legado): '' cuando no se puede descifrar. */
export function decryptNvrPassword(enc: string): string {
  return decryptNvrPasswordOrNull(enc) ?? ''
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
