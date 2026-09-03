// apps/api/src/services/providers/hik-connect/parse.ts
//
// NÚCLEO PURO — parseo de respuestas JSON de la OpenAPI de Hik-Connect y mapeo de
// sus códigos de error (`code`/`msg`). La OpenAPI responde SIEMPRE JSON con la
// forma `{ code: string, msg: string, data?: {...} }` (code "200" = éxito).
//
// Sin I/O. Sin secretos en los mensajes de error.

import { HikConnectError } from './errors'

/** Envelope estándar de la OpenAPI de Hik-Connect. */
export interface HikEnvelope {
  code: string
  msg: string
  data?: unknown
}

/** Mapeo (parcial) de códigos de negocio conocidos → descripción sin secretos. */
export const HIK_ERROR_CODES: Record<string, string> = {
  '200': 'éxito',
  '10001': 'parámetro inválido',
  '10002': 'accessToken vencido o inválido',
  '10004': 'usuario no existe',
  '10005': 'appKey excepcional / congelado',
  '10017': 'appKey no existe',
  '10018': 'error de firma / secretKey inválida',
  '20002': 'el dispositivo no existe',
  '20006': 'excepción de red del dispositivo',
  '20007': 'el dispositivo está offline',
  '20008': 'el dispositivo respondió timeout',
  '20014': 'deviceSerial ilegal',
  '20032': 'el canal no existe en el dispositivo',
  '49999': 'excepción de datos / interno de la nube',
  '60000': 'el dispositivo no soporta la operación',
  '60020': 'operación no soportada por el canal',
}

/** Descripción legible del código (sin filtrar nada). */
export function describeCode(code: string): string {
  return HIK_ERROR_CODES[code] ?? 'error desconocido de Hik-Connect'
}

/** Parseo JSON tolerante: nunca lanza el SyntaxError crudo (podría llevar cuerpo). */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new HikConnectError('PARSE_ERROR', 'respuesta no es JSON válido')
  }
}

/**
 * Valida la forma del envelope y exige code === '200'. Devuelve `data`. Si el
 * code es de error, lanza HikConnectError('API_ERROR') con el code y una glosa,
 * sin incluir `data` ni cuerpos crudos.
 */
export function unwrapEnvelope(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) {
    throw new HikConnectError('PARSE_ERROR', 'envelope de Hik-Connect ausente o no-objeto')
  }
  const env = raw as Record<string, unknown>
  // El code puede venir como número o string; normalizar a string.
  const code = env.code === undefined || env.code === null ? '' : String(env.code)
  if (!code) {
    throw new HikConnectError('PARSE_ERROR', 'envelope sin campo code')
  }
  if (code !== '200') {
    throw new HikConnectError('API_ERROR', `Hik-Connect code ${code}: ${describeCode(code)}`, { apiCode: code })
  }
  return env.data
}

/** Extrae un string obligatorio de `data`. Lanza PARSE_ERROR si falta. */
export function requireString(data: unknown, field: string): string {
  if (typeof data !== 'object' || data === null) {
    throw new HikConnectError('PARSE_ERROR', 'data ausente o no-objeto')
  }
  const v = (data as Record<string, unknown>)[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw new HikConnectError('PARSE_ERROR', `campo "${field}" ausente en la respuesta`)
  }
  return v
}

/** Extrae un número opcional de `data` (acepta string numérico). null si falta. */
export function optionalNumber(data: unknown, field: string): number | null {
  if (typeof data !== 'object' || data === null) return null
  const v = (data as Record<string, unknown>)[field]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
