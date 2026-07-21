// Tests de los helpers RTSP de reproducción — la lógica más delicada del
// módulo Grabaciones (clasificación 453, cadena de variantes, credenciales).
import { describe, it, expect } from 'vitest'
import {
  maskUrlCredentials, classifyRtspError, stripNameSizeParams,
  toSubstreamTrackUrl, buildVariantUrl, buildVariantChain,
  injectCredentialsIntoPlaybackUri, rewritePlaybackUriStart,
  buildFallbackRecordingRtspUrl, normalizeTracksSlashBeforeQuery,
  buildPlaybackAttemptPlan, extractRtspPlaybackTimes, urlFingerprint,
  type PlaybackBaseStrategy,
} from './rtsp-url'

const CREDS = { username: 'admin', password: 'p@ss/w:rd', ipAddress: '192.168.1.112', rtspPort: 554 }
const START = new Date('2026-07-16T17:04:52Z')
const END   = new Date('2026-07-16T17:22:06Z')

describe('normalizeTracksSlashBeforeQuery', () => {
  it('quita el slash antes de ? en /Streaming/tracks/NNN/?', () => {
    expect(normalizeTracksSlashBeforeQuery('/Streaming/tracks/101/?starttime=x'))
      .toBe('/Streaming/tracks/101?starttime=x')
  })
  it('deja intacta una URI ya normalizada', () => {
    expect(normalizeTracksSlashBeforeQuery('/Streaming/tracks/101?starttime=x'))
      .toBe('/Streaming/tracks/101?starttime=x')
  })
})

describe('classifyRtspError — 400', () => {
  it('clasifica patrones RTSP 400 reales como RTSP_PLAYBACK_URI_REJECTED', () => {
    expect(classifyRtspError('Server returned 400 Bad Request')).toBe('RTSP_PLAYBACK_URI_REJECTED')
    expect(classifyRtspError('method DESCRIBE failed: 400')).toBe('RTSP_PLAYBACK_URI_REJECTED')
    expect(classifyRtspError('RTSP/1.0 400 Bad Request')).toBe('RTSP_PLAYBACK_URI_REJECTED')
    expect(classifyRtspError('SETUP failed: 400')).toBe('RTSP_PLAYBACK_URI_REJECTED')
  })
  it('NO clasifica un 400 no relacionado (puerto, bitrate, resolución) como rechazo de URI', () => {
    expect(classifyRtspError('Opening rtsp on port 400')).not.toBe('RTSP_PLAYBACK_URI_REJECTED')
    expect(classifyRtspError('bitrate: 400 kb/s')).not.toBe('RTSP_PLAYBACK_URI_REJECTED')
    expect(classifyRtspError('Stream #0: Video 400x300')).not.toBe('RTSP_PLAYBACK_URI_REJECTED')
    expect(classifyRtspError('frame 400 dropped')).not.toBe('RTSP_PLAYBACK_URI_REJECTED')
  })
})

describe('buildPlaybackAttemptPlan — respeta el playhead', () => {
  // Bloque 09:00–09:30, playhead solicitado 09:22.
  const BLOCK_START = '20260716T090000Z', PLAYHEAD = new Date('2026-07-16T09:22:00Z'), BLOCK_END = new Date('2026-07-16T09:30:00Z')
  const uri = `/Streaming/tracks/101/?starttime=${BLOCK_START}&endtime=20260716T093000Z&name=x&size=y`

  it('la PRIMERA estrategia preserva 09:22 (no reproduce desde 09:00)', () => {
    const plan = buildPlaybackAttemptPlan({ playbackURI: uri, channel: 1, effectiveStart: PLAYHEAD, end: BLOCK_END, creds: CREDS, mode: 'main' })
    expect(plan[0].respectsPlayhead).toBe(true)
    expect(plan[0].masked).toContain('starttime=20260716T092200Z')
    expect(plan[0].strategy).not.toBe('nvr_original')
  })

  it('nvr_original/normalized (start del bloque) van al final y quedan marcadas !respectsPlayhead', () => {
    const plan = buildPlaybackAttemptPlan({ playbackURI: uri, channel: 1, effectiveStart: PLAYHEAD, end: BLOCK_END, creds: CREDS, mode: 'main' })
    const orig = plan.find(p => p.strategy === 'nvr_original')!
    expect(orig.respectsPlayhead).toBe(false)                 // conserva 09:00
    // Todas las que respetan el playhead vienen antes que las que no
    const firstNonRespect = plan.findIndex(p => !p.respectsPlayhead)
    const lastRespect     = plan.map(p => p.respectsPlayhead).lastIndexOf(true)
    expect(firstNonRespect === -1 || firstNonRespect > lastRespect).toBe(true)
  })

  it('no promueve como preferida una estrategia que NO respeta el playhead', () => {
    const plan = buildPlaybackAttemptPlan({
      playbackURI: uri, channel: 1, effectiveStart: PLAYHEAD, end: BLOCK_END, creds: CREDS, mode: 'main',
      preferred: 'nvr_original',  // preferida pero NO respeta → no debe ir primero
    })
    expect(plan[0].strategy).not.toBe('nvr_original')
    expect(plan[0].respectsPlayhead).toBe(true)
  })
})

describe('buildPlaybackAttemptPlan — mode main/sub/auto', () => {
  it('mode=main: nunca agrega substream', () => {
    const plan = buildPlaybackAttemptPlan({ playbackURI: null, channel: 1, effectiveStart: START, end: END, creds: CREDS, mode: 'main' })
    expect(plan.some(p => p.strategy.startsWith('sub'))).toBe(false)
    expect(plan.some(p => p.strategy === 'generated_main')).toBe(true)
  })
  it('mode=sub: sólo substream, nunca main', () => {
    const plan = buildPlaybackAttemptPlan({ playbackURI: null, channel: 1, effectiveStart: START, end: END, creds: CREDS, mode: 'sub' })
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.every(p => p.strategy.startsWith('sub'))).toBe(true)
  })
  it('mode=auto: main y sub', () => {
    const plan = buildPlaybackAttemptPlan({ playbackURI: null, channel: 1, effectiveStart: START, end: END, creds: CREDS, mode: 'auto' })
    expect(plan.some(p => p.strategy === 'generated_main')).toBe(true)
    expect(plan.some(p => p.strategy.startsWith('sub'))).toBe(true)
  })
  it('mode=sub + includeSubstream=false: plan VACÍO (el handler debe dar error, no legacy)', () => {
    const plan = buildPlaybackAttemptPlan({ playbackURI: null, channel: 1, effectiveStart: START, end: END, creds: CREDS, mode: 'sub', includeSubstream: false })
    expect(plan.length).toBe(0)
  })
})

describe('buildPlaybackAttemptPlan', () => {
  it('con playbackURI: prueba original, normalizada, reescrita, sin-metadata Y generated_main', () => {
    const plan = buildPlaybackAttemptPlan({
      playbackURI: '/Streaming/tracks/101/?starttime=20260716T170000Z&endtime=20260716T172206Z&name=x&size=y',
      channel: 1, effectiveStart: START, end: END, creds: CREDS,
    })
    const strategies = plan.map(p => p.strategy)
    expect(strategies).toContain('nvr_original')
    expect(strategies).toContain('nvr_original_normalized')
    expect(strategies).toContain('nvr_rewritten')
    // La URL GENERADA (track 101, sin name/size, start=playhead) SIEMPRE se
    // intenta aunque exista playbackURI — el bug era que nunca se probaba. Puede
    // aparecer bajo el label generated_main o colapsada en nvr_rewritten_no_metadata
    // (misma URL); lo que importa es que la URL esté en el plan.
    const genMasked = buildFallbackRecordingRtspUrl({ ...CREDS, channel: 1, start: START, end: END }).masked
    expect(plan.some(p => p.masked === genMasked)).toBe(true)
    // La normalizada no debe llevar el slash antes de ?
    const norm = plan.find(p => p.strategy === 'nvr_original_normalized')!
    expect(norm.masked).toContain('/Streaming/tracks/101?')
    // Nunca credenciales en claro en el masked
    expect(plan.every(p => !p.masked.includes(CREDS.password))).toBe(true)
    expect(plan.every(p => p.masked.includes(':***@'))).toBe(true)
  })

  it('sin playbackURI: sólo generated_main (+ sub si aplica)', () => {
    const plan = buildPlaybackAttemptPlan({ playbackURI: null, channel: 3, effectiveStart: START, end: END, creds: CREDS })
    expect(plan.some(p => p.strategy === 'generated_main')).toBe(true)
    const gen = plan.find(p => p.strategy === 'generated_main')!
    expect(gen.track).toBe(301)  // channel 3 → 3*100+1
  })

  it('omite el substream cuando includeSubstream=false (NVR sin soporte de playback sub)', () => {
    const withSub = buildPlaybackAttemptPlan({ playbackURI: null, channel: 1, effectiveStart: START, end: END, creds: CREDS })
    const noSub   = buildPlaybackAttemptPlan({ playbackURI: null, channel: 1, effectiveStart: START, end: END, creds: CREDS, includeSubstream: false })
    expect(withSub.some(p => p.strategy.startsWith('sub'))).toBe(true)
    expect(noSub.some(p => p.strategy.startsWith('sub'))).toBe(false)
  })

  it('la estrategia preferida va primero', () => {
    const plan = buildPlaybackAttemptPlan({
      playbackURI: '/Streaming/tracks/101?starttime=20260716T170452Z&endtime=20260716T172206Z',
      channel: 1, effectiveStart: START, end: END, creds: CREDS, preferred: 'generated_main',
    })
    expect(plan[0].strategy).toBe('generated_main')
  })

  it('deduplica estrategias que producen la misma URL', () => {
    // Sin name/size y con start ya == effectiveStart, original/normalized/rewritten colapsan
    const plan = buildPlaybackAttemptPlan({
      playbackURI: '/Streaming/tracks/101?starttime=20260716T170452Z&endtime=20260716T172206Z',
      channel: 1, effectiveStart: START, end: END, creds: CREDS, includeSubstream: false,
    })
    const urls = plan.map(p => p.url)
    expect(new Set(urls).size).toBe(urls.length)  // sin duplicados
  })
})

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

describe('extractRtspPlaybackTimes', () => {
  it('extrae starttime/endtime de una URL RTSP de playback', () => {
    const uri = 'rtsp://admin:***@10.0.0.1:554/Streaming/tracks/101?starttime=20260721T110600Z&endtime=20260721T112200Z'
    expect(extractRtspPlaybackTimes(uri)).toEqual({ starttime: '20260721T110600Z', endtime: '20260721T112200Z' })
  })
  it('funciona sobre un pathQuery suelto', () => {
    expect(extractRtspPlaybackTimes('/Streaming/tracks/101?starttime=20260721T110600Z'))
      .toEqual({ starttime: '20260721T110600Z', endtime: null })
  })
  it('devuelve null cuando no hay tiempos', () => {
    expect(extractRtspPlaybackTimes('rtsp://host/live/101')).toEqual({ starttime: null, endtime: null })
  })
  it('normaliza a mayúsculas la Z', () => {
    expect(extractRtspPlaybackTimes('/x?starttime=20260721t110600z').starttime).toBe('20260721T110600Z')
  })
})

describe('urlFingerprint', () => {
  it('es estable para la misma entrada', () => {
    const a = urlFingerprint('/Streaming/tracks/101?starttime=20260721T110600Z')
    const b = urlFingerprint('/Streaming/tracks/101?starttime=20260721T110600Z')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })
  it('difiere para entradas distintas', () => {
    expect(urlFingerprint('/Streaming/tracks/101?starttime=A'))
      .not.toBe(urlFingerprint('/Streaming/tracks/102?starttime=A'))
  })
  it('NO depende de las credenciales (mismo fingerprint con o sin userinfo)', () => {
    const withCreds = urlFingerprint('rtsp://admin:secret@10.0.0.1:554/Streaming/tracks/101?starttime=A')
    const withMask  = urlFingerprint('rtsp://admin:***@10.0.0.1:554/Streaming/tracks/101?starttime=A')
    const noCreds   = urlFingerprint('rtsp://10.0.0.1:554/Streaming/tracks/101?starttime=A')
    expect(withCreds).toBe(noCreds)
    expect(withMask).toBe(noCreds)
  })
})

describe('buildPlaybackAttemptPlan — dedupSink', () => {
  it('reporta estrategias descartadas por dedup (misma URL final) sin credenciales', () => {
    // Cuando el NVR incrusta el MISMO start que el playhead, la reescritura no
    // cambia nada y generated_main puede colapsar en una nvr_rewritten: esa
    // estrategia deduplicada debe reportarse, no desaparecer en silencio.
    const start = new Date('2026-07-21T11:06:00Z')
    const end   = new Date('2026-07-21T11:22:00Z')
    const playbackURI = `/Streaming/tracks/101?starttime=20260721T110600Z&endtime=20260721T112200Z`
    const dedupSink: Array<{ strategy: PlaybackBaseStrategy; duplicateOf: PlaybackBaseStrategy; urlFingerprint: string }> = []
    const plan = buildPlaybackAttemptPlan({
      playbackURI, channel: 1, effectiveStart: start, end, creds: CREDS, mode: 'main', dedupSink,
    })
    // Debe haber al menos una entrada de dedup y ninguna debe filtrar credenciales.
    expect(dedupSink.length).toBeGreaterThan(0)
    for (const d of dedupSink) {
      expect(d.urlFingerprint).toMatch(/^[0-9a-f]{8}$/)
      expect(d.strategy).not.toBe(d.duplicateOf)
    }
    // El plan resultante no contiene URLs duplicadas.
    const urls = plan.map(p => p.masked)
    expect(new Set(urls).size).toBe(urls.length)
  })
})
