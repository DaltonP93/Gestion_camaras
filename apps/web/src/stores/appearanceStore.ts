// src/stores/appearanceStore.ts
//
// Store de apariencia. Delega TODO el cálculo y la aplicación en el motor único
// (lib/appearanceTokens). Ya no contiene fórmulas de color propias: es la única
// vía por la que la aplicación tematiza el documento.
import { create } from 'zustand'
import { apiGet, resolveAssetUrl } from '@/lib/api'
import type { AppearanceSettings } from '@/types'
import { applyAppearance } from '@/lib/appearanceTokens'

const DEFAULTS: AppearanceSettings = {
  id: 'singleton',
  siteName: 'VisionCore',
  logoText: 'VisionCore',
  primaryColor: '#e51d1d',
  accentColor: '#c41616',
  theme: 'dark',
  sidebarWidth: 'normal',
  showNVRsInSidebar: true,
  customCss: '',
  logoUrl: '',
  sidebarLogoUrl: '',
  faviconUrl: '',
  updatedAt: '',
}

/** prefers-color-scheme actual (para resolver themeMode 'system'). */
function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Aplica una configuración al documento usando el motor único. */
function applyToDocument(s: AppearanceSettings): void {
  applyAppearance(s, { prefersDark: prefersDark(), resolveAsset: resolveAssetUrl })
}

interface AppearanceState {
  settings: AppearanceSettings
  loaded: boolean
  load: () => Promise<void>
  apply: (s: AppearanceSettings) => void
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  settings: DEFAULTS,
  loaded: false,

  load: async () => {
    try {
      const data = await apiGet<AppearanceSettings>('/appearance')
      const clean: AppearanceSettings = {
        ...DEFAULTS,
        ...data,
        customCss: data.customCss ?? '',
        logoUrl: data.logoUrl ?? '',
        sidebarLogoUrl: data.sidebarLogoUrl ?? '',
        faviconUrl: data.faviconUrl ?? '',
      }
      applyToDocument(clean)
      set({ settings: clean, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  apply: (s: AppearanceSettings) => {
    applyToDocument(s)
    set({ settings: s })
  },
}))
