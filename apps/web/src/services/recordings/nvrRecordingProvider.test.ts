import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios'
import { api } from '@/lib/api'
import { nvrRecordingProvider as provider, type PreviewRequest } from './nvrRecordingProvider'

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn() } }))

// Keep the real cookie-authenticated VisionCore client. Intercept only its
// network adapter so these tests cannot contact a server or an NVR.
const originalAdapter = api.defaults.adapter
const requests: InternalAxiosRequestConfig[] = []
let reply: unknown
let rejectStatus: number | undefined
beforeEach(() => {
  requests.length = 0
  reply = {}
  rejectStatus = undefined
  api.defaults.adapter = async config => {
    requests.push(config)
    const response = {
      config, status: rejectStatus ?? 200, statusText: 'test', data: reply,
      headers: new AxiosHeaders({ 'retry-after': '2' }),
    }
    if (rejectStatus) throw new AxiosError('Test response', 'ERR_BAD_RESPONSE', config, undefined, response)
    return response
  }
})
afterEach(() => { api.defaults.adapter = originalAdapter })

const window = {
  cameraId: 'camera-a', startTime: '2026-09-18T11:36:00.000Z', endTime: '2026-09-18T12:36:00.000Z',
}
const preview: PreviewRequest = {
  ...window, slotIndex: 2, playbackURI: 'rtsp://nvr.example.test/recorded-track',
  canPlayHevcMp4: false, forceTranscode: true,
  continuityOfSessionId: '0000000000000001',
  browserLocal: '2026-09-18T08:36:00', browserTimezoneOffset: 180,
}

describe('NVR recording provider contract', () => {
  it('keeps NVR wall-clock intervals, gaps and playback identifiers intact', async () => {
    reply = { recordings: [
      { id: 'r1', ...window, endTime: '2026-09-18T11:40:00.000Z', playbackURI: preview.playbackURI },
      { id: 'r2', ...window, startTime: '2026-09-18T11:45:00.000Z', playbackURI: preview.playbackURI },
    ] }
    expect(provider.archiveSource).toBe('nvr')
    expect(await provider.search(window)).toEqual(reply)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: '/recordings/search', method: 'get', baseURL: '/api', withCredentials: true, params: window,
    })
  })

  it('returns queue admission without attaching media, polling or releasing the predecessor', async () => {
    reply = { sessionId: '0000000000000002', status: 'queued', queueClass: 'continuity',
      queuePosition: 1, capacity: { activeCount: 1, effectiveLimit: 1 } }
    expect(await provider.startPreview(preview)).toEqual(reply)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ url: '/recordings/preview/start', method: 'post', withCredentials: true })
    expect(JSON.parse(requests[0].data)).toEqual(preview)
    expect(requests.some(r => /^(?:rtsp|https?):/.test(r.url ?? ''))).toBe(false)
  })

  it('does not turn a ready URL or server first byte into client playback', async () => {
    reply = { status: 'ready', streamUrl: '/api/recordings/preview/0000000000000002/stream?token=test' }
    const ready = await provider.previewStatus('0000000000000002')
    expect(ready).toEqual(reply)
    reply = { status: 'active', hadFirstByte: true, videoOnly: true }
    const active = await provider.previewStatus('0000000000000002')
    expect(active).toEqual(reply)
    expect(active).not.toHaveProperty('playing')
    expect(requests).toHaveLength(2) // Neither call fetches the returned media URL.
  })

  it.each([403, 404, 410, 429, 503])('preserves HTTP %i and Retry-After for the controller, without a new session', async status => {
    rejectStatus = status
    reply = { message: 'Denied or unavailable' }
    await expect(provider.previewStatus('0000000000000002')).rejects.toMatchObject({
      response: { status, data: reply, headers: { 'retry-after': '2' } },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('get')
  })

  it('keeps exports separate from preview and uses the API for closure', async () => {
    const playback = { ...window, playbackURI: preview.playbackURI, canPlayHevcMp4: false, forceTranscode: false }
    reply = { sessionId: '0000000000000003', status: 'starting', expectedDurationSec: 60 }
    expect(await provider.startPlayback(playback)).toEqual(reply)
    expect(JSON.parse(requests[0].data)).toEqual(playback)
    reply = { status: 'ready', downloadUrl: '/api/recordings/playback/0000000000000003/download' }
    expect(await provider.playbackStatus('0000000000000003')).toEqual(reply)
    await provider.close({ type: 'mp4', id: '0000000000000003' })
    await provider.close({ type: 'preview', id: '0000000000000002' })
    expect(requests.map(r => [r.method, r.url])).toEqual([
      ['post', '/recordings/playback'],
      ['get', '/recordings/playback/0000000000000003/status'],
      ['delete', '/recordings/playback/0000000000000003'],
      ['delete', '/recordings/preview/0000000000000002'],
    ])
    expect(requests.every(r => r.withCredentials && r.baseURL === '/api')).toBe(true)
  })

  it('never reports a rejected close as successful', async () => {
    rejectStatus = 503
    await expect(provider.close({ type: 'preview', id: '0000000000000002' }))
      .rejects.toMatchObject({ response: { status: 503 } })
    expect(requests).toHaveLength(1)
  })

  it('keeps reserved characters inside an API resource segment', async () => {
    await provider.checkCapabilities('nvr/a?b#c')
    await provider.previewStatus('session/a?b#c')
    expect(requests.map(r => r.url)).toEqual([
      '/nvrs/nvr%2Fa%3Fb%23c/recording-capabilities/check',
      '/recordings/preview/session%2Fa%3Fb%23c/status',
    ])
  })

  it.each(['', '.', '..'])('rejects an empty or dot resource "%s" before network I/O', async id => {
    await expect(provider.checkCapabilities(id)).rejects.toThrow('Identificador')
    await expect(provider.playbackStatus(id)).rejects.toThrow('Identificador')
    await expect(provider.close({ type: 'preview', id })).rejects.toThrow('Identificador')
    expect(requests).toHaveLength(0)
  })
})
