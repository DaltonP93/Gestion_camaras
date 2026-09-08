import { describe, it, expect, vi, beforeEach } from 'vitest'

// axios se mockea para probar el contrato de sendToChannel sin salir a la red.
vi.mock('axios', () => ({ default: { post: vi.fn() } }))
import axios from 'axios'
import {
  assertSafeWebhookUrl,
  buildChannelPayload,
  sendToChannel,
  type ChannelAlert,
} from './channel.provider'

const post = axios.post as unknown as ReturnType<typeof vi.fn>

const ALERT: ChannelAlert = {
  type: 'CAMERA_OFFLINE',
  severity: 'HIGH',
  message: 'Cámara sin señal',
  nvrId: 'nvr-1',
  cameraId: 'cam-9',
  nvrName: 'NVR Recepción',
  cameraName: 'Entrada',
}

describe('assertSafeWebhookUrl (SSRF)', () => {
  it('acepta destinos públicos https', () => {
    expect(assertSafeWebhookUrl('https://hooks.slack.com/services/T/B/x').hostname).toBe('hooks.slack.com')
  })

  it('acepta LAN privada (el VMS suele vivir on-prem)', () => {
    expect(() => assertSafeWebhookUrl('http://192.168.1.50/webhook')).not.toThrow()
    expect(() => assertSafeWebhookUrl('http://10.0.0.10:8080/hook')).not.toThrow()
  })

  it('bloquea el endpoint de metadatos cloud (IPv4 e IPv6 y DNS)', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://100.100.100.200/',
      'http://[fd00:ec2::254]/latest/',
    ]) {
      expect(() => assertSafeWebhookUrl(u), u).toThrow()
    }
  })

  it('bloquea loopback y no-especificada', () => {
    for (const u of ['http://localhost/x', 'http://127.0.0.1/x', 'http://127.5.5.5/x', 'http://0.0.0.0/x', 'http://[::1]/x']) {
      expect(() => assertSafeWebhookUrl(u), u).toThrow()
    }
  })

  it('bloquea link-local IPv4 e IPv6', () => {
    expect(() => assertSafeWebhookUrl('http://169.254.10.1/x')).toThrow()
    expect(() => assertSafeWebhookUrl('http://[fe80::1]/x')).toThrow()
  })

  it('rechaza esquemas no http(s) y URLs inválidas', () => {
    expect(() => assertSafeWebhookUrl('file:///etc/passwd')).toThrow()
    expect(() => assertSafeWebhookUrl('ftp://host/x')).toThrow()
    expect(() => assertSafeWebhookUrl('not a url')).toThrow()
  })
})

describe('buildChannelPayload', () => {
  it('slack → { text } con severidad y contexto', () => {
    const p = buildChannelPayload('slack', ALERT) as { text: string }
    expect(p.text).toContain('CAMERA_OFFLINE')
    expect(p.text).toContain('Entrada')
  })

  it('teams → MessageCard válido', () => {
    const p = buildChannelPayload('teams', ALERT) as Record<string, any>
    expect(p['@type']).toBe('MessageCard')
    expect(p.title).toContain('CAMERA_OFFLINE')
  })

  it('webhook genérico → JSON estructurado prometido por la UI', () => {
    const p = buildChannelPayload('webhook', ALERT) as Record<string, any>
    expect(p).toMatchObject({
      source: 'visioncore',
      type: 'CAMERA_OFFLINE',
      severity: 'HIGH',
      message: 'Cámara sin señal',
      nvrId: 'nvr-1',
      cameraId: 'cam-9',
    })
    expect(typeof p.timestamp).toBe('string')
  })
})

describe('sendToChannel (nunca lanza)', () => {
  beforeEach(() => post.mockReset())

  it('destino SSRF: no llama a axios y devuelve errorCode', async () => {
    const r = await sendToChannel('webhook', 'http://169.254.169.254/x', ALERT)
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('SSRF_METADATA')
    expect(post).not.toHaveBeenCalled()
  })

  it('2xx → success con status', async () => {
    post.mockResolvedValueOnce({ status: 204 })
    const r = await sendToChannel('slack', 'https://hooks.slack.com/services/T/B/x', ALERT)
    expect(r).toEqual({ success: true, status: 204 })
    expect(post).toHaveBeenCalledOnce()
  })

  it('non-2xx → failed sin lanzar, con errorCode HTTP_*', async () => {
    post.mockResolvedValueOnce({ status: 500 })
    const r = await sendToChannel('teams', 'https://outlook.office.com/webhook/x', ALERT)
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('HTTP_500')
  })

  it('excepción de red → failed sin propagar', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('connect ETIMEDOUT 10.0.0.9:443'), { code: 'ETIMEDOUT' }))
    const r = await sendToChannel('webhook', 'https://example.com/hook', ALERT)
    expect(r.success).toBe(false)
    expect(r.errorCode).toBe('ETIMEDOUT')
    // la IP embebida en el mensaje debe quedar redactada (invariante #6)
    expect(r.error || '').not.toContain('10.0.0.9')
  })

  it('usa maxRedirects:0 y timeout corto', async () => {
    post.mockResolvedValueOnce({ status: 200 })
    await sendToChannel('webhook', 'https://example.com/hook', ALERT)
    const opts = post.mock.calls[0][2]
    expect(opts.maxRedirects).toBe(0)
    expect(opts.timeout).toBeLessThanOrEqual(10000)
  })
})
