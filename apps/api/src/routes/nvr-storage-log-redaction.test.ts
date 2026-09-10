// #171 P1 — El log del catch de [storage] NUNCA debe filtrar host, usuario,
// contraseña ni Authorization del NVR. Antes se hacía `server.log.error({ err: e })`
// y Pino serializaba `config.url` / `config.auth` / `headers.Authorization` del
// AxiosError. Aquí se captura la salida REAL de Pino (el mismo logger de Fastify) y
// se afirma la ausencia de todo secreto; un caso de CONTROL demuestra que el patrón
// crudo SÍ filtraría (para que el test no sea trivial).
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { Writable } from 'node:stream'
import { maskIp, redactError } from '../lib/log-redact'

/** AxiosError-like: lo que un cliente ISAPI produciría al fallar contra el NVR.
 *  Lleva host+credenciales en message, config.url, config.auth y Authorization. */
function axiosErrorLike() {
  return {
    name: 'AxiosError',
    code: 'ECONNREFUSED',
    message: 'connect ECONNREFUSED http://admin:s3cr3t@10.20.30.40:80/ISAPI/ContentMgmt/Storage',
    config: {
      url: 'http://10.20.30.40:80/ISAPI/ContentMgmt/Storage',
      auth: { username: 'admin', password: 's3cr3t' },
      headers: { Authorization: 'Basic YWRtaW46czNjcjN0' },
    },
    request: { _header: 'GET /ISAPI HTTP/1.1\r\nAuthorization: Basic YWRtaW46czNjcjN0\r\n' },
  }
}

function capturingLogger() {
  let buf = ''
  const stream = new Writable({ write(chunk, _enc, cb) { buf += chunk.toString(); cb() } })
  return { stream, get text() { return buf } }
}

const SECRETS = ['10.20.30.40', 'admin', 's3cr3t', 'YWRtaW46czNjcjN0', 'Basic ', 'Authorization']

describe('#171 · [storage] log redaction (salida REAL de Pino)', () => {
  it('el patrón SEGURO (redactError + maskIp) no deja host/usuario/clave/Authorization', async () => {
    const cap = capturingLogger()
    const app = Fastify({ logger: { level: 'error', stream: cap.stream } })
    app.get('/boom', async () => {
      const e = axiosErrorLike()
      const nvr = { name: 'NVR-Lobby', ipAddress: '10.20.30.40' }
      // EXACTAMENTE como lo hace ahora routes/nvr.ts en el catch de [storage].
      app.log.error(`[storage] ${nvr.name} (${maskIp(nvr.ipAddress)}) error sincronizando HDDs: ${redactError(e)}`)
      return { ok: true }
    })
    await app.inject({ method: 'GET', url: '/boom' })
    await app.close()

    for (const s of SECRETS) expect(cap.text).not.toContain(s)
    expect(cap.text).toContain('10.20.x.x')   // sólo la subred enmascarada
    expect(cap.text).toContain('ECONNREFUSED') // el code sí, útil y sin secreto
  })

  it('CONTROL: el patrón CRUDO `log.error({ err })` SÍ filtraría (por eso se prohíbe)', async () => {
    const cap = capturingLogger()
    const app = Fastify({ logger: { level: 'error', stream: cap.stream } })
    app.get('/leak', async () => {
      app.log.error({ err: axiosErrorLike() }, '[storage] Error sincronizando HDDs del NVR')
      return { ok: true }
    })
    await app.inject({ method: 'GET', url: '/leak' })
    await app.close()

    // Demuestra la fuga que el patrón seguro evita: el host aparece crudo.
    expect(cap.text).toContain('10.20.30.40')
  })
})
