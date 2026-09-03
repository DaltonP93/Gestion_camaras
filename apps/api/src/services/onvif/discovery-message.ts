// apps/api/src/services/onvif/discovery-message.ts
//
// NÚCLEO PURO — mensaje Probe de WS-Discovery (SOAP-over-UDP) y utilidades de
// parseo asociadas. Sin I/O: sólo construye el XML y reexporta el parser de
// ProbeMatches. El envío/recepción multicast vive en discovery.ts (I/O).
//
// El Probe se envía a 239.255.255.250:3702. Buscamos dispositivos ONVIF (tipo
// `dn:NetworkVideoTransmitter` del namespace de red ONVIF).

import crypto from 'crypto'
import { parseProbeMatches, type ProbeMatch } from './parse'

export const WS_DISCOVERY_ADDR = '239.255.255.250'
export const WS_DISCOVERY_PORT = 3702

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  a: 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
  d: 'http://schemas.xmlsoap.org/ws/2005/04/discovery',
  dn: 'http://www.onvif.org/ver10/network/wsdl',
} as const

export const PROBE_ACTION = 'http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe'

export interface ProbeMessageOptions {
  /** MessageID único (urn:uuid:…). Inyectable para tests deterministas. */
  messageId?: string
  /** Tipo a descubrir. Default NetworkVideoTransmitter (cámaras/NVR ONVIF). */
  type?: string
}

/** Genera un urn:uuid v4 aleatorio (usa crypto del runtime). */
export function randomMessageId(): string {
  // crypto.randomUUID está disponible en Node >=16.7.
  return `urn:uuid:${crypto.randomUUID()}`
}

/**
 * Construye el mensaje SOAP Probe de WS-Discovery. Puro y determinista si se
 * pasa `messageId`.
 */
export function buildProbeMessage(opts: ProbeMessageOptions = {}): string {
  const messageId = opts.messageId ?? randomMessageId()
  const type = opts.type ?? 'dn:NetworkVideoTransmitter'
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:d="${NS.d}" xmlns:dn="${NS.dn}">` +
    `<s:Header>` +
    `<a:Action s:mustUnderstand="1">${PROBE_ACTION}</a:Action>` +
    `<a:MessageID>${messageId}</a:MessageID>` +
    `<a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>` +
    `</s:Header>` +
    `<s:Body>` +
    `<d:Probe><d:Types>${type}</d:Types><d:Scopes/></d:Probe>` +
    `</s:Body>` +
    `</s:Envelope>`
  )
}

export { parseProbeMatches }
export type { ProbeMatch }
