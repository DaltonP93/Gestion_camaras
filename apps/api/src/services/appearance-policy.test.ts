// apps/api/src/services/appearance-policy.test.ts
import { describe, it, expect } from 'vitest'
import {
  canManageAppearance,
  isBlockedSvgUpload,
  BLOCKED_SVG_CODE,
  isAllowedUploadMime,
  detectUploadImageType,
  resolveUploadAsset,
  normalizeUploadUrl,
  toPublishableAppearance,
  PUBLISHABLE_APPEARANCE_FIELDS,
  referencedBrandingFile,
  ownedBrandingFile,
  brandingFilesToDelete,
} from './appearance-policy'

// Firmas mágicas mínimas para las pruebas.
const PNG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const ICO  = Buffer.from([0x00, 0x00, 0x01, 0x00, 0, 0])
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>')
const JS   = Buffer.from("document.title='PWNED';fetch('/x')")

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

describe('detectUploadImageType — firma mágica', () => {
  it('detecta formatos raster permitidos', () => {
    expect(detectUploadImageType(PNG)).toBe('png')
    expect(detectUploadImageType(JPEG)).toBe('jpeg')
    expect(detectUploadImageType(WEBP)).toBe('webp')
    expect(detectUploadImageType(ICO)).toBe('x-icon')
  })

  it('devuelve null para HTML/JS/vacío (no son imágenes)', () => {
    expect(detectUploadImageType(HTML)).toBeNull()
    expect(detectUploadImageType(JS)).toBeNull()
    expect(detectUploadImageType(Buffer.alloc(0))).toBeNull()
  })
})

describe('isAllowedUploadMime', () => {
  it('acepta sólo MIMEs raster de la whitelist', () => {
    expect(isAllowedUploadMime('image/png')).toBe(true)
    expect(isAllowedUploadMime('IMAGE/PNG')).toBe(true)
    expect(isAllowedUploadMime('image/vnd.microsoft.icon')).toBe(true)
    expect(isAllowedUploadMime('text/html')).toBe(false)
    expect(isAllowedUploadMime('application/javascript')).toBe(false)
    expect(isAllowedUploadMime('image/svg+xml')).toBe(false)
  })
})

describe('resolveUploadAsset — MIME permitido + imagen real; extensión del tipo DETECTADO', () => {
  it('acepta PNG real y devuelve .png', () => {
    expect(resolveUploadAsset('image/png', PNG)).toEqual({ ok: true, ext: '.png', type: 'png' })
  })

  it('ICO por cualquiera de sus dos MIMEs → .ico', () => {
    expect(resolveUploadAsset('image/x-icon', ICO)).toEqual({ ok: true, ext: '.ico', type: 'x-icon' })
    expect(resolveUploadAsset('image/vnd.microsoft.icon', ICO)).toEqual({ ok: true, ext: '.ico', type: 'x-icon' })
  })

  it('RECHAZA contenido HTML/JS con MIME image/png falso (CONTENT_MISMATCH)', () => {
    expect(resolveUploadAsset('image/png', HTML)).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' })
    expect(resolveUploadAsset('image/png', JS)).toEqual({ ok: false, reason: 'CONTENT_MISMATCH' })
  })

  // El MIME declarado sale de la extensión del archivo en el navegador: un
  // favicon.ico que es PNG o un .jpg que es WEBP son imágenes legítimas. El
  // chequeo de igualdad MIME↔tipo no protege contra XSS (la extensión guardada
  // ya sale del tipo detectado), así que se aceptan con la extensión REAL.
  it('ACEPTA una imagen real declarada con OTRO MIME permitido y usa la extensión del tipo detectado', () => {
    expect(resolveUploadAsset('image/x-icon', PNG)).toEqual({ ok: true, ext: '.png', type: 'png' })
    expect(resolveUploadAsset('image/jpeg', PNG)).toEqual({ ok: true, ext: '.png', type: 'png' })
    expect(resolveUploadAsset('image/jpeg', WEBP)).toEqual({ ok: true, ext: '.webp', type: 'webp' })
    expect(resolveUploadAsset('image/png', JPEG)).toEqual({ ok: true, ext: '.jpg', type: 'jpeg' })
  })

  it('RECHAZA MIME fuera de la whitelist (MIME_NOT_ALLOWED)', () => {
    expect(resolveUploadAsset('text/html', HTML)).toEqual({ ok: false, reason: 'MIME_NOT_ALLOWED' })
    expect(resolveUploadAsset('image/svg+xml', PNG)).toEqual({ ok: false, reason: 'MIME_NOT_ALLOWED' })
  })
})

describe('archivos de branding: referencias y borrado seguro (archivo compartido)', () => {
  it('referencedBrandingFile cuenta referencias relativas y absolutas, sin query ni hash', () => {
    expect(referencedBrandingFile('/uploads/branding/logo_1.png')).toBe('logo_1.png')
    expect(referencedBrandingFile('https://vms.example.test/uploads/branding/logo_1.png?v=2#x')).toBe('logo_1.png')
    expect(referencedBrandingFile('https://cdn.example.org/otra/logo_1.png')).toBeNull()
    expect(referencedBrandingFile(null)).toBeNull()
  })

  it('ownedBrandingFile sólo acepta la ruta relativa (o la legacy de localhost) con nombre plano', () => {
    expect(ownedBrandingFile('/uploads/branding/logo_1.png')).toBe('logo_1.png')
    expect(ownedBrandingFile('http://localhost:4000/uploads/branding/logo_1.png')).toBe('logo_1.png')
    expect(ownedBrandingFile('https://cdn.example.org/uploads/branding/logo_1.png')).toBeNull()
    for (const bad of ['/uploads/branding/../secreto.png', '/uploads/branding/a/b.png', '/uploads/branding/..', '/uploads/branding/', '/uploads/avatars/x.png']) {
      expect(ownedBrandingFile(bad), bad).toBeNull()
    }
  })

  it('brandingFilesToDelete no borra lo que otra columna sigue usando ni archivos que no son nuestros', () => {
    const shared = '/uploads/branding/c.png'
    // Logo y sidebar comparten: reemplazar sólo el logo ⇒ nada que borrar.
    expect(brandingFilesToDelete({ logoUrl: shared, sidebarLogoUrl: shared }, { logoUrl: '/uploads/branding/n.png', sidebarLogoUrl: shared }, ['logoUrl'])).toEqual([])
    // Referencia absoluta del mismo archivo en otra columna ⇒ también protege.
    expect(brandingFilesToDelete({ logoUrl: shared }, { logoUrl: '/uploads/branding/n.png', faviconUrl: 'https://vms.example.test/uploads/branding/c.png' }, ['logoUrl'])).toEqual([])
    // Reemplazar los dos campos que compartían ⇒ se borra una sola vez.
    expect(brandingFilesToDelete({ logoUrl: shared, sidebarLogoUrl: shared }, { logoUrl: '/uploads/branding/n1.png', sidebarLogoUrl: '/uploads/branding/n2.png' }, ['logoUrl', 'sidebarLogoUrl'])).toEqual(['c.png'])
    // URL absoluta de otro host ⇒ no es nuestro archivo.
    expect(brandingFilesToDelete({ logoUrl: 'https://cdn.example.org/uploads/branding/c.png' }, { logoUrl: '/uploads/branding/n.png' }, ['logoUrl'])).toEqual([])
  })
})
