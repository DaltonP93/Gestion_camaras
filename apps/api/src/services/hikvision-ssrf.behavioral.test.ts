// Pruebas CONDUCTUALES de SSRF para los clientes ISAPI de Hikvision.
//
// NO son pruebas de guard/AST: levantan servidores HTTP reales en 127.0.0.1 (puerto
// efímero) y ejercen las funciones reales (getDeviceInfo → createHikClient;
// getIpCameraList → fetchInputProxyChannels). Verifican el comportamiento observable:
//
//   (1) maxRedirects:0 ⇒ un 302 del origen A NO se sigue: el 2º origen (B, que
//       simula loopback/metadatos) nunca recibe una request (contador de hits = 0).
//   (2) redirección múltiple ⇒ se detiene en el 1er salto (A recibe 1 request, no
//       una cadena).
//   (3) Basic y Digest ⇒ la cabecera Authorization se envía SOLO al mismo origen A;
//       si A responde 302 hacia B, Authorization NUNCA llega a B (B: 0 hits).
//   (4) fetchInputProxyChannels (vía getIpCameraList) mantiene el mismo
//       comportamiento seguro: ningún salto llega a B.
//
// MUTACIÓN: subir maxRedirects a >0 en createHikClient o en fetchInputProxyChannels
// hace que A→B se siga y B reciba requests ⇒ estas pruebas fallan (dependen del
// comportamiento real de la red, no de inspección de código).
//
// El guard assertSafeNvrHost bloquea 127.0.0.1 (loopback) por diseño; aquí se
// inyecta como no-op SÓLO para poder apuntar a los servidores de prueba en loopback
// y observar el manejo de redirecciones/credenciales. El guard se prueba aparte en
// net/nvr-host-guard.test.ts. IPs/credenciales 100% ficticias.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// No-op del guard: permite alcanzar 127.0.0.1 en las pruebas de red. La variante
// "ForUrl" devuelve el host tal cual (los servidores de prueba viven en 127.0.0.1).
vi.mock('./net/nvr-host-guard', () => ({
  assertSafeNvrHost: () => {},
  assertSafeNvrHostForUrl: (h: string) => h,
  isNvrHostError: () => false,
}))

import { getDeviceInfo, getIpCameraList } from './hikvision'

interface Recorded { url?: string; method?: string; authorization?: string }

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, hits: Recorded[]) => void) {
  const hits: Recorded[] = []
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, method: req.method, authorization: req.headers['authorization'] as string | undefined })
    handler(req, res, hits)
  })
  return new Promise<{ server: http.Server; port: number; hits: Recorded[] }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ server, port, hits })
    })
  })
}

function close(...servers: http.Server[]) {
  return Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
}

const nvrAt = (port: number) => ({
  id: 'nvr-test', ipAddress: '127.0.0.1', port,
  username: 'svc', password: 'ficticia', rtspPort: 554, channels: 4, firmware: '', model: 'X',
}) as any

describe('SSRF conductual — createHikClient / fetchInputProxyChannels no siguen redirecciones', () => {
  // B = segundo origen (simula loopback/metadatos). Debe quedar SIEMPRE en 0 hits.
  let B: { server: http.Server; port: number; hits: Recorded[] }

  beforeEach(async () => {
    B = await startServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('SECOND-ORIGIN') })
  })
  afterEach(async () => { await close(B.server) })

  it('(1) un 302 del origen A hacia B NO se sigue: B recibe 0 requests', async () => {
    const A = await startServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${B.port}/ISAPI/System/deviceInfo` })
      res.end()
    })
    const info = await getDeviceInfo(nvrAt(A.port))
    expect(info).toBeNull()               // 3xx tratado como error (no se sigue Location)
    expect(A.hits.length).toBe(1)          // A recibió la request
    expect(B.hits.length).toBe(0)          // B jamás fue contactado
    await close(A.server)
  })

  it('(2) redirección múltiple: se detiene en el 1er salto (A recibe una sola request)', async () => {
    // A siempre responde 302 hacia sí mismo: con maxRedirects:0 no se sigue la cadena.
    const A = await startServer((_req, res, _hits) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${(res.socket?.localPort) ?? 0}/next` })
      res.end()
    })
    const info = await getDeviceInfo(nvrAt(A.port))
    expect(info).toBeNull()
    expect(A.hits.length).toBe(1)          // no siguió la cadena de redirecciones
    await close(A.server)
  })

  it('(3-digest) Authorization Digest se envía al mismo origen A pero NUNCA llega a B', async () => {
    const A = await startServer((req, res) => {
      if (!req.headers['authorization']) {
        res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="hik", nonce="abc123", qop="auth"' })
        res.end()
      } else {
        // Con credenciales ya presentes, A intenta redirigir a B.
        res.writeHead(302, { Location: `http://127.0.0.1:${B.port}/leak` })
        res.end()
      }
    })
    const info = await getDeviceInfo(nvrAt(A.port))
    expect(info).toBeNull()
    expect(A.hits.length).toBe(2)                                  // 401 + reintento con auth
    expect(A.hits[1].authorization?.startsWith('Digest')).toBe(true)
    expect(B.hits.length).toBe(0)                                  // Authorization no se reenvió a B
    await close(A.server)
  })

  it('(3-basic) Authorization Basic se envía al mismo origen A pero NUNCA llega a B', async () => {
    const A = await startServer((req, res) => {
      if (!req.headers['authorization']) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="hik"' })
        res.end()
      } else {
        res.writeHead(302, { Location: `http://127.0.0.1:${B.port}/leak` })
        res.end()
      }
    })
    const info = await getDeviceInfo(nvrAt(A.port))
    expect(info).toBeNull()
    expect(A.hits.length).toBe(2)
    expect(A.hits[1].authorization?.startsWith('Basic')).toBe(true)
    expect(B.hits.length).toBe(0)
    await close(A.server)
  })

  it('(4) getIpCameraList/fetchInputProxyChannels no siguen 302 hacia B (B: 0 hits)', async () => {
    // A responde 302 hacia B a TODA request ISAPI.
    const A = await startServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${B.port}/proxy` })
      res.end()
    })
    const cams = await getIpCameraList(nvrAt(A.port))
    expect(Array.isArray(cams)).toBe(true)  // degrada a fallback sin datos
    expect(A.hits.length).toBeGreaterThan(0)
    expect(B.hits.length).toBe(0)            // ni el cliente compartido ni fetchInputProxyChannels siguieron a B
    await close(A.server)
  })
})
