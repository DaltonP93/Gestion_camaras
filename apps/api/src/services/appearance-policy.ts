// apps/api/src/services/appearance-policy.ts
//
// Helpers PUROS de política de apariencia (sin Fastify ni Prisma) para que sean
// testeables como unidades, siguiendo la convención del repo (tests a nivel de
// servicio/función pura).

import { resolveFeaturePermissions } from './totp'

// ─── Autorización: ADMIN o canManageAppearance ────────────────

/**
 * Decide si un usuario puede administrar la apariencia.
 * ADMIN siempre puede. El resto sólo si su permiso de feature
 * `canManageAppearance` (resuelto contra los defaults del rol) es true.
 */
export function canManageAppearance(
  role: string,
  featurePermissions: Record<string, boolean> | null | undefined,
): boolean {
  if (role === 'ADMIN') return true
  const resolved = resolveFeaturePermissions(role, featurePermissions)
  return resolved.canManageAppearance === true
}

// ─── Uploads: bloqueo temporal de SVG (hasta sanitización real en PR 1b) ──

export const BLOCKED_SVG_CODE = 'UNSAFE_SVG_UPLOAD_DISABLED'

const SVG_MIMES = new Set(['image/svg+xml'])

/**
 * ¿Es una carga SVG que debe bloquearse? Los SVG permiten scripting embebido;
 * hasta que PR 1b implemente sanitización real, se rechazan cargas NUEVAS.
 * (Los SVG ya configurados no se tocan: se siguen sirviendo con nosniff + CSP
 * sandbox, ver lib/uploads-static.ts.)
 */
export function isBlockedSvgUpload(mimetype: string, filename?: string | null): boolean {
  if (SVG_MIMES.has((mimetype || '').toLowerCase())) return true
  // Defensa extra: extensión .svg aunque el MIME venga disfrazado.
  if (filename && /\.svg$/i.test(filename.trim())) return true
  return false
}

// ─── Uploads: validación de contenido real (anti-XSS almacenado) ──
//
// El MIME de la parte multipart y el nombre de archivo los controla el CLIENTE.
// Si la extensión guardada sale del nombre del cliente, se puede guardar
// .html/.js/.xml (hasta .xhtm/.svgz) con un Content-Type de imagen falso, y
// @fastify/static los serviría con Content-Type EJECUTABLE en el mismo origen
// (XSS almacenado que esquiva la CSP vía <script src> mismo-origen). Por eso:
//   1) el MIME declarado debe estar en la whitelist;
//   2) la FIRMA MÁGICA del contenido debe ser la de una imagen permitida
//      (PNG/JPEG/WEBP/ICO); y
//   3) la extensión guardada se DERIVA del tipo DETECTADO (mapa fijo), nunca
//      del nombre del cliente ni del MIME declarado.
//
// No se exige que el MIME declarado coincida con el tipo detectado: el
// navegador lo deduce de la EXTENSIÓN (file.type), así que un favicon.ico que en
// realidad es PNG o un .jpg que es WEBP son imágenes legítimas y comunes. Esa
// igualdad no agrega protección: lo que se guarda y se sirve sale del contenido.

export type UploadImageType = 'png' | 'jpeg' | 'webp' | 'x-icon'

// MIMEs declarados aceptados (whitelist de entrada; no deciden la extensión).
export const ALLOWED_UPLOAD_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

export function isAllowedUploadMime(mimetype: string): boolean {
  return ALLOWED_UPLOAD_MIMES.has((mimetype || '').toLowerCase())
}

export function extensionForImageType(type: UploadImageType): string {
  switch (type) {
    case 'png':    return '.png'
    case 'jpeg':   return '.jpg'
    case 'webp':   return '.webp'
    case 'x-icon': return '.ico'
  }
}

/**
 * Detecta el tipo real de imagen por su firma mágica. Devuelve null si el
 * contenido NO es una imagen raster permitida (p. ej. HTML/JS/XML/SVG
 * disfrazados con un Content-Type de imagen).
 */
export function detectUploadImageType(buf: Uint8Array): UploadImageType | null {
  const b = buf
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  // WEBP: "RIFF"...."WEBP"
  if (b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  // ICO: 00 00 01 00 (reservado=0, tipo=1 icono). CUR (tipo=2) se rechaza.
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'x-icon'
  return null
}

export type UploadAssetResult =
  | { ok: true; ext: string; type: UploadImageType }
  | { ok: false; reason: 'MIME_NOT_ALLOWED' | 'CONTENT_MISMATCH' }

/**
 * Valida una carga de branding y resuelve su extensión canónica.
 * - El MIME declarado debe estar permitido.
 * - El contenido debe ser una imagen permitida según su firma mágica (aunque
 *   sea de OTRO formato permitido que el declarado).
 * La extensión devuelta sale del tipo DETECTADO, NUNCA del nombre del cliente
 * ni del MIME declarado.
 */
export function resolveUploadAsset(mimetype: string, buf: Uint8Array): UploadAssetResult {
  if (!isAllowedUploadMime(mimetype)) return { ok: false, reason: 'MIME_NOT_ALLOWED' }
  const type = detectUploadImageType(buf)
  if (!type) return { ok: false, reason: 'CONTENT_MISMATCH' }
  return { ok: true, ext: extensionForImageType(type), type }
}

// ─── URLs de assets: normalización legacy localhost → relativa ────

/** Convierte http(s)://localhost[:port]/uploads/... en /uploads/... (idempotente). */
export function normalizeUploadUrl(v: string | null | undefined): string {
  if (!v) return ''
  return v.replace(/^https?:\/\/localhost(:\d+)?\/uploads\//, '/uploads/')
}

// ─── Proyección pública (whitelist) ───────────────────────────
//
// El GET de apariencia es PÚBLICO (necesario para tematizar el login). Debe
// devolver SÓLO configuración publicable, nunca campos internos/sensibles.
// Se usa una lista blanca explícita para que futuros campos sensibles del
// modelo NO se filtren por defecto.

export const PUBLISHABLE_APPEARANCE_FIELDS = [
  'id', 'siteName', 'logoText',
  // legacy
  'primaryColor', 'accentColor', 'theme', 'sidebarWidth', 'showNVRsInSidebar',
  'customCss', 'logoUrl', 'sidebarLogoUrl', 'faviconUrl', 'updatedAt',
  // V2 tokens
  'themeMode', 'fontFamily', 'fontScale', 'density', 'borderRadius', 'shadowLevel',
  'componentHeight', 'backgroundColor', 'surfaceColor', 'surfaceRaisedColor',
  'borderColor', 'textPrimaryColor', 'textSecondaryColor', 'textMutedColor',
  'successColor', 'warningColor', 'dangerColor', 'informationColor',
  'offlineColor', 'recordingColor', 'analyticsColor',
] as const

type AnyRecord = Record<string, unknown>

/**
 * Proyecta un registro de apariencia a su forma publicable.
 * - Sólo incluye campos de la whitelist (descarta cualquier otro).
 * - Normaliza las URLs de assets y coacciona customCss null → ''.
 */
export function toPublishableAppearance(settings: AnyRecord): AnyRecord {
  const out: AnyRecord = {}
  for (const key of PUBLISHABLE_APPEARANCE_FIELDS) {
    if (key in settings) out[key] = settings[key]
  }
  out.customCss = (settings.customCss as string | null) ?? ''
  out.logoUrl = normalizeUploadUrl(settings.logoUrl as string | null)
  out.sidebarLogoUrl = normalizeUploadUrl(settings.sidebarLogoUrl as string | null)
  out.faviconUrl = normalizeUploadUrl(settings.faviconUrl as string | null)
  return out
}
