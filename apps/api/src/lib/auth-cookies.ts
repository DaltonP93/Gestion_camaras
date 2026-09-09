// apps/api/src/lib/auth-cookies.ts
//
// Cookies de autenticación HttpOnly. El JWT (access + refresh) deja de viajar en
// el JSON de respuesta y en localStorage: pasa a cookies HttpOnly, Secure,
// SameSite=Strict, de modo que JavaScript ya no puede leer el token (defensa
// contra XSS/exfiltración) y el navegador las adjunta solo a peticiones
// same-site (defensa CSRF nativa, reforzada por la verificación de Origin).
//
//   access_token  → Path=/            (toda la API lo necesita). Cookie de sesión
//                   (sin Max-Age): sobrevive recargas, se borra al cerrar el navegador.
//   refresh_token → Path=/api/auth  (se envía SÓLO al subárbol de endpoints de
//                   autenticación — refresh y logout lo necesitan — no a toda la
//                   API: minimiza la exposición sin romper el cierre de sesión).
//                   Persistente (Max-Age) sólo si el usuario marcó "recordarme";
//                   si no, cookie de sesión.
import type { FastifyReply } from 'fastify'

export const ACCESS_COOKIE = 'access_token'
export const REFRESH_COOKIE = 'refresh_token'
// Acotado al subárbol /api/auth (refresh + logout), no a /api/auth/refresh solo:
// el logout necesita el refresh token para revocar SU sesión, y el navegador no
// puede leer la cookie HttpOnly para reenviarla. Sigue sin viajar al resto de la API.
export const REFRESH_COOKIE_PATH = '/api/auth'

// Secure por defecto en producción. COOKIE_SECURE lo puede forzar (true/false),
// necesario en staging por HTTP donde Secure impediría enviar la cookie.
function secureFlag(): boolean {
  const env = process.env.COOKIE_SECURE
  if (env === 'true') return true
  if (env === 'false') return false
  return process.env.NODE_ENV === 'production'
}

function baseOptions() {
  return { httpOnly: true, secure: secureFlag(), sameSite: 'strict' as const }
}

export interface SetAuthCookiesArgs {
  accessToken: string
  refreshToken: string
  /** true = "recordarme": la cookie de refresh persiste (Max-Age); false = cookie de sesión. */
  persist: boolean
  /** Ventana de vida del refresh en ms (para el Max-Age cuando persist=true). */
  refreshMaxAgeMs: number
}

export function setAuthCookies(reply: FastifyReply, args: SetAuthCookiesArgs): void {
  const base = baseOptions()
  reply.setCookie(ACCESS_COOKIE, args.accessToken, { ...base, path: '/' })
  reply.setCookie(REFRESH_COOKIE, args.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    ...(args.persist ? { maxAge: Math.floor(args.refreshMaxAgeMs / 1000) } : {}),
  })
}

export function clearAuthCookies(reply: FastifyReply): void {
  const base = baseOptions()
  reply.clearCookie(ACCESS_COOKIE, { ...base, path: '/' })
  reply.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH })
}
