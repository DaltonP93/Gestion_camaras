// C03 — confianza en el proxy acotada al salto inmediato. Se prueba con una
// instancia Fastify real (request.ip la calcula Fastify/proxy-addr con la función)
// y @fastify/rate-limit en memoria con el MISMO config que /api/auth/login.
// Direcciones TEST-NET (198.51.100.0/24, 203.0.113.0/24) y privadas de ejemplo.
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyServerOptions } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { resolveTrustedProxies, normalizePeerAddress, DEFAULT_TRUSTED_PROXIES } from './trusted-proxy'
import { isInternalIp, isInternalPeer, socketPeerAddress } from './internal-origin'

const NGINX = '172.18.0.5'          // par típico de nginx en la red bridge del compose
const NGINX_ALT = '192.168.32.4'    // red bridge asignada del pool 192.168.0.0/16

async function appWith(trustProxy: FastifyServerOptions['trustProxy']) {
  const app = Fastify({ trustProxy })
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' })
  app.get('/ip', async (req) => ({ ip: req.ip, socket: socketPeerAddress(req), internal: isInternalPeer(req) }))
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (_req, reply) => reply.status(401).send())
  await app.ready()
  return app
}

/** nginx: X-Forwarded-For = $proxy_add_x_forwarded_for = "<XFF del cliente>, $remote_addr". */
const viaNginx = (remoteAddr: string, xffCliente?: string) => ({
  'x-forwarded-for': xffCliente ? `${xffCliente}, ${remoteAddr}` : remoteAddr,
  'x-real-ip': remoteAddr,
})

describe('resolveTrustedProxies — configuración', () => {
  it('vacío/ausente ⇒ default (loopback + pools bridge de Docker); 10/8 y públicas NO', () => {
    for (const raw of [undefined, '', '   ']) {
      const t = resolveTrustedProxies(raw)
      expect(t.origin).toBe('default')
      for (const a of ['127.0.0.1', '127.0.0.9', '::1', '::ffff:127.0.0.1', NGINX, '172.31.255.254', NGINX_ALT]) expect(t.isTrustedPeer(a), a).toBe(true)
      for (const a of ['10.0.0.5', '172.15.0.1', '172.32.0.1', '198.51.100.7', '203.0.113.9', '::ffff:203.0.113.9', 'fe80::1', '', undefined]) expect(t.isTrustedPeer(a), String(a)).toBe(false)
    }
    expect(DEFAULT_TRUSTED_PROXIES).toBe('loopback,172.16.0.0/12,192.168.0.0/16')
  })

  it('lista explícita: IPs, CIDR, `loopback`/`uniquelocal`, separadores coma/espacio', () => {
    const t = resolveTrustedProxies(' 10.20.0.0/16, 192.0.2.10 loopback ')
    expect(t.origin).toBe('env')
    expect(t.isTrustedPeer('10.20.3.4')).toBe(true)
    expect(t.isTrustedPeer('10.21.0.1')).toBe(false)
    expect(t.isTrustedPeer('192.0.2.10')).toBe(true)
    expect(t.isTrustedPeer('192.0.2.11')).toBe(false)
    expect(t.isTrustedPeer('127.0.0.1')).toBe(true)
    expect(t.isTrustedPeer(NGINX)).toBe(false) // no está en la lista explícita
    expect(resolveTrustedProxies('uniquelocal').isTrustedPeer('10.9.9.9')).toBe(true)
  })

  it('`none` ⇒ no se confía en nadie (comportamiento previo)', () => {
    const t = resolveTrustedProxies('none')
    expect(t.origin).toBe('none')
    expect(t.isTrustedPeer('127.0.0.1')).toBe(false)
    expect(t.trustProxy('127.0.0.1', 0)).toBe(false)
  })

  it('inválido ⇒ no se confía en nadie y se informa la posición (nunca el valor)', () => {
    for (const raw of ['loopback,nginx', '172.16.0.0/33', '10.0.0.0/x', 'none,loopback', '999.1.1.1']) {
      const t = resolveTrustedProxies(raw)
      expect(t.origin, raw).toBe('invalid')
      expect(t.isTrustedPeer('127.0.0.1'), raw).toBe(false)
      expect(t.error, raw).toMatch(/^entrada #\d+ /)
    }
    expect(resolveTrustedProxies('loopback,nginx').error).not.toContain('nginx')
  })

  it('sólo el salto 0: un salto más a la izquierda NUNCA es confiable aunque esté en la lista', () => {
    const t = resolveTrustedProxies(undefined)
    expect(t.trustProxy(NGINX, 0)).toBe(true)
    expect(t.trustProxy('127.0.0.1', 1)).toBe(false)
    expect(t.trustProxy(NGINX, 2)).toBe(false)
  })

  it('aviso único si llega X-Forwarded-For de un par INTERNO no confiable; nunca por un par externo', () => {
    let avisos = 0
    const t = resolveTrustedProxies('192.0.2.10', () => { avisos++ })
    t.trustProxy('203.0.113.9', 0)   // externo: no avisa
    expect(avisos).toBe(0)
    t.trustProxy('10.1.2.3', 0)      // interno no listado: avisa
    t.trustProxy('172.18.0.9', 0)    // una sola vez
    expect(avisos).toBe(1)
  })

  it('normalizePeerAddress quita el prefijo IPv4-mapeado', () => {
    expect(normalizePeerAddress('::ffff:172.18.0.5')).toBe('172.18.0.5')
    expect(normalizePeerAddress('::1')).toBe('::1')
    expect(normalizePeerAddress(undefined)).toBeUndefined()
  })
})

describe('request.ip con la función (Fastify real)', () => {
  const trust = resolveTrustedProxies(undefined).trustProxy

  it('par nginx confiable ⇒ request.ip = la ÚLTIMA entrada de X-Forwarded-For ($remote_addr de nginx)', async () => {
    const app = await appWith(trust)
    for (const peer of [NGINX, NGINX_ALT, '127.0.0.1']) {
      const r = await app.inject({ method: 'GET', url: '/ip', remoteAddress: peer, headers: viaNginx('203.0.113.50') })
      expect(r.json(), peer).toEqual({ ip: '203.0.113.50', socket: peer, internal: true })
    }
    await app.close()
  })

  it('el cliente no elige su IP con un X-Forwarded-For falso (nginx agrega $remote_addr al final)', async () => {
    const app = await appWith(trust)
    const r = await app.inject({ method: 'GET', url: '/ip', remoteAddress: NGINX, headers: viaNginx('203.0.113.50', '127.0.0.1, 10.0.0.1') })
    expect(r.json().ip).toBe('203.0.113.50')
    await app.close()
  })

  it('cliente de la LAN en rango "confiable" detrás de nginx: tampoco falsifica (su IP es el salto 1)', async () => {
    const app = await appWith(trust)
    for (const lan of ['192.168.1.50', '172.20.0.7', '127.0.0.33']) {
      const r = await app.inject({ method: 'GET', url: '/ip', remoteAddress: NGINX, headers: viaNginx(lan, '198.51.100.99') })
      expect(r.json().ip, lan).toBe(lan)
    }
    await app.close()
  })

  it('par directo NO confiable ⇒ request.ip = socket; sus cabeceras se ignoran (comportamiento previo)', async () => {
    const app = await appWith(trust)
    const r = await app.inject({ method: 'GET', url: '/ip', remoteAddress: '198.51.100.7', headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' } })
    expect(r.json()).toEqual({ ip: '198.51.100.7', socket: '198.51.100.7', internal: false })
    await app.close()
  })

  it('par confiable sin X-Forwarded-For (healthcheck, MediaMTX) ⇒ request.ip = socket', async () => {
    const app = await appWith(trust)
    const r = await app.inject({ method: 'GET', url: '/ip', remoteAddress: NGINX })
    expect(r.json().ip).toBe(NGINX)
    await app.close()
  })

  it('cupo de login por cliente detrás de nginx; rotar X-Forwarded-For no lo evade', async () => {
    const app = await appWith(trust)
    const login = (remoteAddr: string, xff?: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: NGINX, payload: {}, headers: viaNginx(remoteAddr, xff) })
    const distintos: number[] = []
    for (let i = 1; i <= 12; i++) distintos.push((await login(`198.51.100.${i}`)).statusCode)
    expect(distintos).toEqual(Array(12).fill(401))   // 12 clientes ≠ ⇒ nadie llega a 429
    const mismo: number[] = []
    for (let i = 1; i <= 9; i++) mismo.push((await login('203.0.113.50', `10.0.0.${i}`)).statusCode)
    expect(mismo.slice(0, 8)).toEqual(Array(8).fill(401))
    expect(mismo[8]).toBe(429)
    await app.close()
  })

  it('contraste: `trustProxy` con la lista de proxy-addr (todo salto listado) SÍ permite falsificar desde la LAN', async () => {
    // Por qué no se usa `trustProxy: DEFAULT_TRUSTED_PROXIES`: confía en el salto 1
    // (cliente LAN en 192.168/16) y toma su X-Forwarded-For inventado.
    const app = await appWith(DEFAULT_TRUSTED_PROXIES)
    const r = await app.inject({ method: 'GET', url: '/ip', remoteAddress: NGINX, headers: viaNginx('192.168.1.50', '198.51.100.99') })
    expect(r.json().ip).toBe('198.51.100.99')
    await app.close()
  })
})

describe('isInternalIp (mismos rangos que tenían hls-auth y el hook)', () => {
  it('loopback exacto y redes privadas sí; públicas y otros 127.x no', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.0.1', '192.168.0.1']) expect(isInternalIp(a), a).toBe(true)
    for (const a of ['127.0.0.2', '172.15.0.1', '172.32.0.1', '198.51.100.7', '203.0.113.9', '', undefined]) expect(isInternalIp(a), String(a)).toBe(false)
  })
})
