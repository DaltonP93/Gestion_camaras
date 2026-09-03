// apps/api/src/services/providers/hik-connect/token.ts
//
// NÚCLEO PURO — builder del request de token y parser de la respuesta.
//
// Flujo Hik-Connect: POST form-urlencoded a `/api/lapp/token/get` con `appKey` y
// `appSecret`. Respuesta: `{ code, msg, data: { accessToken, areaDomain,
// expireTime } }` (expireTime = epoch en milisegundos).
//
// SEGURIDAD: appKey/secretKey se serializan en el body para ESTA request; nunca
// se retornan ni se incrustan en errores. El accessToken parseado es secreto y
// sólo debe circular internamente en el provider.

import { HikConnectError } from './errors'
import type { HttpRequestSpec } from './http-spec'
import { unwrapEnvelope, requireString, optionalNumber } from './parse'

export const TOKEN_PATH = '/api/lapp/token/get'

export interface TokenCredentials {
  appKey: string
  secretKey: string
}

export interface ParsedToken {
  /** Secreto: no exponer al frontend ni loguear. */
  accessToken: string
  /** URL base de la nube regional (se valida aparte con validate.ts). */
  areaDomain: string
  /** Epoch en ms de expiración (absoluto), o null si la nube no lo informó. */
  expireTimeMs: number | null
}

/** Codifica pares clave/valor como application/x-www-form-urlencoded. */
export function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/**
 * Construye el request de token. NO ejecuta I/O; sólo produce la especificación.
 * Lanza INVALID_ARG si faltan credenciales (defensa; el provider ya lo chequea).
 */
export function buildTokenRequest(creds: TokenCredentials): HttpRequestSpec {
  if (!creds.appKey || !creds.secretKey) {
    throw new HikConnectError('INVALID_ARG', 'appKey y secretKey son obligatorios')
  }
  return {
    method: 'POST',
    path: TOKEN_PATH,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // appSecret es el nombre del parámetro en la OpenAPI de Hik-Connect.
    body: formEncode({ appKey: creds.appKey, appSecret: creds.secretKey }),
  }
}

/** Parsea la respuesta del token. Lanza API_ERROR/PARSE_ERROR según corresponda. */
export function parseTokenResponse(json: unknown): ParsedToken {
  const data = unwrapEnvelope(json)
  return {
    accessToken: requireString(data, 'accessToken'),
    areaDomain: requireString(data, 'areaDomain'),
    expireTimeMs: optionalNumber(data, 'expireTime'),
  }
}
