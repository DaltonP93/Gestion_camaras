// apps/api/src/lib/csrf.ts
//
// Defensa CSRF en profundidad para peticiones autenticadas por COOKIE. SameSite=Strict
// ya impide que las cookies de sesión viajen en peticiones cross-site, pero además se
// valida que las mutaciones (POST/PUT/PATCH/DELETE) traigan un Origin/Referer que
// coincida con un origen permitido (mismo host, o la allowlist CORS, o localhost en
// desarrollo). Así un sitio malicioso no puede provocar cambios de estado aunque el
// navegador adjuntara la cookie por algún resquicio.
//
// Alcance ACOTADO a peticiones con cookie de auth: las llamadas servicio→servicio
// (analytics, métricas) y las de prueba con Authorization: Bearer NO llevan estas
// cookies y por tanto NO quedan sujetas a esta verificación (no rompe integraciones).

import { isLocalhostOrigin } from './cors-config'
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth-cookies'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface CsrfInput {
  method: string
  origin?: string        // header Origin
  referer?: string       // header Referer (fallback)
  host?: string          // header Host de la petición
  hasAuthCookie: boolean // ¿la petición trae access_token o refresh_token?
  corsOriginsEnv?: string
}

/** Origen (scheme://host[:port]) de una URL, o null si no parsea. */
function originOf(u: string | undefined): string | null {
  if (!u) return null
  try { return new URL(u).origin } catch { return null }
}

/** true = la petición es segura frente a CSRF; false = debe rechazarse (403). */
export function isCsrfSafe(input: CsrfInput): boolean {
  if (!MUTATING.has(input.method.toUpperCase())) return true
  // Sólo se exige a peticiones autenticadas por cookie (navegador). El resto
  // (Bearer, servicio→servicio, health) no adjunta estas cookies.
  if (!input.hasAuthCookie) return true

  const candidate = originOf(input.origin) ?? originOf(input.referer)
  // Mutación con cookie de auth pero sin Origin/Referer utilizable ⇒ sospechosa.
  // Los navegadores modernos envían Origin en toda mutación same-origin incluida.
  if (!candidate) return false

  // 1) Same-origin: el Origin coincide con el Host de la petición.
  if (input.host) {
    for (const scheme of ['https://', 'http://']) {
      if (candidate === `${scheme}${input.host}`) return true
    }
  }
  // 2) Allowlist CORS explícita.
  const list = input.corsOriginsEnv
    ? input.corsOriginsEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : null
  if (list && list.includes(candidate)) return true
  // 3) Sin CORS_ORIGINS (dev) ⇒ localhost permitido.
  if (!list && isLocalhostOrigin(candidate)) return true

  return false
}

/** ¿La petición trae alguna cookie de auth? (para decidir si aplica la verificación) */
export function requestHasAuthCookie(cookies: Record<string, string | undefined> | undefined): boolean {
  if (!cookies) return false
  return !!cookies[ACCESS_COOKIE] || !!cookies[REFRESH_COOKIE]
}
