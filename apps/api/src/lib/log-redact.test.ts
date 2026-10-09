import { describe, it, expect } from 'vitest'
import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { redactLog, redactError, maskIp, maskUser, redactDiagnosticText, requestLogSerializer } from './log-redact'
import { resolveTrustedProxies } from './trusted-proxy'

describe('redactLog — invariante #6: ni host ni credenciales en el log', () => {
  it('colapsa IPv4, IPv6, userinfo y Authorization', () => {
    const raw =
      'connect ECONNREFUSED http://admin:s3cr3t@10.20.30.40:80/ISAPI ' +
      'ipv6 [fd12:3456:789a:1::abcd]:554 ' +
      'headers Authorization: Bearer eyJhbGciOiJIUzI1.abc.def Basic YWRtaW46czNjcjN0'
    const out = redactLog(raw)
    // No debe quedar NINGÚN octeto/credencial sensible.
    expect(out).not.toContain('30.40')
    expect(out).not.toContain('s3cr3t')
    expect(out).not.toContain('admin')        // el USUARIO del userinfo tampoco queda
    expect(out).not.toContain('fd12:3456:789a')
    expect(out).not.toContain('eyJhbGciOiJIUzI1.abc.def')
    expect(out).not.toContain('YWRtaW46czNjcjN0')
    expect(out).toContain('10.20.x.x')
    expect(out).toContain('[ipv6]')
    // Ningún token vivo tras Bearer/Basic/Authorization (todo colapsado a ***).
    expect(out).not.toMatch(/Bearer\s+[A-Za-z0-9]/)
    expect(out).not.toMatch(/Basic\s+[A-Za-z0-9]/)
  })

  it('redacta el userinfo completo, incluso sin contraseña (user@host)', () => {
    const out = redactLog('GET http://operador@10.0.0.5:8000/ISAPI/System/deviceInfo')
    expect(out).not.toContain('operador')     // usuario redactado aun sin ":pass"
    expect(out).toContain('***@')
    expect(out).toContain('10.0.x.x')
  })

  it('redactError nunca expone host/credencial del AxiosError', () => {
    const axiosLike = {
      code: 'ERR_BAD_REQUEST',
      message: 'Request failed https://user:pw@192.168.9.9:8000/ISAPI/System',
      config: { url: 'https://user:pw@192.168.9.9:8000/ISAPI', headers: { Authorization: 'Bearer TOKEN123' } },
    }
    const out = redactError(axiosLike)
    expect(out).toContain('ERR_BAD_REQUEST')
    expect(out).not.toContain('192.168.9.9')
    expect(out).not.toContain('pw@')
    expect(out).not.toContain('TOKEN123') // el objeto config NO se serializa
    expect(out).toContain('192.168.x.x')
  })

  it('maskIp / maskUser no filtran el valor', () => {
    expect(maskIp('10.20.30.40')).toBe('10.20.x.x')
    expect(maskIp('fd12::1')).toBe('***')
    expect(maskUser('admin')).toBe('set')
    expect(maskUser('')).toBe('unset')
  })
})

describe('redactDiagnosticText — respuestas de diagnóstico: ni usuario ni host/IP en NINGUNA forma', () => {
  // Valores ficticios (TEST-NET RFC 5737).
  const secrets = ['192.0.2.10', 'nvr-fixture-svc', 'Fixture!Pass0', '198.51.100.20']

  it('error real de rtsp-probe (URL con usuario+IP, también la variante "rtsp:***@") ⇒ sólo el path', () => {
    const raw = 'rtsp:***@192.0.2.10:554/Streaming/Channels/101: Command failed: ffprobe -v quiet ' +
      'rtsp://nvr-fixture-svc:***@192.0.2.10:554/Streaming/Channels/101\n'
    const out = redactDiagnosticText(raw, secrets)!
    expect(out).toBe('rtsp://***/Streaming/Channels/101: Command failed: ffprobe -v quiet rtsp://***/Streaming/Channels/101\n')
  })

  it('no deja la IP ni siquiera enmascarada (a.b.x.x) y colapsa hostnames/puertos de la autoridad', () => {
    expect(redactDiagnosticText('rtsp://***@192.0.x.x:554/Streaming/Channels/102')).toBe('rtsp://***/Streaming/Channels/102')
    expect(redactDiagnosticText('rtsp://nvr.interno.lan:554/x')).toBe('rtsp://***/x')
    expect(redactDiagnosticText('sonda a 203.0.113.7 falló', [])).toBe('sonda a *** falló')
    expect(redactDiagnosticText('Connection to tcp://[fd00::10]:554?timeout=0 failed')).toBe('Connection to tcp://***?timeout=0 failed')
  })

  it('valores literales conocidos (también url-encoded) se tapan aunque no estén en una URL', () => {
    const out = redactDiagnosticText('usuario nvr-fixture-svc clave Fixture%21Pass0 cam 198.51.100.20', secrets)!
    expect(out).not.toContain('nvr-fixture-svc')
    expect(out).not.toContain('Fixture')
    expect(out).not.toContain('198.51')
  })

  it('conserva el texto útil y respeta vacíos', () => {
    expect(redactDiagnosticText('Credenciales RTSP incorrectas (401)', secrets)).toBe('Credenciales RTSP incorrectas (401)')
    expect(redactDiagnosticText(null)).toBeNull()
    expect(redactDiagnosticText(undefined)).toBeNull()
    expect(redactDiagnosticText('')).toBe('')
  })
})

// C03 — Con trustProxy (server.ts), request.hostname sale de X-Forwarded-Host (lo elige
// el cliente: nginx no lo fija) y request.ip de X-Forwarded-For. El log de cada request
// registra el Host y el par TCP, como antes de C03: ni un hostname elegido por el
// cliente ni su IP (dato personal en logs sin retención; desde la LAN, una IP interna).
describe('requestLogSerializer — el log de request no toma X-Forwarded-Host ni X-Forwarded-For (C03)', () => {
  async function logDe(headers: Record<string, string>, remoteAddress: string) {
    const lines: string[] = []
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb() } })
    const app = Fastify({
      trustProxy: resolveTrustedProxies(undefined).trustProxy,
      logger: { level: 'info', stream, serializers: { req: requestLogSerializer } },
    })
    app.get('/api/x', async () => ({ ok: true }))
    await app.inject({ method: 'GET', url: '/api/x?token=abc', remoteAddress, headers })
    await app.close()
    const entry = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'incoming request')
    return entry.req as { method: string; url: string; hostname?: string; remoteAddress?: string }
  }

  it('desde nginx (par confiable) con X-Forwarded-Host y X-Forwarded-For del cliente ⇒ Host y par TCP', async () => {
    const req = await logDe({
      host: 'vms.example.test', 'x-forwarded-host': 'atacante.example',
      'x-forwarded-for': '203.0.113.77', 'x-real-ip': '203.0.113.77',
    }, '172.18.0.5')
    expect(req).toEqual({ method: 'GET', url: '/api/x?token=***', hostname: 'vms.example.test', remoteAddress: '172.18.0.5' })
  })

  it('Host con puerto ⇒ sin el puerto (como request.hostname); IPv6 entre corchetes', async () => {
    expect((await logDe({ host: 'vms.example.test:8443' }, '127.0.0.1')).hostname).toBe('vms.example.test')
    expect((await logDe({ host: '[::1]:4000' }, '127.0.0.1')).hostname).toBe('[::1]')
  })
})
