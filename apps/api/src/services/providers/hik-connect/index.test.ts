// HikConnectProvider: gate HIK_CONNECT_ENABLED (inerte con OFF), flujo con
// transporte INYECTADO, cache/refresh de token, validación anti-SSRF del
// areaDomain y NO filtración de secretos (secretKey/accessToken).

import { describe, it, expect } from 'vitest'
import { HikConnectProvider } from './index'
import type { HttpTransport, RawHttpResponse } from './client'

const APP_KEY = 'AK-test'
const SECRET_KEY = 'SK-super-secret-value'
const ACCESS_TOKEN = 'at.super-secret-token'
const AREA = 'https://isaeu.hik-connect.com'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** Transporte que registra requests y responde según una cola de respuestas. */
function scriptedTransport(responses: RawHttpResponse[]) {
  const sent: Sent[] = []
  let i = 0
  const transport: HttpTransport = {
    async request(url, o) {
      sent.push({ url, method: o.method, headers: o.headers, body: o.body })
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      return r
    },
  }
  return { transport, sent }
}

function tokenResponse(expireTimeMs?: number): RawHttpResponse {
  return {
    status: 200,
    body: JSON.stringify({
      code: '200',
      msg: 'ok',
      data: { accessToken: ACCESS_TOKEN, areaDomain: AREA, expireTime: expireTimeMs ?? 1893456000000 },
    }),
  }
}

describe('HikConnectProvider — gate', () => {
  it('con enabled=false cada método lanza NOT_ENABLED y NO hace I/O', async () => {
    let called = false
    const transport: HttpTransport = {
      async request() {
        called = true
        return { status: 200, body: '{}' }
      },
    }
    const p = new HikConnectProvider({ enabled: false, appKey: APP_KEY, secretKey: SECRET_KEY, transport })
    await expect(p.getToken()).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    await expect(p.getHlsAddress('DS1')).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    await expect(p.proxyIsapi('DS1', 'GET', '/ISAPI/System/deviceInfo')).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    expect(p.isEnabled()).toBe(false)
    expect(called).toBe(false)
  })

  it('respeta HIK_CONNECT_ENABLED del entorno cuando no se pasa enabled', () => {
    const prev = process.env.HIK_CONNECT_ENABLED
    process.env.HIK_CONNECT_ENABLED = 'true'
    expect(new HikConnectProvider().isEnabled()).toBe(true)
    process.env.HIK_CONNECT_ENABLED = 'false'
    expect(new HikConnectProvider().isEnabled()).toBe(false)
    if (prev === undefined) delete process.env.HIK_CONNECT_ENABLED
    else process.env.HIK_CONNECT_ENABLED = prev
  })

  it('enabled pero sin credenciales → NOT_CONFIGURED', async () => {
    const { transport } = scriptedTransport([{ status: 200, body: '{}' }])
    const p = new HikConnectProvider({ enabled: true, appKey: '', secretKey: '', transport })
    await expect(p.getToken()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })
})

describe('HikConnectProvider — flujo con transporte inyectado', () => {
  it('getToken: obtiene token, valida areaDomain y NO expone el accessToken', async () => {
    const { transport } = scriptedTransport([tokenResponse()])
    const p = new HikConnectProvider({ enabled: true, appKey: APP_KEY, secretKey: SECRET_KEY, transport })
    const info = await p.getToken()
    expect(info.areaDomain).toBe(AREA)
    expect(info.active).toBe(true)
    // El objeto público NO contiene el accessToken.
    expect(JSON.stringify(info)).not.toContain(ACCESS_TOKEN)
    expect(JSON.stringify(info)).not.toContain(SECRET_KEY)
  })

  it('getHlsAddress: usa el areaDomain validado como base y clampa TTL', async () => {
    const { transport, sent } = scriptedTransport([
      tokenResponse(),
      { status: 200, body: JSON.stringify({ code: '200', data: { url: `${AREA}/live/abc.m3u8` } }) },
    ])
    const p = new HikConnectProvider({
      enabled: true,
      appKey: APP_KEY,
      secretKey: SECRET_KEY,
      transport,
      hlsTtlSec: 9999,
    })
    const hls = await p.getHlsAddress('DS-serial', 3)
    expect(hls.url).toBe(`${AREA}/live/abc.m3u8`)
    expect(hls.ttlSec).toBe(600) // clamp
    // La segunda request salió al areaDomain validado, no al base de bootstrap.
    expect(sent[1].url.startsWith(AREA)).toBe(true)
    expect(sent[1].body).toContain('expireTime=600')
    expect(sent[1].body).toContain('channelNo=3')
  })

  it('proxyIsapi: valida el path y sale al areaDomain', async () => {
    const { transport, sent } = scriptedTransport([
      tokenResponse(),
      { status: 200, body: JSON.stringify({ code: '200', data: { ok: true } }) },
    ])
    const p = new HikConnectProvider({ enabled: true, appKey: APP_KEY, secretKey: SECRET_KEY, transport })
    await p.proxyIsapi('DS1', 'GET', '/ISAPI/System/deviceInfo')
    expect(sent[1].url.startsWith(AREA)).toBe(true)
    expect(sent[1].headers['EZO-ISAPI-Path']).toBe('/ISAPI/System/deviceInfo')
  })

  it('proxyIsapi: path inseguro → INVALID_ISAPI_PATH (tras obtener token)', async () => {
    const { transport } = scriptedTransport([tokenResponse()])
    const p = new HikConnectProvider({ enabled: true, appKey: APP_KEY, secretKey: SECRET_KEY, transport })
    await expect(p.proxyIsapi('DS1', 'GET', '/ISAPI/../secret')).rejects.toMatchObject({
      code: 'INVALID_ISAPI_PATH',
    })
  })

  it('cachea el token: dos operaciones = una sola request de token', async () => {
    const { transport, sent } = scriptedTransport([
      tokenResponse(),
      { status: 200, body: JSON.stringify({ code: '200', data: { url: `${AREA}/a.m3u8` } }) },
      { status: 200, body: JSON.stringify({ code: '200', data: { url: `${AREA}/b.m3u8` } }) },
    ])
    const p = new HikConnectProvider({ enabled: true, appKey: APP_KEY, secretKey: SECRET_KEY, transport })
    await p.getHlsAddress('DS1')
    await p.getHlsAddress('DS2')
    const tokenCalls = sent.filter((s) => s.url.includes('/token/get'))
    expect(tokenCalls.length).toBe(1)
  })

  it('refresca el token cuando está por expirar (clock inyectado)', async () => {
    let now = 1000
    const { transport, sent } = scriptedTransport([
      tokenResponse(1000 + 30_000), // expira 30s tras el "ahora" inicial (< margen 60s)
      { status: 200, body: JSON.stringify({ code: '200', data: { url: `${AREA}/a.m3u8` } }) },
      tokenResponse(9_999_999_999_999),
      { status: 200, body: JSON.stringify({ code: '200', data: { url: `${AREA}/b.m3u8` } }) },
    ])
    const p = new HikConnectProvider({
      enabled: true,
      appKey: APP_KEY,
      secretKey: SECRET_KEY,
      transport,
      clock: () => now,
    })
    await p.getHlsAddress('DS1')
    now = 2000
    await p.getHlsAddress('DS2')
    const tokenCalls = sent.filter((s) => s.url.includes('/token/get'))
    expect(tokenCalls.length).toBe(2) // se refrescó porque el primero estaba por expirar
  })

  it('rechaza un areaDomain malicioso devuelto por el token (SSRF)', async () => {
    const evil = {
      status: 200,
      body: JSON.stringify({
        code: '200',
        data: { accessToken: ACCESS_TOKEN, areaDomain: 'https://169.254.169.254', expireTime: 1893456000000 },
      }),
    }
    const { transport } = scriptedTransport([evil])
    const p = new HikConnectProvider({ enabled: true, appKey: APP_KEY, secretKey: SECRET_KEY, transport })
    await expect(p.getToken()).rejects.toMatchObject({ code: 'INVALID_AREA_DOMAIN' })
  })

  it('secretKey/accessToken NUNCA aparecen en los mensajes de error', async () => {
    // Forzar un API_ERROR de token; el mensaje no debe llevar secretos.
    const { transport } = scriptedTransport([
      { status: 200, body: JSON.stringify({ code: '10018', msg: 'sign error' }) },
    ])
    const p = new HikConnectProvider({ enabled: true, appKey: APP_KEY, secretKey: SECRET_KEY, transport })
    try {
      await p.getToken()
      throw new Error('debió lanzar')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).not.toContain(SECRET_KEY)
      expect(msg).not.toContain(ACCESS_TOKEN)
    }
  })
})
