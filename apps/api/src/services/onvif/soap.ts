// apps/api/src/services/onvif/soap.ts
//
// NÚCLEO PURO — builders de sobres SOAP 1.2 para operaciones ONVIF.
// Sin I/O: cada builder devuelve el XML del sobre completo (string). El header
// WS-Security (si se pasa) se inyecta tal cual en <s:Header>.
//
// Operaciones cubiertas:
//   Device : GetDeviceInformation
//   Media  : GetProfiles, GetStreamUri
//   PTZ    : GetConfigurations, ContinuousMove, Stop, AbsoluteMove
//   Imaging: GetImagingSettings, SetImagingSettings (IrCutFilter/Focus)
//
// Namespaces ONVIF estándar. Los espacios de nombres de las operaciones sirven
// también como SOAPAction (ver ACTIONS) para el transporte.

import { xmlEscape } from './xml-escape'

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  timg: 'http://www.onvif.org/ver20/imaging/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
} as const

/** SOAPAction por operación (SOAP 1.2 lo transporta en el Content-Type). */
export const ACTIONS = {
  GetDeviceInformation: `${NS.tds}/GetDeviceInformation`,
  GetProfiles: `${NS.trt}/GetProfiles`,
  GetStreamUri: `${NS.trt}/GetStreamUri`,
  GetConfigurations: `${NS.tptz}/GetConfigurations`,
  ContinuousMove: `${NS.tptz}/ContinuousMove`,
  Stop: `${NS.tptz}/Stop`,
  AbsoluteMove: `${NS.tptz}/AbsoluteMove`,
  GetImagingSettings: `${NS.timg}/GetImagingSettings`,
  SetImagingSettings: `${NS.timg}/SetImagingSettings`,
} as const

export interface EnvelopeOpts {
  /** Fragmento XML del header WS-Security (de buildUsernameToken). Opcional. */
  securityHeader?: string
}

/** Compone un sobre SOAP 1.2 con el body dado y un header opcional. */
export function soapEnvelope(bodyXml: string, opts: EnvelopeOpts = {}): string {
  const header = opts.securityHeader ? `<s:Header>${opts.securityHeader}</s:Header>` : ''
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS.s}">` +
    header +
    `<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema">${bodyXml}</s:Body>` +
    `</s:Envelope>`
  )
}

// ─── Device ───────────────────────────────────────────────────

export function buildGetDeviceInformation(opts?: EnvelopeOpts): string {
  return soapEnvelope(`<tds:GetDeviceInformation xmlns:tds="${NS.tds}"/>`, opts)
}

// ─── Media ────────────────────────────────────────────────────

export function buildGetProfiles(opts?: EnvelopeOpts): string {
  return soapEnvelope(`<trt:GetProfiles xmlns:trt="${NS.trt}"/>`, opts)
}

export type StreamTransport = 'UDP' | 'TCP' | 'RTSP' | 'HTTP'

export interface GetStreamUriOptions extends EnvelopeOpts {
  /** Stream deseado. Default RTP-Unicast. */
  stream?: 'RTP-Unicast' | 'RTP-Multicast'
  /** Protocolo de transporte. Default RTSP (lo habitual para URI RTSP). */
  protocol?: StreamTransport
}

export function buildGetStreamUri(profileToken: string, opts: GetStreamUriOptions = {}): string {
  if (!profileToken) throw new Error('buildGetStreamUri: profileToken requerido')
  const stream = opts.stream ?? 'RTP-Unicast'
  const protocol = opts.protocol ?? 'RTSP'
  const body =
    `<trt:GetStreamUri xmlns:trt="${NS.trt}" xmlns:tt="${NS.tt}">` +
    `<trt:StreamSetup>` +
    `<tt:Stream>${stream}</tt:Stream>` +
    `<tt:Transport><tt:Protocol>${protocol}</tt:Protocol></tt:Transport>` +
    `</trt:StreamSetup>` +
    `<trt:ProfileToken>${xmlEscape(profileToken)}</trt:ProfileToken>` +
    `</trt:GetStreamUri>`
  return soapEnvelope(body, opts)
}

// ─── PTZ ──────────────────────────────────────────────────────

export function buildPtzGetConfigurations(opts?: EnvelopeOpts): string {
  return soapEnvelope(`<tptz:GetConfigurations xmlns:tptz="${NS.tptz}"/>`, opts)
}

export interface PtzVector {
  /** Pan [-1,1] */ x?: number
  /** Tilt [-1,1] */ y?: number
  /** Zoom [-1,1] */ zoom?: number
}

function panTiltZoomXml(v: PtzVector): string {
  let out = ''
  if (v.x !== undefined || v.y !== undefined) {
    out += `<tt:PanTilt x="${numAttr(v.x ?? 0)}" y="${numAttr(v.y ?? 0)}"/>`
  }
  if (v.zoom !== undefined) out += `<tt:Zoom x="${numAttr(v.zoom)}"/>`
  return out
}

/** Serializa un número finito para un atributo XML; rechaza NaN/Infinity. */
function numAttr(n: number): string {
  if (!Number.isFinite(n)) throw new Error('PTZ: valor numérico inválido')
  return String(n)
}

export interface ContinuousMoveOptions extends EnvelopeOpts {
  /** Timeout de auto-stop (ISO-8601 duration, p.ej. "PT1S"). Opcional. */
  timeout?: string
}

export function buildContinuousMove(
  profileToken: string,
  velocity: PtzVector,
  opts: ContinuousMoveOptions = {},
): string {
  if (!profileToken) throw new Error('buildContinuousMove: profileToken requerido')
  const timeout = opts.timeout ? `<tptz:Timeout>${xmlEscape(opts.timeout)}</tptz:Timeout>` : ''
  const body =
    `<tptz:ContinuousMove xmlns:tptz="${NS.tptz}" xmlns:tt="${NS.tt}">` +
    `<tptz:ProfileToken>${xmlEscape(profileToken)}</tptz:ProfileToken>` +
    `<tptz:Velocity>${panTiltZoomXml(velocity)}</tptz:Velocity>` +
    timeout +
    `</tptz:ContinuousMove>`
  return soapEnvelope(body, opts)
}

export interface StopOptions extends EnvelopeOpts {
  panTilt?: boolean
  zoom?: boolean
}

export function buildPtzStop(profileToken: string, opts: StopOptions = {}): string {
  if (!profileToken) throw new Error('buildPtzStop: profileToken requerido')
  const panTilt = opts.panTilt ?? true
  const zoom = opts.zoom ?? true
  const body =
    `<tptz:Stop xmlns:tptz="${NS.tptz}">` +
    `<tptz:ProfileToken>${xmlEscape(profileToken)}</tptz:ProfileToken>` +
    `<tptz:PanTilt>${panTilt}</tptz:PanTilt>` +
    `<tptz:Zoom>${zoom}</tptz:Zoom>` +
    `</tptz:Stop>`
  return soapEnvelope(body, opts)
}

export interface AbsoluteMoveOptions extends EnvelopeOpts {
  speed?: PtzVector
}

export function buildAbsoluteMove(
  profileToken: string,
  position: PtzVector,
  opts: AbsoluteMoveOptions = {},
): string {
  if (!profileToken) throw new Error('buildAbsoluteMove: profileToken requerido')
  const speed = opts.speed ? `<tptz:Speed>${panTiltZoomXml(opts.speed)}</tptz:Speed>` : ''
  const body =
    `<tptz:AbsoluteMove xmlns:tptz="${NS.tptz}" xmlns:tt="${NS.tt}">` +
    `<tptz:ProfileToken>${xmlEscape(profileToken)}</tptz:ProfileToken>` +
    `<tptz:Position>${panTiltZoomXml(position)}</tptz:Position>` +
    speed +
    `</tptz:AbsoluteMove>`
  return soapEnvelope(body, opts)
}

// ─── Imaging ──────────────────────────────────────────────────

export function buildGetImagingSettings(videoSourceToken: string, opts: EnvelopeOpts = {}): string {
  if (!videoSourceToken) throw new Error('buildGetImagingSettings: videoSourceToken requerido')
  const body =
    `<timg:GetImagingSettings xmlns:timg="${NS.timg}">` +
    `<timg:VideoSourceToken>${xmlEscape(videoSourceToken)}</timg:VideoSourceToken>` +
    `</timg:GetImagingSettings>`
  return soapEnvelope(body, opts)
}

export type IrCutFilterMode = 'ON' | 'OFF' | 'AUTO'
export type FocusAutoMode = 'AUTO' | 'MANUAL'

export interface ImagingSettingsInput {
  brightness?: number
  contrast?: number
  colorSaturation?: number
  sharpness?: number
  /** Filtro de corte IR — clave para visión nocturna. */
  irCutFilter?: IrCutFilterMode
  /** Enfoque. `autoFocusMode` AUTO/MANUAL; `defaultSpeed` opcional. */
  focus?: { autoFocusMode?: FocusAutoMode; defaultSpeed?: number }
}

function tag(ns: string, name: string, value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Imaging: ${name} inválido`)
  return `<${ns}:${name}>${value}</${ns}:${name}>`
}

export function buildSetImagingSettings(
  videoSourceToken: string,
  settings: ImagingSettingsInput,
  opts: EnvelopeOpts = {},
): string {
  if (!videoSourceToken) throw new Error('buildSetImagingSettings: videoSourceToken requerido')
  let inner = ''
  if (settings.brightness !== undefined) inner += tag('tt', 'Brightness', settings.brightness)
  if (settings.colorSaturation !== undefined) inner += tag('tt', 'ColorSaturation', settings.colorSaturation)
  if (settings.contrast !== undefined) inner += tag('tt', 'Contrast', settings.contrast)
  if (settings.sharpness !== undefined) inner += tag('tt', 'Sharpness', settings.sharpness)
  if (settings.irCutFilter !== undefined) {
    if (!['ON', 'OFF', 'AUTO'].includes(settings.irCutFilter)) throw new Error('Imaging: irCutFilter inválido')
    inner += `<tt:IrCutFilter>${settings.irCutFilter}</tt:IrCutFilter>`
  }
  if (settings.focus) {
    let focusInner = ''
    if (settings.focus.autoFocusMode !== undefined) {
      if (!['AUTO', 'MANUAL'].includes(settings.focus.autoFocusMode)) throw new Error('Imaging: autoFocusMode inválido')
      focusInner += `<tt:AutoFocusMode>${settings.focus.autoFocusMode}</tt:AutoFocusMode>`
    }
    if (settings.focus.defaultSpeed !== undefined) focusInner += tag('tt', 'DefaultSpeed', settings.focus.defaultSpeed)
    inner += `<tt:Focus>${focusInner}</tt:Focus>`
  }
  const body =
    `<timg:SetImagingSettings xmlns:timg="${NS.timg}" xmlns:tt="${NS.tt}">` +
    `<timg:VideoSourceToken>${xmlEscape(videoSourceToken)}</timg:VideoSourceToken>` +
    `<timg:ImagingSettings>${inner}</timg:ImagingSettings>` +
    `<timg:ForcePersistence>true</timg:ForcePersistence>` +
    `</timg:SetImagingSettings>`
  return soapEnvelope(body, opts)
}

export { NS as ONVIF_NS }
