// src/lib/appearanceTokens.test.ts
import { describe, it, expect } from 'vitest'
import {
  normalizeAppearanceSettings,
  buildAppearanceTokens,
  applyAppearanceTokens,
  resetAppearanceTokens,
  appearanceVarNames,
  hexToChannels,
} from './appearanceTokens'
import type { AppearanceSettings } from '@/types'

// Fake StyleTarget que registra las escrituras — evita depender de jsdom.
function makeFakeRoot() {
  const store = new Map<string, string>()
  return {
    store,
    target: {
      style: {
        setProperty: (name: string, value: string) => { store.set(name, value) },
        removeProperty: (name: string) => { store.delete(name) },
      },
    },
  }
}

const legacyDark: Partial<AppearanceSettings> = {
  id: 'singleton',
  siteName: 'Acme Vigilancia',
  logoText: 'Acme',
  primaryColor: '#2563eb',
  accentColor: '#1d4ed8',
  theme: 'dark',
  sidebarWidth: 'normal',
  customCss: '.x{color:red}',
}

describe('normalizeAppearanceSettings — conversión legacy → V2', () => {
  it('deriva themeMode desde el campo legacy `theme` cuando V2 es null', () => {
    expect(normalizeAppearanceSettings({ theme: 'midnight' }).themeMode).toBe('midnight')
    expect(normalizeAppearanceSettings({ theme: 'darker' }).themeMode).toBe('darker')
  })

  it('V2 themeMode tiene prioridad sobre el legacy theme', () => {
    const n = normalizeAppearanceSettings({ theme: 'dark', themeMode: 'light' } as any)
    expect(n.themeMode).toBe('light')
  })

  it('aplica defaults sensatos ante entrada vacía/nula', () => {
    const n = normalizeAppearanceSettings(null)
    expect(n.themeMode).toBe('dark')
    expect(n.primaryColor).toBe('#e51d1d')
    expect(n.fontScale).toBe(1)
    expect(n.density).toBe('normal')
    expect(n.sidebarWidth).toBe('normal')
    expect(n.borderRadius).toBe('md')
  })

  it('es idempotente: normalizar dos veces da el mismo resultado', () => {
    const once = normalizeAppearanceSettings(legacyDark)
    const twice = normalizeAppearanceSettings(once as any)
    expect(twice).toEqual(once)
  })

  it('rechaza hex inválidos dejándolos en null (para derivar del tema)', () => {
    const n = normalizeAppearanceSettings({ backgroundColor: 'notacolor' } as any)
    expect(n.backgroundColor).toBeNull()
  })

  it('acota fontScale a un rango razonable', () => {
    expect(normalizeAppearanceSettings({ fontScale: 99 } as any).fontScale).toBe(1.5)
    expect(normalizeAppearanceSettings({ fontScale: 0.1 } as any).fontScale).toBe(0.75)
  })
})

describe('buildAppearanceTokens — determinismo', () => {
  it('los mismos settings producen siempre exactamente los mismos tokens', () => {
    const a = buildAppearanceTokens(legacyDark)
    const b = buildAppearanceTokens(legacyDark)
    expect(a).toEqual(b)
  })

  it('emite todas las variables --vc-* requeridas', () => {
    const { cssVars } = buildAppearanceTokens(legacyDark)
    const required = [
      '--vc-background', '--vc-surface', '--vc-surface-raised', '--vc-surface-overlay',
      '--vc-border', '--vc-border-strong', '--vc-text-primary', '--vc-text-secondary',
      '--vc-text-muted', '--vc-primary', '--vc-accent', '--vc-success', '--vc-warning',
      '--vc-danger', '--vc-information', '--vc-offline', '--vc-recording', '--vc-analytics',
      '--vc-radius', '--vc-component-height', '--vc-sidebar-width', '--vc-font-family',
      '--vc-font-scale',
    ]
    for (const name of required) {
      expect(cssVars[name], `falta ${name}`).toBeTruthy()
    }
  })

  it('--vc-primary refleja el primaryColor y --vc-accent el accentColor', () => {
    const { cssVars } = buildAppearanceTokens(legacyDark)
    expect(cssVars['--vc-primary']).toBe('#2563eb')
    expect(cssVars['--vc-accent']).toBe('#1d4ed8')
  })

  it('las variables legacy --brand-* derivan del MISMO primaryColor', () => {
    const { cssVars } = buildAppearanceTokens(legacyDark)
    // --brand-600 debe ser exactamente el accent en canales.
    expect(cssVars['--brand-600']).toBe(hexToChannels('#1d4ed8'))
    // --brand-500 no vacío y en formato de canales "R G B".
    expect(cssVars['--brand-500']).toMatch(/^\d+ \d+ \d+$/)
  })

  it('los overrides V2 de superficie se reflejan también en la escala legacy', () => {
    const { cssVars } = buildAppearanceTokens({ ...legacyDark, backgroundColor: '#101010' } as any)
    expect(cssVars['--vc-background']).toBe('#101010')
    expect(cssVars['--surface-900']).toBe(hexToChannels('#101010'))
  })
})

describe('buildAppearanceTokens — modos de tema', () => {
  const modes = ['light', 'dark', 'darker', 'midnight'] as const
  it('cada modo produce un fondo distinto', () => {
    const backgrounds = modes.map((m) => buildAppearanceTokens({ themeMode: m } as any).cssVars['--vc-background'])
    expect(new Set(backgrounds).size).toBe(modes.length)
  })

  it('resolvedMode expone el modo efectivo', () => {
    for (const m of modes) {
      expect(buildAppearanceTokens({ themeMode: m } as any).resolvedMode).toBe(m)
    }
  })

  it('system resuelve a dark o light según prefers-color-scheme', () => {
    const dark = buildAppearanceTokens({ themeMode: 'system' } as any, { prefersDark: true })
    const light = buildAppearanceTokens({ themeMode: 'system' } as any, { prefersDark: false })
    expect(dark.resolvedMode).toBe('dark')
    expect(light.resolvedMode).toBe('light')
    expect(dark.cssVars['--vc-background']).not.toBe(light.cssVars['--vc-background'])
  })

  it('el tema light invierte la escala legacy (surface-900 claro)', () => {
    const { cssVars } = buildAppearanceTokens({ themeMode: 'light' } as any)
    // En light, surface-900 (slot de fondo) debe ser claro (canales altos).
    const [r] = cssVars['--surface-900'].split(' ').map(Number)
    expect(r).toBeGreaterThan(200)
  })
})

describe('buildAppearanceTokens — densidad, sidebar, tipografía', () => {
  it('densidad compact/normal/comfortable cambia la altura de componente', () => {
    const c = buildAppearanceTokens({ density: 'compact' } as any).cssVars['--vc-component-height']
    const n = buildAppearanceTokens({ density: 'normal' } as any).cssVars['--vc-component-height']
    const f = buildAppearanceTokens({ density: 'comfortable' } as any).cssVars['--vc-component-height']
    expect(new Set([c, n, f]).size).toBe(3)
    expect(c).toBe('32px'); expect(n).toBe('38px'); expect(f).toBe('44px')
  })

  it('componentHeight explícito tiene prioridad sobre la densidad', () => {
    const v = buildAppearanceTokens({ density: 'compact', componentHeight: 50 } as any)
    expect(v.cssVars['--vc-component-height']).toBe('50px')
  })

  it('sidebar compact/normal/wide cambia el ancho', () => {
    const c = buildAppearanceTokens({ sidebarWidth: 'compact' } as any).cssVars['--vc-sidebar-width']
    const n = buildAppearanceTokens({ sidebarWidth: 'normal' } as any).cssVars['--vc-sidebar-width']
    const w = buildAppearanceTokens({ sidebarWidth: 'wide' } as any).cssVars['--vc-sidebar-width']
    expect(new Set([c, n, w]).size).toBe(3)
    expect(w).toBe('320px')
  })

  it('tipografía: fontFamily y fontScale se reflejan en tokens', () => {
    const v = buildAppearanceTokens({ fontFamily: "'Roboto', sans-serif", fontScale: 1.25 } as any)
    expect(v.cssVars['--vc-font-family']).toBe("'Roboto', sans-serif")
    expect(v.cssVars['--vc-font-scale']).toBe('1.25')
  })
})

describe('buildAppearanceTokens — login antes de autenticación', () => {
  it('con settings por defecto produce tokens completos para tematizar el login', () => {
    // El login se pinta con la respuesta pública/por defecto, sin usuario.
    const { cssVars, documentTitle } = buildAppearanceTokens(null)
    expect(cssVars['--vc-background']).toBeTruthy()
    expect(cssVars['--vc-primary']).toBeTruthy()
    expect(cssVars['--surface-900']).toBeTruthy() // clases Tailwind del login
    expect(cssVars['--brand-600']).toBeTruthy()   // botón primario del login
    expect(documentTitle).toBe('VisionCore')
  })
})

describe('applyAppearanceTokens / resetAppearanceTokens — único aplicador', () => {
  it('un solo aplicador escribe TODAS las variables en el root', () => {
    const { target, store } = makeFakeRoot()
    const tokens = buildAppearanceTokens(legacyDark)
    applyAppearanceTokens(tokens, { root: target })
    // Todas las claves de tokens.cssVars quedaron escritas.
    for (const name of Object.keys(tokens.cssVars)) {
      expect(store.get(name)).toBe(tokens.cssVars[name])
    }
    // Y no escribió nada fuera del set del motor.
    const known = new Set(appearanceVarNames())
    for (const key of store.keys()) expect(known.has(key)).toBe(true)
  })

  it('reset elimina todas las variables escritas', () => {
    const { target, store } = makeFakeRoot()
    applyAppearanceTokens(buildAppearanceTokens(legacyDark), { root: target })
    expect(store.size).toBeGreaterThan(0)
    resetAppearanceTokens({ root: target })
    expect(store.size).toBe(0)
  })

  it('applyAppearanceTokens no lanza si no hay DOM ni root (SSR/tests)', () => {
    expect(() => applyAppearanceTokens(buildAppearanceTokens(null), {})).not.toThrow()
  })
})
