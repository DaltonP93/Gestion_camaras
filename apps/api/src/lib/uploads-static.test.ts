// Pruebas de la política de servido de /uploads/ (defensa en profundidad anti-XSS).
import { describe, it, expect } from 'vitest'
import {
  isServableUploadPath,
  applyUploadResponseHeaders,
  uploadsStaticOptions,
  UPLOADS_CSP,
} from './uploads-static'

describe('isServableUploadPath', () => {
  it('permite extensiones de imagen', () => {
    for (const p of ['/branding/a.png', '/branding/a.jpg', '/branding/a.jpeg', '/branding/a.webp', '/branding/a.ico', '/b/a.GIF']) {
      expect(isServableUploadPath(p)).toBe(true)
    }
  })

  it('sigue sirviendo los .svg ya configurados (política: "los SVG ya configurados no se tocan")', () => {
    expect(isServableUploadPath('/branding/logo_legacy.svg')).toBe(true)
    expect(isServableUploadPath('/branding/LOGO.SVG')).toBe(true)
  })

  it('404ea (false) extensiones ejecutables/legadas', () => {
    for (const p of ['/branding/a.html', '/branding/a.htm', '/branding/a.js', '/branding/a.xml', '/branding/a.xhtm', '/branding/a.svgz', '/branding/sinext']) {
      expect(isServableUploadPath(p)).toBe(false)
    }
  })
})

describe('applyUploadResponseHeaders', () => {
  it('fija nosniff + CSP sandbox + XFO', () => {
    const headers: Record<string, string> = {}
    applyUploadResponseHeaders({ header: (k, v) => { headers[k] = v } })
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN')
    expect(headers['Content-Security-Policy']).toBe(UPLOADS_CSP)
  })

  it('la CSP de /uploads/ es sandbox SIN allow-scripts y conserva frame-ancestors de helmet (la reemplaza)', () => {
    const directives = UPLOADS_CSP.split(';').map((d) => d.trim())
    expect(directives).toContain('sandbox')
    expect(directives).toContain("default-src 'none'")
    expect(directives).toContain("frame-ancestors 'self'")
    expect(UPLOADS_CSP).not.toMatch(/allow-scripts/)
  })
})

describe('uploadsStaticOptions — única fuente de las opciones de @fastify/static', () => {
  it('monta /uploads/ sobre el root dado con el guard de servido y las cabeceras', () => {
    const opts = uploadsStaticOptions('/tmp/uploads-x')
    expect(opts.root).toBe('/tmp/uploads-x')
    expect(opts.prefix).toBe('/uploads/')
    expect(opts.decorateReply).toBe(false)
    expect(typeof opts.allowedPath).toBe('function')
    expect(typeof opts.setHeaders).toBe('function')
  })
})

describe('server.ts — cableado de @fastify/static para /uploads/', () => {
  it('registra staticFiles UNA sola vez y con uploadsStaticOptions(uploadsDir)', async () => {
    // server.ts no es importable (ejecuta main() al importarse). Igual que el
    // precedente de stream-manager-races.test.ts, se fija el cableado sobre el
    // fuente: si alguien vuelve a opciones inline sin allowedPath/setHeaders, o
    // agrega otro montaje estático sin el guard, esta prueba falla.
    const server = (await import('node:fs')).readFileSync(
      new URL('../server.ts', import.meta.url), 'utf8')
    const registers = server.match(/register\(\s*staticFiles\b/g) ?? []
    expect(registers).toHaveLength(1)
    expect(server).toMatch(/register\(\s*staticFiles\s*,\s*uploadsStaticOptions\(\s*uploadsDir\s*\)\s*\)/)
    expect(server).toMatch(/import\s*\{\s*uploadsStaticOptions\s*\}\s*from\s*'\.\/lib\/uploads-static'/)
  })
})
