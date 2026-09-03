// apps/api/src/services/providers/hik-connect/errors.ts
//
// Errores tipados del provider Hik-Connect. Código estable + mensaje SIN
// secretos. NUNCA incrustar appKey, secretKey, accessToken ni cuerpos crudos en
// el mensaje: el mensaje puede terminar en logs o en respuestas de la API.

export type HikConnectErrorCode =
  | 'NOT_ENABLED' // HIK_CONNECT_ENABLED != true ⇒ provider inerte
  | 'NOT_CONFIGURED' // faltan appKey/secretKey
  | 'INVALID_AREA_DOMAIN' // areaDomain no https / host no plausible / IP privada / metadatos
  | 'INVALID_ISAPI_PATH' // ruta ISAPI fuera del patrón permitido (anti-SSRF/inyección)
  | 'INVALID_ARG' // argumento inválido en la llamada
  | 'TIMEOUT' // el transporte agotó el tiempo
  | 'TRANSPORT_ERROR' // fallo de red / socket / status no-2xx
  | 'PARSE_ERROR' // respuesta no interpretable (JSON/campos ausentes)
  | 'API_ERROR' // Hik-Connect respondió code != 200

export class HikConnectError extends Error {
  readonly code: HikConnectErrorCode
  /** Código de negocio de Hik-Connect (`code`), si aplica. Nunca un secreto. */
  readonly apiCode?: string
  /** Estado HTTP del transporte, si aplica (diagnóstico, nunca cuerpo). */
  readonly httpStatus?: number

  constructor(
    code: HikConnectErrorCode,
    message: string,
    opts: { apiCode?: string; httpStatus?: number } = {},
  ) {
    super(message)
    this.name = 'HikConnectError'
    this.code = code
    this.apiCode = opts.apiCode
    this.httpStatus = opts.httpStatus
    Object.setPrototypeOf(this, HikConnectError.prototype)
  }
}

export function isHikConnectError(e: unknown): e is HikConnectError {
  return e instanceof HikConnectError
}
