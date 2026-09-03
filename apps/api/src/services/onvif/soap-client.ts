// apps/api/src/services/onvif/soap-client.ts
//
// I/O INYECTABLE (delgado) — POST del sobre SOAP al servicio del dispositivo.
//
// El transporte es INYECTABLE (`SoapTransport`): en producción usa axios; en
// tests se inyecta un doble sin red. Aquí SÓLO se orquesta: validar SSRF, hacer
// el POST, mapear errores a OnvifError y detectar <Fault>. El parseo de payloads
// concretos vive en parse.ts (núcleo puro).
//
// No se hace ningún I/O al importar el módulo. Timeouts explícitos.

import axios from 'axios'
import { OnvifError } from './errors'
import { assertSafeDeviceUrl, type SsrfPolicy } from './ssrf'
import { parseSoapFault } from './parse'

export interface SoapResponse {
  status: number
  body: string
}

/** Transporte HTTP inyectable: recibe la URL ya validada y el sobre SOAP. */
export interface SoapTransport {
  post(url: string, body: string, opts: { headers: Record<string, string>; timeoutMs: number }): Promise<SoapResponse>
}

export interface PostSoapOptions {
  transport: SoapTransport
  /** SOAPAction (namespace de la operación). Va en el Content-Type SOAP 1.2. */
  action: string
  timeoutMs?: number
  ssrfPolicy?: SsrfPolicy
}

const DEFAULT_TIMEOUT_MS = 8000

/**
 * Envía un sobre SOAP a `deviceUrl`. Valida SSRF, aplica timeout, mapea errores
 * y lanza OnvifError('SOAP_FAULT') si el dispositivo devuelve un Fault (incluso
 * con HTTP 500, como manda SOAP 1.2). Devuelve el body crudo para que el llamador
 * lo parse con parse.ts.
 */
export async function postSoap(deviceUrl: string, envelope: string, opts: PostSoapOptions): Promise<string> {
  const url = assertSafeDeviceUrl(deviceUrl, opts.ssrfPolicy)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers = {
    // SOAP 1.2: el action viaja en el parámetro del Content-Type.
    'Content-Type': `application/soap+xml; charset=utf-8; action="${opts.action}"`,
    Accept: 'application/soap+xml, application/xml, text/xml',
  }

  let res: SoapResponse
  try {
    res = await opts.transport.post(url.toString(), envelope, { headers, timeoutMs })
  } catch (e) {
    const code = (e as { code?: string })?.code
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      throw new OnvifError('TIMEOUT', 'timeout de transporte ONVIF')
    }
    throw new OnvifError('TRANSPORT_ERROR', 'fallo de transporte ONVIF')
  }

  const body = res.body ?? ''
  // SOAP 1.2 puede devolver Fault con 500; detectarlo antes de decidir por status.
  const fault = parseSoapFault(body)
  if (fault) {
    throw new OnvifError('SOAP_FAULT', `SOAP Fault: ${fault.subcode ?? fault.code ?? 'desconocido'}`, res.status)
  }
  if (res.status < 200 || res.status >= 300) {
    throw new OnvifError('TRANSPORT_ERROR', `HTTP ${res.status} del dispositivo ONVIF`, res.status)
  }
  return body
}

/**
 * Transporte por defecto sobre axios (no ejecuta I/O hasta que se llama a post).
 * Pide el XML crudo (sin auto-parseo) y nunca loguea cuerpos ni credenciales.
 */
export function createAxiosSoapTransport(): SoapTransport {
  return {
    async post(url, body, o) {
      const res = await axios.request({
        url,
        method: 'POST',
        data: body,
        headers: o.headers,
        timeout: o.timeoutMs,
        responseType: 'text',
        transformResponse: [(d: unknown) => d], // no parsear: queremos el XML crudo
        validateStatus: () => true, // el status lo evalúa postSoap
        maxRedirects: 0,
      })
      const data = res.data
      return { status: res.status, body: typeof data === 'string' ? data : String(data ?? '') }
    },
  }
}
