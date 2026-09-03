// apps/api/src/services/providers/hik-connect/index.ts
//
// Provider Hik-Connect (P1) — conectividad remota de FALLBACK vía la nube de
// Hikvision/EZVIZ. Compone builders (núcleo puro: token/hls/isapi), parsers y
// validación anti-SSRF (areaDomain + path ISAPI) con el cliente HTTP inyectable.
//
// GATE: todo el provider está detrás de `HIK_CONNECT_ENABLED`:
//   - Con la flag OFF (default) el provider es INERTE: cada método lanza
//     HikConnectError('NOT_ENABLED') y NO se construye ni ejecuta ningún I/O ni
//     se toca red al importar el módulo o al arrancar.
//
// SEGURIDAD:
//   - AppKey/SecretKey son CREDENCIALES: se leen de env/config, jamás se loguean
//     ni se retornan. Si se persistieran, deben cifrarse con services/credentials
//     (AES-256-GCM); este provider las mantiene sólo en memoria.
//   - El accessToken es SECRETO: se cachea en memoria y NUNCA se expone en las
//     respuestas públicas (getToken() devuelve metadatos, no el token).
//   - SSRF: el HLS y el ISAPI-proxy sólo salen al `areaDomain` VALIDADO del
//     token (validate.ts); el `isapiPath` pasa por la validación estricta
//     (isapi.ts). El host destino jamás proviene del input del caller.
//
// LIMITACIÓN CONOCIDA (documentada): la ruta HLS/ISAPI de la nube Hik-Connect
// entrega SÓLO H.264. No hay HEVC/H.265 y no hay transcode en la nube; una
// cámara/canal en HEVC no será reproducible por esta vía. Es un fallback de
// conectividad remota, no un reemplazo del pipeline local.

import { HikConnectError } from './errors'
import { HikConnectClient, createAxiosTransport, type HttpTransport } from './client'
import { assertSafeAreaDomain, type AreaDomainPolicy } from './validate'
import { buildTokenRequest, parseTokenResponse, type ParsedToken } from './token'
import { buildHlsAddressRequest, parseHlsAddress, clampHlsTtl, type HlsAddress } from './hls'
import { buildIsapiProxyRequest } from './isapi'
import type { HttpMethod } from './http-spec'

/** Endpoint global de bootstrap para obtener el token (config; se valida). */
export const DEFAULT_BASE_URL = 'https://open.hik-connect.com'

/** Margen para refrescar el token antes de que expire (ms). */
const TOKEN_REFRESH_MARGIN_MS = 60_000

export type ClockProvider = () => number

export interface HikConnectProviderOptions {
  /** Fuerza el estado del gate (tests). Default: HIK_CONNECT_ENABLED==='true'. */
  enabled?: boolean
  appKey?: string
  secretKey?: string
  /** Base URL de bootstrap del token. Default: DEFAULT_BASE_URL. */
  baseUrl?: string
  /** TTL solicitado para la URL HLS (segundos); se hace clamp a ≤600. */
  hlsTtlSec?: number
  timeoutMs?: number
  /** Transporte HTTP inyectable. Default: axios (perezoso). */
  transport?: HttpTransport
  /** Reloj inyectable (tests deterministas). Default: Date.now. */
  clock?: ClockProvider
  /** Política de validación de areaDomain (sufijos permitidos). */
  areaDomainPolicy?: AreaDomainPolicy
}

/** Metadatos públicos del token — NUNCA incluye el accessToken crudo. */
export interface TokenInfo {
  areaDomain: string
  expireTimeMs: number | null
  /** ¿Hay un token vigente cacheado? */
  active: boolean
}

interface CachedToken extends ParsedToken {
  /** Base URL validada derivada del areaDomain. */
  areaBaseUrl: string
}

export class HikConnectProvider {
  private readonly enabled: boolean
  private readonly appKey: string
  private readonly secretKey: string
  private readonly baseUrl: string
  private readonly hlsTtlSec?: number
  private readonly timeoutMs?: number
  private readonly clock: ClockProvider
  private readonly areaDomainPolicy?: AreaDomainPolicy
  private transport: HttpTransport | null
  private cached: CachedToken | null = null

  constructor(opts: HikConnectProviderOptions = {}) {
    this.enabled = opts.enabled ?? process.env.HIK_CONNECT_ENABLED === 'true'
    this.appKey = opts.appKey ?? process.env.HIK_CONNECT_APP_KEY ?? ''
    this.secretKey = opts.secretKey ?? process.env.HIK_CONNECT_SECRET_KEY ?? ''
    this.baseUrl = opts.baseUrl ?? process.env.HIK_CONNECT_BASE_URL ?? DEFAULT_BASE_URL
    this.hlsTtlSec = opts.hlsTtlSec
    this.timeoutMs = opts.timeoutMs
    this.clock = opts.clock ?? (() => Date.now())
    this.areaDomainPolicy = opts.areaDomainPolicy
    // El transporte por defecto (axios) se resuelve perezosamente: con la flag
    // OFF nunca se crea ⇒ ningún I/O potencial se inicializa.
    this.transport = opts.transport ?? null
  }

  isEnabled(): boolean {
    return this.enabled
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new HikConnectError('NOT_ENABLED', 'Hik-Connect deshabilitado (HIK_CONNECT_ENABLED=false)')
    }
  }

  private requireConfigured(): void {
    if (!this.appKey || !this.secretKey) {
      throw new HikConnectError('NOT_CONFIGURED', 'faltan HIK_CONNECT_APP_KEY / HIK_CONNECT_SECRET_KEY')
    }
  }

  private getTransport(): HttpTransport {
    if (!this.transport) this.transport = createAxiosTransport()
    return this.transport
  }

  private isCacheValid(): boolean {
    if (!this.cached) return false
    const exp = this.cached.expireTimeMs
    if (exp === null) return true // sin expiración informada: usar hasta invalidación externa
    return this.clock() < exp - TOKEN_REFRESH_MARGIN_MS
  }

  /** Obtiene (y cachea) el token interno. Refresca antes de expirar. Uso interno. */
  private async ensureToken(): Promise<CachedToken> {
    if (this.isCacheValid() && this.cached) return this.cached
    // Validar también el endpoint de bootstrap (config): https + host plausible.
    const bootstrapUrl = assertSafeAreaDomain(this.baseUrl, this.areaDomainPolicy)
    const bootstrap = new HikConnectClient({
      baseUrl: `${bootstrapUrl.protocol}//${bootstrapUrl.host}`,
      transport: this.getTransport(),
      timeoutMs: this.timeoutMs,
    })
    const json = await bootstrap.send(buildTokenRequest({ appKey: this.appKey, secretKey: this.secretKey }))
    const parsed = parseTokenResponse(json)
    // VALIDACIÓN ANTI-SSRF del areaDomain antes de usarlo como destino.
    const areaUrl = assertSafeAreaDomain(parsed.areaDomain, this.areaDomainPolicy)
    this.cached = { ...parsed, areaBaseUrl: `${areaUrl.protocol}//${areaUrl.host}` }
    return this.cached
  }

  private areaClient(base: string): HikConnectClient {
    return new HikConnectClient({ baseUrl: base, transport: this.getTransport(), timeoutMs: this.timeoutMs })
  }

  // ─── API pública ────────────────────────────────────────────

  /**
   * Fuerza la obtención/refresh del token y devuelve METADATOS públicos. NUNCA
   * expone el accessToken crudo.
   */
  async getToken(): Promise<TokenInfo> {
    this.requireEnabled()
    this.requireConfigured()
    const t = await this.ensureToken()
    return { areaDomain: t.areaBaseUrl, expireTimeMs: t.expireTimeMs, active: true }
  }

  /**
   * Obtiene una URL HLS temporal (TTL ≤ 600s) para un canal. La URL sale SÓLO al
   * areaDomain validado. Recordá: la nube entrega H.264 únicamente (no HEVC).
   */
  async getHlsAddress(deviceSerial: string, channelNo = 1): Promise<HlsAddress> {
    this.requireEnabled()
    this.requireConfigured()
    if (!deviceSerial) throw new HikConnectError('INVALID_ARG', 'deviceSerial requerido')
    const t = await this.ensureToken()
    const ttl = clampHlsTtl(this.hlsTtlSec)
    const spec = buildHlsAddressRequest({
      accessToken: t.accessToken,
      deviceSerial,
      channelNo,
      expireSec: ttl,
    })
    const json = await this.areaClient(t.areaBaseUrl).send(spec)
    return parseHlsAddress(json, ttl)
  }

  /**
   * Reenvía una request ISAPI al NVR a través de la nube (ISAPI-proxy). El
   * `isapiPath` se valida estrictamente (anti-SSRF/inyección) y el destino es
   * SIEMPRE el areaDomain validado. Devuelve el cuerpo crudo de la respuesta.
   */
  async proxyIsapi(
    deviceSerial: string,
    method: HttpMethod,
    isapiPath: string,
    body?: string,
    channelNo?: number,
  ): Promise<unknown> {
    this.requireEnabled()
    this.requireConfigured()
    if (!deviceSerial) throw new HikConnectError('INVALID_ARG', 'deviceSerial requerido')
    const t = await this.ensureToken()
    const spec = buildIsapiProxyRequest({
      accessToken: t.accessToken,
      deviceSerial,
      method,
      isapiPath,
      body,
      channelNo,
    })
    return this.areaClient(t.areaBaseUrl).send(spec)
  }

  /** Invalida el token cacheado (p.ej. tras un API_ERROR de token vencido). */
  clearToken(): void {
    this.cached = null
  }
}

// Reexports para consumidores (rutas, tests).
export { HikConnectError, isHikConnectError } from './errors'
export type { HikConnectErrorCode } from './errors'
export { assertSafeAreaDomain, DEFAULT_AREA_DOMAIN_SUFFIXES } from './validate'
export { assertSafeIsapiPath } from './isapi'
export { MAX_HLS_TTL_SEC } from './hls'
export type { HlsAddress } from './hls'
export type { HttpMethod } from './http-spec'
