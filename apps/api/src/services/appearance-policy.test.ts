// apps/api/src/services/appearance-policy.test.ts
import { describe, it, expect } from 'vitest'
import {
  canManageAppearance,
  isBlockedSvgUpload,
  BLOCKED_SVG_CODE,
  normalizeUploadUrl,
  toPublishableAppearance,
  PUBLISHABLE_APPEARANCE_FIELDS,
} from './appearance-policy'

describe('canManageAppearance', () => {
  it('permite a ADMIN siempre (aunque no tenga override)', () => {
    expect(canManageAppearance('ADMIN', null)).toBe(true)
    expect(canManageAppearance('ADMIN', { canManageAppearance: false })).toBe(true)
  })

  it('permite a un no-ADMIN con canManageAppearance=true', () => {
    expect(canManageAppearance('SUPERVISOR', { canManageAppearance: true })).toBe(true)
  })

  it('rechaza a un no-ADMIN sin el permiso', () => {
    expect(canManageAppearance('SUPERVISOR', null)).toBe(false)
    expect(canManageAppearance('OPERATOR', { canManageAppearance: false })).toBe(false)
    expect(canManageAppearance('AUDITOR', {})).toBe(false)
  })
})

describe('isBlockedSvgUpload', () => {
  it('bloquea image/svg+xml', () => {
    expect(isBlockedSvgUpload('image/svg+xml')).toBe(true)
    expect(isBlockedSvgUpload('IMAGE/SVG+XML')).toBe(true)
  })

  it('bloquea por extensión .svg aunque el MIME venga disfrazado', () => {
    expect(isBlockedSvgUpload('image/png', 'logo.svg')).toBe(true)
    expect(isBlockedSvgUpload('application/octet-stream', 'x.SVG')).toBe(true)
  })

  it('no bloquea formatos raster permitidos', () => {
    expect(isBlockedSvgUpload('image/png', 'logo.png')).toBe(false)
    expect(isBlockedSvgUpload('image/jpeg', 'a.jpg')).toBe(false)
    expect(isBlockedSvgUpload('image/webp')).toBe(false)
  })

  it('expone el código de error estable', () => {
    expect(BLOCKED_SVG_CODE).toBe('UNSAFE_SVG_UPLOAD_DISABLED')
  })
})

describe('normalizeUploadUrl — no regresión de /uploads/branding/', () => {
  it('convierte localhost absoluto en ruta relativa', () => {
    expect(normalizeUploadUrl('http://localhost:4000/uploads/branding/logo.png'))
      .toBe('/uploads/branding/logo.png')
    expect(normalizeUploadUrl('https://localhost/uploads/branding/x.png'))
      .toBe('/uploads/branding/x.png')
  })

  it('deja intactas las rutas ya relativas (idempotente)', () => {
    expect(normalizeUploadUrl('/uploads/branding/logo.png')).toBe('/uploads/branding/logo.png')
  })

  it('mapea null/undefined/"" a cadena vacía', () => {
    expect(normalizeUploadUrl(null)).toBe('')
    expect(normalizeUploadUrl(undefined)).toBe('')
    expect(normalizeUploadUrl('')).toBe('')
  })
})

describe('toPublishableAppearance — sólo campos publicables', () => {
  it('descarta campos fuera de la whitelist (nunca filtra internos)', () => {
    const record = {
      id: 'singleton',
      siteName: 'Acme',
      primaryColor: '#123456',
      // campos NO publicables simulados:
      internalSecret: 'nope',
      updatedBy: 'user-1',
      customCss: null,
    }
    const pub = toPublishableAppearance(record as any)
    expect(pub.internalSecret).toBeUndefined()
    expect(pub.updatedBy).toBeUndefined()
    expect(pub.siteName).toBe('Acme')
    expect(pub.primaryColor).toBe('#123456')
  })

  it('coacciona customCss null → "" y normaliza URLs de assets', () => {
    const pub = toPublishableAppearance({
      customCss: null,
      logoUrl: 'http://localhost:4000/uploads/branding/l.png',
      faviconUrl: null,
      sidebarLogoUrl: '/uploads/branding/s.png',
    } as any)
    expect(pub.customCss).toBe('')
    expect(pub.logoUrl).toBe('/uploads/branding/l.png')
    expect(pub.sidebarLogoUrl).toBe('/uploads/branding/s.png')
    expect(pub.faviconUrl).toBe('')
  })

  it('incluye los campos de token V2 en la whitelist', () => {
    expect(PUBLISHABLE_APPEARANCE_FIELDS).toContain('themeMode')
    expect(PUBLISHABLE_APPEARANCE_FIELDS).toContain('backgroundColor')
    expect(PUBLISHABLE_APPEARANCE_FIELDS).toContain('analyticsColor')
  })
})
