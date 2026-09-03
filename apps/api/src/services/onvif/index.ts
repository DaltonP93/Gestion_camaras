// apps/api/src/services/onvif/index.ts
//
// API del servicio ONVIF (`OnvifService`) — compone builders SOAP (núcleo puro),
// parsers (núcleo puro), WS-Security (núcleo puro) e I/O inyectable (soap-client,
// discovery). Todo el servicio está detrás de `ONVIF_ENABLED`:
//
//   - Con la flag OFF (default) el servicio es INERTE: cada método lanza
//     OnvifError('NOT_ENABLED') y NO se construye ni ejecuta ningún I/O.
//   - No se hace ninguna llamada de red al importar el módulo ni al arranque.
//
// SEGURIDAD:
//   - Las credenciales del dispositivo (usuario/clave ONVIF) se pasan por llamada
//     y sólo se usan para calcular el PasswordDigest WSSE. JAMÁS se loguean ni se
//     retornan.
//   - `deviceUrl` se valida contra SSRF (ver ssrf.ts) en cada POST.

import { OnvifError } from './errors'
import type { SsrfPolicy } from './ssrf'
import {
  buildUsernameToken,
  type NonceProvider,
  type ClockProvider,
} from './ws-security'
import {
  buildGetDeviceInformation,
  buildGetProfiles,
  buildGetStreamUri,
  buildPtzGetConfigurations,
  buildContinuousMove,
  buildPtzStop,
  buildAbsoluteMove,
  buildGetImagingSettings,
  buildSetImagingSettings,
  ACTIONS,
  type PtzVector,
  type GetStreamUriOptions,
  type ImagingSettingsInput,
  type ContinuousMoveOptions,
  type AbsoluteMoveOptions,
  type StopOptions,
} from './soap'
import {
  parseStreamUri,
  parseProfiles,
  parsePtzConfigurations,
  parseImagingSettings,
  tagText,
  type OnvifProfile,
  type PtzConfiguration,
  type ImagingSettings,
} from './parse'
import { postSoap, createAxiosSoapTransport, type SoapTransport } from './soap-client'
import { discover as discoverDevices, type DiscoverOptions, type DiscoveredDevice } from './discovery'

export interface OnvifCredentials {
  username: string
  password: string
}

export interface OnvifServiceOptions {
  /** Fuerza el estado del gate (tests). Default: process.env.ONVIF_ENABLED==='true'. */
  enabled?: boolean
  /** Transporte SOAP inyectable. Default: axios. */
  transport?: SoapTransport
  /** Timeout por request SOAP en ms. */
  timeoutMs?: number
  /** Política SSRF para validar deviceUrl. */
  ssrfPolicy?: SsrfPolicy
  /** Nonce/reloj inyectables para el header WSSE (tests deterministas). */
  nonceProvider?: NonceProvider
  clock?: ClockProvider
}

export interface DeviceInformation {
  manufacturer: string | null
  model: string | null
  firmwareVersion: string | null
  serialNumber: string | null
  hardwareId: string | null
}

export class OnvifService {
  private readonly enabled: boolean
  private readonly timeoutMs?: number
  private readonly ssrfPolicy?: SsrfPolicy
  private readonly nonceProvider?: NonceProvider
  private readonly clock?: ClockProvider
  private transport: SoapTransport | null

  constructor(opts: OnvifServiceOptions = {}) {
    this.enabled = opts.enabled ?? process.env.ONVIF_ENABLED === 'true'
    this.timeoutMs = opts.timeoutMs
    this.ssrfPolicy = opts.ssrfPolicy
    this.nonceProvider = opts.nonceProvider
    this.clock = opts.clock
    // El transporte por defecto (axios) se resuelve perezosamente: con la flag OFF
    // nunca se crea ⇒ ningún I/O potencial se inicializa.
    this.transport = opts.transport ?? null
  }

  isEnabled(): boolean {
    return this.enabled
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new OnvifError('NOT_ENABLED', 'ONVIF deshabilitado (ONVIF_ENABLED=false)')
  }

  private getTransport(): SoapTransport {
    if (!this.transport) this.transport = createAxiosSoapTransport()
    return this.transport
  }

  /** Header WSSE para las credenciales de ESTA llamada (nunca se retiene). */
  private securityHeader(creds: OnvifCredentials): string {
    return buildUsernameToken({
      username: creds.username,
      password: creds.password,
      nonceProvider: this.nonceProvider,
      clock: this.clock,
    }).headerXml
  }

  private async send(deviceUrl: string, action: string, envelope: string): Promise<string> {
    return postSoap(deviceUrl, envelope, {
      transport: this.getTransport(),
      action,
      timeoutMs: this.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
    })
  }

  // ─── WS-Discovery ───────────────────────────────────────────

  /** Descubre dispositivos ONVIF por multicast local. Vacío si no hay respuestas. */
  async discover(opts: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
    this.requireEnabled()
    return discoverDevices({ timeoutMs: this.timeoutMs, ...opts })
  }

  // ─── Device ─────────────────────────────────────────────────

  async getDeviceInformation(deviceUrl: string, creds: OnvifCredentials): Promise<DeviceInformation> {
    this.requireEnabled()
    const env = buildGetDeviceInformation({ securityHeader: this.securityHeader(creds) })
    const body = await this.send(deviceUrl, ACTIONS.GetDeviceInformation, env)
    return {
      manufacturer: tagText(body, 'Manufacturer'),
      model: tagText(body, 'Model'),
      firmwareVersion: tagText(body, 'FirmwareVersion'),
      serialNumber: tagText(body, 'SerialNumber'),
      hardwareId: tagText(body, 'HardwareId'),
    }
  }

  // ─── Media ──────────────────────────────────────────────────

  async getProfiles(deviceUrl: string, creds: OnvifCredentials): Promise<OnvifProfile[]> {
    this.requireEnabled()
    const env = buildGetProfiles({ securityHeader: this.securityHeader(creds) })
    const body = await this.send(deviceUrl, ACTIONS.GetProfiles, env)
    return parseProfiles(body)
  }

  /** Obtiene la URI RTSP de un profile. Lanza PARSE_ERROR si el device no la trae. */
  async getStreamUri(
    deviceUrl: string,
    creds: OnvifCredentials,
    profileToken: string,
    opts: Omit<GetStreamUriOptions, 'securityHeader'> = {},
  ): Promise<string> {
    this.requireEnabled()
    if (!profileToken) throw new OnvifError('INVALID_ARG', 'profileToken requerido')
    const env = buildGetStreamUri(profileToken, { ...opts, securityHeader: this.securityHeader(creds) })
    const body = await this.send(deviceUrl, ACTIONS.GetStreamUri, env)
    const uri = parseStreamUri(body)
    if (!uri) throw new OnvifError('PARSE_ERROR', 'GetStreamUri sin URI en la respuesta')
    return uri
  }

  // ─── PTZ ────────────────────────────────────────────────────

  async getPtzConfigurations(deviceUrl: string, creds: OnvifCredentials): Promise<PtzConfiguration[]> {
    this.requireEnabled()
    const env = buildPtzGetConfigurations({ securityHeader: this.securityHeader(creds) })
    const body = await this.send(deviceUrl, ACTIONS.GetConfigurations, env)
    return parsePtzConfigurations(body)
  }

  /** Movimiento PTZ continuo (velocidad). Recordá llamar ptzStop para detener. */
  async ptzMove(
    deviceUrl: string,
    creds: OnvifCredentials,
    profileToken: string,
    velocity: PtzVector,
    opts: Omit<ContinuousMoveOptions, 'securityHeader'> = {},
  ): Promise<void> {
    this.requireEnabled()
    if (!profileToken) throw new OnvifError('INVALID_ARG', 'profileToken requerido')
    const env = buildContinuousMove(profileToken, velocity, { ...opts, securityHeader: this.securityHeader(creds) })
    await this.send(deviceUrl, ACTIONS.ContinuousMove, env)
  }

  async ptzStop(
    deviceUrl: string,
    creds: OnvifCredentials,
    profileToken: string,
    opts: Omit<StopOptions, 'securityHeader'> = {},
  ): Promise<void> {
    this.requireEnabled()
    if (!profileToken) throw new OnvifError('INVALID_ARG', 'profileToken requerido')
    const env = buildPtzStop(profileToken, { ...opts, securityHeader: this.securityHeader(creds) })
    await this.send(deviceUrl, ACTIONS.Stop, env)
  }

  async ptzAbsoluteMove(
    deviceUrl: string,
    creds: OnvifCredentials,
    profileToken: string,
    position: PtzVector,
    opts: Omit<AbsoluteMoveOptions, 'securityHeader'> = {},
  ): Promise<void> {
    this.requireEnabled()
    if (!profileToken) throw new OnvifError('INVALID_ARG', 'profileToken requerido')
    const env = buildAbsoluteMove(profileToken, position, { ...opts, securityHeader: this.securityHeader(creds) })
    await this.send(deviceUrl, ACTIONS.AbsoluteMove, env)
  }

  // ─── Imaging ────────────────────────────────────────────────

  async getImaging(deviceUrl: string, creds: OnvifCredentials, videoSourceToken: string): Promise<ImagingSettings> {
    this.requireEnabled()
    if (!videoSourceToken) throw new OnvifError('INVALID_ARG', 'videoSourceToken requerido')
    const env = buildGetImagingSettings(videoSourceToken, { securityHeader: this.securityHeader(creds) })
    const body = await this.send(deviceUrl, ACTIONS.GetImagingSettings, env)
    return parseImagingSettings(body)
  }

  /** Aplica ajustes de imagen (incl. IrCutFilter / Focus). */
  async setImaging(
    deviceUrl: string,
    creds: OnvifCredentials,
    videoSourceToken: string,
    settings: ImagingSettingsInput,
  ): Promise<void> {
    this.requireEnabled()
    if (!videoSourceToken) throw new OnvifError('INVALID_ARG', 'videoSourceToken requerido')
    const env = buildSetImagingSettings(videoSourceToken, settings, { securityHeader: this.securityHeader(creds) })
    await this.send(deviceUrl, ACTIONS.SetImagingSettings, env)
  }
}

// Reexports para consumidores (rutas, tests).
export { OnvifError, isOnvifError } from './errors'
export type { OnvifErrorCode } from './errors'
export type { SsrfPolicy } from './ssrf'
export { assertSafeDeviceUrl } from './ssrf'
export type { DiscoveredDevice } from './discovery'
export type { OnvifProfile, PtzConfiguration, ImagingSettings } from './parse'
export type { PtzVector, ImagingSettingsInput, IrCutFilterMode } from './soap'
