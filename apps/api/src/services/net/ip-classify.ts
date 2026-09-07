// apps/api/src/services/net/ip-classify.ts
//
// NÚCLEO PURO y compartido — clasificación sintáctica de hosts/IPs para las
// defensas SSRF de VisionCore (ONVIF y NVR Hikvision). Sin dependencias de
// errores ni de red: sólo predicados deterministas ⇒ testeables y reutilizables.
//
// NO resuelve DNS (eso ocurre al conectar); por eso los hostnames se acotan
// fuerte aguas arriba. Aquí sólo se clasifican literales y hostnames conocidos.

/** Hostnames / IPs literales de metadatos de proveedor cloud (bloqueo duro en
 *  cualquier política). Incluye AWS/GCP/Azure (169.254.169.254, ya cae en
 *  link-local) y Alibaba (100.100.100.200), que CAE dentro del rango CGNAT
 *  100.64.0.0/10 — de otro modo `isPrivateIpv4` lo daría por LAN legítima. */
export const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',      // Alibaba Cloud ECS metadata (dentro de CGNAT)
  'metadata.google.internal',
  'metadata',
  'metadata.goog',
])

/** Endpoints de metadatos de proveedor sobre IPv6 (forma normalizada, sin
 *  brackets y en minúsculas). fd00:ec2::254 (AWS IMDS IPv6) cae en ULA fc00::/7,
 *  así que `isPrivateIpv6` lo permitiría — hay que bloquearlo explícitamente. */
export const METADATA_IPV6 = new Set([
  'fd00:ec2::254',
])

/** Forma SINTÁCTICA de cuádruple punteado (4 grupos de 1-3 dígitos), posiblemente
 *  NO canónica (p. ej. con ceros a la izquierda). Se usa para detectar "parece una
 *  IPv4 literal" y exigir entonces forma canónica. */
export function isDottedQuadShape(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

// Octeto CANÓNICO: sin ceros a la izquierda (excepto el octeto exacto "0").
const CANONICAL_OCTET = /^(0|[1-9]\d{0,2})$/

/**
 * IPv4 CANÓNICA ⇒ octetos. Rechaza ceros a la izquierda ("010", "00"), porque
 * WHATWG URL / axios los interpretan como OCTAL ("010" → 8): un guard que los lea
 * como decimal validaría un destino DISTINTO del que se conecta (bypass SSRF por
 * parser diferencial). El octeto exacto "0" sí es válido. Devuelve null si no es
 * canónica o está fuera de rango.
 */
export function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!CANONICAL_OCTET.test(p)) return null
    const n = Number(p)
    if (n < 0 || n > 255) return null
    out.push(n)
  }
  return out
}

/** IPv4 literal CANÓNICA (estricta: sin ceros a la izquierda). */
export function isIpv4(host: string): boolean {
  return ipv4Octets(host) !== null
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

/** Normalización LÉXICA (sólo brackets + minúsculas). Conservada por
 *  compatibilidad; para comparar IPs por VALOR usar `expandIpv6` (semántica). */
export function normalizeIpv6(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

/**
 * Expansión SEMÁNTICA de una IPv6 a su forma canónica de 8 hextetos de 4 dígitos
 * (p. ej. `fd00:ec2::254`, `FD00:EC2::254`, `[fd00:ec2::254]` y
 * `fd00:0ec2:0000:0000:0000:0000:0000:0254` → todas dan
 * `fd00:0ec2:0000:0000:0000:0000:0000:0254`). Devuelve `null` si NO es una IPv6
 * válida — el llamador debe tratar `null` como fail-closed, no como "no aplica".
 *
 * Sin esto, la comparación era léxica: una forma expandida (o con IPv4 embebida)
 * del endpoint de metadatos evadía el set de bloqueo y caía en la allow de ULA.
 * Soporta IPv4 embebida en el último grupo (`::ffff:192.168.0.1`) y descarta el
 * zone-id (`%eth0`), que no es válido para un destino remoto.
 */
export function expandIpv6(raw: string): string | null {
  if (raw == null) return null
  let h = raw.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  // Zone-id (scope-id, `%eth0`): NO es un destino remoto válido. Se RECHAZA (null),
  // no se elimina en silencio — eliminarlo cambiaría el host que se valida vs. el
  // que se conecta.
  if (h.includes('%')) return null
  if (!h.includes(':')) return null   // no es IPv6
  if (/[^0-9a-f:.]/.test(h)) return null

  const dbl = (h.match(/::/g) || []).length
  if (dbl > 1) return null

  const toHextets = (parts: string[]): string[] | null => {
    const out: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (p === '') return null // grupo vacío fuera de '::' ⇒ inválido
      if (p.includes('.')) {
        if (i !== parts.length - 1) return null // IPv4 sólo como último componente
        const o = ipv4Octets(p)
        if (!o) return null
        out.push((((o[0] << 8) | o[1]) >>> 0).toString(16).padStart(4, '0'))
        out.push((((o[2] << 8) | o[3]) >>> 0).toString(16).padStart(4, '0'))
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(p)) return null
        out.push(p.padStart(4, '0'))
      }
    }
    return out
  }

  let full: string[]
  if (dbl === 1) {
    const [l, r] = h.split('::')
    const head = l ? l.split(':') : []
    const tail = r ? r.split(':') : []
    const h2 = toHextets(head)
    const t2 = toHextets(tail)
    if (h2 === null || t2 === null) return null
    const missing = 8 - (h2.length + t2.length)
    if (missing < 1) return null // '::' representa ≥1 grupo de ceros
    full = [...h2, ...Array(missing).fill('0000'), ...t2]
  } else {
    const groups = toHextets(h.split(':'))
    if (groups === null || groups.length !== 8) return null
    full = groups
  }
  if (full.length !== 8) return null
  return full.join(':')
}

const IPV6_UNSPECIFIED = '0000:0000:0000:0000:0000:0000:0000:0000'
const IPV6_LOOPBACK    = '0000:0000:0000:0000:0000:0000:0000:0001'

export function isPrivateIpv6(host: string): boolean {
  const c = expandIpv6(host)
  if (!c) return false
  if (c === IPV6_LOOPBACK) return true // loopback (se mantiene como en el contrato previo)
  const g0 = c.slice(0, 4)
  return g0.startsWith('fc') || g0.startsWith('fd') // ULA fc00::/7
}

export function isLoopbackIpv6(host: string): boolean {
  return expandIpv6(host) === IPV6_LOOPBACK
}

/** IPv6 no especificada :: (todo cero). */
export function isUnspecifiedIpv6(host: string): boolean {
  return expandIpv6(host) === IPV6_UNSPECIFIED
}

export function isLinkLocalIpv6(host: string): boolean {
  const c = expandIpv6(host)
  if (!c) return false
  const g0 = parseInt(c.slice(0, 4), 16)
  return g0 >= 0xfe80 && g0 <= 0xfebf // fe80::/10 link-local
}

export function looksLikeIpv6(host: string): boolean {
  return host.includes(':')
}

/** Set de metadatos IPv6 en forma CANÓNICA (expandida), para comparar por valor
 *  sin depender de la representación textual. */
export const METADATA_IPV6_CANON: ReadonlySet<string> = new Set(
  [...METADATA_IPV6].map((h) => expandIpv6(h)).filter((h): h is string => h !== null),
)
