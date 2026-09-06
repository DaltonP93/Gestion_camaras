// Prueba CONDUCTUAL de SSRF para POST /api/nvrs/scan (caso 5).
//
// El barrido de subred debe rechazar subredes/IPs reservadas ANTES de abrir
// cualquier conexión. Se levanta un servidor HTTP real en 127.0.0.1 y se escanea
// la subred loopback 127.0.0 apuntando a su puerto: como el guard (real, sin mock)
// rechaza 127.0.0.0/8, la ruta responde 400 y el servidor recibe 0 requests
// (contador de hits = 0). También se cubre el endpoint de metadatos Alibaba
// 100.100.100.200 (cae en CGNAT). Contraste positivo: una subred LAN legítima NO
// es rechazada por SSRF (el guard la deja pasar).
//
// MUTACIÓN: si se elimina/ debilita la validación previa de /scan, el barrido de
// 127.0.0 llegaría a conectar y el servidor registraría hits ⇒ esta prueba falla.
//
// Este archivo NO mockea el guard (a diferencia del test de redirecciones): aquí lo
// que se ejercita es precisamente la política real. IPs/credenciales ficticias.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { nvrRoutes } from './nvr'

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  const user = { sub: 'adm1', role: 'ADMIN' as const }
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (_roles: string[]) => async (req: any) => { req.user = user })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', { nVR: { findUnique: async () => null, findMany: async () => [] }, userPermission: { findFirst: async () => null, findMany: async () => [] }, auditLog: { create: async () => ({}) } } as any)
  await app.register(nvrRoutes, { prefix: '/api/nvrs' })
  await app.ready()
  return app
}

describe('SSRF conductual — POST /api/nvrs/scan rechaza subredes reservadas antes de conectar', () => {
  let target: http.Server
  let targetPort: number
  let hits: number

  beforeEach(async () => {
    hits = 0
    target = http.createServer((_req, res) => { hits++; res.writeHead(200); res.end('<DeviceInfo/>') })
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()))
    targetPort = (target.address() as AddressInfo).port
  })
  afterEach(async () => { await new Promise<void>((r) => target.close(() => r())) })

  it('(5) subred loopback 127.0.0 ⇒ 400 y el servidor NO recibe ninguna conexión (hits=0)', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/api/nvrs/scan',
      payload: { subnet: '127.0.0', port: targetPort, start: 1, end: 5 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().errorCode).toBe('SSRF_BLOCKED')
    expect(hits).toBe(0)   // rechazado ANTES de cualquier probe
    await app.close()
  })

  it('(5b) subred CGNAT que incluye metadatos Alibaba 100.100.100.200 ⇒ 400 sin conectar', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/api/nvrs/scan',
      payload: { subnet: '100.100.100', port: targetPort, start: 200, end: 200 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().errorCode).toBe('SSRF_BLOCKED')
    expect(hits).toBe(0)
    await app.close()
  })

  it('(5c) subred no especificada 0.0.0 ⇒ 400 sin conectar', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/api/nvrs/scan',
      payload: { subnet: '0.0.0', port: targetPort, start: 1, end: 3 },
    })
    expect(res.statusCode).toBe(400)
    expect(hits).toBe(0)
    await app.close()
  })

  it('contraste positivo: subred LAN 10.0.0 NO se rechaza por SSRF (el guard la permite)', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/api/nvrs/scan',
      payload: { subnet: '10.0.0', port: 9, start: 1, end: 1 },  // puerto discard: la conexión falla rápido
    })
    // La política LAN permite 10.0.0.x ⇒ NO es 400 SSRF; procede al barrido (200).
    expect(res.statusCode).toBe(200)
    expect(res.json().scanned).toBe(1)
    await app.close()
  })
})
