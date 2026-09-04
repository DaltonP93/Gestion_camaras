// apps/api/src/lib/cors-config.ts
//
// Resolución de la configuración de CORS a partir de la env var CORS_ORIGINS.
//
// Objetivo de endurecimiento (auditoría de robustez, hallazgo #3):
//   ANTES: sin CORS_ORIGINS se usaba `origin: true` + `credentials: true`, es
//   decir se REFLEJABA cualquier `Origin` y se permitían peticiones credenciadas
//   (cookies de refresh). Un sitio malicioso podía emitir requests con
//   credenciales al API si un navegador visitaba su página.
//
//   AHORA: sin CORS_ORIGINS NO se refleja un origin arbitrario con credenciales.
//   Sólo se permite localhost/127.0.0.1/[::1] (cualquier puerto) para mantener
//   el desarrollo usable; cualquier otro origin cruzado no recibe cabeceras CORS
//   y el navegador lo bloquea. Las peticiones same-origin (producción detrás de
//   nginx) no llevan `Origin` cruzado y no se ven afectadas.
//
// INVARIANTE: cuando CORS_ORIGINS ESTÁ definido (string no vacío) el
// comportamiento es EXACTAMENTE el histórico: `origin: <lista parseada>` (que
// puede ser `[]` si el valor sólo tiene comas/espacios) + `credentials: true`.
// El único caso que cambia es CORS_ORIGINS ausente/vacío.

export type CorsOriginCallback = (err: Error | null, allow: boolean) => void

export type CorsOriginResolver =
  | string[]
  | ((origin: string | undefined, cb: CorsOriginCallback) => void)

export interface CorsOptions {
  origin: CorsOriginResolver
  credentials: boolean
}

// http(s)://localhost | 127.0.0.1 | [::1], con puerto opcional. Nada más.
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

export function isLocalhostOrigin(origin: string): boolean {
  return LOCALHOST_ORIGIN_RE.test(origin)
}

export function resolveCorsOptions(corsOriginsEnv: string | undefined): CorsOptions {
  // Mismo parseo que el histórico: string truthy → lista (filtrando vacíos),
  // ausente/'' → null. `[]` (todos los segmentos vacíos) sigue siendo truthy,
  // igual que antes, así que se preserva el comportamiento exacto.
  const corsOrigins = corsOriginsEnv
    ? corsOriginsEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : null

  if (corsOrigins) {
    // CORS_ORIGINS definido → IDÉNTICO a hoy.
    return { origin: corsOrigins, credentials: true }
  }

  // CORS_ORIGINS ausente/vacío → sólo localhost, sin reflejar orígenes arbitrarios.
  return {
    credentials: true,
    origin: (origin, cb) => {
      // Sin cabecera Origin (same-origin, curl, health checks) → permitir.
      if (!origin || isLocalhostOrigin(origin)) return cb(null, true)
      return cb(null, false)
    },
  }
}
