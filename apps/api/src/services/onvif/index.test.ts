// apps/api/src/services/onvif/index.test.ts
//
// OnvifService: gate ONVIF_ENABLED (inerte con OFF) y flujo con transporte
// INYECTADO. Verifica que las credenciales se usan (digest) pero NO se filtran,
// y que las operaciones componen builder+parser correctamente.

import { describe, it, expect } from 'vitest'
import { OnvifService } from './index'
import type { SoapTransport } from './soap-client'

const CREDS = { username: 'admin', password: 'super-secret-pass' }
const URL = 'http://192.168.1.50/onvif/device_service'

/** Transporte que registra los cuerpos enviados y responde con `body`. */
function recordingTransport(body: string) {
  const sent: { url: string; body: string; headers: Record<string, string> }[] = []
  const transport: SoapTransport = {
    async post(url, b, o) {
      sent.push({ url, body: b, headers: o.headers })
      return { status: 200, body }
    },
  }
  return { transport, sent }
}

// Nonce/clock fijos para envolturas deterministas.
const fixed = { nonceProvider: () => Buffer.from('nonce-fixed'), clock: () => '2026-09-03T12:00:00Z' }

describe('OnvifService — gate', () => {
  it('con enabled=false cada método lanza NOT_ENABLED (inerte)', async () => {
    const svc = new OnvifService({ enabled: false })
    await expect(svc.discover()).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    await expect(svc.getProfiles(URL, CREDS)).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    await expect(svc.getStreamUri(URL, CREDS, 'P1')).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    await expect(svc.ptzMove(URL, CREDS, 'P1', { x: 0.1 })).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    await expect(svc.getImaging(URL, CREDS, 'VS1')).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    await expect(svc.setImaging(URL, CREDS, 'VS1', { irCutFilter: 'ON' })).rejects.toMatchObject({ code: 'NOT_ENABLED' })
    expect(svc.isEnabled()).toBe(false)
  })

  it('respeta ONVIF_ENABLED del entorno cuando no se pasa enabled', () => {
    const prev = process.env.ONVIF_ENABLED
    process.env.ONVIF_ENABLED = 'true'
    expect(new OnvifService().isEnabled()).toBe(true)
    process.env.ONVIF_ENABLED = 'false'
    expect(new OnvifService().isEnabled()).toBe(false)
    if (prev === undefined) delete process.env.ONVIF_ENABLED
    else process.env.ONVIF_ENABLED = prev
  })
})

describe('OnvifService — flujo con transporte inyectado', () => {
  it('getStreamUri: compone GetStreamUri, envía WSSE con digest y parsea la URI', async () => {
    const { transport, sent } = recordingTransport(
      '<trt:MediaUri><tt:Uri>rtsp://192.168.1.50:554/Streaming/Channels/101</tt:Uri></trt:MediaUri>',
    )
    const svc = new OnvifService({ enabled: true, transport, ...fixed })
    const uri = await svc.getStreamUri(URL, CREDS, 'Profile_1')
    expect(uri).toBe('rtsp://192.168.1.50:554/Streaming/Channels/101')
    // Se envió el token de seguridad, pero NUNCA la contraseña en claro.
    expect(sent[0].body).toContain('<wsse:Security')
    expect(sent[0].body).toContain('<trt:ProfileToken>Profile_1</trt:ProfileToken>')
    expect(sent[0].body).not.toContain(CREDS.password)
  })

  it('getProfiles: parsea la lista', async () => {
    const { transport } = recordingTransport(
      '<trt:GetProfilesResponse><trt:Profiles token="P1"><tt:Name>main</tt:Name></trt:Profiles></trt:GetProfilesResponse>',
    )
    const svc = new OnvifService({ enabled: true, transport, ...fixed })
    const profiles = await svc.getProfiles(URL, CREDS)
    expect(profiles).toEqual([
      { token: 'P1', name: 'main', videoSourceToken: null, encoding: null, width: null, height: null },
    ])
  })

  it('getStreamUri: PARSE_ERROR si la respuesta no trae URI', async () => {
    const { transport } = recordingTransport('<trt:GetStreamUriResponse/>')
    const svc = new OnvifService({ enabled: true, transport, ...fixed })
    await expect(svc.getStreamUri(URL, CREDS, 'P1')).rejects.toMatchObject({ code: 'PARSE_ERROR' })
  })

  it('ptzMove y setImaging: envían el body correcto y resuelven', async () => {
    const { transport, sent } = recordingTransport('<ok/>')
    const svc = new OnvifService({ enabled: true, transport, ...fixed })
    await svc.ptzMove(URL, CREDS, 'P1', { x: 0.5, zoom: 0.2 })
    await svc.setImaging(URL, CREDS, 'VS1', { irCutFilter: 'ON', focus: { autoFocusMode: 'MANUAL' } })
    expect(sent[0].body).toContain('ContinuousMove')
    expect(sent[0].body).toContain('<tt:PanTilt x="0.5" y="0"/>')
    expect(sent[1].body).toContain('<tt:IrCutFilter>ON</tt:IrCutFilter>')
    expect(sent[1].body).toContain('<tt:AutoFocusMode>MANUAL</tt:AutoFocusMode>')
  })

  it('SSRF: deviceUrl a metadatos cloud → SSRF_BLOCKED (sin tocar el device)', async () => {
    let called = false
    const transport: SoapTransport = { async post() { called = true; return { status: 200, body: '' } } }
    const svc = new OnvifService({ enabled: true, transport, ...fixed })
    await expect(svc.getProfiles('http://169.254.169.254/onvif', CREDS)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
    expect(called).toBe(false)
  })

  it('SSRF (ONVIF_ENABLED=true): AWS IMDS sobre IPv6 (toda forma) → SSRF_BLOCKED y el transporte NUNCA se invoca', async () => {
    // Con el servicio HABILITADO, cada método valida SSRF antes de cualquier POST.
    // fd00:ec2::254 cae en ULA (isPrivateIpv6 lo permitiría): sólo el bloqueo por
    // valor canónico de metadatos lo detiene. Se prueba en varias operaciones y con
    // formas comprimida/expandida/mayúsculas y allowPublic=true.
    for (const url of [
      'http://[fd00:ec2::254]/onvif',
      'http://[fd00:0ec2:0000:0000:0000:0000:0000:0254]/onvif',
      'http://[FD00:EC2::254]/onvif',
    ]) {
      let called = false
      const transport: SoapTransport = { async post() { called = true; return { status: 200, body: '' } } }
      const svc = new OnvifService({ enabled: true, transport, ...fixed, ssrfPolicy: { allowPublic: true } })
      await expect(svc.getProfiles(url, CREDS)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
      await expect(svc.getDeviceInformation(url, CREDS)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
      await expect(svc.getStreamUri(url, CREDS, 'P1')).rejects.toMatchObject({ code: 'SSRF_BLOCKED' })
      expect(called).toBe(false)  // el transporte NUNCA fue invocado
    }
  })

  it('rechaza argumentos vacíos con INVALID_ARG', async () => {
    const { transport } = recordingTransport('<ok/>')
    const svc = new OnvifService({ enabled: true, transport, ...fixed })
    await expect(svc.getStreamUri(URL, CREDS, '')).rejects.toMatchObject({ code: 'INVALID_ARG' })
    await expect(svc.getImaging(URL, CREDS, '')).rejects.toMatchObject({ code: 'INVALID_ARG' })
  })
})
