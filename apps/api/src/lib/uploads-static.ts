// apps/api/src/lib/uploads-static.ts
//
// Política de servido de /uploads/ — defensa en profundidad anti-XSS almacenado
// de branding. Aunque la CARGA ya valida la firma mágica y deriva la extensión
// del tipo de imagen DETECTADO (services/appearance-policy.ts), el directorio
// puede contener archivos LEGADOS subidos antes del fix con extensiones
// ejecutables (.html/.js/.xhtm...). @fastify/static los serviría con un
// Content-Type ejecutable en el MISMO origen (XSS que esquiva la CSP vía
// <script src>).
//
// Por eso, al servir:
//   1) sólo se permiten extensiones de imagen, raster o .svg ya configurado
//      (el resto ⇒ 404, SIN borrar nada); y
//   2) se refuerzan cabeceras por respuesta (nosniff + CSP sandbox + XFO).
//
// server.ts registra @fastify/static con `uploadsStaticOptions(uploadsDir)`: las
// pruebas de ruta usan EXACTAMENTE las mismas opciones, y una prueba sobre el
// fuente de server.ts fija ese cableado (ver uploads-static.test.ts).

import type { FastifyReply } from 'fastify'
import type { FastifyStaticOptions } from '@fastify/static'

// Extensiones raster servibles (coinciden con las que genera la carga válida).
export const SERVABLE_UPLOAD_EXTENSIONS = new Set<string>([
  '.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif',
])

// `.svg` se sigue sirviendo SÓLO por los SVG ya configurados: la política
// documentada es "los SVG ya configurados no se tocan" (isBlockedSvgUpload en
// services/appearance-policy.ts) y GET /api/appearance sigue publicando esas
// URLs; un 404 haría desaparecer el branding en silencio. Ya no se pueden
// SUBIR SVG nuevos, pero un .svg en disco puede venir de una carga legítima
// previa al bloqueo o del bug (p. ej. nombre `x.s-vg` ⇒ extensión `.svg` sin
// pasar el bloqueo por nombre). En ambos casos queda neutralizado al servirlo:
// en <img> un SVG nunca ejecuta scripts; abierto como documento (navegación,
// iframe, object) la CSP `sandbox` sin allow-scripts impide ejecutarlos; y
// nosniff impide usarlo como <script src>. `.svgz` NO: sólo llegaba por el bug.
export const LEGACY_SERVABLE_UPLOAD_EXTENSIONS = new Set<string>(['.svg'])

/**
 * ¿El path pedido termina en una extensión servible (raster o .svg legado)?
 * Cualquier otra cosa (incluido sin extensión) ⇒ false ⇒ 404 en el servido.
 */
export function isServableUploadPath(pathname: string): boolean {
  const m = /\.[a-z0-9]+$/i.exec((pathname || '').toLowerCase())
  if (!m) return false
  return SERVABLE_UPLOAD_EXTENSIONS.has(m[0]) || LEGACY_SERVABLE_UPLOAD_EXTENSIONS.has(m[0])
}

// CSP restrictiva + sandbox para respuestas de /uploads/: aunque un legado
// ejecutable se colara, `sandbox` (sin allow-scripts) neutraliza cualquier
// ejecución de JavaScript en esa respuesta.
//
// OJO: esta cabecera REEMPLAZA la CSP de helmet en estas respuestas (no se suma
// ni se intersecta: reply.header pisa el valor). Por eso se repite acá
// `frame-ancestors 'self'`, la directiva de helmet que sigue aplicando a un
// asset estático (base-uri/form-action/upgrade-insecure-requests no aportan en
// un documento sin scripts ni formularios bajo sandbox). Detrás de nginx llega
// además la CSP de su `location /uploads/` (mismo valor).
export const UPLOADS_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox"

/**
 * Cabeceras de refuerzo para respuestas estáticas de /uploads/. Recibe un
 * objeto con `.header(name, value)` (FastifyReply) para no acoplar el tipo.
 */
export function applyUploadResponseHeaders(reply: { header: (k: string, v: string) => unknown }): void {
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Content-Security-Policy', UPLOADS_CSP)
  reply.header('X-Frame-Options', 'SAMEORIGIN')
}

/**
 * Opciones de @fastify/static para /uploads/. ÚNICA fuente: la usan server.ts
 * y las pruebas de ruta, así que quitar el guard de acá rompe las pruebas.
 */
export function uploadsStaticOptions(root: string): FastifyStaticOptions {
  return {
    root,
    prefix: '/uploads/',
    decorateReply: false,
    allowedPath: (pathName: string) => isServableUploadPath(pathName),
    setHeaders: (reply: FastifyReply) => applyUploadResponseHeaders(reply),
  }
}
