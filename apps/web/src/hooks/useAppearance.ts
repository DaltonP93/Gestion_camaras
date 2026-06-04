// src/hooks/useAppearance.ts
import { useEffect } from 'react'
import { apiGet } from '@/lib/api'
import type { AppearanceSettings } from '@/types'

function hexToSpacedRgb(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `${r} ${g} ${b}`
}

const THEME_BG: Record<string, { 950: string; 900: string; 800: string; 750: string; 700: string; 600: string; 500: string; 400: string }> = {
  dark:     { 950: '10 10 12',    900: '15 15 18',    800: '22 22 26',    750: '26 26 31',    700: '32 32 38',    600: '50 50 58',    500: '80 80 90',    400: '120 120 132' },
  darker:   { 950: '6 6 8',       900: '10 10 12',    800: '16 16 20',    750: '20 20 24',    700: '26 26 32',    600: '44 44 52',    500: '72 72 82',    400: '110 110 122' },
  midnight: { 950: '4 6 14',      900: '8 10 20',     800: '13 15 28',    750: '17 19 34',    700: '22 24 42',    600: '38 40 60',    500: '65 68 92',    400: '100 103 134' },
}

export function applyAppearanceToDocument(settings: AppearanceSettings): void {
  const root = document.documentElement

  // Brand/accent colors
  root.style.setProperty('--brand', hexToSpacedRgb(settings.primaryColor))
  const shade = (hex: string, factor: number): string => {
    const h = hex.replace('#', '')
    const r = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(0, 2), 16) * factor)))
    const g = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(2, 4), 16) * factor)))
    const b = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(4, 6), 16) * factor)))
    return `${r} ${g} ${b}`
  }
  root.style.setProperty('--brand-50',  shade(settings.primaryColor, 1.9))
  root.style.setProperty('--brand-100', shade(settings.primaryColor, 1.7))
  root.style.setProperty('--brand-200', shade(settings.primaryColor, 1.5))
  root.style.setProperty('--brand-300', shade(settings.primaryColor, 1.3))
  root.style.setProperty('--brand-400', shade(settings.primaryColor, 1.15))
  root.style.setProperty('--brand-500', hexToSpacedRgb(settings.primaryColor))
  root.style.setProperty('--brand-600', hexToSpacedRgb(settings.accentColor || settings.primaryColor))
  root.style.setProperty('--brand-700', shade(settings.accentColor || settings.primaryColor, 0.75))
  root.style.setProperty('--brand-800', shade(settings.accentColor || settings.primaryColor, 0.5))
  root.style.setProperty('--brand-900', shade(settings.accentColor || settings.primaryColor, 0.25))

  // Surface/background vars from theme
  const theme = THEME_BG[settings.theme] ?? THEME_BG.dark
  root.style.setProperty('--surface-950', theme[950])
  root.style.setProperty('--surface-900', theme[900])
  root.style.setProperty('--surface-800', theme[800])
  root.style.setProperty('--surface-750', theme[750])
  root.style.setProperty('--surface-700', theme[700])
  root.style.setProperty('--surface-600', theme[600])
  root.style.setProperty('--surface-500', theme[500])
  root.style.setProperty('--surface-400', theme[400])

  // Custom CSS
  const styleId = 'visioncore-custom-css'
  let styleEl = document.getElementById(styleId) as HTMLStyleElement | null
  if (settings.customCss) {
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = styleId
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = settings.customCss
  } else if (styleEl) {
    styleEl.textContent = ''
  }

  // Site name → document title
  if (settings.siteName) {
    document.title = settings.siteName
  }

  // Favicon
  if (settings.faviconUrl) {
    const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (existing) {
      existing.href = settings.faviconUrl
    } else {
      const link = document.createElement('link')
      link.rel = 'icon'
      link.href = settings.faviconUrl
      document.head.appendChild(link)
    }
  }
}

let _cachedSettings: AppearanceSettings | null = null

export function useAppearance(): void {
  useEffect(() => {
    if (_cachedSettings) {
      applyAppearanceToDocument(_cachedSettings)
      return
    }
    apiGet<AppearanceSettings>('/appearance')
      .then((data) => {
        _cachedSettings = data
        applyAppearanceToDocument(data)
      })
      .catch(() => {})
  }, [])
}

export function invalidateAppearanceCache(): void {
  _cachedSettings = null
}
