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
 * (Los SVG ya configurados no se tocan.)
 */
export function isBlockedSvgUpload(mimetype: string, filename?: string | null): boolean {
  if (SVG_MIMES.has((mimetype || '').toLowerCase())) return true
  // Defensa extra: extensión .svg aunque el MIME venga disfrazado.
  if (filename && /\.svg$/i.test(filename.trim())) return true
  return false
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
