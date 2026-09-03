// apps/api/src/services/onvif/errors.ts
//
// Errores tipados del servicio ONVIF. Código estable + mensaje sin secretos.
// NUNCA incrustar credenciales, nonces ni cuerpos SOAP completos en el mensaje.

export type OnvifErrorCode =
  | 'NOT_ENABLED'      // ONVIF_ENABLED != true ⇒ servicio inerte
  | 'SSRF_BLOCKED'     // deviceUrl fuera del rango permitido / metadatos cloud
  | 'INVALID_URL'      // deviceUrl no parseable o esquema no http(s)
  | 'TIMEOUT'          // el transporte agotó el tiempo
  | 'TRANSPORT_ERROR'  // fallo de red / socket / status no-2xx
  | 'SOAP_FAULT'       // el dispositivo respondió un <Fault>
  | 'PARSE_ERROR'      // respuesta no interpretable (URI/profiles/etc. ausentes)
  | 'INVALID_ARG'      // argumento inválido en la llamada

export class OnvifError extends Error {
  readonly code: OnvifErrorCode
  /** Estado HTTP del transporte, si aplica (diagnóstico, nunca cuerpo). */
  readonly httpStatus?: number

  constructor(code: OnvifErrorCode, message: string, httpStatus?: number) {
    super(message)
    this.name = 'OnvifError'
    this.code = code
    this.httpStatus = httpStatus
    Object.setPrototypeOf(this, OnvifError.prototype)
  }
}

export function isOnvifError(e: unknown): e is OnvifError {
  return e instanceof OnvifError
}
