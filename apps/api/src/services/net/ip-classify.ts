// apps/api/src/services/net/ip-classify.ts
//
// NÚCLEO PURO y compartido — clasificación sintáctica de hosts/IPs para las
// defensas SSRF de VisionCore (ONVIF y NVR Hikvision). Sin dependencias de
// errores ni de red: sólo predicados deterministas ⇒ testeables y reutilizables.
//
// NO resuelve DNS (eso ocurre al conectar); por eso los hostnames se acotan
// fuerte aguas arriba. Aquí sólo se clasifican literales y hostnames conocidos.

/** Hostnames de metadatos cloud (bloqueo duro en cualquier política). */
export const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  'metadata.goog',
])

export function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

export function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return parts
}

/** ¿La IPv4 está en un rango privado/loopback/CGNAT? (incluye loopback 127/8). */
export function isPrivateIpv4(host: string): boolean {
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

/** Loopback IPv4 127.0.0.0/8. */
export function isLoopbackIpv4(host: string): boolean {
  const o = ipv4Octets(host)
  return !!o && o[0] === 127
}

/** IPv4 no especificada 0.0.0.0 (todo el /8 0.0.0.0/8 es inválido como destino). */
export function isUnspecifiedIpv4(host: string): boolean {
  const o = ipv4Octets(host)
  return !!o && o[0] === 0
}

export function isLinkLocalIpv4(host: string): boolean {
  const o = ipv4Octets(host)
  return !!o && o[0] === 169 && o[1] === 254 // 169.254.0.0/16 (incluye metadatos)
}

export function normalizeIpv6(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

export function isPrivateIpv6(host: string): boolean {
  const h = normalizeIpv6(host)
  if (h === '::1') return true // loopback
  if (h.startsWith('fc') || h.startsWith('fd')) return true // ULA fc00::/7
  return false
}

export function isLoopbackIpv6(host: string): boolean {
  return normalizeIpv6(host) === '::1'
}

/** IPv6 no especificada :: (todo cero). */
export function isUnspecifiedIpv6(host: string): boolean {
  const h = normalizeIpv6(host)
  return h === '::' || /^0+(:0+)*$/.test(h)
}

export function isLinkLocalIpv6(host: string): boolean {
  return normalizeIpv6(host).startsWith('fe80') // link-local
}

export function looksLikeIpv6(host: string): boolean {
  return host.includes(':')
}
