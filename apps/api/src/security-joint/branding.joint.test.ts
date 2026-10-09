// Suite conjunta de seguridad — branding (#192 × #190 × #182 sobre server.ts real).
//
// Lo que las CI de #192 no prueban en combinación: el server.ts COMPLETO (helmet
// real con la CSP de lib/security-headers, @fastify/static con
// `uploadsStaticOptions`, @fastify/multipart con sus límites reales, hook CSRF y
// JWT con `trusted` de #190) y el navegador simulado (login real, cookie HttpOnly,
// Origin en mutaciones). La carga escribe en el UPLOADS_DIR efímero de la corrida y
// la DB es el PostgreSQL efímero: se verifica disco, DB y lo que se sirve (también
// por el listener TCP real, con las cabeceras tal como salen al cable).
//
// La autorización de apariencia NO usa `server.authenticate`: hace
// `request.jwtVerify()` propio + canManageAppearance leído de la DB en cada petición.
// Por eso se prueba aparte que #190 (sólo access tokens) también rige ahí y que
// quitar la delegación corta en la petición siguiente.
// Contenido de prueba: un PNG real de 1×1 y textos inertes; nada se ejecuta.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))

import fs from 'node:fs'
import path from 'node:path'
import { infra } from './infra-doubles'
import { jointInfraAvailable, startJointServer, JOINT_ORIGIN, type JointEnv, type SimBrowser, type JointResponse } from './harness'
import {
  multipartBody, obtainNonAccessTokens, nonAccessFailures, settle, REAL_PNG,
  type FilePart, type NonAccessTokens,
} from './joint-helpers'
import { UPLOADS_CSP } from '../lib/uploads-static'

const JS_PAYLOAD = Buffer.from('/* inerte */ window.__joint_branding_payload__ = document.domain\n')
const HTML_PAYLOAD = Buffer.from('<!doctype html><html><body><script>window.__joint__=1</script></body></html>\n')
const SVG_PAYLOAD = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.__joint__=1</script></svg>\n')

describe.skipIf(!jointInfraAvailable())('conjunta · branding: carga y servido de /uploads/ (#192)', { timeout: 60_000 }, () => {
  let env: JointEnv
  let brandingDir = ''
  const ids: Record<string, string> = {}
  const b: Record<string, SimBrowser> = {}
  let tokens: NonAccessTokens

  const listBranding = () => fs.readdirSync(brandingDir).sort()
  const upload = (who: SimBrowser, parts: FilePart[], o: { headers?: Record<string, string>; origin?: string | null } = {}) => {
    const { body, contentType } = multipartBody(parts)
    return who.post('/api/appearance/upload', body, { ...o, headers: { 'content-type': contentType, ...(o.headers ?? {}) } })
  }
  const png = (field: string, filename = 'logo.png', contentType = 'image/png'): FilePart => ({ field, filename, contentType, data: REAL_PNG })
  const appearanceRow = () => env.prisma.appearanceSettings.findUnique({ where: { id: 'singleton' } })
  /** Los nombres de archivo llevan Date.now(): dos cargas del mismo campo en el mismo ms colisionarían. */
  const nextMs = async () => { const t = Date.now(); await settle(() => Date.now(), now => now > t, 1000, 1) }

  beforeAll(async () => {
    env = await startJointServer({ label: 'branding' })
    brandingDir = path.join(env.tmpDir, 'uploads', 'branding')
    ids.admin = (await env.createUser('admin_brand', 'ADMIN')).id
    ids.sup = (await env.createUser('sup_brand', 'SUPERVISOR')).id
    ids.op = (await env.createUser('op_brand', 'OPERATOR')).id
    ids.aud = (await env.createUser('aud_brand', 'AUDITOR')).id
    for (const [k, user] of [['admin', 'admin_brand'], ['sup', 'sup_brand'], ['op', 'op_brand'], ['aud', 'aud_brand']] as const) {
      b[k] = env.browser(k)
      await b[k].signIn(user)
    }
    tokens = await obtainNonAccessTokens(env, b.admin, 'brand')
  }, 120_000)

  afterAll(async () => { await env?.stop() })

  it('ADMIN: PNG real ⇒ 200 con extensión DERIVADA del contenido (aunque se llame .html o declare image/x-icon); servido por TCP con image/png, nosniff, CSP sandbox + frame-ancestors y XFO; el resto de la API conserva la CSP de helmet', async () => {
    const r = await upload(b.admin, [png('loginLogo', 'logo.html', 'image/png')])
    expect(r.status, r.text).toBe(200)
    const logoUrl = r.json().logoUrl as string
    expect(logoUrl).toMatch(/^\/uploads\/branding\/loginLogo_\d+\.png$/)
    expect(fs.existsSync(path.join(brandingDir, path.basename(logoUrl)))).toBe(true)
    expect((await appearanceRow())!.logoUrl).toBe(logoUrl)

    await nextMs()
    const ico = await upload(b.admin, [png('favicon', 'favicon.ico', 'image/x-icon')])
    expect(ico.status, ico.text).toBe(200)
    expect(ico.json().faviconUrl).toMatch(/^\/uploads\/branding\/favicon_\d+\.png$/)   // es un PNG: se guarda como .png

    // Servido por el listener TCP real (cabeceras tal como salen al cable).
    const served = await env.tcp('GET', logoUrl)
    expect(served.status).toBe(200)
    expect(served.headers['content-type']).toBe('image/png')
    expect(served.headers['x-content-type-options']).toBe('nosniff')
    expect(served.headers['content-security-policy']).toBe(UPLOADS_CSP)   // UNA sola CSP (la de helmet queda reemplazada)
    expect(String(served.headers['content-security-policy'])).toMatch(/(^|; )sandbox($|;)/)
    expect(String(served.headers['content-security-policy'])).toContain("frame-ancestors 'self'")
    expect(served.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(served.headers['cross-origin-resource-policy']).toBe('same-site')
    // El resto de la API sigue con la CSP de helmet (sin sandbox).
    const api = await env.tcp('GET', '/api/appearance')
    expect(api.status).toBe(200)
    expect(String(api.headers['content-security-policy'])).toContain("script-src 'self'")
    expect(String(api.headers['content-security-policy'])).not.toMatch(/(^|; )sandbox($|;)/)
    expect(api.json().logoUrl).toBe(logoUrl)
  })

  it('cargas disfrazadas ⇒ 400 sin escribir en disco ni tocar la DB: .js/.html con MIME de imagen, SVG (MIME o nombre), MIME no permitido y una 2.ª parte inválida tras una válida', async () => {
    const filesBefore = listBranding()
    const rowBefore = await appearanceRow()
    const cases: Array<[string, FilePart[], string | undefined]> = [
      ['.js con image/png', [{ field: 'loginLogo', filename: 'logo.png', contentType: 'image/png', data: JS_PAYLOAD }], 'UNSAFE_UPLOAD_CONTENT'],
      ['.html con image/jpeg', [{ field: 'sidebarLogo', filename: 'x.html', contentType: 'image/jpeg', data: HTML_PAYLOAD }], 'UNSAFE_UPLOAD_CONTENT'],
      ['.js llamado .ico', [{ field: 'favicon', filename: 'favicon.ico', contentType: 'image/x-icon', data: JS_PAYLOAD }], 'UNSAFE_UPLOAD_CONTENT'],
      ['SVG por MIME', [{ field: 'loginLogo', filename: 'logo.png', contentType: 'image/svg+xml', data: SVG_PAYLOAD }], 'UNSAFE_SVG_UPLOAD_DISABLED'],
      ['SVG por nombre', [{ field: 'loginLogo', filename: 'logo.svg', contentType: 'image/png', data: SVG_PAYLOAD }], 'UNSAFE_SVG_UPLOAD_DISABLED'],
      ['PNG real con MIME text/html', [png('loginLogo', 'logo.png', 'text/html')], undefined],
      ['2.ª parte inválida tras una válida', [png('loginLogo'), { field: 'sidebarLogo', filename: 's.png', contentType: 'image/png', data: HTML_PAYLOAD }], 'UNSAFE_UPLOAD_CONTENT'],
    ]
    const failures: string[] = []
    for (const [label, parts, code] of cases) {
      const r = await upload(b.admin, parts)
      if (r.status !== 400 || (code && r.json().code !== code)) failures.push(`${label} ⇒ ${r.status} ${r.text.slice(0, 120)}`)
    }
    expect(failures).toEqual([])
    expect(listBranding()).toEqual(filesBefore)
    const rowAfter = await appearanceRow()
    expect({ l: rowAfter?.logoUrl, s: rowAfter?.sidebarLogoUrl, f: rowAfter?.faviconUrl })
      .toEqual({ l: rowBefore?.logoUrl, s: rowBefore?.sidebarLogoUrl, f: rowBefore?.faviconUrl })
  })

  it('legados en disco: .html/.js/.xhtml/.svgz/sin extensión ⇒ 404 (sin borrarlos); .svg legado ⇒ 200 neutralizado (sandbox + nosniff); traversal fuera de /uploads ⇒ no se sirve', async () => {
    const legacy = ['legado_payload.html', 'legado_payload.js', 'legado_payload.xhtml', 'legado.svgz', 'legado_sin_ext', 'LEGADO.HTML']
    for (const f of legacy) fs.writeFileSync(path.join(brandingDir, f), f.includes('js') ? JS_PAYLOAD : HTML_PAYLOAD)
    fs.writeFileSync(path.join(brandingDir, 'legado.svg'), SVG_PAYLOAD)
    fs.writeFileSync(path.join(env.tmpDir, 'fuera_de_uploads.png'), 'SECRETO-FUERA-DE-UPLOADS')
    for (const f of legacy) {
      const r = await env.tcp('GET', `/uploads/branding/${f}`)
      expect(r.status, f).toBe(404)
      expect(r.text, f).not.toContain('__joint')
      expect(fs.existsSync(path.join(brandingDir, f)), `${f} sigue en disco`).toBe(true)
    }
    const svg = await env.tcp('GET', '/uploads/branding/legado.svg')
    expect(svg.status).toBe(200)
    expect(svg.headers['content-security-policy']).toBe(UPLOADS_CSP)
    expect(svg.headers['x-content-type-options']).toBe('nosniff')
    for (const url of ['/uploads/..%2ffuera_de_uploads.png', '/uploads/branding/..%2f..%2ffuera_de_uploads.png', '/uploads/%2e%2e/fuera_de_uploads.png']) {
      const r = await env.tcp('GET', url)
      expect(r.status, url).not.toBe(200)
      expect(r.text, url).not.toContain('SECRETO-FUERA-DE-UPLOADS')
    }
  })

  it('archivo compartido: reemplazar un campo NO borra el archivo que otro campo sigue usando (referencia absoluta por PUT o relativa legada); cuando ya nadie lo usa y es propio, sí', async () => {
    // (a) Mismo archivo reutilizado por PUT /api/appearance con su URL absoluta.
    await nextMs()
    const first = await upload(b.admin, [png('loginLogo')])
    expect(first.status).toBe(200)
    const l1 = first.json().logoUrl as string
    const reuse = await b.admin.put('/api/appearance', { sidebarLogoUrl: `${JOINT_ORIGIN}${l1}` })
    expect(reuse.status, reuse.text).toBe(200)
    await nextMs()
    const second = await upload(b.admin, [png('loginLogo')])
    expect(second.status).toBe(200)
    expect(second.json().logoUrl).not.toBe(l1)
    expect(fs.existsSync(path.join(brandingDir, path.basename(l1))), 'archivo aún usado por el sidebar').toBe(true)
    expect((await env.tcp('GET', l1)).status).toBe(200)

    // (b) Estado legado: logo y favicon apuntan al MISMO archivo relativo.
    fs.writeFileSync(path.join(brandingDir, 'compartido_legado.png'), REAL_PNG)
    const shared = '/uploads/branding/compartido_legado.png'
    await env.prisma.appearanceSettings.update({ where: { id: 'singleton' }, data: { logoUrl: shared, faviconUrl: shared } })
    await nextMs()
    const third = await upload(b.admin, [png('loginLogo')])
    expect(third.status).toBe(200)
    expect(fs.existsSync(path.join(brandingDir, 'compartido_legado.png')), 'el favicon lo sigue usando').toBe(true)
    expect((await env.tcp('GET', shared)).status).toBe(200)
    await nextMs()
    const fourth = await upload(b.admin, [png('favicon', 'f.png')])
    expect(fourth.status).toBe(200)
    expect(fs.existsSync(path.join(brandingDir, 'compartido_legado.png')), 'ya nadie lo usa').toBe(false)
    expect((await env.tcp('GET', shared)).status).toBe(404)
    // Lo que la DB publica sigue sirviéndose (ninguna columna quedó en 404).
    const row = (await appearanceRow())!
    for (const u of [row.logoUrl, row.faviconUrl]) expect((await env.tcp('GET', u!)).status, u!).toBe(200)
    expect((await env.tcp('GET', new URL(row.sidebarLogoUrl!).pathname)).status).toBe(200)
  })

  it('roles: SUPERVISOR, OPERATOR y AUDITOR ⇒ 403 (carga y PUT) sin escribir; SUPERVISOR con canManageAppearance delegado ⇒ 200; quitar la delegación corta en la petición siguiente con el MISMO access', async () => {
    const filesBefore = listBranding()
    const failures: string[] = []
    for (const who of ['sup', 'op', 'aud'] as const) {
      const u = await upload(b[who], [png('loginLogo')])
      const p = await b[who].put('/api/appearance', { siteName: `tomado-${who}` })
      for (const [label, r] of [['upload', u], ['put', p]] as Array<[string, JointResponse]>) if (r.status !== 403) failures.push(`${who} ${label} ⇒ ${r.status}`)
    }
    expect(failures).toEqual([])
    expect(listBranding()).toEqual(filesBefore)
    expect((await appearanceRow())!.siteName).not.toMatch(/^tomado-/)

    const grant = await b.admin.put(`/api/users/${ids.sup}/permissions`, { featurePermissions: { canManageAppearance: true } })
    expect(grant.status, grant.text).toBe(200)
    await nextMs()
    const delegated = await upload(b.sup, [png('sidebarLogo')])
    expect(delegated.status, delegated.text).toBe(200)
    expect(delegated.json().sidebarLogoUrl).toMatch(/^\/uploads\/branding\/sidebarLogo_\d+\.png$/)

    const revoke = await b.admin.put(`/api/users/${ids.sup}/permissions`, { featurePermissions: { canManageAppearance: false } })
    expect(revoke.status).toBe(200)
    const afterRevoke = listBranding()
    expect((await upload(b.sup, [png('sidebarLogo')])).status).toBe(403)
    expect((await b.sup.put('/api/appearance', { siteName: 'tomado-tras-revocar' })).status).toBe(403)
    expect(listBranding()).toEqual(afterRevoke)
  })

  it('#190: tempToken 2fa, enrollToken, step-up y refresh (del ADMIN), por Bearer o cookie ⇒ 401 en la carga y en PUT /api/appearance, sin escribir', async () => {
    const filesBefore = listBranding()
    const failures = [
      ...await nonAccessFailures(env, tokens, (atk, headers) => upload(atk, [png('loginLogo')], { headers }), 'upload'),
      ...await nonAccessFailures(env, tokens, (atk, headers) => atk.put('/api/appearance', { siteName: 'tomado-token' }, { headers }), 'put'),
    ]
    expect(failures).toEqual([])
    expect(listBranding()).toEqual(filesBefore)
    expect((await appearanceRow())!.siteName).not.toBe('tomado-token')
  })

  it('CSRF: con la cookie del ADMIN pero sin Origin o con un Origin ajeno ⇒ 403 CSRF_BLOCKED, sin escribir', async () => {
    const filesBefore = listBranding()
    for (const origin of [null, 'https://atacante.example']) {
      const u = await upload(b.admin, [png('loginLogo')], { origin })
      const p = await b.admin.put('/api/appearance', { siteName: 'tomado-csrf' }, { origin })
      for (const r of [u, p]) {
        expect(r.status).toBe(403)
        expect(r.json().code).toBe('CSRF_BLOCKED')
      }
    }
    expect(listBranding()).toEqual(filesBefore)
    expect((await appearanceRow())!.siteName).not.toBe('tomado-csrf')
  })

  it('higiene: sin red saliente ni contacto con NVR/MediaMTX/FFmpeg', () => {
    expect(env.blockedConnections).toEqual([])
    expect(infra.externalEffectsSince(0)).toEqual([])
  })
})
