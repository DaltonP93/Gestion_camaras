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

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]
}

function hexToHsl(hex: string): [number, number, number] {
  let [r, g, b] = hexToRgb(hex)
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0, l = (max + min) / 2
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
    if (t < 1/6) return p + (q-p)*6*t
    if (t < 1/2) return q
    if (t < 2/3) return p + (q-p)*(2/3-t)*6
    return p
  }
  return [Math.round(hue2rgb(p,q,h+1/3)*255), Math.round(hue2rgb(p,q,h)*255), Math.round(hue2rgb(p,q,h-1/3)*255)]
}

function rgbChannels(r: number, g: number, b: number): string {
  return `${r} ${g} ${b}`
}

function generateBrandScale(primaryHex: string, accentHex?: string): Record<string, string> {
  const [hue, sat] = hexToHsl(primaryHex)
  const lights = [96, 92, 84, 73, 62, 52, 43, 34, 27, 20]
  const satScales = [0.25, 0.40, 0.55, 0.70, 0.85, 1.0, 1.0, 0.95, 0.85, 0.75]
  const keys = ['50','100','200','300','400','500','600','700','800','900']
  const result: Record<string, string> = {}
  keys.forEach((key, i) => {
    const s = Math.min(sat * satScales[i], 95)
    const [r, g, b] = hslToRgb(hue, s, lights[i])
    result[key] = rgbChannels(r, g, b)
  })
  if (accentHex) {
    const [r, g, b] = hexToRgb(accentHex)
    result['600'] = rgbChannels(r, g, b)
  }
  return result
}

const SURFACE_THEMES: Record<string, Record<string, string>> = {
  dark: {
    '--surface-900': '13 17 23',
    '--surface-800': '22 27 34',
    '--surface-750': '27 32 40',
    '--surface-700': '33 38 45',
    '--surface-600': '48 54 61',
    '--surface-500': '72 79 88',
    '--surface-400': '110 118 129',
    '--surface-300': '139 148 158',
    '--surface-200': '177 186 196',
    '--surface-100': '201 209 217',
    '--surface-50':  '240 246 252',
  },
  darker: {
    '--surface-900': '8 10 14',
    '--surface-800': '13 17 24',
    '--surface-750': '17 22 30',
    '--surface-700': '22 28 36',
    '--surface-600': '34 40 50',
    '--surface-500': '55 62 74',
    '--surface-400': '95 103 116',
    '--surface-300': '130 139 152',
    '--surface-200': '172 181 195',
    '--surface-100': '198 207 220',
    '--surface-50':  '236 242 250',
  },
  midnight: {
    '--surface-900': '1 3 12',
    '--surface-800': '5 9 22',
    '--surface-750': '8 13 30',
    '--surface-700': '12 18 42',
    '--surface-600': '20 28 60',
    '--surface-500': '38 48 90',
    '--surface-400': '82 95 145',
    '--surface-300': '128 143 188',
    '--surface-200': '175 188 222',
    '--surface-100': '210 218 242',
    '--surface-50':  '238 243 255',
  },
}

function applyToDocument(s: AppearanceSettings) {
  // Title
  if (s.siteName) document.title = s.siteName

  // Favicon
  const favicon = resolveAssetUrl(s.faviconUrl)
  if (favicon) {
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
    link.href = favicon
  }

  // Custom CSS
  const styleId = 'visioncore-custom-css'
  let style = document.getElementById(styleId) as HTMLStyleElement | null
  if (!style) { style = document.createElement('style'); style.id = styleId; document.head.appendChild(style) }
  style.textContent = s.customCss || ''

  const root = document.documentElement

  // Brand color scale
  if (s.primaryColor) {
    const scale = generateBrandScale(s.primaryColor, s.accentColor || undefined)
    Object.entries(scale).forEach(([shade, channels]) => {
      root.style.setProperty(`--brand-${shade}`, channels)
    })
  }

  // Surface theme
  const theme = s.theme || 'dark'
  const surfaceVars = SURFACE_THEMES[theme] ?? SURFACE_THEMES.dark
  Object.entries(surfaceVars).forEach(([varName, channels]) => {
    root.style.setProperty(varName, channels)
  })
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
