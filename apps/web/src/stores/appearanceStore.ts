// src/stores/appearanceStore.ts
import { create } from 'zustand'
import { apiGet } from '@/lib/api'
import { resolveAssetUrl } from '@/lib/api'
import type { AppearanceSettings } from '@/types'

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

interface AppearanceState {
  settings: AppearanceSettings
  loaded: boolean
  load: () => Promise<void>
  apply: (s: AppearanceSettings) => void
}

function applyToDocument(s: AppearanceSettings) {
  if (s.siteName) document.title = s.siteName
  const favicon = resolveAssetUrl(s.faviconUrl)
  if (favicon) {
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
    link.href = favicon
  }
  const styleId = 'visioncore-custom-css'
  let style = document.getElementById(styleId) as HTMLStyleElement | null
  if (!style) { style = document.createElement('style'); style.id = styleId; document.head.appendChild(style) }
  style.textContent = s.customCss || ''
  const root = document.documentElement
  if (s.primaryColor) {
    root.style.setProperty('--brand-500', s.primaryColor)
    root.style.setProperty('--brand-600', s.accentColor || s.primaryColor)
  }
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
