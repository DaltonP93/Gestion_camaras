// apps/api/src/services/providers/hik-connect/hls.ts
//
// NÚCLEO PURO — builder de `live/address/get` (URL HLS efímera) y parser de la
// URL resultante.
//
// La OpenAPI de Hik-Connect entrega una URL HLS temporal (TTL ≤ 600s). Se hace
// CLAMP DURO del `expireTime` a [1, 600] para no pedir jamás una URL de vida más
// larga de lo permitido (evidencia/seguridad: URLs efímeras).
//
// SEGURIDAD: el accessToken viaja en el body de ESTA request (es secreto); no se
// retorna ni se loguea. El request es RELATIVO: el host destino lo fija el
// cliente con el areaDomain validado, nunca el caller.

import { HikConnectError } from './errors'
import type { HttpRequestSpec } from './http-spec'
import { formEncode } from './token'
import { unwrapEnvelope, requireString } from './parse'

export const HLS_ADDRESS_PATH = '/api/lapp/live/address/get'

/** TTL máximo permitido por la nube para una URL HLS temporal (segundos). */
export const MAX_HLS_TTL_SEC = 600

/** Código de protocolo HLS en la OpenAPI de Hik-Connect (1=HLS). */
export const PROTOCOL_HLS = 1

export interface HlsAddressInput {
  accessToken: string
  deviceSerial: string
  /** Nº de canal (por defecto 1). */
  channelNo?: number
  /** TTL solicitado en segundos; se hace clamp a [1, 600]. */
  expireSec?: number
}

/** Aplica el clamp del TTL HLS a [1, MAX_HLS_TTL_SEC]. Exportado para test. */
export function clampHlsTtl(sec: number | undefined): number {
  const n = typeof sec === 'number' && Number.isFinite(sec) ? Math.floor(sec) : MAX_HLS_TTL_SEC
  if (n < 1) return 1
  if (n > MAX_HLS_TTL_SEC) return MAX_HLS_TTL_SEC
  return n
}

/**
 * Construye el request de dirección HLS. NO ejecuta I/O. Valida deviceSerial y
 * channelNo, y hace clamp del expireTime ≤ 600.
 */
export function buildHlsAddressRequest(input: HlsAddressInput): HttpRequestSpec {
  if (!input.accessToken) throw new HikConnectError('INVALID_ARG', 'accessToken requerido')
  if (!input.deviceSerial) throw new HikConnectError('INVALID_ARG', 'deviceSerial requerido')
  const channel = input.channelNo ?? 1
  if (!Number.isInteger(channel) || channel < 1) {
    throw new HikConnectError('INVALID_ARG', 'channelNo debe ser un entero ≥ 1')
  }
  const expireTime = clampHlsTtl(input.expireSec)
  return {
    method: 'POST',
    path: HLS_ADDRESS_PATH,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode({
      accessToken: input.accessToken,
      deviceSerial: input.deviceSerial,
      channelNo: String(channel),
      protocol: String(PROTOCOL_HLS),
      expireTime: String(expireTime),
    }),
  }
}

export interface HlsAddress {
  url: string
  /** TTL efectivo con el que se pidió la URL (tras clamp). */
  ttlSec: number
}

/**
 * Parsea la respuesta de `live/address/get`. La URL puede venir como `url` o
 * (según versión) `hlsAddress`. Lanza PARSE_ERROR si no hay URL.
 */
export function parseHlsAddress(json: unknown, ttlSec: number): HlsAddress {
  const data = unwrapEnvelope(json)
  let url: string | null = null
  try {
    url = requireString(data, 'url')
  } catch {
    // Fallback al nombre alternativo antes de rendirse.
    url = requireString(data, 'hlsAddress')
  }
  return { url, ttlSec }
}
