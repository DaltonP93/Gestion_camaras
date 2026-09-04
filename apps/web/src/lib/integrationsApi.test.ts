// Verifica que los métodos del cliente arman bien las requests (URL + body),
// espiando la instancia axios `api` (no se toca la red real).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { api, integrationsApi, onvifApi, hikConnectApi } from './api'

const creds = { username: 'u', password: 'p' }

beforeEach(() => {
  vi.restoreAllMocks()
})

function stubPost(data: unknown) {
  return vi.spyOn(api, 'post').mockResolvedValue({ data } as any)
}
function stubGet(data: unknown) {
  return vi.spyOn(api, 'get').mockResolvedValue({ data } as any)
}

describe('integrationsApi', () => {
  it('getStatus → GET /integrations/status', async () => {
    const get = stubGet({ onvif: { enabled: false }, hikConnect: { enabled: false } })
    const res = await integrationsApi.getStatus()
    expect(get.mock.calls[0][0]).toBe('/integrations/status')
    expect(res).toEqual({ onvif: { enabled: false }, hikConnect: { enabled: false } })
  })
})

describe('onvifApi arma las requests correctamente', () => {
  it('discover → POST /onvif/discover sin body', async () => {
    const post = stubPost({ devices: [] })
    const res = await onvifApi.discover()
    expect(post.mock.calls[0][0]).toBe('/onvif/discover')
    expect(post.mock.calls[0][1]).toBeUndefined()
    expect(res).toEqual({ devices: [] })
  })

  it('deviceInformation → body { deviceUrl, creds }', async () => {
    const post = stubPost({ manufacturer: 'X' })
    await onvifApi.deviceInformation('http://dev/onvif', creds)
    expect(post.mock.calls[0][0]).toBe('/onvif/device-information')
    expect(post.mock.calls[0][1]).toEqual({ deviceUrl: 'http://dev/onvif', creds })
  })

  it('profiles → body { deviceUrl, creds }', async () => {
    const post = stubPost({ profiles: [] })
    await onvifApi.profiles('http://dev/onvif', creds)
    expect(post.mock.calls[0][0]).toBe('/onvif/profiles')
    expect(post.mock.calls[0][1]).toEqual({ deviceUrl: 'http://dev/onvif', creds })
  })

  it('streamUri → body incluye profileToken', async () => {
    const post = stubPost({ uri: 'rtsp://…' })
    await onvifApi.streamUri('http://dev/onvif', creds, 'Profile_1')
    expect(post.mock.calls[0][0]).toBe('/onvif/stream-uri')
    expect(post.mock.calls[0][1]).toEqual({ deviceUrl: 'http://dev/onvif', creds, profileToken: 'Profile_1' })
  })

  it('ptzMove → body incluye velocity', async () => {
    const post = stubPost({ ok: true })
    await onvifApi.ptzMove('http://dev/onvif', creds, 'Profile_1', { x: 0.5, y: -0.2, zoom: 0 })
    expect(post.mock.calls[0][0]).toBe('/onvif/ptz/move')
    expect(post.mock.calls[0][1]).toEqual({
      deviceUrl: 'http://dev/onvif', creds, profileToken: 'Profile_1', velocity: { x: 0.5, y: -0.2, zoom: 0 },
    })
  })

  it('ptzStop → body { deviceUrl, creds, profileToken }', async () => {
    const post = stubPost({ ok: true })
    await onvifApi.ptzStop('http://dev/onvif', creds, 'Profile_1')
    expect(post.mock.calls[0][0]).toBe('/onvif/ptz/stop')
    expect(post.mock.calls[0][1]).toEqual({ deviceUrl: 'http://dev/onvif', creds, profileToken: 'Profile_1' })
  })

  it('imagingGet → body incluye videoSourceToken', async () => {
    const post = stubPost({ settings: {} })
    await onvifApi.imagingGet('http://dev/onvif', creds, 'VideoSource_1')
    expect(post.mock.calls[0][0]).toBe('/onvif/imaging/get')
    expect(post.mock.calls[0][1]).toEqual({ deviceUrl: 'http://dev/onvif', creds, videoSourceToken: 'VideoSource_1' })
  })

  it('imagingSet → body incluye settings (IrCutFilter)', async () => {
    const post = stubPost({ ok: true })
    await onvifApi.imagingSet('http://dev/onvif', creds, 'VideoSource_1', { irCutFilter: 'AUTO' })
    expect(post.mock.calls[0][0]).toBe('/onvif/imaging/set')
    expect(post.mock.calls[0][1]).toEqual({
      deviceUrl: 'http://dev/onvif', creds, videoSourceToken: 'VideoSource_1', settings: { irCutFilter: 'AUTO' },
    })
  })
})

describe('hikConnectApi arma las requests correctamente', () => {
  it('tokenStatus → POST /hik-connect/token sin body', async () => {
    const post = stubPost({ areaDomain: 'https://x.hik-connect.com', expireTimeMs: null, active: true })
    const res = await hikConnectApi.tokenStatus()
    expect(post.mock.calls[0][0]).toBe('/hik-connect/token')
    expect(post.mock.calls[0][1]).toBeUndefined()
    expect(res).toEqual({ areaDomain: 'https://x.hik-connect.com', expireTimeMs: null, active: true })
  })

  it('getHls con canal → body { deviceSerial, channelNo }', async () => {
    const post = stubPost({ url: 'https://x/hls.m3u8', ttlSec: 600 })
    const res = await hikConnectApi.getHls({ deviceSerial: 'DS-1', channelNo: 2 })
    expect(post.mock.calls[0][0]).toBe('/hik-connect/hls')
    expect(post.mock.calls[0][1]).toEqual({ deviceSerial: 'DS-1', channelNo: 2 })
    expect(res).toEqual({ url: 'https://x/hls.m3u8', ttlSec: 600 })
  })

  it('getHls sin canal → body sólo { deviceSerial } (no envía channelNo undefined)', async () => {
    const post = stubPost({ url: 'https://x/hls.m3u8', ttlSec: 600 })
    await hikConnectApi.getHls({ deviceSerial: 'DS-1' })
    expect(post.mock.calls[0][1]).toEqual({ deviceSerial: 'DS-1' })
    expect(post.mock.calls[0][1]).not.toHaveProperty('channelNo')
  })

  it('proxyIsapi con body → body { deviceSerial, method, isapiPath, body }', async () => {
    const post = stubPost({ result: '<xml/>' })
    await hikConnectApi.proxyIsapi({
      deviceSerial: 'DS-1', method: 'POST', isapiPath: '/ISAPI/System/deviceInfo', body: '<x/>',
    })
    expect(post.mock.calls[0][0]).toBe('/hik-connect/isapi')
    expect(post.mock.calls[0][1]).toEqual({
      deviceSerial: 'DS-1', method: 'POST', isapiPath: '/ISAPI/System/deviceInfo', body: '<x/>',
    })
  })

  it('proxyIsapi sin body → no envía body undefined', async () => {
    const post = stubPost({ result: {} })
    await hikConnectApi.proxyIsapi({ deviceSerial: 'DS-1', method: 'GET', isapiPath: '/ISAPI/System/deviceInfo' })
    expect(post.mock.calls[0][1]).toEqual({
      deviceSerial: 'DS-1', method: 'GET', isapiPath: '/ISAPI/System/deviceInfo',
    })
    expect(post.mock.calls[0][1]).not.toHaveProperty('body')
  })
})
