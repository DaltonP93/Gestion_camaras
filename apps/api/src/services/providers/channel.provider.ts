// apps/api/src/services/providers/channel.provider.ts
//
// Envío de alertas a canales de webhook salientes configurados por un ADMIN:
// Slack (Incoming Webhook), Microsoft Teams (connector) y un Webhook genérico
// (HTTP POST JSON, compatible con n8n/Zapier/IFTTT).
//
// SEGURIDAD (SSRF): la URL la define un ADMIN, así que se valida el destino antes
// de conectar. Se permiten destinos públicos y LAN privada (el VMS suele vivir en
// LAN y el webhook genérico puede ser on-prem), pero se BLOQUEAN los vectores SSRF
// clásicos: endpoint de metadatos cloud, loopback, link-local y no-especificada.
// `maxRedirects:0` evita que un 3xx redirija a un destino interno.

import axios from 'axios'
import { redactIps } from '../../lib/log-redact'

export type ChannelKind = 'slack' | 'teams' | 'webhook'

export interface ChannelAlert {
  type: string
  severity: string
  message: string
  nvrId?: string | null
  cameraId?: string | null
  nvrName?: string | null
  cameraName?: string | null
}

export interface ChannelSendResult {
  success: boolean
  status?: number
  error?: string
  errorCode?: string
}

const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata', 'metadata.goog', '100.100.100.200'])

/** Valida la URL del webhook (SSRF). Lanza Error con code legible si es insegura. */
export function assertSafeWebhookUrl(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { const e = new Error('URL inválida') as any; e.code = 'INVALID_URL'; throw e }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') { const e = new Error('esquema no permitido') as any; e.code = 'INVALID_SCHEME'; throw e }
  const host = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const block = (code: string) => { const e = new Error('destino de webhook bloqueado (SSRF)') as any; e.code = code; throw e }
  if (METADATA_HOSTS.has(host)) block('SSRF_METADATA')
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '::') block('SSRF_LOOPBACK')
  if (/^127\./.test(host)) block('SSRF_LOOPBACK')
  if (/^169\.254\./.test(host)) block('SSRF_LINK_LOCAL')          // incluye el metadata IPv4
  if (host.startsWith('fe80')) block('SSRF_LINK_LOCAL')            // IPv6 link-local
  if (host === 'fd00:ec2::254') block('SSRF_METADATA')             // AWS IMDS IPv6
  return u
}

const SEVERITY_EMOJI: Record<string, string> = { LOW: '🔵', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' }

function summaryLine(a: ChannelAlert): string {
  const where = a.cameraName ? ` · ${a.cameraName}` : a.nvrName ? ` · ${a.nvrName}` : ''
  return `${SEVERITY_EMOJI[a.severity] || '⚪'} *VisionCore* [${a.severity}] ${a.type}${where}\n${a.message}`
}

/** Construye el payload por canal. El genérico lleva los campos estructurados que
 *  la UI promete (type, severity, message, nvrId, cameraId, timestamp). */
export function buildChannelPayload(kind: ChannelKind, a: ChannelAlert): unknown {
  const text = summaryLine(a)
  if (kind === 'slack') return { text }
  if (kind === 'teams') {
    return {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: `VisionCore ${a.severity}: ${a.type}`,
      themeColor: a.severity === 'CRITICAL' ? 'ef4444' : a.severity === 'HIGH' ? 'f97316' : 'f59e0b',
      title: `VisionCore — ${a.type} (${a.severity})`,
      text: a.message + (a.cameraName ? `\n\nCámara: ${a.cameraName}` : '') + (a.nvrName ? `\n\nNVR: ${a.nvrName}` : ''),
    }
  }
  // webhook genérico
  return {
    source: 'visioncore',
    type: a.type,
    severity: a.severity,
    message: a.message,
    nvrId: a.nvrId ?? null,
    cameraId: a.cameraId ?? null,
    nvrName: a.nvrName ?? null,
    cameraName: a.cameraName ?? null,
    timestamp: new Date().toISOString(),
  }
}

/** POST del payload al webhook. Valida SSRF, timeout corto, sin redirecciones.
 *  Nunca propaga: devuelve un resultado con success/errorCode (redactado). */
export async function sendToChannel(kind: ChannelKind, url: string, alert: ChannelAlert): Promise<ChannelSendResult> {
  let target: URL
  try {
    target = assertSafeWebhookUrl(url)
  } catch (e: any) {
    return { success: false, error: 'destino inseguro o inválido', errorCode: e?.code || 'INVALID_URL' }
  }
  try {
    const res = await axios.post(target.toString(), buildChannelPayload(kind, alert), {
      timeout: 8000,
      maxRedirects: 0,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    })
    if (res.status >= 200 && res.status < 300) return { success: true, status: res.status }
    return { success: false, status: res.status, error: `HTTP ${res.status}`, errorCode: `HTTP_${res.status}` }
  } catch (e: any) {
    // Redactar cualquier host/IP embebido en el mensaje de error.
    return { success: false, error: redactIps(String(e?.message ?? 'error')), errorCode: e?.code || 'SEND_FAIL' }
  }
}
