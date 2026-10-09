// Pruebas de RUTA del endurecimiento anti-XSS almacenado de la carga de branding
// (POST /api/appearance/upload) + política de servido de /uploads/.
//
// Contexto: el MIME de la parte multipart y el nombre de archivo los controla el
// cliente. Antes del fix, la extensión guardada salía del nombre del cliente, así
// que se podía guardar un .js/.html con un Content-Type de imagen falso y
// @fastify/static lo servía con Content-Type EJECUTABLE en el mismo origen
// (XSS que esquiva la CSP vía <script src> mismo-origen). Repro aislada con
// Chromium confirmó la ejecución.
//
// El servido se monta con `uploadsStaticOptions` (las MISMAS opciones que usa
// server.ts) y helmet con las `cspDirectives` reales, así que estas pruebas
// ejercitan el cableado de producción; que server.ts siga usando el helper lo
// fija uploads-static.test.ts. Las cargas se arman con FormData/Blob/Response
// nativos de Node (sin depender de `form-data`, que no está declarado).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import staticFiles from '@fastify/static'
import multipart from '@fastify/multipart'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import fs from 'fs'
import os from 'os'
import path from 'path'
import appearancePlugin from './appearance'
import { uploadsStaticOptions, UPLOADS_CSP } from '../lib/uploads-static'
import { cspDirectives } from '../lib/security-headers'

const JWT_SECRET = 'test-secret-para-repro-aislada-0123456789abcdef'
// PNG mínimo real (firma + IHDR) para el caso legítimo.
const REAL_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
// WEBP mínimo: "RIFF" + tamaño + "WEBP" + chunk VP8.
const REAL_WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])
const LEGACY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'

let app: FastifyInstance
let uploadsDir: string
let token: string
const store: any = { appearance: { id: 'singleton' } }

beforeAll(async () => {
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xss-upl-'))
  fs.mkdirSync(path.join(uploadsDir, 'branding'), { recursive: true })
  process.env.UPLOADS_DIR = uploadsDir

  app = Fastify({ logger: false })
  // Igual que server.ts: helmet con las directivas reales, ANTES del estático.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: cspDirectives },
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
  await app.register(fastifyCookie)
  await app.register(fastifyJwt, { secret: JWT_SECRET, cookie: { cookieName: 'access_token', signed: false } })
  app.decorate('prisma', {
    appearanceSettings: {
      findUnique: async () => store.appearance,
      upsert: async ({ create, update }: any) => { store.appearance = { ...store.appearance, ...(store.appearance ? update : create) }; return store.appearance },
    },
    userFeaturePermissions: { findUnique: async () => null },
  } as any)
  await app.register(staticFiles, uploadsStaticOptions(uploadsDir))
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 4 } })
  await app.register(appearancePlugin, { prefix: '/api/appearance' })
  await app.ready()
  token = app.jwt.sign({ sub: 'admin1', username: 'admin', role: 'ADMIN' })
})

afterAll(async () => { await app.close(); try { fs.rmSync(uploadsDir, { recursive: true, force: true }) } catch {} })

async function uploadPart(field: string, filename: string, mime: string, content: Buffer | string) {
  const form = new FormData()
  form.append(field, new Blob([Buffer.isBuffer(content) ? content : Buffer.from(content)], { type: mime }), filename)
  // Response serializa el multipart (boundary incluido) igual que fetch.
  const encoded = new Response(form)
  return app.inject({
    method: 'POST', url: '/api/appearance/upload',
    headers: { authorization: `Bearer ${token}`, 'content-type': encoded.headers.get('content-type') ?? '' },
    payload: Buffer.from(await encoded.arrayBuffer()),
  })
}

describe('POST /api/appearance/upload — anti-XSS almacenado', () => {
  it('RECHAZA un .js con MIME image/png falso (no coincide la firma mágica)', async () => {
    const res = await uploadPart('headerLogo', 'evil.js', 'image/png', "document.title='PWNED';")
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('UNSAFE_UPLOAD_CONTENT')
  })

  it('RECHAZA un .html con MIME image/png falso', async () => {
    const res = await uploadPart('headerLogo', 'evil.html', 'image/png', '<script>document.title="x"</script>')
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('UNSAFE_UPLOAD_CONTENT')
  })

  it('ACEPTA un PNG real y guarda extensión .png DERIVADA del contenido, ignorando el nombre .html del cliente', async () => {
    const res = await uploadPart('headerLogo', 'evil.html', 'image/png', REAL_PNG)
    expect(res.statusCode).toBe(200)
    const url: string = res.json().logoUrl
    expect(url.endsWith('.png')).toBe(true)
    expect(url.endsWith('.html')).toBe(false)
  })

  // El navegador deduce file.type de la EXTENSIÓN: un favicon.ico que en
  // realidad es PNG, o un .jpg que es WEBP, son comunes y antes se aceptaban.
  it('ACEPTA un PNG real nombrado favicon.ico (MIME image/x-icon) y lo guarda como .png', async () => {
    const res = await uploadPart('favicon', 'favicon.ico', 'image/x-icon', REAL_PNG)
    expect(res.statusCode).toBe(200)
    const url: string = res.json().faviconUrl
    expect(url).toMatch(/^\/uploads\/branding\/favicon_\d+\.png$/)
    const get = await app.inject({ method: 'GET', url })
    expect(get.statusCode).toBe(200)
    expect(get.headers['content-type']).toBe('image/png')
  })

  it('ACEPTA un WEBP real nombrado logo.jpg (MIME image/jpeg) y lo guarda como .webp', async () => {
    const res = await uploadPart('sidebarLogo', 'logo.jpg', 'image/jpeg', REAL_WEBP)
    expect(res.statusCode).toBe(200)
    expect(res.json().sidebarLogoUrl).toMatch(/^\/uploads\/branding\/sidebarLogo_\d+\.webp$/)
  })
})

describe('POST /api/appearance/upload — varias partes', () => {
  it('si una parte posterior es inválida ⇒ 400 sin tocar el disco ni la DB (el logo anterior sigue existiendo)', async () => {
    const first = await uploadPart('headerLogo', 'logo.png', 'image/png', REAL_PNG)
    expect(first.statusCode).toBe(200)
    const prevUrl: string = first.json().logoUrl
    const prevFile = path.join(uploadsDir, 'branding', path.basename(prevUrl))
    expect(fs.existsSync(prevFile)).toBe(true)
    const filesBefore = fs.readdirSync(path.join(uploadsDir, 'branding')).sort()

    const form = new FormData()
    form.append('headerLogo', new Blob([REAL_PNG], { type: 'image/png' }), 'nuevo.png')
    form.append('favicon', new Blob([Buffer.from('<script>x</script>')], { type: 'image/png' }), 'evil.html')
    const encoded = new Response(form)
    const res = await app.inject({
      method: 'POST', url: '/api/appearance/upload',
      headers: { authorization: `Bearer ${token}`, 'content-type': encoded.headers.get('content-type') ?? '' },
      payload: Buffer.from(await encoded.arrayBuffer()),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('UNSAFE_UPLOAD_CONTENT')
    expect(store.appearance.logoUrl).toBe(prevUrl)
    expect(fs.existsSync(prevFile)).toBe(true)
    expect(fs.readdirSync(path.join(uploadsDir, 'branding')).sort()).toEqual(filesBefore)
  })

  it('carga válida de reemplazo ⇒ la DB apunta al nuevo y recién entonces se borra el anterior', async () => {
    const first = await uploadPart('loginLogo', 'a.png', 'image/png', REAL_PNG)
    const prevFile = path.join(uploadsDir, 'branding', path.basename(first.json().logoUrl))
    await new Promise((r) => setTimeout(r, 5))
    const second = await uploadPart('loginLogo', 'b.png', 'image/png', REAL_PNG)
    expect(second.statusCode).toBe(200)
    const newUrl: string = second.json().logoUrl
    expect(newUrl).not.toBe(first.json().logoUrl)
    expect(fs.existsSync(path.join(uploadsDir, 'branding', path.basename(newUrl)))).toBe(true)
    expect(fs.existsSync(prevFile)).toBe(false)
  })
})

// Archivo compartido: el mismo archivo puede estar referenciado por más de una
// columna (logo, sidebar, favicon), p. ej. cargado una vez y reutilizado por
// PUT /api/appearance. Reemplazar uno de los campos NO debe borrar un archivo que
// otro campo sigue usando, ni un archivo local que coincide por nombre con una URL
// absoluta (de otro host o cargada a mano).
describe('POST /api/appearance/upload — archivo compartido entre campos', () => {
  const brandingFile = (name: string) => path.join(uploadsDir, 'branding', name)
  const seed = (name: string) => { fs.writeFileSync(brandingFile(name), REAL_PNG); return `/uploads/branding/${name}` }

  it('logo y sidebar comparten archivo: reemplazar el logo conserva el archivo del sidebar (sigue sirviéndose)', async () => {
    const shared = seed('compartido_1.png')
    store.appearance = { id: 'singleton', logoUrl: shared, sidebarLogoUrl: shared, faviconUrl: null }

    const res = await uploadPart('loginLogo', 'nuevo.png', 'image/png', REAL_PNG)

    expect(res.statusCode).toBe(200)
    expect(res.json().logoUrl).not.toBe(shared)
    expect(store.appearance.sidebarLogoUrl).toBe(shared)
    expect(fs.existsSync(brandingFile('compartido_1.png'))).toBe(true)
    expect((await app.inject({ method: 'GET', url: shared })).statusCode).toBe(200)
  })

  it('la referencia por URL absoluta del mismo archivo (cargada por PUT) también lo protege', async () => {
    const shared = seed('compartido_2.png')
    store.appearance = { id: 'singleton', logoUrl: shared, sidebarLogoUrl: 'https://vms.example.test/uploads/branding/compartido_2.png', faviconUrl: null }

    const res = await uploadPart('loginLogo', 'nuevo.png', 'image/png', REAL_PNG)

    expect(res.statusCode).toBe(200)
    expect(fs.existsSync(brandingFile('compartido_2.png'))).toBe(true)
  })

  it('una URL absoluta de otro host con el mismo nombre que un archivo local no borra el archivo local', async () => {
    seed('ajeno_1.png')
    store.appearance = { id: 'singleton', logoUrl: 'https://cdn.example.org/uploads/branding/ajeno_1.png', sidebarLogoUrl: null, faviconUrl: null }

    const res = await uploadPart('loginLogo', 'nuevo.png', 'image/png', REAL_PNG)

    expect(res.statusCode).toBe(200)
    expect(fs.existsSync(brandingFile('ajeno_1.png'))).toBe(true)
  })

  it('reemplazar dos campos que compartían archivo en la misma carga sí lo borra (ya nadie lo usa)', async () => {
    const shared = seed('compartido_3.png')
    store.appearance = { id: 'singleton', logoUrl: shared, sidebarLogoUrl: shared, faviconUrl: null }

    const form = new FormData()
    form.append('loginLogo', new Blob([REAL_PNG], { type: 'image/png' }), 'a.png')
    form.append('sidebarLogo', new Blob([REAL_PNG], { type: 'image/png' }), 'b.png')
    const encoded = new Response(form)
    const res = await app.inject({
      method: 'POST', url: '/api/appearance/upload',
      headers: { authorization: `Bearer ${token}`, 'content-type': encoded.headers.get('content-type') ?? '' },
      payload: Buffer.from(await encoded.arrayBuffer()),
    })

    expect(res.statusCode).toBe(200)
    expect(fs.existsSync(brandingFile('compartido_3.png'))).toBe(false)
    for (const url of [res.json().logoUrl, res.json().sidebarLogoUrl]) {
      expect(fs.existsSync(brandingFile(path.basename(url)))).toBe(true)
    }
  })
})

describe('GET /uploads/ — política de servido (defensa en profundidad)', () => {
  it('404 para un .js LEGADO ya presente en disco (sin borrarlo)', async () => {
    const legacy = path.join(uploadsDir, 'branding', 'legacy_payload.js')
    fs.writeFileSync(legacy, "document.title='PWNED';")
    const res = await app.inject({ method: 'GET', url: '/uploads/branding/legacy_payload.js' })
    expect(res.statusCode).toBe(404)
    // No se borró: sigue en disco (la política es de SERVIDO, no destructiva).
    expect(fs.existsSync(legacy)).toBe(true)
  })

  it('404 para un .html LEGADO', async () => {
    fs.writeFileSync(path.join(uploadsDir, 'branding', 'legacy.html'), '<script>1</script>')
    const res = await app.inject({ method: 'GET', url: '/uploads/branding/legacy.html' })
    expect(res.statusCode).toBe(404)
  })

  it('sirve un .png con nosniff + UNA sola CSP (sandbox + frame-ancestors) que reemplaza la de helmet', async () => {
    fs.writeFileSync(path.join(uploadsDir, 'branding', 'ok.png'), REAL_PNG)
    const res = await app.inject({ method: 'GET', url: '/uploads/branding/ok.png' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    // Un único valor (no un array): setHeaders PISA la CSP de helmet, no se
    // intersecta con ella. Por eso UPLOADS_CSP repite frame-ancestors 'self'.
    expect(res.headers['content-security-policy']).toBe(UPLOADS_CSP)
    expect(String(res.headers['content-security-policy'])).toContain('sandbox')
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'self'")
  })

  it('sigue sirviendo un .svg YA configurado (no se toca) con nosniff + CSP sandbox', async () => {
    const legacy = path.join(uploadsDir, 'branding', 'logo_legacy.svg')
    fs.writeFileSync(legacy, LEGACY_SVG)
    const res = await app.inject({ method: 'GET', url: '/uploads/branding/logo_legacy.svg' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/svg+xml')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBe(UPLOADS_CSP)
    expect(fs.existsSync(legacy)).toBe(true)
  })

  it('404 para un .svgz LEGADO (sólo podía llegar por el bug)', async () => {
    fs.writeFileSync(path.join(uploadsDir, 'branding', 'legacy.svgz'), LEGACY_SVG)
    const res = await app.inject({ method: 'GET', url: '/uploads/branding/legacy.svgz' })
    expect(res.statusCode).toBe(404)
  })
})
