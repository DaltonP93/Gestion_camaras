// Suite conjunta — C03: rate-limit detrás de nginx sin cortar el HLS (server.ts REAL).
//
// Defecto (revisión conjunta, MFA-03/CHW-06/CHW-11): sin `trustProxy`, detrás de
// nginx request.ip es SIEMPRE la del proxy ⇒ un único cupo para todos (8 logins /
// 15 min, 2FA y step-up agotables por anónimos, ~600 req/min dejan sin API a todos)
// y Session.ipAddress / AuditLog guardan la IP del proxy. El arreglo está acoplado:
// con trustProxy, request.ip pasa a ser la del CLIENTE y las puertas de "origen
// interno" (hls-auth, hook de MediaMTX, media-grant validate) cortarían el HLS si
// siguieran mirando request.ip.
//
// Efectos del arreglo que también se fijan acá:
//   - el cupo de /2fa/verify y /step-up deja de ser un tope global ⇒ bloqueo por
//     USUARIO del 2.º factor (no depende de cuántas IPs tenga el atacante);
//   - media-grant validate vive bajo /api/ (alcanzable por nginx, cuyo par es
//     interno) ⇒ se rechaza lo reenviado por el proxy, no sólo el par externo.
//
// Cómo se prueba (sólo loopback):
//   - `server.ts` real con el harness conjunto (PG + Redis efímeros; store del
//     rate-limit en Redis como en producción; TRUSTED_PROXIES sin definir ⇒ default).
//   - Un proxy HTTP local que hace lo que infra/nginx/nginx.conf:
//       /api/            → proxy_pass con Host $host, X-Real-IP $remote_addr,
//                          X-Forwarded-For $proxy_add_x_forwarded_for, X-Forwarded-Proto.
//       /hls/            → auth_request /internal/hls-auth (GET sin cuerpo, cabeceras
//                          del cliente —Cookie incluida—, X-Original-URI = $uri del
//                          padre normalizado, X-Real-IP, X-Forwarded-For); 2xx ⇒ sirve
//                          el doble de MediaMTX; 401/403 ⇒ ese código; otro ⇒ 500.
//       /internal/hls-auth desde afuera ⇒ 404 (`internal;`); el resto ⇒ 404 (web).
//     Conecta al API desde NGINX_INTERNAL_IP con keepalive (upstream api keepalive 32).
//   - Cada cliente abre su TCP desde una dirección loopback DISTINTA (127.0.0.N).
//     Proxy "internet": $remote_addr = 203.0.113.N (traducción tipo NAT a TEST-NET-3:
//     en loopback no hay direcciones públicas). Proxy "lan": $remote_addr = 127.0.0.N
//     tal cual — un cliente cuya IP cae DENTRO de un rango confiable (loopback), el
//     caso del cliente de la LAN en rango privado.
// Sin red salvo loopback; NVR en TEST-NET; credenciales y secretos efímeros (nunca
// se imprimen).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))

import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import speakeasy from 'speakeasy'
import {
  jointInfraAvailable, startJointServer, totpNow, parseSetCookie,
  JOINT_HOST, JOINT_ORIGIN, JOINT_PASSWORD, NGINX_INTERNAL_IP,
  type JointEnv, type SetCookie,
} from './harness'

const NVR_IP = '192.0.2.63'

/** Códigos de 6 dígitos que NO valen para `secret` en ±2 pasos (la verificación acepta ±1). */
function codigosInvalidos(secret: string, n: number): string[] {
  const now = Math.floor(Date.now() / 1000)
  const validos = new Set([-2, -1, 0, 1, 2].map((k) => speakeasy.totp({ secret, encoding: 'base32', time: now + k * 30 })))
  const out: string[] = []
  for (let i = 0; out.length < n; i++) {
    const c = String((i * 7919 + 123457) % 1_000_000).padStart(6, '0')
    if (!validos.has(c)) out.push(c)
  }
  return out
}

/** TOTP del PRÓXIMO paso (válido con la ventana ±1): no reusa el código ya aceptado (MFA-04). */
const totpSiguiente = (secret: string) =>
  speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + 30 })

// ─── Proxy tipo nginx (infra/nginx/nginx.conf) ────────────────────────────────

interface NginxLike {
  port: number
  /** $remote_addr de cada petición recibida. */
  remoteAddrs: string[]
  /** URIs que llegaron al doble de MediaMTX (sólo tras un auth_request 2xx). */
  mediamtxHits: string[]
  close(): Promise<void>
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']

/** $uri de nginx: sin query, decodificado, barras fusionadas y `.`/`..` resueltos. */
function nginxUri(rawUrl: string): string {
  let p = rawUrl.split('?')[0]
  try { p = decodeURIComponent(p) } catch { /* se deja crudo */ }
  return path.posix.normalize(p.replace(/\/{2,}/g, '/'))
}

async function startNginxLike(apiPort: number, remoteAddrOf: (socketAddr: string) => string): Promise<NginxLike> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 }) // upstream api { keepalive 32; }
  const remoteAddrs: string[] = []
  const mediamtxHits: string[] = []

  const toApi = (method: string, url: string, headers: http.OutgoingHttpHeaders) => http.request({
    host: '127.0.0.1', port: apiPort, localAddress: NGINX_INTERNAL_IP, method, path: url, headers, agent,
  })

  const srv = http.createServer((req, res) => {
    const remoteAddr = remoteAddrOf((req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''))
    remoteAddrs.push(remoteAddr)
    const rawUrl = req.url ?? '/'
    const uri = nginxUri(rawUrl)
    const prev = req.headers['x-forwarded-for']
    const prevXff = Array.isArray(prev) ? prev.join(', ') : prev
    // Cabeceras que nginx manda al upstream: las del cliente (salvo hop-by-hop) +
    // las de `proxy_set_header`.
    const proxied = (): http.OutgoingHttpHeaders => {
      const h: http.OutgoingHttpHeaders = { ...req.headers }
      for (const k of HOP_BY_HOP) delete h[k]
      h.host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()   // Host $host
      h['x-real-ip'] = remoteAddr                                                   // X-Real-IP $remote_addr
      h['x-forwarded-for'] = prevXff ? `${prevXff}, ${remoteAddr}` : remoteAddr      // $proxy_add_x_forwarded_for
      return h
    }

    // location = /internal/hls-auth { internal; … } ⇒ desde afuera no existe.
    if (uri === '/internal/hls-auth') { res.writeHead(404); res.end(); return }

    // location /hls/ { set $hls_original_uri $uri; auth_request /internal/hls-auth; proxy_pass mediamtx_hls; }
    if (uri.startsWith('/hls/')) {
      const h = proxied()
      delete h['content-length']                 // proxy_pass_request_body off; Content-Length ""
      h['x-original-uri'] = uri                  // X-Original-URI $hls_original_uri
      const sub = toApi('GET', '/internal/hls-auth', h)
      sub.on('response', (ar) => {
        ar.resume()
        ar.on('end', () => {
          const st = ar.statusCode ?? 500
          if (st === 401 || st === 403) { res.writeHead(st); res.end(); return }
          if (st < 200 || st > 299) { res.writeHead(500); res.end(); return }
          mediamtxHits.push(uri)                 // doble de MediaMTX (playlist fija)
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache, no-store, must-revalidate' })
          res.end(uri.endsWith('.m3u8') ? '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nsegment_0001.mp4\n' : 'segmento-simulado')
        })
      })
      sub.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end() })
      sub.end()
      req.resume()
      return
    }

    // location /api/ { proxy_pass http://api; … X-Forwarded-Proto $scheme; }
    if (uri.startsWith('/api/')) {
      const h = proxied()
      h['x-forwarded-proto'] = 'https'
      const up = toApi(req.method ?? 'GET', rawUrl, h)
      up.on('response', (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res) })
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.pipe(up)
      return
    }

    res.writeHead(404); res.end()                // location / → web (no llega al API)
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return {
    port: (srv.address() as AddressInfo).port,
    remoteAddrs, mediamtxHits,
    close: () => new Promise<void>((r) => { agent.destroy(); srv.close(() => r()) }),
  }
}

// ─── Clientes TCP reales desde 127.0.0.N ──────────────────────────────────────

interface Resp { status: number; text: string; setCookies: SetCookie[]; json<T = any>(): T }

interface ReqOpts {
  body?: unknown
  /** Cuerpo crudo (JSON malformado). */
  rawBody?: string
  cookie?: string
  headers?: Record<string, string>
  agent?: http.Agent
}

/** Petición HTTP real desde la dirección origen `clientIp` hacia `port` (proxy o API). */
function desde(clientIp: string, port: number, method: string, url: string, o: ReqOpts = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = o.rawBody !== undefined ? Buffer.from(o.rawBody) : (o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : undefined)
    const headers: Record<string, string> = { host: JOINT_HOST, 'user-agent': `cliente-c03/${clientIp}`, ...(o.headers ?? {}) }
    if (!['GET', 'HEAD'].includes(method)) headers.origin = JOINT_ORIGIN       // fetch same-origin
    if (o.cookie) headers.cookie = o.cookie
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length) }
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, localAddress: clientIp, agent: o.agent ?? false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const sc = res.headers['set-cookie'] ?? []
        resolve({ status: res.statusCode ?? 0, text, setCookies: sc.map(parseSetCookie), json: () => JSON.parse(text) })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Navegador mínimo sobre TCP real: tarro de cookies con Path (como el harness). */
class ClienteTcp {
  private readonly jar = new Map<string, { name: string; value: string; path: string }>()
  constructor(readonly ip: string, private readonly port: number) {}

  cookieFor(url: string): string | undefined {
    const p = url.split('?')[0]
    const parts = [...this.jar.values()]
      .filter((c) => p === c.path || (p.startsWith(c.path) && (c.path.endsWith('/') || p[c.path.length] === '/')))
      .map((c) => `${c.name}=${c.value}`)
    return parts.length ? parts.join('; ') : undefined
  }

  async req(method: string, url: string, o: ReqOpts = {}, port = this.port): Promise<Resp> {
    const r = await desde(this.ip, port, method, url, { cookie: this.cookieFor(url), ...o })
    for (const c of r.setCookies) {
      const key = `${c.name}\u0000${c.path ?? '/'}`
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0)) this.jar.delete(key)
      else this.jar.set(key, { name: c.name, value: c.value, path: c.path ?? '/' })
    }
    return r
  }

  login(username: string, password = JOINT_PASSWORD) {
    return this.req('POST', '/api/auth/login', { body: { username, password, rememberMe: true } })
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!jointInfraAvailable())('C03 · server.ts real detrás de un proxy con las cabeceras del nginx versionado', { timeout: 180_000 }, () => {
  let env: JointEnv
  let internet: NginxLike
  let lan: NginxLike
  let gs: typeof import('../services/media/grant-service')
  let nvrId = ''
  let camA = ''

  const pub = (n: number) => `203.0.113.${n}`                 // $remote_addr que ve el proxy "internet"
  const viaInternet = (n: number) => new ClienteTcp(`127.0.0.${n}`, internet.port)
  const viaLan = (n: number) => new ClienteTcp(`127.0.0.${n}`, lan.port)
  const directo = (n: number) => new ClienteTcp(`127.0.0.${n}`, env.port)
  const hlsUri = (channel: number, file = 'index.m3u8') => `/hls/nvr_${nvrId}_ch${String(channel).padStart(2, '0')}_sub/${file}`
  const rlKey = (route: string, ip: string) => `fastify-rate-limit-${route}-${ip}`

  beforeAll(async () => {
    env = await startJointServer({ label: 'c03tp', nativeRelay: true })
    gs = await import('../services/media/grant-service')
    internet = await startNginxLike(env.port, (a) => a.replace(/^127\.0\.0\./, '203.0.113.'))
    lan = await startNginxLike(env.port, (a) => a)
    nvrId = (await env.createNvr('NVR C03', NVR_IP)).id
    camA = (await env.createCamera(nvrId, 1)).id
    await env.createCamera(nvrId, 2)       // existe, sin permiso para los operadores
  }, 120_000)

  afterAll(async () => {
    await internet?.close()
    await lan?.close()
    await env?.stop()
  })

  it('login por cliente: 8 fallos de A no bloquean a B (A sí queda limitado); Session.ipAddress y AuditLog guardan la IP del cliente', async () => {
    const u = await env.createUser('op_c03_login', 'OPERATOR')
    const a = viaInternet(21)
    const fallos: number[] = []
    for (let i = 1; i <= 8; i++) fallos.push((await a.login(`c03a-no-existe-${i}`, 'clave-falsa-123')).status)
    expect(fallos).toEqual(Array(8).fill(401))
    expect((await a.login('c03a-no-existe-9', 'clave-falsa-123')).status, 'A agotó SU cupo').toBe(429)

    const b = viaInternet(22)
    expect((await b.login('op_c03_login')).status, 'B no comparte el cupo de A').toBe(200)

    const ses = await env.prisma.session.findMany({ where: { userId: u.id }, select: { ipAddress: true } })
    expect(ses.map((s) => s.ipAddress)).toEqual([pub(22)])
    const login = await env.prisma.auditLog.findMany({ where: { userId: u.id, action: 'LOGIN' }, select: { ipAddress: true } })
    expect(login.map((x) => x.ipAddress)).toEqual([pub(22)])
    const aud = await env.prisma.auditLog.findMany({ where: { action: 'AUTH_FAILED', resource: { startsWith: 'c03a-no-existe-' } }, select: { ipAddress: true } })
    expect(aud).toHaveLength(8)
    expect(new Set(aud.map((x) => x.ipAddress))).toEqual(new Set([pub(21)]))

    const keys = await env.redisKeys('fastify-rate-limit-*')
    expect(keys).toContain(rlKey('POST/api/auth/login', pub(21)))
    expect(keys).toContain(rlKey('POST/api/auth/login', pub(22)))
    expect(keys).not.toContain(rlKey('POST/api/auth/login', NGINX_INTERNAL_IP))
  })

  it('falsificación: rotar X-Forwarded-For desde el cliente no evade el cupo (cliente de Internet y cliente LAN en rango confiable)', async () => {
    const falsos = (i: number) => ['127.0.0.1', `10.0.0.${i}`, `198.51.100.${i}`, `172.18.0.${i}`, `192.168.1.${i}, 127.0.0.1`][i % 5]
    for (const [label, cli, ipVista] of [
      ['internet', viaInternet(31), pub(31)],
      ['lan', viaLan(32), '127.0.0.32'],
    ] as const) {
      const r: number[] = []
      for (let i = 1; i <= 9; i++) {
        r.push((await cli.req('POST', '/api/auth/login', { body: { username: `c03f-${label}-${i}`, password: 'x' }, headers: { 'x-forwarded-for': falsos(i), 'x-real-ip': falsos(i) } })).status)
      }
      expect(r.slice(0, 8), label).toEqual(Array(8).fill(401))
      expect(r[8], `${label}: el 9.º intento con otro X-Forwarded-For`).toBe(429)
      const aud = await env.prisma.auditLog.findMany({ where: { action: 'AUTH_FAILED', resource: { startsWith: `c03f-${label}-` } }, select: { ipAddress: true } })
      expect(new Set(aud.map((x) => x.ipAddress)), label).toEqual(new Set([ipVista]))
    }
    const keys = await env.redisKeys('fastify-rate-limit-POST/api/auth/login-*')
    for (const falso of ['10.0.0.3', '198.51.100.4', '172.18.0.1', '192.168.1.5', '127.0.0.1']) {
      expect(keys, `clave para el valor inventado ${falso}`).not.toContain(rlKey('POST/api/auth/login', falso))
    }
  })

  it('2FA: 10 POST anónimos de A (JSON malformado) no agotan el 2.º factor de B', async () => {
    const u = await env.createMfaUser('mfa_c03', 'OPERATOR')
    const b = viaInternet(51)
    const l = await b.login('mfa_c03')
    expect(l.status).toBe(200)
    const tempToken = l.json().tempToken as string
    expect(typeof tempToken).toBe('string')

    const a = viaInternet(52)
    const basura: number[] = []
    for (let i = 1; i <= 10; i++) basura.push((await a.req('POST', '/api/auth/2fa/verify', { rawBody: '{"tempToken":' })).status)
    expect(basura).toEqual(Array(10).fill(400))
    expect((await a.req('POST', '/api/auth/2fa/verify', { rawBody: '{"tempToken":' })).status, 'A sí se limita').toBe(429)

    const v = await b.req('POST', '/api/auth/2fa/verify', { body: { tempToken, code: await totpNow(u.secret), rememberMe: true } })
    expect(v.status, '2.º factor legítimo de B').toBe(200)
    const ses = await env.prisma.session.findMany({ where: { userId: u.id }, select: { ipAddress: true } })
    expect(ses.map((s) => s.ipAddress)).toEqual([pub(51)])
  })

  it('step-up: 10 POST anónimos de A no agotan el step-up de B', async () => {
    await env.createUser('op_c03_su', 'OPERATOR')
    const b = viaInternet(61)
    expect((await b.login('op_c03_su')).status).toBe(200)
    const a = viaInternet(62)
    const anon: number[] = []
    for (let i = 1; i <= 10; i++) anon.push((await a.req('POST', '/api/auth/step-up', { body: { password: 'x' } })).status)
    expect(anon).toEqual(Array(10).fill(401))
    expect((await a.req('POST', '/api/auth/step-up', { body: { password: 'x' } })).status, 'A sí se limita').toBe(429)
    expect((await b.req('POST', '/api/auth/step-up', { body: { password: JOINT_PASSWORD } })).status, 'step-up de B').toBe(200)
  })

  it('cupo global: A agota sus 600/min y /me, heartbeat, refresh y el HLS de B siguen', async () => {
    const u = await env.createUser('op_c03_glob', 'OPERATOR')
    await env.grant(u.id, nvrId, camA, { canView: true })
    const b = viaInternet(71)
    expect((await b.login('op_c03_glob')).status).toBe(200)
    expect((await b.req('GET', '/api/auth/me')).status).toBe(200)

    const atk = new http.Agent({ keepAlive: true, maxSockets: 1 })
    let primer429 = -1
    for (let n = 1; n <= 700 && primer429 < 0; n++) {
      const r = await desde('127.0.0.72', internet.port, 'GET', '/api/health', { agent: atk })
      if (r.status === 429) primer429 = n
    }
    atk.destroy()
    expect(primer429, 'A llega a SU tope global').toBeGreaterThan(0)
    expect(primer429).toBeLessThanOrEqual(601)
    expect((await desde('127.0.0.72', internet.port, 'GET', '/api/auth/me')).status, 'A sigue limitado').toBe(429)

    expect((await b.req('GET', '/api/auth/me')).status, '/me de B').toBe(200)
    expect((await b.req('POST', '/api/live-view/heartbeat', { body: { viewId: 'v-c03', visibleCameraIds: [] } })).status, 'heartbeat de B').toBe(200)
    expect((await b.req('POST', '/api/auth/refresh', { body: {} })).status, 'refresh de B').toBe(200)
    const hls = await b.req('GET', hlsUri(1))
    expect(hls.status, 'HLS de B').toBe(200)
    expect(hls.text.startsWith('#EXTM3U')).toBe(true)

    const keys = await env.redisKeys('fastify-rate-limit-*')
    expect(keys).toContain(`fastify-rate-limit-${pub(72)}`)
    expect(keys).not.toContain(`fastify-rate-limit-${NGINX_INTERNAL_IP}`)
  })

  it('HLS vía el proxy: 200 con permiso (MediaMTX sirve), 403 sin permiso y 401 sin cookie (MediaMTX ni se toca); /internal/hls-auth no es alcanzable desde afuera', async () => {
    const u = await env.createUser('op_c03_hls', 'OPERATOR')
    await env.grant(u.id, nvrId, camA, { canView: true })
    const b = viaInternet(81)
    expect((await b.login('op_c03_hls')).status).toBe(200)

    const antes = internet.mediamtxHits.length
    const pl = await b.req('GET', hlsUri(1))
    expect(pl.status, 'playlist con canView').toBe(200)
    expect(pl.text.startsWith('#EXTM3U')).toBe(true)
    expect((await b.req('GET', hlsUri(1, 'segment_0001.mp4'))).status, 'segmento').toBe(200)
    expect(internet.mediamtxHits.length - antes).toBe(2)

    expect((await b.req('GET', hlsUri(2))).status, 'cámara sin permiso').toBe(403)
    expect((await viaInternet(82).req('GET', hlsUri(1))).status, 'sin cookie').toBe(401)
    expect((await b.req('GET', `/hls/nvr_${nvrId}_ch01_sub/../nvr_${nvrId}_ch02_sub/index.m3u8`)).status, '`..` normalizado por nginx ⇒ ch02').toBe(403)
    expect(internet.mediamtxHits.length - antes, 'los rechazos no llegan a MediaMTX').toBe(2)

    // El mismo navegador detrás del proxy "lan" (su $remote_addr es 127.0.0.81).
    const cookie = b.cookieFor(hlsUri(1))!
    expect((await desde('127.0.0.81', lan.port, 'GET', hlsUri(1), { cookie })).status, 'vía proxy lan').toBe(200)
    // location = /internal/hls-auth { internal; }
    expect((await desde('127.0.0.81', internet.port, 'GET', '/internal/hls-auth', { cookie, headers: { 'x-original-uri': hlsUri(1) } })).status).toBe(404)

    // Par EXTERNO directo al API (sin nginx) que dice ser interno por cabecera ⇒ 403.
    const forged = await env.server.inject({
      method: 'GET', url: '/internal/hls-auth', remoteAddress: '203.0.113.9',
      headers: { host: JOINT_HOST, cookie, 'x-original-uri': hlsUri(1), 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
    })
    expect(forged.statusCode).toBe(403)
  })

  it('hook de MediaMTX: origen interno por el socket — 200 desde la red interna (con o sin X-Forwarded-For), 403 ORIGIN_NOT_ALLOWED desde un par externo aunque diga 127.0.0.1', async () => {
    const u = await env.createUser('op_c03_mtx', 'OPERATOR')
    await env.grant(u.id, nvrId, camA, { canView: true })
    const sp = `nvr_${nvrId}_ch01_sub`
    const mgr = gs.getMediaGrantManager(env.server)
    if (!(await mgr.currentInstance(sp))) await mgr.registerSource(sp, 300_000)
    const r = await mgr.issueSession({
      userId: u.id, viewId: 'relay-c03', cameraId: camA, streamPath: sp, effectiveType: 'sub', codec: 'h264',
      transport: 'rtsps', device: 'relay-simulado', ttlMs: 120_000,
    })
    if (!r.ok) throw new Error(`issueSession: ${r.code}`)
    const body = (id: string) => ({ user: r.issued.grantId, password: r.issued.secret, action: 'read', path: sp, protocol: 'rtsps', id })
    const relay = { 'x-media-relay-secret': env.relaySecret! }

    // MediaMTX llama directo (red interna, sin nginx): TCP real desde 127.0.0.1.
    expect((await desde('127.0.0.1', env.port, 'POST', '/internal/mediamtx/auth', { body: body('c03-int'), headers: relay })).status).toBe(200)
    // El origen lo decide el socket, no una cabecera de cliente.
    expect((await desde('127.0.0.1', env.port, 'POST', '/internal/mediamtx/auth', { body: body('c03-int-xff'), headers: { ...relay, 'x-forwarded-for': '203.0.113.9' } })).status).toBe(200)
    const ext = await env.server.inject({
      method: 'POST', url: '/internal/mediamtx/auth', remoteAddress: '198.51.100.240',
      headers: { ...relay, 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' }, payload: body('c03-ext'),
    })
    expect(ext.statusCode).toBe(403)
    expect(ext.json().code).toBe('ORIGIN_NOT_ALLOWED')
  })

  it('media-grant validate: par externo ⇒ 403 ORIGIN_NOT_ALLOWED sin consumir el grant; el relay interno ⇒ 200', async () => {
    const u = await env.createUser('op_c03_val', 'OPERATOR')
    await env.grant(u.id, nvrId, camA, { canView: true })
    const sp = `nvr_${nvrId}_ch01_sub`
    const mgr = gs.getMediaGrantManager(env.server)
    if (!(await mgr.currentInstance(sp))) await mgr.registerSource(sp, 300_000)
    const br = env.browser('op_c03_val')
    await br.signIn('op_c03_val')
    const g = await br.post('/api/live-view/media-grant', { viewId: 'v-c03-val', cameraId: camA, transport: 'rtsps', device: 'navegador-simulado' })
    expect(g.status).toBe(200)
    const payload = { grantId: g.json().grantId, secret: g.json().secret, streamPath: g.json().streamPath, transport: 'rtsps', cameraId: camA }
    const relay = { 'x-media-relay-secret': env.relaySecret! }

    const ext = await env.server.inject({
      method: 'POST', url: '/api/live-view/internal/media-grant/validate', remoteAddress: '198.51.100.241',
      headers: { host: JOINT_HOST, ...relay, 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' }, payload,
    })
    expect(ext.statusCode).toBe(403)
    expect(ext.json().code).toBe('ORIGIN_NOT_ALLOWED')

    const int = await desde('127.0.0.1', env.port, 'POST', '/api/live-view/internal/media-grant/validate', { body: payload, headers: relay })
    expect(int.status, 'el grant no se consumió en el intento externo').toBe(200)
    expect(int.json().ok).toBe(true)
  })

  it('media-grant validate VÍA el proxy (location /api/): para el API el par es nginx (interno), pero la petición reenviada ⇒ 403 ORIGIN_NOT_ALLOWED aun con el secreto del relay, sin consumir el grant', async () => {
    const u = await env.createUser('op_c03_valpx', 'OPERATOR')
    await env.grant(u.id, nvrId, camA, { canView: true })
    const sp = `nvr_${nvrId}_ch01_sub`
    const mgr = gs.getMediaGrantManager(env.server)
    if (!(await mgr.currentInstance(sp))) await mgr.registerSource(sp, 300_000)
    const br = env.browser('op_c03_valpx')
    await br.signIn('op_c03_valpx')
    const g = await br.post('/api/live-view/media-grant', { viewId: 'v-c03-valpx', cameraId: camA, transport: 'rtsps', device: 'navegador-simulado' })
    expect(g.status).toBe(200)
    const payload = { grantId: g.json().grantId, secret: g.json().secret, streamPath: g.json().streamPath, transport: 'rtsps', cameraId: camA }
    const url = '/api/live-view/internal/media-grant/validate'

    const cli = viaInternet(160)
    const sinSecreto = await cli.req('POST', url, { body: payload, headers: { 'x-media-relay-secret': 'secreto-incorrecto' } })
    expect(sinSecreto.status, 'no llega a probar el secreto').toBe(403)
    expect(sinSecreto.json().code).toBe('ORIGIN_NOT_ALLOWED')
    const conSecreto = await cli.req('POST', url, { body: payload, headers: { 'x-media-relay-secret': env.relaySecret! } })
    expect(conSecreto.status, 'aun con el secreto correcto').toBe(403)
    expect(conSecreto.json().code).toBe('ORIGIN_NOT_ALLOWED')
    // Un cliente de la LAN (su IP cae en un rango "interno") tampoco.
    expect((await viaLan(161).req('POST', url, { body: payload, headers: { 'x-media-relay-secret': env.relaySecret! } })).status).toBe(403)

    // El relay llama DIRECTO (red interna, sin nginx ni X-Forwarded-For): el grant sigue sin usar.
    const relay = await desde('127.0.0.1', env.port, 'POST', url, { body: payload, headers: { 'x-media-relay-secret': env.relaySecret! } })
    expect(relay.status, 'el grant no se consumió por el proxy').toBe(200)
    expect(relay.json().ok).toBe(true)
  })

  // ─── Bloqueo por USUARIO del 2.º factor (el cupo por cliente ya no es un tope global) ───
  //
  // Con trustProxy el cupo de /2fa/verify (10 cada 5 min) es por IP: sin un límite
  // por usuario, quien ya tiene la contraseña suma 10 intentos de TOTP por cada IP
  // que controle (el tempToken no se consume: MFA-04). El tope lo debe poner el
  // USUARIO: lockoutMaxAttempts / lockoutDurationMinutes, como el login.
  const K = 5

  it('2.º factor: K fallos del MISMO usuario desde 3 IPs bloquean la cuenta; el código correcto desde una 4.ª IP recibe ACCOUNT_LOCKED (no 200) y el login también', async () => {
    await env.setSecurity({ lockoutMaxAttempts: K, lockoutDurationMinutes: 15 })
    const u = await env.createMfaUser('mfa_c03_bloqueo', 'OPERATOR')
    // El atacante ya tiene la contraseña: obtiene un tempToken y lo reusa (MFA-04).
    const l = await viaInternet(90).login('mfa_c03_bloqueo')
    expect(l.status).toBe(200)
    const tempToken = l.json().tempToken as string
    const malos = codigosInvalidos(u.secret, 30)
    const st: Array<{ status: number; code?: string }> = []
    for (const [k, n] of [91, 92, 93].entries()) {
      const cli = viaInternet(n)
      for (let i = 0; i < 10; i++) {
        const r = await cli.req('POST', '/api/auth/2fa/verify', { body: { tempToken, code: malos[k * 10 + i] } })
        st.push({ status: r.status, code: r.status === 403 ? r.json().code : undefined })
      }
    }
    // Ninguna IP llega a su cupo (10/5 min): el tope lo pone el usuario.
    expect(st.some((s) => s.status === 429)).toBe(false)
    expect(st.slice(0, K - 1).map((s) => s.status)).toEqual(Array(K - 1).fill(401))
    expect(st.slice(K - 1), `del intento ${K} en adelante`).toEqual(Array(30 - (K - 1)).fill({ status: 403, code: 'ACCOUNT_LOCKED' }))

    const legit = await viaInternet(94).req('POST', '/api/auth/2fa/verify', { body: { tempToken, code: await totpNow(u.secret) } })
    expect(legit.status, 'código correcto con la cuenta bloqueada').toBe(403)
    expect(legit.json().code).toBe('ACCOUNT_LOCKED')
    expect(await env.prisma.session.count({ where: { userId: u.id } })).toBe(0)
    const row = await env.prisma.user.findUnique({ where: { id: u.id }, select: { lockedUntil: true } })
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000)
    const relogin = await viaInternet(95).login('mfa_c03_bloqueo')
    expect(relogin.status, 'login con la contraseña correcta durante el bloqueo').toBe(403)
    expect(relogin.json().code).toBe('ACCOUNT_LOCKED')

    // Auditoría: los fallos quedan con la IP de cada cliente (no la de nginx).
    const aud = await env.prisma.auditLog.findMany({ where: { userId: u.id, action: 'AUTH_2FA_FAILED' }, select: { ipAddress: true } })
    expect(aud.length).toBeGreaterThanOrEqual(K)
    expect(aud.every((a) => ['203.0.113.91', '203.0.113.92', '203.0.113.93', '203.0.113.94'].includes(a.ipAddress ?? ''))).toBe(true)
  })

  it('2.º factor: una ráfaga PARALELA de 20 códigos desde 20 IPs verifica a lo sumo K (el intento se reserva antes de verificar)', async () => {
    await env.setSecurity({ lockoutMaxAttempts: K, lockoutDurationMinutes: 15 })
    const u = await env.createMfaUser('mfa_c03_rafaga', 'OPERATOR')
    const tempToken = (await viaInternet(100).login('mfa_c03_rafaga')).json().tempToken as string
    const malos = codigosInvalidos(u.secret, 20)
    const res = await Promise.all(malos.map((code, i) => viaInternet(101 + i).req('POST', '/api/auth/2fa/verify', { body: { tempToken, code } })))
    expect(res.filter((r) => r.status === 401).length, 'códigos verificados sin bloquear').toBe(K - 1)
    expect(res.filter((r) => r.status === 403 && r.json().code === 'ACCOUNT_LOCKED').length).toBe(20 - (K - 1))
    const legit = await viaInternet(121).req('POST', '/api/auth/2fa/verify', { body: { tempToken, code: await totpNow(u.secret) } })
    expect(legit.status).toBe(403)
    expect(await env.prisma.session.count({ where: { userId: u.id } })).toBe(0)
    // Cuántos códigos se VERIFICARON (la auditoría distingue el fallo verificado, con
    // `attempt`, del rechazo sin verificar por bloqueo). Contar sólo al fallar daría
    // las mismas respuestas pero 20 códigos probados.
    const aud = await env.prisma.auditLog.findMany({ where: { userId: u.id, action: 'AUTH_2FA_FAILED' }, select: { detail: true } })
    // AuditAction guarda `detail` como JSON serializado.
    const detalles = aud.map((a) => (typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail ?? {}) as { attempt?: number; reason?: string })
    expect(detalles.filter((d) => typeof d.attempt === 'number').map((d) => d.attempt).sort((a, b) => a! - b!), 'códigos verificados').toEqual([1, 2, 3, 4, 5])
    expect(detalles.filter((d) => d.reason === 'account_locked').length, 'rechazados sin verificar').toBe(20 - K + 1)
  })

  it('sesión robada: step-up, regenerar códigos y desactivar 2FA comparten el contador del usuario; al llegar a K el step-up legítimo recibe ACCOUNT_LOCKED y el 2FA sigue activo', async () => {
    await env.setSecurity({ lockoutMaxAttempts: K, lockoutDurationMinutes: 15 })
    const u = await env.createMfaUser('mfa_c03_sesion', 'OPERATOR')
    const legit = viaInternet(130)
    const l = await legit.login('mfa_c03_sesion')
    expect((await legit.req('POST', '/api/auth/2fa/verify', { body: { tempToken: l.json().tempToken, code: await totpNow(u.secret), rememberMe: true } })).status).toBe(200)
    const antes = await env.prisma.user.findUnique({ where: { id: u.id }, select: { twoFactorBackupCodes: true } })
    const robada = legit.cookieFor('/api/auth/step-up')!
    const malos = codigosInvalidos(u.secret, 6)
    const intentos: Array<[string, Record<string, string>]> = [
      ['/api/auth/step-up', { code: malos[0] }],
      ['/api/auth/2fa/backup-codes/regenerate', { code: malos[1] }],
      ['/api/auth/2fa/disable', { code: malos[2], password: JOINT_PASSWORD }],
      ['/api/auth/step-up', { code: malos[3] }],
      ['/api/auth/2fa/backup-codes/regenerate', { code: malos[4] }],
      ['/api/auth/step-up', { code: malos[5] }],
    ]
    const st: number[] = []
    for (const [i, [url, body]] of intentos.entries()) {
      st.push((await desde(`127.0.0.${131 + i}`, internet.port, 'POST', url, { cookie: robada, body })).status)
    }
    // Hasta K-1: el error propio de cada ruta; desde K: bloqueo.
    expect(st).toEqual([401, 400, 400, 401, 403, 403])

    const su = await legit.req('POST', '/api/auth/step-up', { body: { code: await totpNow(u.secret) } })
    expect(su.status, 'step-up legítimo con la cuenta bloqueada').toBe(403)
    expect(su.json().code).toBe('ACCOUNT_LOCKED')
    const despues = await env.prisma.user.findUnique({ where: { id: u.id }, select: { twoFactorEnabled: true, twoFactorBackupCodes: true, lockedUntil: true } })
    expect(despues!.twoFactorEnabled).toBe(true)
    expect(despues!.twoFactorBackupCodes).toBe(antes!.twoFactorBackupCodes)
    expect(despues!.lockedUntil!.getTime()).toBeGreaterThan(Date.now())
  })

  it('step-up por contraseña (usuario sin MFA): K contraseñas incorrectas desde IPs distintas bloquean; la correcta recibe ACCOUNT_LOCKED', async () => {
    await env.setSecurity({ lockoutMaxAttempts: K, lockoutDurationMinutes: 15 })
    await env.createUser('op_c03_supw', 'OPERATOR')
    const legit = viaInternet(140)
    expect((await legit.login('op_c03_supw')).status).toBe(200)
    const robada = legit.cookieFor('/api/auth/step-up')!
    const st: number[] = []
    for (let i = 0; i < K + 1; i++) {
      st.push((await desde(`127.0.0.${141 + i}`, internet.port, 'POST', '/api/auth/step-up', { cookie: robada, body: { password: `incorrecta-${i}` } })).status)
    }
    expect(st).toEqual([...Array(K - 1).fill(401), 403, 403])
    const ok = await legit.req('POST', '/api/auth/step-up', { body: { password: JOINT_PASSWORD } })
    expect(ok.status).toBe(403)
    expect(ok.json().code).toBe('ACCOUNT_LOCKED')
  })

  it('un 2.º factor correcto reinicia el contador; el desbloqueo del admin también lo limpia', async () => {
    await env.setSecurity({ lockoutMaxAttempts: K, lockoutDurationMinutes: 15 })
    const u = await env.createMfaUser('mfa_c03_reinicio', 'OPERATOR')
    const malos = codigosInvalidos(u.secret, 2 * K)
    const verify = (n: number, tempToken: string, code: string) => viaInternet(n).req('POST', '/api/auth/2fa/verify', { body: { tempToken, code } })

    const t1 = (await viaInternet(150).login('mfa_c03_reinicio')).json().tempToken as string
    for (let i = 0; i < K - 1; i++) expect((await verify(151, t1, malos[i])).status).toBe(401)
    expect((await verify(151, t1, await totpNow(u.secret))).status, 'acierto con K-1 fallos previos').toBe(200)

    // Si el acierto no reiniciara el contador, el primero de éstos ya bloquearía.
    const t2 = (await viaInternet(152).login('mfa_c03_reinicio')).json().tempToken as string
    for (let i = 0; i < K - 1; i++) expect((await verify(153, t2, malos[K + i])).status).toBe(401)
    const bloqueo = await verify(153, t2, malos[2 * K - 1])
    expect(bloqueo.status).toBe(403)
    expect(bloqueo.json().code).toBe('ACCOUNT_LOCKED')

    expect(await env.redisKeys('auth:2fa-fail:*'), 'contador agotado').toContain(`auth:2fa-fail:${u.id}`)
    await env.createUser('admin_c03_unlock', 'ADMIN')
    const admin = env.browser('admin_c03_unlock')
    await admin.signIn('admin_c03_unlock')
    expect((await admin.post(`/api/users/${u.id}/unlock`)).status).toBe(200)
    expect(await env.redisKeys('auth:2fa-fail:*'), 'el desbloqueo borra el contador').not.toContain(`auth:2fa-fail:${u.id}`)
    expect((await verify(154, t2, totpSiguiente(u.secret))).status, 'tras el desbloqueo del admin').toBe(200)
  })

  it('sin proxy (acceso directo) el comportamiento es el de hoy: cupo por IP del socket; un par no confiable no elige su IP con X-Forwarded-For', async () => {
    // Directo por TCP desde loopback, sin cabeceras de proxy.
    const r: number[] = []
    for (let i = 1; i <= 9; i++) r.push((await directo(41).login(`c03d-no-existe-${i}`, 'clave-falsa-123')).status)
    expect(r.slice(0, 8)).toEqual(Array(8).fill(401))
    expect(r[8]).toBe(429)
    expect((await directo(42).login('c03d-otro', 'clave-falsa-123')).status, 'otra IP de socket, su propio cupo').toBe(401)
    const u = await env.createUser('op_c03_dir', 'OPERATOR')
    expect((await directo(43).login('op_c03_dir')).status).toBe(200)
    expect((await env.prisma.session.findMany({ where: { userId: u.id }, select: { ipAddress: true } })).map((s) => s.ipAddress)).toEqual(['127.0.0.43'])

    // Par directo NO confiable (TEST-NET-2) con X-Forwarded-For inventado: se ignora.
    const u2 = await env.createUser('op_c03_ext', 'OPERATOR')
    const ext = env.browser('op_c03_ext')
    const ok = await ext.post('/api/auth/login', { username: 'op_c03_ext', password: JOINT_PASSWORD, rememberMe: true }, { headers: { 'x-forwarded-for': '203.0.113.200', 'x-real-ip': '203.0.113.200' } })
    expect(ok.status).toBe(200)
    expect((await env.prisma.session.findMany({ where: { userId: u2.id }, select: { ipAddress: true } })).map((s) => s.ipAddress)).toEqual([ext.ip])
    const otro = env.browser('rotador')
    const rot: number[] = []
    for (let i = 1; i <= 9; i++) {
      rot.push((await otro.post('/api/auth/login', { username: `c03x-no-existe-${i}`, password: 'x' }, { headers: { 'x-forwarded-for': `203.0.113.${100 + i}` } })).status)
    }
    expect(rot.slice(0, 8)).toEqual(Array(8).fill(401))
    expect(rot[8], 'rotar XFF desde un par no confiable no evade').toBe(429)

    // Borde HLS directo desde la red interna (como lo usan las demás suites): igual que hoy.
    const hlsU = await env.createUser('op_c03_hlsdir', 'OPERATOR')
    await env.grant(hlsU.id, nvrId, camA, { canView: true })
    const hb = env.browser('op_c03_hlsdir')
    await hb.signIn('op_c03_hlsdir')
    expect((await env.hlsAuth(hlsUri(1), { browser: hb })).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(1), { browser: hb, remoteAddress: '198.51.100.77' })).status).toBe(403)
  })

  it('higiene: sin red saliente; el proxy vio clientes distintos', () => {
    expect(env.blockedConnections).toEqual([])
    expect(new Set(internet.remoteAddrs).size).toBeGreaterThanOrEqual(10)
    expect(internet.remoteAddrs.every((a) => a.startsWith('203.0.113.'))).toBe(true)
  })
})
