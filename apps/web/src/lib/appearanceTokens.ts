// src/lib/appearanceTokens.ts
//
// Motor ÚNICO de tokens de apariencia (fuente de verdad).
//
// Reemplaza los tres aplicadores divergentes que existían antes
// (stores/appearanceStore, hooks/useAppearance y AppearancePage), cada uno
// con su propia fórmula de color y su propio efecto sobre documentElement.
//
// Diseño:
//   normalizeAppearanceSettings(raw)  -> rellena los campos V2 desde el legacy
//   buildAppearanceTokens(settings)   -> función PURA sin DOM: devuelve los
//                                        tokens (variables CSS + título + favicon
//                                        + customCss). Emite tanto las variables
//                                        nuevas --vc-* como las legacy
//                                        --brand-*/--surface-* derivadas del
//                                        MISMO cálculo.
//   applyAppearanceTokens(tokens)     -> único punto que escribe en el documento
//   resetAppearanceTokens()           -> limpia todo lo aplicado
//
// Las funciones de cálculo no dependen del DOM y están cubiertas por tests.

import type { AppearanceSettings } from '@/types'

// ─── Tipos ────────────────────────────────────────────────────

export type ResolvedThemeMode = 'light' | 'dark' | 'darker' | 'midnight'
export type ThemeMode = ResolvedThemeMode | 'system'
export type Density = 'compact' | 'normal' | 'comfortable'
export type SidebarWidth = 'compact' | 'normal' | 'wide'
export type BorderRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl'
export type ShadowLevel = 'none' | 'sm' | 'md' | 'lg'

/** Configuración normalizada: todos los campos V2 resueltos a un valor concreto. */
export interface NormalizedAppearance {
  siteName: string
  logoText: string
  themeMode: ThemeMode
  fontFamily: string
  fontScale: number
  density: Density
  sidebarWidth: SidebarWidth
  borderRadius: BorderRadius
  shadowLevel: ShadowLevel
  componentHeight: number | null
  // colores (hex #rrggbb)
  primaryColor: string
  accentColor: string
  backgroundColor: string | null
  surfaceColor: string | null
  surfaceRaisedColor: string | null
  borderColor: string | null
  textPrimaryColor: string | null
  textSecondaryColor: string | null
  textMutedColor: string | null
  successColor: string | null
  warningColor: string | null
  dangerColor: string | null
  informationColor: string | null
  offlineColor: string | null
  recordingColor: string | null
  analyticsColor: string | null
  // side-effects
  customCss: string
  faviconUrl: string | null
}

/** Resultado puro del motor: todo lo necesario para tematizar el documento. */
export interface AppearanceTokens {
  /** Variables CSS a escribir en documentElement (incluye --vc-* y legacy). */
  cssVars: Record<string, string>
  /** Título del documento (siteName). */
  documentTitle: string
  /** URL cruda del favicon (sin resolver contra el origin). */
  faviconUrl: string | null
  /** CSS personalizado a inyectar en <style>. */
  customCss: string
  /** Modo de tema efectivo tras resolver 'system'. */
  resolvedMode: ResolvedThemeMode
}

// ─── Utilidades de color (compartidas por todo el motor) ──────

const HEX_RE = /^#[0-9a-fA-F]{6}$/

function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v.trim())
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Canales "R G B" separados por espacio — formato que Tailwind usa con /<alpha>. */
export function hexToChannels(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return `${r} ${g} ${b}`
}

function hexToHsl(hex: string): [number, number, number] {
  let [r, g, b] = hexToRgb(hex)
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
      case g: h = ((b - r) / d + 2) / 6; break
      case b: h = ((r - g) / d + 4) / 6; break
    }
  }
  return [h * 360, s * 100, l * 100]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360; s /= 100; l /= 100
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v] }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

/** Escala de marca 50→900 a partir del color primario (y opcional accent en 600). */
function generateBrandScale(primaryHex: string, accentHex?: string | null): Record<string, string> {
  const [hue, sat] = hexToHsl(primaryHex)
  const lights = [96, 92, 84, 73, 62, 52, 43, 34, 27, 20]
  const satScales = [0.25, 0.40, 0.55, 0.70, 0.85, 1.0, 1.0, 0.95, 0.85, 0.75]
  const keys = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900']
  const result: Record<string, string> = {}
  keys.forEach((key, i) => {
    const s = Math.min(sat * satScales[i], 95)
    const [r, g, b] = hslToRgb(hue, s, lights[i])
    result[key] = `${r} ${g} ${b}`
  })
  if (isHex(accentHex)) result['600'] = hexToChannels(accentHex)
  return result
}

// ─── Paletas base por tema (canales "R G B") ──────────────────
// Fuente: se conserva la escala del antiguo appearanceStore (la más completa).
// La escala legacy --surface-* va de 900 (fondo más oscuro) a 50 (texto claro).

const SURFACE_SCALES: Record<ResolvedThemeMode, Record<string, string>> = {
  dark: {
    '900': '13 17 23', '800': '22 27 34', '750': '27 32 40', '700': '33 38 45',
    '600': '48 54 61', '500': '72 79 88', '400': '110 118 129', '300': '139 148 158',
    '200': '177 186 196', '100': '201 209 217', '50': '240 246 252',
  },
  darker: {
    '900': '8 10 14', '800': '13 17 24', '750': '17 22 30', '700': '22 28 36',
    '600': '34 40 50', '500': '55 62 74', '400': '95 103 116', '300': '130 139 152',
    '200': '172 181 195', '100': '198 207 220', '50': '236 242 250',
  },
  midnight: {
    '900': '1 3 12', '800': '5 9 22', '750': '8 13 30', '700': '12 18 42',
    '600': '20 28 60', '500': '38 48 90', '400': '82 95 145', '300': '128 143 188',
    '200': '175 188 222', '100': '210 218 242', '50': '238 243 255',
  },
  // Tema claro (nuevo): la escala se invierte para que las clases existentes
  // (bg-surface-900 = fondo, text-surface-50 = texto) sigan siendo coherentes.
  light: {
    '900': '246 248 250', '800': '255 255 255', '750': '248 250 252', '700': '234 238 242',
    '600': '208 215 222', '500': '175 184 193', '400': '139 148 158', '300': '101 109 118',
    '200': '71 78 86', '100': '45 51 59', '50': '31 35 40',
  },
}

/** Roles semánticos de superficie/texto derivados de la escala del tema. */
interface SurfaceRoles {
  background: string
  surface: string
  surfaceRaised: string
  surfaceOverlay: string
  border: string
  borderStrong: string
  textPrimary: string
  textSecondary: string
  textMuted: string
}

function surfaceRolesFor(mode: ResolvedThemeMode): SurfaceRoles {
  const s = SURFACE_SCALES[mode]
  return {
    background: s['900'],
    surface: s['800'],
    surfaceRaised: s['700'],
    surfaceOverlay: s['750'],
    border: s['600'],
    borderStrong: s['500'],
    textPrimary: s['50'],
    textSecondary: s['200'],
    textMuted: s['400'],
  }
}

// Colores semánticos por defecto (hex). Sobrescribibles por campos V2.
const SEMANTIC_DEFAULTS = {
  success: '#2ea043',
  warning: '#d29922',
  danger: '#f85149',
  information: '#388bfd',
  offline: '#6e7681',
  recording: '#f85149',
  analytics: '#a371f7',
} as const

// Escalas discretas para dimensiones.
const RADIUS_PX: Record<BorderRadius, number> = { none: 0, sm: 4, md: 8, lg: 12, xl: 16 }
const DENSITY_HEIGHT_PX: Record<Density, number> = { compact: 32, normal: 38, comfortable: 44 }
const SIDEBAR_WIDTH_PX: Record<SidebarWidth, number> = { compact: 64, normal: 260, wide: 320 }

const DEFAULT_FONT_FAMILY = "'Inter', system-ui, sans-serif"

// ─── Normalización legacy -> V2 ───────────────────────────────

function coerceEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

function coerceHexOrNull(v: unknown): string | null {
  return isHex(v) ? (v as string).trim().toLowerCase() : null
}

/**
 * Convierte una configuración (posiblemente sólo con campos legacy) en una
 * configuración V2 completa. Cuando un campo V2 es null/ausente se deriva del
 * legacy equivalente. Es idempotente: normalizar dos veces da lo mismo.
 */
export function normalizeAppearanceSettings(raw: Partial<AppearanceSettings> | null | undefined): NormalizedAppearance {
  const s = raw ?? {}

  // themeMode: usa V2 si existe; si no, cae al legacy `theme`; default dark.
  const legacyTheme = coerceEnum(s.theme, ['dark', 'darker', 'midnight'] as const, 'dark')
  const themeMode = coerceEnum<ThemeMode>(
    (s as any).themeMode,
    ['light', 'dark', 'darker', 'midnight', 'system'],
    legacyTheme,
  )

  const primaryColor = coerceHexOrNull(s.primaryColor) ?? '#e51d1d'
  const accentColor = coerceHexOrNull(s.accentColor) ?? '#c41616'

  const fontScaleRaw = Number((s as any).fontScale)
  const fontScale = Number.isFinite(fontScaleRaw) && fontScaleRaw > 0
    ? Math.min(Math.max(fontScaleRaw, 0.75), 1.5)
    : 1

  const componentHeightRaw = Number((s as any).componentHeight)
  const componentHeight = Number.isFinite(componentHeightRaw) && componentHeightRaw > 0
    ? Math.round(componentHeightRaw)
    : null

  return {
    siteName: typeof s.siteName === 'string' && s.siteName ? s.siteName : 'VisionCore',
    logoText: typeof s.logoText === 'string' && s.logoText ? s.logoText : 'VisionCore',
    themeMode,
    fontFamily: typeof (s as any).fontFamily === 'string' && (s as any).fontFamily
      ? (s as any).fontFamily
      : DEFAULT_FONT_FAMILY,
    fontScale,
    density: coerceEnum<Density>((s as any).density, ['compact', 'normal', 'comfortable'], 'normal'),
    // sidebarWidth legacy era compact|normal; V2 añade wide.
    sidebarWidth: coerceEnum<SidebarWidth>(s.sidebarWidth, ['compact', 'normal', 'wide'], 'normal'),
    borderRadius: coerceEnum<BorderRadius>((s as any).borderRadius, ['none', 'sm', 'md', 'lg', 'xl'], 'md'),
    shadowLevel: coerceEnum<ShadowLevel>((s as any).shadowLevel, ['none', 'sm', 'md', 'lg'], 'md'),
    componentHeight,
    primaryColor,
    accentColor,
    backgroundColor: coerceHexOrNull((s as any).backgroundColor),
    surfaceColor: coerceHexOrNull((s as any).surfaceColor),
    surfaceRaisedColor: coerceHexOrNull((s as any).surfaceRaisedColor),
    borderColor: coerceHexOrNull((s as any).borderColor),
    textPrimaryColor: coerceHexOrNull((s as any).textPrimaryColor),
    textSecondaryColor: coerceHexOrNull((s as any).textSecondaryColor),
    textMutedColor: coerceHexOrNull((s as any).textMutedColor),
    successColor: coerceHexOrNull((s as any).successColor),
    warningColor: coerceHexOrNull((s as any).warningColor),
    dangerColor: coerceHexOrNull((s as any).dangerColor),
    informationColor: coerceHexOrNull((s as any).informationColor),
    offlineColor: coerceHexOrNull((s as any).offlineColor),
    recordingColor: coerceHexOrNull((s as any).recordingColor),
    analyticsColor: coerceHexOrNull((s as any).analyticsColor),
    customCss: typeof s.customCss === 'string' ? s.customCss : '',
    faviconUrl: typeof s.faviconUrl === 'string' && s.faviconUrl ? s.faviconUrl : null,
  }
}

// ─── Motor puro ───────────────────────────────────────────────

function resolveMode(themeMode: ThemeMode, prefersDark: boolean): ResolvedThemeMode {
  if (themeMode === 'system') return prefersDark ? 'dark' : 'light'
  return themeMode
}

/** Canal "R G B" desde hex, o el valor legacy de la escala si el override es null. */
function channelOr(overrideHex: string | null, fallbackChannels: string): string {
  return overrideHex ? hexToChannels(overrideHex) : fallbackChannels
}

export interface BuildOptions {
  /** Resultado de prefers-color-scheme cuando el modo es 'system'. Default true. */
  prefersDark?: boolean
}

/**
 * PURA. Construye todos los tokens a partir de una configuración.
 * Acepta settings legacy o V2 indistintamente (los normaliza internamente),
 * por lo que los mismos settings producen siempre los mismos tokens.
 */
export function buildAppearanceTokens(
  raw: Partial<AppearanceSettings> | null | undefined,
  opts: BuildOptions = {},
): AppearanceTokens {
  const n = normalizeAppearanceSettings(raw)
  const prefersDark = opts.prefersDark ?? true
  const mode = resolveMode(n.themeMode, prefersDark)

  const roles = surfaceRolesFor(mode)
  const surfaceScale = SURFACE_SCALES[mode]
  const brandScale = generateBrandScale(n.primaryColor, n.accentColor)

  // Colores semánticos (override V2 o default).
  const primaryHex = n.primaryColor
  const accentHex = n.accentColor
  const successHex = n.successColor ?? SEMANTIC_DEFAULTS.success
  const warningHex = n.warningColor ?? SEMANTIC_DEFAULTS.warning
  const dangerHex = n.dangerColor ?? SEMANTIC_DEFAULTS.danger
  const informationHex = n.informationColor ?? SEMANTIC_DEFAULTS.information
  const offlineHex = n.offlineColor ?? SEMANTIC_DEFAULTS.offline
  const recordingHex = n.recordingColor ?? SEMANTIC_DEFAULTS.recording
  const analyticsHex = n.analyticsColor ?? SEMANTIC_DEFAULTS.analytics

  // Dimensiones.
  const radiusPx = RADIUS_PX[n.borderRadius]
  const componentHeightPx = n.componentHeight ?? DENSITY_HEIGHT_PX[n.density]
  const sidebarWidthPx = SIDEBAR_WIDTH_PX[n.sidebarWidth]

  const cssVars: Record<string, string> = {}

  // ── Tokens nuevos --vc-* (hex directo, consumo simple con var(--vc-...)) ──
  cssVars['--vc-background'] = n.backgroundColor ?? channelsToHex(roles.background)
  cssVars['--vc-surface'] = n.surfaceColor ?? channelsToHex(roles.surface)
  cssVars['--vc-surface-raised'] = n.surfaceRaisedColor ?? channelsToHex(roles.surfaceRaised)
  cssVars['--vc-surface-overlay'] = channelsToHex(roles.surfaceOverlay)
  cssVars['--vc-border'] = n.borderColor ?? channelsToHex(roles.border)
  cssVars['--vc-border-strong'] = channelsToHex(roles.borderStrong)
  cssVars['--vc-text-primary'] = n.textPrimaryColor ?? channelsToHex(roles.textPrimary)
  cssVars['--vc-text-secondary'] = n.textSecondaryColor ?? channelsToHex(roles.textSecondary)
  cssVars['--vc-text-muted'] = n.textMutedColor ?? channelsToHex(roles.textMuted)
  cssVars['--vc-primary'] = primaryHex
  cssVars['--vc-accent'] = accentHex
  cssVars['--vc-success'] = successHex
  cssVars['--vc-warning'] = warningHex
  cssVars['--vc-danger'] = dangerHex
  cssVars['--vc-information'] = informationHex
  cssVars['--vc-offline'] = offlineHex
  cssVars['--vc-recording'] = recordingHex
  cssVars['--vc-analytics'] = analyticsHex
  cssVars['--vc-radius'] = `${radiusPx}px`
  cssVars['--vc-component-height'] = `${componentHeightPx}px`
  cssVars['--vc-sidebar-width'] = `${sidebarWidthPx}px`
  cssVars['--vc-font-family'] = n.fontFamily
  cssVars['--vc-font-scale'] = String(n.fontScale)

  // ── Variables legacy --brand-* / --surface-* derivadas del MISMO motor ──
  // (mantenidas temporalmente; NO se calculan con un algoritmo distinto).
  for (const [shade, channels] of Object.entries(brandScale)) {
    cssVars[`--brand-${shade}`] = channels
  }
  for (const [shade, channels] of Object.entries(surfaceScale)) {
    cssVars[`--surface-${shade}`] = channels
  }
  // Compat: algunos consumidores usaban --brand y --surface-950.
  cssVars['--brand'] = brandScale['500']
  cssVars['--surface-950'] = surfaceScale['900']

  // Overrides de superficie V2 reflejados también en la escala legacy para que
  // los componentes que usan bg-surface-* respeten el color elegido.
  cssVars['--surface-900'] = channelOr(n.backgroundColor, surfaceScale['900'])
  cssVars['--surface-800'] = channelOr(n.surfaceColor, surfaceScale['800'])
  cssVars['--surface-700'] = channelOr(n.surfaceRaisedColor, surfaceScale['700'])
  cssVars['--surface-600'] = channelOr(n.borderColor, surfaceScale['600'])

  return {
    cssVars,
    documentTitle: n.siteName,
    faviconUrl: n.faviconUrl,
    customCss: n.customCss,
    resolvedMode: mode,
  }
}

function channelsToHex(channels: string): string {
  const [r, g, b] = channels.split(' ').map((x) => parseInt(x, 10))
  const to2 = (v: number) => v.toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

// ─── Aplicación al documento (ÚNICO punto que toca el DOM) ─────

const CUSTOM_CSS_STYLE_ID = 'visioncore-custom-css'

/** Objetivo mínimo para escribir variables — permite inyectar un fake en tests. */
export interface StyleTarget {
  style: {
    setProperty(name: string, value: string): void
    removeProperty(name: string): void
  }
}

export interface ApplyOptions {
  /** Elemento raíz sobre el que escribir (default document.documentElement). */
  root?: StyleTarget
  /** Documento (default global document). Permite tests sin jsdom. */
  doc?: Document
  /** Resuelve una URL de asset relativa a absoluta (p.ej. resolveAssetUrl). */
  resolveAsset?: (url: string | null | undefined) => string | null | undefined
}

function getRoot(opts: ApplyOptions): StyleTarget | null {
  if (opts.root) return opts.root
  if (typeof document !== 'undefined') return document.documentElement as unknown as StyleTarget
  return null
}

function getDoc(opts: ApplyOptions): Document | null {
  if (opts.doc) return opts.doc
  if (typeof document !== 'undefined') return document
  return null
}

/** Escribe los tokens en el documento. Único aplicador de la aplicación. */
export function applyAppearanceTokens(tokens: AppearanceTokens, opts: ApplyOptions = {}): void {
  const root = getRoot(opts)
  if (root) {
    for (const [name, value] of Object.entries(tokens.cssVars)) {
      root.style.setProperty(name, value)
    }
  }

  const doc = getDoc(opts)
  if (!doc) return

  // Título
  if (tokens.documentTitle) doc.title = tokens.documentTitle

  // Favicon
  const favicon = opts.resolveAsset ? opts.resolveAsset(tokens.faviconUrl) : (tokens.faviconUrl || '')
  if (favicon) {
    let link = doc.querySelector<HTMLLinkElement>("link[rel~='icon']")
    if (!link) { link = doc.createElement('link'); link.rel = 'icon'; doc.head.appendChild(link) }
    link.href = favicon
  }

  // CSS personalizado
  let style = doc.getElementById(CUSTOM_CSS_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = CUSTOM_CSS_STYLE_ID
    doc.head.appendChild(style)
  }
  style.textContent = tokens.customCss || ''
}

/** Lista de todos los nombres de variables que el motor puede escribir. */
export function appearanceVarNames(): string[] {
  // Se construye a partir de un build por defecto para no duplicar la lista.
  return Object.keys(buildAppearanceTokens(null).cssVars)
}

/** Limpia todas las variables y el CSS personalizado aplicados. */
export function resetAppearanceTokens(opts: ApplyOptions = {}): void {
  const root = getRoot(opts)
  if (root) {
    for (const name of appearanceVarNames()) root.style.removeProperty(name)
  }
  const doc = getDoc(opts)
  if (doc) {
    const style = doc.getElementById(CUSTOM_CSS_STYLE_ID)
    if (style) style.textContent = ''
  }
}

/** Conveniencia: normaliza + construye + aplica en un solo paso. */
export function applyAppearance(
  raw: Partial<AppearanceSettings> | null | undefined,
  opts: ApplyOptions & BuildOptions = {},
): AppearanceTokens {
  const tokens = buildAppearanceTokens(raw, { prefersDark: opts.prefersDark })
  applyAppearanceTokens(tokens, opts)
  return tokens
}
