// apps/api/src/services/onvif/ssrf.ts
//
// NÚCLEO PURO — validación SSRF de `deviceUrl` para ONVIF.
//
// MODELO DE AMENAZA: `deviceUrl` proviene de configuración o de WS-Discovery en
// la red LOCAL (los XAddrs de un ProbeMatch son la IP LAN del dispositivo). El
// servicio nunca debe usarse para alcanzar destinos arbitrarios ni el endpoint
// de metadatos de la nube. Mitigación (defensa en profundidad):
//
//   1. Esquema debe ser http/https (nada de file:, gopher:, dict:, etc.).
//   2. Se BLOQUEA explícitamente el endpoint de metadatos cloud
//      (169.254.169.254 y todo 169.254.0.0/16 link-local, y hostnames de
//      metadatos conocidos).
//   3. Literales IP: SÓLO se permiten rangos privados/loopback (RFC1918, CGNAT
//      100.64/10, loopback, ULA fc00::/7, IPv6 loopback). Se rechazan IPs
//      públicas → un atacante no puede pivotar a Internet.
//   4. Hostnames (no IP): sólo `localhost` y sufijos `.local`/`.lan` (mDNS/LAN).
//      Otros hostnames se rechazan por defecto para evitar DNS-rebinding hacia
//      metadatos o destinos externos. `allowedHosts` permite ampliar de forma
//      explícita si la operación lo requiere.
//
// NO resuelve DNS aquí (eso ocurre al conectar); por eso los hostnames se acotan
// fuerte. La comprobación es puramente sintáctica y determinista ⇒ testeable.

import { OnvifError } from './errors'

export interface SsrfPolicy {
  /** Hostnames extra permitidos (exactos, en minúscula). Default vacío. */
  allowedHosts?: string[]
  /** Permitir IPs públicas (SÓLO si el operador lo decide). Default false. */
  allowPublic?: boolean
}

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  'metadata.goog',
])

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return parts
}

/** ¿La IPv4 está en un rango privado/loopback/CGNAT permitido? */
function isPrivateIpv4(host: string): boolean {
  const o = ipv4Octets(host)
  if (!o) return false
  const [a, b] = o
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

function isLinkLocalIpv4(host: string): boolean {
  const o = ipv4Octets(host)
  return !!o && o[0] === 169 && o[1] === 254 // 169.254.0.0/16 (incluye metadatos)
}

function normalizeIpv6(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

function isPrivateIpv6(host: string): boolean {
  const h = normalizeIpv6(host)
  if (h === '::1') return true // loopback
  if (h.startsWith('fc') || h.startsWith('fd')) return true // ULA fc00::/7
  return false
}

function isLinkLocalIpv6(host: string): boolean {
  const h = normalizeIpv6(host)
  return h.startsWith('fe80') // link-local
}

function looksLikeIpv6(host: string): boolean {
  return host.includes(':')
}

/**
 * Valida `deviceUrl` según la política SSRF. Lanza OnvifError('INVALID_URL' o
 * 'SSRF_BLOCKED') si no es segura. Devuelve el objeto URL parseado si es válida.
 */
export function assertSafeDeviceUrl(deviceUrl: string, policy: SsrfPolicy = {}): URL {
  let url: URL
  try {
    url = new URL(deviceUrl)
  } catch {
    throw new OnvifError('INVALID_URL', 'deviceUrl no es una URL válida')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OnvifError('INVALID_URL', `esquema no permitido: ${url.protocol}`)
  }

  const rawHost = url.hostname
  const host = rawHost.toLowerCase()
  const allowed = new Set((policy.allowedHosts ?? []).map((h) => h.toLowerCase()))

  // 1) Metadatos cloud / link-local: bloqueo duro (aunque estén en allowedHosts).
  if (METADATA_HOSTS.has(host)) throw new OnvifError('SSRF_BLOCKED', 'destino de metadatos cloud bloqueado')

  if (isIpv4(host)) {
    if (isLinkLocalIpv4(host)) throw new OnvifError('SSRF_BLOCKED', 'IP link-local bloqueada')
    if (isPrivateIpv4(host) || policy.allowPublic || allowed.has(host)) return url
    throw new OnvifError('SSRF_BLOCKED', 'IP fuera del rango privado permitido')
  }

  if (looksLikeIpv6(host)) {
    if (isLinkLocalIpv6(host)) throw new OnvifError('SSRF_BLOCKED', 'IPv6 link-local bloqueada')
    if (isPrivateIpv6(host) || policy.allowPublic || allowed.has(host)) return url
    throw new OnvifError('SSRF_BLOCKED', 'IPv6 fuera del rango privado permitido')
  }

  // Hostname (no IP): sólo localhost / *.local / *.lan / allowedHosts (o allowPublic).
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    allowed.has(host) ||
    policy.allowPublic
  ) {
    return url
  }
  throw new OnvifError('SSRF_BLOCKED', 'hostname no permitido para ONVIF (LAN-only)')
}
