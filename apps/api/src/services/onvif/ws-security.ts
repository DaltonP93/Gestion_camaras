// apps/api/src/services/onvif/ws-security.ts
//
// NÚCLEO PURO — Header WS-Security UsernameToken con PasswordDigest.
//
// Digest = Base64( SHA1( nonceBytes + createdUtf8 + passwordUtf8 ) )   (WSSE 1.0)
// El <Nonce> del XML lleva Base64(nonceBytes) y <Created> el timestamp UTC.
//
// Nonce y reloj son INYECTABLES para poder testear el digest de forma
// determinística (vector conocido). Las credenciales llegan por parámetro y
// JAMÁS se loguean ni se retornan; sólo se usan para calcular el digest.

import crypto from 'crypto'
import { xmlEscape } from './xml-escape'

/** Genera bytes de nonce (16 por defecto). Inyectable para tests. */
export type NonceProvider = () => Buffer
/** Devuelve el timestamp `Created` en UTC ISO-8601. Inyectable para tests. */
export type ClockProvider = () => string

export interface UsernameTokenInput {
  username: string
  password: string
  /** Bytes crudos del nonce (no Base64). Si se omite, se usa el provider. */
  nonce?: Buffer
  /** Timestamp `Created` (UTC ISO). Si se omite, se usa el clock. */
  created?: string
  nonceProvider?: NonceProvider
  clock?: ClockProvider
}

const defaultNonceProvider: NonceProvider = () => crypto.randomBytes(16)
const defaultClock: ClockProvider = () => new Date().toISOString()

/**
 * Calcula el PasswordDigest WSSE de forma pura y determinística.
 * Recibe el nonce en BYTES (no Base64) y el `created` ya formateado.
 */
export function computePasswordDigest(nonce: Buffer, created: string, password: string): string {
  const hash = crypto.createHash('sha1')
  hash.update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
  return hash.digest('base64')
}

export interface UsernameTokenParts {
  usernameToken: { username: string; nonceB64: string; created: string; digest: string }
  /** Fragmento XML del <wsse:Security> listo para insertar en el <Header>. */
  headerXml: string
}

const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd'
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd'
const PWD_DIGEST_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest'
const NONCE_ENC = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary'

/**
 * Construye el header WS-Security UsernameToken (PasswordDigest).
 * Puro: con `nonce`+`created` fijos el resultado es reproducible byte a byte.
 */
export function buildUsernameToken(input: UsernameTokenInput): UsernameTokenParts {
  if (!input.username) throw new Error('ws-security: username requerido')
  const nonce = input.nonce ?? (input.nonceProvider ?? defaultNonceProvider)()
  const created = input.created ?? (input.clock ?? defaultClock)()
  const nonceB64 = nonce.toString('base64')
  const digest = computePasswordDigest(nonce, created, input.password)

  const headerXml =
    `<wsse:Security xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}" s:mustUnderstand="1">` +
    `<wsse:UsernameToken>` +
    `<wsse:Username>${xmlEscape(input.username)}</wsse:Username>` +
    `<wsse:Password Type="${PWD_DIGEST_TYPE}">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${NONCE_ENC}">${nonceB64}</wsse:Nonce>` +
    `<wsu:Created>${xmlEscape(created)}</wsu:Created>` +
    `</wsse:UsernameToken>` +
    `</wsse:Security>`

  return { usernameToken: { username: input.username, nonceB64, created, digest }, headerXml }
}
