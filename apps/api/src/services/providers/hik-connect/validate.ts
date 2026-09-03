// apps/api/src/services/providers/hik-connect/validate.ts
//
// NÚCLEO PURO — validación anti-SSRF del `areaDomain` devuelto por el token.
//
// MODELO DE AMENAZA: el `areaDomain` NO es input directo del caller, pero SÍ
// proviene de una respuesta de red (la del token). Un token comprometido o un
// MITM podrían inyectar un `areaDomain` apuntando a un destino interno (metadatos
// cloud, IP privada del datacenter) para pivotar SSRF. Mitigación (defensa en
// profundidad, puramente sintáctica y determinista ⇒ testeable):
//
//   1. Esquema DEBE ser https (la nube Hik-Connect es siempre TLS).
//   2. Se BLOQUEA todo literal IP: el areaDomain legítimo es un hostname de la
//      nube. Cualquier IP (privada, pública, link-local, metadatos) se rechaza.
//   3. Se BLOQUEAN explícitamente hosts de metadatos cloud conocidos.
//   4. El host DEBE terminar en uno de los sufijos plausibles de Hik-Connect /
//      EZVIZ / Hikvision. `allowedSuffixes` permite ampliar la lista de forma
//      explícita si el operador opera en otra región/marca.
//
// No se resuelve DNS aquí (eso ocurre al conectar). La lista de sufijos evita
// que un areaDomain arbitrario apunte a cualquier host de Internet.

import { HikConnectError } from './errors'

/** Sufijos de dominio plausibles para la nube Hik-Connect / EZVIZ / Hikvision. */
export const DEFAULT_AREA_DOMAIN_SUFFIXES: readonly string[] = [
  '.hik-connect.com',
  '.hikvision.com',
  '.ezvizlife.com',
  '.ys7.com',
  '.hicloudcam.com',
  '.ezviz.com',
]

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  'metadata.goog',
])

export interface AreaDomainPolicy {
  /** Sufijos permitidos (en minúscula, con punto inicial). Default: la lista de arriba. */
  allowedSuffixes?: readonly string[]
}

function isIpLiteral(host: string): boolean {
  // IPv4 dotted, o IPv6 (contiene ':'), o forma con corchetes.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  if (host.includes(':')) return true
  return false
}

/**
 * Valida el `areaDomain` (una URL base https de la nube). Lanza
 * HikConnectError('INVALID_AREA_DOMAIN') si no es segura. Devuelve el objeto URL
 * normalizado (sin path/credenciales) si es válida.
 */
export function assertSafeAreaDomain(areaDomain: string, policy: AreaDomainPolicy = {}): URL {
  let url: URL
  try {
    url = new URL(areaDomain)
  } catch {
    throw new HikConnectError('INVALID_AREA_DOMAIN', 'areaDomain no es una URL válida')
  }
  if (url.protocol !== 'https:') {
    throw new HikConnectError('INVALID_AREA_DOMAIN', 'areaDomain debe ser https')
  }
  // Rechazar credenciales embebidas (user:pass@host) — vector de confusión.
  if (url.username || url.password) {
    throw new HikConnectError('INVALID_AREA_DOMAIN', 'areaDomain no puede llevar credenciales embebidas')
  }

  const host = url.hostname.toLowerCase()

  if (METADATA_HOSTS.has(host)) {
    throw new HikConnectError('INVALID_AREA_DOMAIN', 'areaDomain de metadatos cloud bloqueado')
  }
  if (isIpLiteral(host)) {
    // El areaDomain legítimo es un hostname de la nube, nunca una IP.
    throw new HikConnectError('INVALID_AREA_DOMAIN', 'areaDomain no puede ser una IP literal')
  }

  const suffixes = policy.allowedSuffixes ?? DEFAULT_AREA_DOMAIN_SUFFIXES
  const ok = suffixes.some((s) => host === s.replace(/^\./, '') || host.endsWith(s))
  if (!ok) {
    throw new HikConnectError('INVALID_AREA_DOMAIN', 'host de areaDomain no plausible para Hik-Connect')
  }
  return url
}
