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
import {
  METADATA_HOSTS,
  isIpv4,
  isPrivateIpv4,
  isLinkLocalIpv4,
  isPrivateIpv6,
  isLinkLocalIpv6,
  looksLikeIpv6,
} from '../net/ip-classify'

export interface SsrfPolicy {
  /** Hostnames extra permitidos (exactos, en minúscula). Default vacío. */
  allowedHosts?: string[]
  /** Permitir IPs públicas (SÓLO si el operador lo decide). Default false. */
  allowPublic?: boolean
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
