// Tests de los helpers RTSP de reproducción — la lógica más delicada del
// módulo Grabaciones (clasificación 453, cadena de variantes, credenciales).
import { describe, it, expect } from 'vitest'
import {
  maskUrlCredentials, classifyRtspError, stripNameSizeParams,
  toSubstreamTrackUrl, buildVariantUrl, buildVariantChain,
  injectCredentialsIntoPlaybackUri, rewritePlaybackUriStart,
  buildFallbackRecordingRtspUrl,
} from './rtsp-url'

describe('maskUrlCredentials', () => {
  it('enmascara contraseñas en URLs rtsp y http', () => {
    expect(maskUrlCredentials('open rtsp://admin:S3cret!@10.0.0.5:554/x failed'))
      .toBe('open rtsp://admin:***@10.0.0.5:554/x failed')
    expect(maskUrlCredentials('GET https://user:pw@host/api'))
      .toBe('GET https://user:***@host/api')
  })
  it('no toca URLs sin credenciales', () => {
    expect(maskUrlCredentials('rtsp://10.0.0.5:554/Streaming/tracks/101'))
      .toBe('rtsp://10.0.0.5:554/Streaming/tracks/101')
  })
})

describe('classifyRtspError', () => {
  it('453 gana aunque el stderr también contenga 4XX/DESCRIBE (regresión real)', () => {
    const stderr = 'method DESCRIBE failed: 453 Not Enough Bandwidth\nServer returned 4XX Client Error'
    expect(classifyRtspError(stderr)).toBe('NVR_BANDWIDTH_OR_SESSION_LIMIT')
  })
  it('clasifica auth, not-found, offline, codec y open', () => {
    expect(classifyRtspError('401 Unauthorized')).toBe('RTSP_AUTH_OR_TRACK_DENIED')
    expect(classifyRtspError('404 Not Found')).toBe('RTSP_TRACK_NOT_FOUND')
    expect(classifyRtspError('Connection refused')).toBe('NVR_OFFLINE_OR_TIMEOUT')
    expect(classifyRtspError('Connection timed out')).toBe('NVR_OFFLINE_OR_TIMEOUT')
    expect(classifyRtspError('Invalid data found when processing input')).toBe('CODEC_UNSUPPORTED')
    expect(classifyRtspError('Error opening input file')).toBe('RTSP_OPEN_FAILED')
    expect(classifyRtspError('algo inesperado')).toBe('UNKNOWN')
  })
})

const BASE = 'rtsp://u:p@10.0.0.5:554/Streaming/tracks/301?starttime=20260709T140000Z&endtime=20260709T150000Z&name=ch03_x&size=12345'

describe('variantes de URL', () => {
  it('stripNameSizeParams elimina name y size', () => {
    const out = stripNameSizeParams(BASE)
    expect(out).not.toMatch(/[?&](name|size)=/)
    expect(out).toContain('starttime=20260709T140000Z')
  })
  it('toSubstreamTrackUrl transforma 301→302 y rechaza tracks no-main', () => {
    expect(toSubstreamTrackUrl(BASE)).toContain('/Streaming/tracks/302')
    expect(toSubstreamTrackUrl(BASE.replace('/tracks/301', '/tracks/302'))).toBeNull()
    expect(toSubstreamTrackUrl('rtsp://x/algo')).toBeNull()
  })
  it('buildVariantUrl colapsa *_no_name_size cuando no hay name/size', () => {
    const noParams = 'rtsp://u:p@h/Streaming/tracks/101?starttime=20260101T000000Z'
    expect(buildVariantUrl(noParams, 'main_no_name_size')).toBeNull()
    expect(buildVariantUrl(noParams, 'main_full')).toBe(noParams)
  })
})

describe('buildVariantChain', () => {
  it('modo auto produce las 4 variantes deduplicadas', () => {
    const chain = buildVariantChain(BASE, { mode: 'auto' })
    expect(chain.map(c => c.variant)).toEqual([
      'main_full', 'main_no_name_size', 'sub_full', 'sub_no_name_size',
    ])
    expect(new Set(chain.map(c => c.url)).size).toBe(chain.length)
  })
  it('la variante preferida va primero', () => {
    const chain = buildVariantChain(BASE, { mode: 'auto', preferred: 'sub_full' })
    expect(chain[0].variant).toBe('sub_full')
  })
  it('modo sub solo genera variantes de substream', () => {
    const chain = buildVariantChain(BASE, { mode: 'sub' })
    expect(chain.every(c => c.variant.startsWith('sub'))).toBe(true)
  })
  it('URL sin name/size colapsa a 2 variantes en modo auto', () => {
    const noParams = 'rtsp://u:p@h/Streaming/tracks/101?starttime=20260101T000000Z&endtime=20260101T010000Z'
    const chain = buildVariantChain(noParams, { mode: 'auto' })
    expect(chain.map(c => c.variant)).toEqual(['main_full', 'sub_full'])
  })
})

describe('injectCredentialsIntoPlaybackUri', () => {
  it('inyecta credenciales codificadas y produce versión enmascarada', () => {
    const { url, masked } = injectCredentialsIntoPlaybackUri({
      playbackURI: '/Streaming/tracks/101?starttime=20260709T140000Z',
      username: 'admin', password: 'p@ss/word', ipAddress: '10.0.0.5', rtspPort: 554,
    })
    expect(url).toContain(`admin:${encodeURIComponent('p@ss/word')}@10.0.0.5:554`)
    expect(masked).toContain('admin:***@')
    expect(masked).not.toContain('p@ss')
  })
})

describe('rewritePlaybackUriStart', () => {
  const URI = '/Streaming/tracks/101?starttime=20260709T140000Z&endtime=20260709T150000Z'
  it('reescribe el starttime al playhead solicitado', () => {
    const r = rewritePlaybackUriStart(URI, new Date('2026-07-09T14:23:45Z'))
    expect(r.rewritten).toBe(true)
    expect(r.originalStart).toBe('20260709T140000Z')
    expect(r.uri).toContain('starttime=20260709T142345Z')
    expect(r.uri).toContain('endtime=20260709T150000Z')
  })
  it('no reescribe si el timestamp coincide o no hay starttime', () => {
    expect(rewritePlaybackUriStart(URI, new Date('2026-07-09T14:00:00Z')).rewritten).toBe(false)
    expect(rewritePlaybackUriStart('/x/y', new Date()).rewritten).toBe(false)
  })
})

describe('buildFallbackRecordingRtspUrl', () => {
  it('construye track main (canal*100+1) con rango y máscara', () => {
    const r = buildFallbackRecordingRtspUrl({
      username: 'admin', password: 'pw', ipAddress: '10.0.0.5', rtspPort: 554,
      channel: 3,
      start: new Date('2026-07-09T14:00:00Z'), end: new Date('2026-07-09T15:00:00Z'),
    })
    expect(r.trackId).toBe(301)
    expect(r.url).toContain('/Streaming/tracks/301?starttime=20260709T140000Z&endtime=20260709T150000Z')
    expect(r.masked).toContain(':***@')
  })
})
