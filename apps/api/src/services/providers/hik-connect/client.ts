// apps/api/src/services/providers/hik-connect/client.ts
//
// I/O INYECTABLE (delgado) — cliente HTTP hacia una base URL YA VALIDADA. El
// transporte es INYECTABLE (`HttpTransport`): en producción usa axios; en tests
// se inyecta un doble sin red. Aquí SÓLO se orquesta: resolver la URL absoluta a
// partir de la base validada + el path relativo del builder, hacer la request,
// aplicar timeout, mapear errores a HikConnectError y parsear el JSON.
//
// SEGURIDAD: la base URL la fija SIEMPRE el provider con un valor validado
// (areaDomain o el endpoint de token), NUNCA el caller. El path proviene de los
// builders (relativo, con charset acotado). No se sigue redirecciones (evita que
// la nube redirija el request a un destino inesperado). No se loguea el cuerpo
// ni los headers (llevan accessToken).

import axios from 'axios'
import { HikConnectError } from './errors'
import type { HttpRequestSpec } from './http-spec'
import { safeJsonParse } from './parse'

export interface RawHttpResponse {
  status: number
  body: string
}

/** Transporte HTTP inyectable: recibe la URL ABSOLUTA ya resuelta y validada. */
export interface HttpTransport {
  request(
    url: string,
    opts: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  ): Promise<RawHttpResponse>
}

export const DEFAULT_TIMEOUT_MS = 8000

export interface HikConnectClientOptions {
  /** Base URL ABSOLUTA y ya validada (token endpoint o areaDomain). */
  baseUrl: string
  transport: HttpTransport
  timeoutMs?: number
}

/**
 * Resuelve la URL absoluta a partir de la base y un path RELATIVO. Rechaza
 * cualquier path que no empiece con '/' (defensa: nunca aceptar un absoluto que
 * pudiera cambiar el host).
 */
export function resolveUrl(baseUrl: string, path: string): string {
  if (!path.startsWith('/')) {
    throw new HikConnectError('INVALID_ARG', 'path debe ser relativo y empezar con "/"')
  }
  const base = new URL(baseUrl)
  // Componer sobre el origin; ignora cualquier path en baseUrl para ser predecible.
  return new URL(path, `${base.protocol}//${base.host}`).toString()
}

export class HikConnectClient {
  private readonly baseUrl: string
  private readonly transport: HttpTransport
  private readonly timeoutMs: number

  constructor(opts: HikConnectClientOptions) {
    this.baseUrl = opts.baseUrl
    this.transport = opts.transport
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Envía un request-spec y devuelve el JSON parseado (sin desempaquetar). */
  async send(spec: HttpRequestSpec): Promise<unknown> {
    const url = resolveUrl(this.baseUrl, spec.path)
    let res: RawHttpResponse
    try {
      res = await this.transport.request(url, {
        method: spec.method,
        headers: spec.headers,
        body: spec.body,
        timeoutMs: this.timeoutMs,
      })
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        throw new HikConnectError('TIMEOUT', 'timeout de transporte Hik-Connect')
      }
      throw new HikConnectError('TRANSPORT_ERROR', 'fallo de transporte Hik-Connect')
    }
    if (res.status < 200 || res.status >= 300) {
      throw new HikConnectError('TRANSPORT_ERROR', `HTTP ${res.status} de Hik-Connect`, { httpStatus: res.status })
    }
    return safeJsonParse(res.body ?? '')
  }
}

/**
 * Transporte por defecto sobre axios (no ejecuta I/O hasta que se llama a
 * request). Pide el cuerpo crudo (sin auto-parseo), sin redirecciones, y nunca
 * loguea cuerpos ni headers (llevan accessToken).
 */
export function createAxiosTransport(): HttpTransport {
  return {
    async request(url, o) {
      const res = await axios.request({
        url,
        method: o.method,
        data: o.body,
        headers: o.headers,
        timeout: o.timeoutMs,
        responseType: 'text',
        transformResponse: [(d: unknown) => d], // no parsear: queremos el texto crudo
        validateStatus: () => true, // el status lo evalúa HikConnectClient.send
        maxRedirects: 0,
      })
      const data = res.data
      return { status: res.status, body: typeof data === 'string' ? data : String(data ?? '') }
    },
  }
}
