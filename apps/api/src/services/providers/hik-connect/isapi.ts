// apps/api/src/services/providers/hik-connect/isapi.ts
//
// NÚCLEO PURO — builder del ISAPI-proxy (`isapi/proxypass`) con VALIDACIÓN
// ESTRICTA del path ISAPI. Este es el módulo más sensible a SSRF/inyección: el
// `isapiPath` lo elige el caller y se reenvía al NVR a través de la nube.
//
// MITIGACIÓN SSRF / ANTI-INYECCIÓN (todo en `assertSafeIsapiPath`):
//   - Debe matchear `^/ISAPI/[A-Za-z0-9/_.-]+$` (empieza en /ISAPI/, sólo un
//     set seguro de caracteres). Un querystring `?…=…` opcional se permite con
//     un charset igualmente acotado.
//   - Se rechaza cualquier `..` (path traversal) y cualquier `//` (colapso/host
//     relativo protocol-less).
//   - Se rechazan CR/LF/TAB/NUL y todo carácter de control (anti header/CRLF
//     injection al reenviar).
//   - Se rechaza cualquier `scheme://` o `host` embebido (no puede contener ':',
//     '//', '@', '\\', espacios, etc.).
//   - Límite de longitud (evita abusos y payloads gigantes).
// El host destino SIEMPRE es el areaDomain validado del token (lo fija el
// cliente), NUNCA sale del `isapiPath`.

import { HikConnectError } from './errors'
import type { HttpMethod, HttpRequestSpec } from './http-spec'

/** Endpoint de proxy ISAPI de la nube (fijo; el path ISAPI va como parámetro). */
export const ISAPI_PROXY_PATH = '/api/hpcgw/v1/isapi/proxypass'

/** Longitud máxima admitida para un path ISAPI (con querystring). */
export const MAX_ISAPI_PATH_LEN = 1024

/** Métodos HTTP permitidos hacia el NVR vía proxy. */
const ALLOWED_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'DELETE'])

// Path base: /ISAPI/ + segmentos seguros. Sin querystring.
const ISAPI_PATH_RE = /^\/ISAPI\/[A-Za-z0-9/_.-]+$/
// Querystring opcional: charset acotado (sin control, sin espacios, sin CRLF).
const ISAPI_QUERY_RE = /^[A-Za-z0-9._~%=&,+-]*$/
// Caracteres de control (CR, LF, TAB, NUL, DEL, etc.) → CRLF/header injection.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp("[\\x00-\\x1f\\x7f]")

/**
 * Valida ESTRICTAMENTE un path ISAPI. Devuelve el path normalizado (idéntico al
 * input si es válido) o lanza HikConnectError('INVALID_ISAPI_PATH'). No hace I/O.
 */
export function assertSafeIsapiPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'isapiPath vacío')
  }
  if (rawPath.length > MAX_ISAPI_PATH_LEN) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'isapiPath excede la longitud máxima')
  }
  if (CONTROL_CHARS_RE.test(rawPath)) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'isapiPath contiene caracteres de control')
  }
  // Traversal y colapso de barras / host protocol-less.
  if (rawPath.includes('..')) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'isapiPath contiene ".." (traversal)')
  }
  if (rawPath.includes('//')) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'isapiPath contiene "//"')
  }
  // Scheme/host embebido, backslash, arroba, espacios. Rechazar ':' bloquea
  // cualquier `http:`/`https:` y puertos embebidos.
  if (/[\\@\s:]/.test(rawPath)) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'isapiPath no puede contener host/scheme/caracteres inseguros')
  }

  // Separar path y querystring (una sola '?').
  const qIdx = rawPath.indexOf('?')
  const pathPart = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx)
  const queryPart = qIdx === -1 ? '' : rawPath.slice(qIdx + 1)
  if (qIdx !== -1 && rawPath.indexOf('?', qIdx + 1) !== -1) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'isapiPath tiene más de un "?"')
  }
  if (!ISAPI_PATH_RE.test(pathPart)) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'isapiPath debe empezar en /ISAPI/ y usar sólo caracteres seguros')
  }
  if (!ISAPI_QUERY_RE.test(queryPart)) {
    throw new HikConnectError('INVALID_ISAPI_PATH', 'querystring del isapiPath con caracteres no permitidos')
  }
  return rawPath
}

export interface IsapiProxyInput {
  accessToken: string
  deviceSerial: string
  method: HttpMethod
  /** Ruta ISAPI hacia el NVR; se valida estrictamente. */
  isapiPath: string
  /** Cuerpo opcional (XML/JSON ISAPI) a reenviar. */
  body?: string
  /** Nº de canal opcional (algunos endpoints ISAPI lo requieren). */
  channelNo?: number
}

/**
 * Construye el request del ISAPI-proxy. Valida el path ISAPI y el método. NO
 * ejecuta I/O. El host destino lo fija el cliente con el areaDomain validado.
 * El accessToken y el path ISAPI viajan en headers de la nube.
 */
export function buildIsapiProxyRequest(input: IsapiProxyInput): HttpRequestSpec {
  if (!input.accessToken) throw new HikConnectError('INVALID_ARG', 'accessToken requerido')
  if (!input.deviceSerial) throw new HikConnectError('INVALID_ARG', 'deviceSerial requerido')
  const method = String(input.method).toUpperCase() as HttpMethod
  if (!ALLOWED_METHODS.has(method)) {
    throw new HikConnectError('INVALID_ARG', `método HTTP no permitido: ${input.method}`)
  }
  const isapiPath = assertSafeIsapiPath(input.isapiPath)

  const headers: Record<string, string> = {
    // La nube autentica con el accessToken; el proxy identifica el destino con
    // el deviceSerial y el path ISAPI validado. NO se pone host/scheme aquí.
    'EZO-AccessToken': input.accessToken,
    'EZO-DeviceSerial': input.deviceSerial,
    'EZO-ISAPI-Method': method,
    'EZO-ISAPI-Path': isapiPath,
  }
  if (input.channelNo !== undefined) {
    if (!Number.isInteger(input.channelNo) || input.channelNo < 1) {
      throw new HikConnectError('INVALID_ARG', 'channelNo debe ser un entero ≥ 1')
    }
    headers['EZO-Channel'] = String(input.channelNo)
  }
  if (input.body !== undefined) {
    headers['Content-Type'] = 'application/xml'
  }

  return {
    method: 'POST', // la request a la nube es POST; el método ISAPI real va en header
    path: ISAPI_PROXY_PATH,
    headers,
    body: input.body,
  }
}
