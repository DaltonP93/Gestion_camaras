// apps/api/src/services/net/nvr-host-guard.ts
//
// Defensa SSRF para el HOST/IP de un NVR Hikvision. El host lo define un ADMIN al
// crear/editar el NVR, por lo que sin validación un input (o un ADMIN comprometido)
// podría apuntar a metadatos cloud, loopback u otros servicios internos ⇒ SSRF.
//
// MODELO DE AMENAZA vs. ONVIF: los NVR viven en LAN, así que las IPs privadas
// RFC1918/CGNAT SÍ se permiten. A diferencia de ONVIF (que admite loopback para
// desarrollo), aquí:
//
//   1. BLOQUEO DURO de 169.254.0.0/16 (incluye el endpoint de metadatos cloud
//      169.254.169.254) y de los hostnames/IPs de metadatos conocidos (Alibaba
//      100.100.100.200 dentro de CGNAT, y fd00:ec2::254 IPv6 dentro de ULA).
//   2. BLOQUEO de loopback (127.0.0.0/8, ::1) y de la dirección no especificada
//      (0.0.0.0, ::) — un NVR real jamás vive ahí; permitirlo abriría SSRF a
//      servicios locales del servidor.
//   3. BLOQUEO de IPv6 link-local (fe80::/10).
//
// POLÍTICA LAN PERMITIDA (allowlist explícita — todo lo demás se rechaza):
//   IPv4 privadas:  10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC1918) y
//                   100.64.0.0/10 (CGNAT, RFC6598) — MENOS 100.100.100.200.
//   IPv6:           fc00::/7 (ULA) — MENOS los endpoints de metadatos IPv6.
//   Se aceptan porque son exactamente los rangos donde vive un NVR en una LAN/
//   red de operador; una IP pública o de metadatos jamás debería configurarse.
//
// IP-LITERAL-ONLY (anti DNS-rebinding): sólo se admite una IP literal como host
// del NVR. Los hostnames (incluidos localhost, *.local y *.lan) se RECHAZAN: sin
// resolución+fijado de IP no se puede garantizar a qué dirección se conecta y un
// nombre podría re-resolver a metadatos/loopback entre validación y conexión.
// El schema Zod de NVR ya exige `.ip()`, así que esto es coherente con el modelo
// de datos. FUTURO: si algún día se necesita hostname, la alternativa segura es
// resolver el nombre, validar TODAS las direcciones devueltas contra esta misma
// política y fijar la conexión (connect) a la IP validada — no admitir el nombre.
//
// La comprobación es puramente sintáctica y determinista ⇒ testeable. No resuelve
// DNS ni loguea la IP/URL (invariante 6 del handoff).

import {
  METADATA_HOSTS,
  METADATA_IPV6_CANON,
  isIpv4,
  isDottedQuadShape,
  isPrivateIpv4,
  isLoopbackIpv4,
  isUnspecifiedIpv4,
  isLinkLocalIpv4,
  isPrivateIpv6,
  isLoopbackIpv6,
  isUnspecifiedIpv6,
  isLinkLocalIpv6,
  looksLikeIpv6,
  expandIpv6,
} from './ip-classify'

export type NvrHostErrorCode =
  | 'SSRF_BLOCKED'  // destino fuera del rango LAN permitido / metadatos / loopback
  | 'INVALID_HOST'  // host vacío o no interpretable como IP/hostname

/** Error tipado — mensaje SIN la IP/host (no filtrar destino en logs). */
export class NvrHostError extends Error {
  readonly code: NvrHostErrorCode
  constructor(code: NvrHostErrorCode, message: string) {
    super(message)
    this.name = 'NvrHostError'
    this.code = code
    Object.setPrototypeOf(this, NvrHostError.prototype)
  }
}

export function isNvrHostError(e: unknown): e is NvrHostError {
  return e instanceof NvrHostError
}

/**
 * Valida el host/IP de un NVR según la política LAN-only anti-SSRF. Lanza
 * `NvrHostError` si no es seguro. Idempotente y sin efectos secundarios.
 *
 * Exige una IP LITERAL (IPv4 o IPv6) tal cual se guarda en `NVR.ipAddress`
 * (el schema Zod usa `.ip()`). Cualquier hostname se rechaza (IP-literal-only).
 */
export function assertSafeNvrHost(rawHost: string): void {
  const host = (rawHost ?? '').trim().toLowerCase()
  if (!host) throw new NvrHostError('INVALID_HOST', 'host de NVR vacío')

  // 1) Metadatos de proveedor (hostname o IPv4 literal): bloqueo duro y primero,
  //    para que 100.100.100.200 no pase como CGNAT en la rama IPv4 de abajo.
  if (METADATA_HOSTS.has(host)) {
    throw new NvrHostError('SSRF_BLOCKED', 'destino de metadatos cloud bloqueado')
  }

  // Cualquier cosa con forma de cuádruple punteado se trata como IPv4 literal y se
  // EXIGE canónica: sin ceros a la izquierda (salvo el octeto exacto "0"). Un
  // "010.010.010.010" NO es 10.10.10.10 — WHATWG URL/axios lo leen como OCTAL
  // (8.8.8.8, público). Rechazar la forma no canónica cierra el bypass por parser
  // diferencial y garantiza que el guard y el cliente interpretan el MISMO destino.
  if (isDottedQuadShape(host)) {
    if (!isIpv4(host)) {
      throw new NvrHostError('INVALID_HOST', 'IPv4 no canónica (ceros a la izquierda o fuera de rango)')
    }
    if (isLinkLocalIpv4(host)) throw new NvrHostError('SSRF_BLOCKED', 'IP link-local bloqueada (169.254.0.0/16)')
    if (isLoopbackIpv4(host)) throw new NvrHostError('SSRF_BLOCKED', 'IP loopback bloqueada')
    if (isUnspecifiedIpv4(host)) throw new NvrHostError('SSRF_BLOCKED', 'IP no especificada bloqueada')
    if (isPrivateIpv4(host)) return // LAN legítima (RFC1918 / CGNAT)
    throw new NvrHostError('SSRF_BLOCKED', 'IP fuera del rango privado (LAN) permitido')
  }

  if (looksLikeIpv6(host)) {
    // Canonicalización SEMÁNTICA: una IPv6 malformada es fail-closed (INVALID_HOST),
    // nunca se deja caer a las ramas de abajo. Y la comparación con metadatos se
    // hace por VALOR canónico, así ninguna forma expandida/con IPv4 embebida evade
    // el bloqueo para colarse por la allow de ULA.
    const canon = expandIpv6(host)
    if (!canon) throw new NvrHostError('INVALID_HOST', 'IPv6 malformada')
    // Metadatos IPv6 (fd00:ec2::254) — bloqueo antes de la allow de ULA.
    if (METADATA_IPV6_CANON.has(canon)) throw new NvrHostError('SSRF_BLOCKED', 'destino de metadatos cloud bloqueado')
    if (isLinkLocalIpv6(host)) throw new NvrHostError('SSRF_BLOCKED', 'IPv6 link-local bloqueada')
    if (isLoopbackIpv6(host)) throw new NvrHostError('SSRF_BLOCKED', 'IPv6 loopback bloqueada')
    if (isUnspecifiedIpv6(host)) throw new NvrHostError('SSRF_BLOCKED', 'IPv6 no especificada bloqueada')
    if (isPrivateIpv6(host)) return // ULA LAN legítima
    throw new NvrHostError('SSRF_BLOCKED', 'IPv6 fuera del rango privado (LAN) permitido')
  }

  // No es IP literal ⇒ es un hostname. IP-literal-only: se rechaza TODO hostname
  // (localhost, *.local, *.lan y cualquier FQDN) para no depender de una
  // resolución DNS que podría re-apuntar a metadatos/loopback (DNS-rebinding).
  throw new NvrHostError('SSRF_BLOCKED', 'sólo se admite IP literal para NVR (hostname rechazado, anti DNS-rebinding)')
}
