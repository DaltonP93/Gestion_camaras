// Audio de un StreamingChannel Hikvision: se lee y se escribe SÓLO dentro de <Audio>.
//
// El XML de /ISAPI/Streaming/channels/<NN><01|02> tiene VARIOS <enabled>: el del
// CANAL (el primero, antes de <Transport>), los de Unicast/Multicast/Security, el
// de <Video> (y SVC) y recién al final el de <Audio>. El código anterior aplicaba
// audioEnabled sobre el PRIMER <enabled> ⇒ apagar el audio deshabilitaba el canal,
// y leía audioEnabled del primer <enabled> ⇒ informaba el estado del canal.
//
// Se ejercita el código real (makeClient → GET → reemplazo → PUT → re-lectura)
// contra un NVR simulado EN MEMORIA: axios.create está mockeado y guarda/devuelve
// el XML por endpoint. No hay red. El guard SSRF se reemplaza por un passthrough
// (se prueba aparte en net/nvr-host-guard.test.ts) porque la IP es TEST-NET.
//
// MUTACIÓN: volver a `replaceXmlTag(xml, 'enabled', …)` o a `xmlGet(xml, 'enabled')`
// hace fallar (a), (b), (c) y la lectura; quitar el chequeo de bloque hace fallar (e);
// quitar el chequeo de tag repetido (`count > 1`) o los de tipo/valor de audio hace
// fallar las pruebas de rechazo correspondientes.
// IPs/credenciales 100% ficticias.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const nvr = vi.hoisted(() => ({
  store: new Map<string, string>(),
  calls: [] as Array<{ method: 'GET' | 'PUT'; url: string; body?: string }>,
}))

vi.mock('axios', () => {
  const create = () => ({
    interceptors: { response: { use: () => 0 } },
    get: async (url: string) => {
      nvr.calls.push({ method: 'GET', url })
      const xml = nvr.store.get(url)
      if (xml === undefined) {
        const err: any = new Error('Request failed with status code 404')
        err.response = { status: 404, headers: {} }
        throw err
      }
      return { status: 200, statusText: 'OK', data: xml }
    },
    // NVR "fiel": guarda tal cual lo que recibe y lo devuelve en el próximo GET.
    put: async (url: string, body: string) => {
      nvr.calls.push({ method: 'PUT', url, body })
      nvr.store.set(url, body)
      return { status: 200, statusText: 'OK', data: '<ResponseStatus><statusCode>1</statusCode></ResponseStatus>' }
    },
  })
  return { default: { create }, create }
})

vi.mock('../net/nvr-host-guard', () => ({
  assertSafeNvrHostForUrl: (h: string) => h,
}))

import { getChannelVideoConfig, putChannelVideoConfig, AUDIO_UPDATE_REJECTED } from './hikvision'

const CREDS = { ipAddress: '192.0.2.10', port: 80, username: 'usuario-prueba', password: 'clave-ficticia' }
// El adaptador arma el id como <canal con 2 dígitos><01|02> (canal 1 ⇒ 0101/0102).
const MAIN = '/ISAPI/Streaming/channels/0101'
const SUB  = '/ISAPI/Streaming/channels/0102'

interface Fx {
  audioEnabled?: string
  codec?:        string
  bitrate?:      string | null   // null ⇒ sin <audioBitRate> (típico de G.711)
  videoCodec?:   string
  maxFrameRate?: string
  cbr?:          string
  withAudio?:    boolean
  eol?:          string
}

// StreamingChannel realista (NVR Hikvision, ISAPI 2.0). Sólo varían los valores
// parametrizados; el resto del texto es idéntico entre llamadas, así que comparar
// contra `streamingChannel({...cambio})` prueba que NO cambió ningún otro byte.
function streamingChannel(o: Fx = {}): string {
  const f = { audioEnabled: 'true', codec: 'G.711ulaw', bitrate: null, videoCodec: 'H.264', maxFrameRate: '2500', cbr: '4096', withAudio: true, eol: '\n', ...o }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<StreamingChannel version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">',
    '<id>101</id>',
    '<channelName>Camara Prueba 01</channelName>',
    '<enabled>true</enabled>',
    '<Transport>',
    '<maxPacketSize>1000</maxPacketSize>',
    '<audioPacketLength>0</audioPacketLength>',
    '<audioInboundPacketLength>0</audioInboundPacketLength>',
    '<ControlProtocolList>',
    '<ControlProtocol>',
    '<streamingTransport>RTSP</streamingTransport>',
    '</ControlProtocol>',
    '</ControlProtocolList>',
    '<Unicast>',
    '<enabled>true</enabled>',
    '<rtpTransportType>RTP/TCP</rtpTransportType>',
    '</Unicast>',
    '<Multicast>',
    '<enabled>true</enabled>',
    '<destIPAddress>0.0.0.0</destIPAddress>',
    '<videoDestPortNo>8860</videoDestPortNo>',
    '<audioDestPortNo>8862</audioDestPortNo>',
    '</Multicast>',
    '<Security>',
    '<enabled>true</enabled>',
    '<certificateType>digest</certificateType>',
    '</Security>',
    '</Transport>',
    '<Video>',
    '<enabled>true</enabled>',
    '<videoInputChannelID>1</videoInputChannelID>',
    `<videoCodecType>${f.videoCodec}</videoCodecType>`,
    '<videoScanType>progressive</videoScanType>',
    '<videoResolutionWidth>1920</videoResolutionWidth>',
    '<videoResolutionHeight>1080</videoResolutionHeight>',
    '<videoQualityControlType>CBR</videoQualityControlType>',
    `<constantBitRate>${f.cbr}</constantBitRate>`,
    '<fixedQuality>60</fixedQuality>',
    `<maxFrameRate>${f.maxFrameRate}</maxFrameRate>`,
    '<keyFrameInterval>4000</keyFrameInterval>',
    '<GovLength>100</GovLength>',
    '<SVC>',
    '<enabled>false</enabled>',
    '</SVC>',
    '</Video>',
    ...(f.withAudio ? [
      '<Audio>',
      `<enabled>${f.audioEnabled}</enabled>`,
      '<audioInputChannelID>1</audioInputChannelID>',
      `<audioCompressionType>${f.codec}</audioCompressionType>`,
      ...(f.bitrate === null ? [] : [`<audioBitRate>${f.bitrate}</audioBitRate>`]),
      '</Audio>',
    ] : []),
    '</StreamingChannel>',
  ]
  return lines.join(f.eol) + f.eol
}

// Extrae el <enabled> de cada nivel SIN usar el código bajo prueba.
function between(xml: string, open: string, close: string): string {
  const a = xml.indexOf(open)
  const b = xml.indexOf(close, a)
  if (a < 0 || b < 0) throw new Error(`no hay ${open}`)
  return xml.slice(a, b + close.length)
}
const enabledOf = (fragment: string) => /<enabled>([^<]*)<\/enabled>/.exec(fragment)?.[1]
const levels = (xml: string) => ({
  channel:   enabledOf(xml.slice(0, xml.indexOf('<Transport>'))),
  unicast:   enabledOf(between(xml, '<Unicast>', '</Unicast>')),
  multicast: enabledOf(between(xml, '<Multicast>', '</Multicast>')),
  security:  enabledOf(between(xml, '<Security>', '</Security>')),
  video:     enabledOf(between(xml, '<Video>', '<SVC>')),
  svc:       enabledOf(between(xml, '<SVC>', '</SVC>')),
  audio:     xml.includes('<Audio>') ? enabledOf(between(xml, '<Audio>', '</Audio>')) : undefined,
})

/** Primer y último índice donde difieren dos strings (ventana del cambio). */
function diffWindow(a: string, b: string) {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  return { start: s, before: a.slice(s, ea), after: b.slice(s, eb) }
}

const puts = () => nvr.calls.filter((c) => c.method === 'PUT')

beforeEach(() => {
  nvr.store.clear()
  nvr.calls.length = 0
})

describe('putChannelVideoConfig — audio sólo dentro de <Audio>', () => {
  it('(a) apagar audio: el XML del PUT difiere del original SÓLO en el <enabled> de <Audio>', async () => {
    const original = streamingChannel()
    nvr.store.set(MAIN, original)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })

    expect(r.success).toBe(true)
    expect(puts()).toHaveLength(1)
    const sent = puts()[0].body!
    // Idéntico byte a byte al original salvo ese valor.
    expect(sent).toBe(streamingChannel({ audioEnabled: 'false' }))
    // Y la ventana de diferencia cae dentro de <Audio><enabled>…</enabled>.
    const d = diffWindow(original, sent)
    expect(d).toMatchObject({ before: 'tru', after: 'fals' })
    expect(d.start).toBeGreaterThan(original.indexOf('<Audio>'))
    expect(original.slice(original.indexOf('<Audio>'), d.start)).toBe('<Audio>\n<enabled>')
  })

  it('(b) tras apagar el audio, el <enabled> del canal, Transport y Video siguen en true', async () => {
    nvr.store.set(MAIN, streamingChannel())

    await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })

    expect(levels(puts()[0].body!)).toEqual({
      channel: 'true', unicast: 'true', multicast: 'true', security: 'true',
      video: 'true', svc: 'false', audio: 'false',
    })
  })

  it('(c) ida y vuelta GET→PUT→GET: canal habilitado y audio apagado', async () => {
    nvr.store.set(MAIN, streamingChannel())
    nvr.store.set(SUB,  streamingChannel())

    const before = await getChannelVideoConfig('nvr-1', CREDS, 1)
    expect(before.main?.audioEnabled).toBe(true)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })
    expect(r.success).toBe(true)
    // Lo que quedó guardado en el NVR: canal y video habilitados, audio apagado.
    // (El código anterior también "leía" audioEnabled=false… porque leía el canal
    // que acababa de apagar: por eso se verifica el XML guardado, no sólo la lectura.)
    expect(levels(nvr.store.get(MAIN)!)).toMatchObject({ channel: 'true', video: 'true', audio: 'false' })
    // La config devuelta es la RE-LECTURA del NVR simulado (GET posterior al PUT).
    expect(r.config?.main?.audioEnabled).toBe(false)
    expect(r.config?.sub?.audioEnabled).toBe(true)   // el sub-stream no se tocó
    expect(nvr.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${MAIN}`, `GET ${SUB}`,          // lectura inicial
      `GET ${MAIN}`, `PUT ${MAIN}`,         // escritura
      `GET ${MAIN}`, `GET ${SUB}`,          // re-lectura
    ])

    const after = await getChannelVideoConfig('nvr-1', CREDS, 1)
    expect(after.main?.audioEnabled).toBe(false)
    expect(after.main?.audioBlockPresent).toBe(true)
    // El video sigue igual tras la vuelta completa.
    expect(after.main).toMatchObject({ videoCodecType: 'H.264', width: 1920, height: 1080, fps: 25, bitrateMax: 4096 })
  })

  it('(d) prender audio, cambiar codec y bitrate también tocan sólo <Audio>', async () => {
    const original = streamingChannel({ audioEnabled: 'false', codec: 'MP2L2', bitrate: '64' })
    nvr.store.set(MAIN, original)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', {
      audioEnabled: true, audioCodecType: 'AAC', audioBitrate: 128,
    })

    expect(r.success).toBe(true)
    const sent = puts()[0].body!
    expect(sent).toBe(streamingChannel({ audioEnabled: 'true', codec: 'AAC', bitrate: '128' }))
    // Todo lo previo a <Audio> y lo posterior a </Audio> es idéntico.
    expect(sent.slice(0, sent.indexOf('<Audio>'))).toBe(original.slice(0, original.indexOf('<Audio>')))
    expect(sent.slice(sent.indexOf('</Audio>'))).toBe(original.slice(original.indexOf('</Audio>')))
    expect(levels(sent)).toMatchObject({ channel: 'true', video: 'true', audio: 'true' })
    expect(r.config?.main).toMatchObject({ audioEnabled: true, audioCodecType: 'AAC', audioBitrate: 128 })
  })

  it('(d) codec con </Audio> se escapa: no puede salirse del bloque', async () => {
    const original = streamingChannel()
    nvr.store.set(MAIN, original)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', {
      audioCodecType: 'X</audioCompressionType></Audio><enabled>false</enabled><Audio><audioCompressionType>',
    })

    expect(r.success).toBe(true)
    const sent = puts()[0].body!
    expect(sent.slice(0, sent.indexOf('<Audio>'))).toBe(original.slice(0, original.indexOf('<Audio>')))
    expect(sent.match(/<Audio>/g)).toHaveLength(1)
    expect(sent).toContain('<audioCompressionType>X&lt;/audioCompressionType&gt;&lt;/Audio&gt;')
    expect(levels(sent).channel).toBe('true')
  })

  it('respeta atributos, CRLF y espacios alrededor del valor dentro de <Audio>', async () => {
    const original = streamingChannel({ eol: '\r\n' })
      .replace('<Audio>', '<Audio version="2.0">')
      .replace('<enabled>true</enabled>\r\n<audioInputChannelID>', '<enabled opt="true,false">\r\n  true\r\n</enabled>\r\n<audioInputChannelID>')
    nvr.store.set(MAIN, original)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })

    expect(r.success).toBe(true)
    const sent = puts()[0].body!
    expect(sent).toBe(original.replace('<enabled opt="true,false">\r\n  true\r\n</enabled>', '<enabled opt="true,false">\r\n  false\r\n</enabled>'))
    expect(r.config?.main?.audioEnabled).toBe(false)
  })

  it('tolera un prefijo de namespace (<hik:Audio>/<hik:enabled>) sin tocar el <hik:enabled> del canal', async () => {
    const original = streamingChannel()
      .replace(/<(\/?)(enabled|Audio|audioCompressionType)>/g, '<$1hik:$2>')
    nvr.store.set(MAIN, original)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })

    expect(r.success).toBe(true)
    const d = diffWindow(original, puts()[0].body!)
    expect(d).toMatchObject({ before: 'tru', after: 'fals' })
    expect(d.start).toBeGreaterThan(original.indexOf('<hik:Audio>'))
  })
})

describe('putChannelVideoConfig — sin un bloque <Audio> utilizable ⇒ error y NINGÚN PUT', () => {
  it('(e) sin <Audio>: success=false, código de rechazo y no se envía PUT', async () => {
    nvr.store.set(MAIN, streamingChannel({ withAudio: false }))

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })

    expect(r.success).toBe(false)
    expect(r.code).toBe(AUDIO_UPDATE_REJECTED)
    expect(r.error).toMatch(/<Audio>/)
    expect(puts()).toHaveLength(0)
    expect(levels(nvr.store.get(MAIN)!).channel).toBe('true')
  })

  it('(e) un cambio de video + audio sin <Audio> tampoco se aplica a medias', async () => {
    nvr.store.set(MAIN, streamingChannel({ withAudio: false }))

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { fps: 15, audioEnabled: true })

    expect(r.success).toBe(false)
    expect(puts()).toHaveLength(0)
  })

  it('(e) más de un bloque <Audio> ⇒ error y sin PUT', async () => {
    const xml = streamingChannel().replace('</StreamingChannel>', '<Audio>\n<enabled>true</enabled>\n</Audio>\n</StreamingChannel>')
    nvr.store.set(MAIN, xml)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })

    expect(r).toMatchObject({ success: false, code: AUDIO_UPDATE_REJECTED })
    expect(r.error).toMatch(/más de un bloque <Audio>/)
    expect(puts()).toHaveLength(0)
  })

  it('(e) falta el tag dentro de <Audio> (bitrate en G.711) ⇒ error y sin PUT; aunque exista fuera', async () => {
    // <audioBitRate> FUERA de <Audio> no debe usarse como destino.
    const xml = streamingChannel({ bitrate: null }).replace('<GovLength>100</GovLength>', '<GovLength>100</GovLength>\n<audioBitRate>32</audioBitRate>')
    nvr.store.set(MAIN, xml)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioBitrate: 128 })

    expect(r).toMatchObject({ success: false, code: AUDIO_UPDATE_REJECTED })
    expect(r.error).toMatch(/no tiene <audioBitRate>/)
    expect(puts()).toHaveLength(0)
  })

  it('(e) <Audio/> autocerrado o <enabled/> autocerrado ⇒ error y sin PUT', async () => {
    nvr.store.set(MAIN, streamingChannel({ withAudio: false }).replace('</StreamingChannel>', '<Audio/>\n</StreamingChannel>'))
    expect((await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })).success).toBe(false)

    nvr.store.set(MAIN, streamingChannel().replace('<Audio>\n<enabled>true</enabled>', '<Audio>\n<enabled/>'))
    expect((await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })).success).toBe(false)

    expect(puts()).toHaveLength(0)
  })

  it('audioEnabled no booleano ("false" es truthy) ⇒ rechazo antes de tocar el NVR', async () => {
    nvr.store.set(MAIN, streamingChannel())

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: 'false' as unknown as boolean })

    expect(r).toMatchObject({ success: false, code: AUDIO_UPDATE_REJECTED })
    expect(nvr.calls).toHaveLength(0)
  })

  it('(e) un tag repetido dentro de <Audio> (p.ej. un <enabled> anidado) ⇒ error y sin PUT', async () => {
    // No se adivina cuál de los dos es "el" del audio: se rechaza.
    const xml = streamingChannel().replace(
      '<audioInputChannelID>1</audioInputChannelID>',
      '<audioInputChannelID>1</audioInputChannelID>\n<AudioExt>\n<enabled>true</enabled>\n</AudioExt>',
    )
    nvr.store.set(MAIN, xml)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { audioEnabled: false })

    expect(r).toMatchObject({ success: false, code: AUDIO_UPDATE_REJECTED })
    expect(r.error).toMatch(/más de un <enabled>/)
    expect(puts()).toHaveLength(0)
    expect(nvr.store.get(MAIN)).toBe(xml)
  })

  it('payload de NVRDetailPage (audio oculto: false, codec "", bitrate 64) en canal AAC con <audioBitRate> ⇒ rechazo sin tocar el NVR', async () => {
    // La UI arma SIEMPRE estos tres campos aunque el usuario sólo edite video.
    // Antes se aceptaba: apagaba el audio y dejaba <audioCompressionType></audioCompressionType>.
    const original = streamingChannel({ codec: 'AAC', bitrate: '64' })
    nvr.store.set(MAIN, original)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', {
      videoCodecType: 'H.264', width: 1920, height: 1080, fps: 15, bitrateMax: 4096, bitrateType: 'CBR',
      audioEnabled: false, audioCodecType: '', audioBitrate: 64,
    })

    expect(r).toMatchObject({ success: false, code: AUDIO_UPDATE_REJECTED })
    expect(r.error).toMatch(/audioCodecType/)
    expect(nvr.calls).toHaveLength(0)
    expect(nvr.store.get(MAIN)).toBe(original)
  })

  it.each([
    ['audioCodecType vacío',         { audioCodecType: '' }],
    ['audioCodecType sólo espacios', { audioCodecType: '   ' }],
    ['audioCodecType no texto',      { audioCodecType: 123 }],
    ['audioBitrate string',          { audioBitrate: '64' }],
    ['audioBitrate negativo',        { audioBitrate: -5 }],
    ['audioBitrate decimal',         { audioBitrate: 64.5 }],
    ['audioBitrate cero',            { audioBitrate: 0 }],
    ['audioBitrate NaN',             { audioBitrate: Number.NaN }],
  ])('%s ⇒ rechazo antes de tocar el NVR', async (_caso, update) => {
    nvr.store.set(MAIN, streamingChannel({ codec: 'AAC', bitrate: '64' }))

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', update as never)

    expect(r).toMatchObject({ success: false, code: AUDIO_UPDATE_REJECTED })
    expect(nvr.calls).toHaveLength(0)
  })
})

describe('putChannelVideoConfig — (f) los cambios de video no se ven afectados', () => {
  it('codec/fps/bitrate de video se aplican igual y <Audio> queda intacto', async () => {
    const original = streamingChannel()
    nvr.store.set(MAIN, original)

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { videoCodecType: 'H.265', fps: 15, bitrateMax: 2048 })

    expect(r.success).toBe(true)
    const sent = puts()[0].body!
    expect(sent).toBe(streamingChannel({ videoCodec: 'H.265', maxFrameRate: '1500', cbr: '2048' }))
    expect(between(sent, '<Audio>', '</Audio>')).toBe(between(original, '<Audio>', '</Audio>'))
    expect(levels(sent)).toMatchObject({ channel: 'true', video: 'true', audio: 'true' })
  })

  it('un canal SIN <Audio> sigue aceptando cambios sólo de video', async () => {
    nvr.store.set(MAIN, streamingChannel({ withAudio: false }))

    const r = await putChannelVideoConfig('nvr-1', CREDS, 1, 'main', { fps: 10 })

    expect(r.success).toBe(true)
    expect(puts()[0].body).toBe(streamingChannel({ withAudio: false, maxFrameRate: '1000' }))
  })
})

describe('getChannelVideoConfig — audio leído del bloque <Audio>', () => {
  it('canal habilitado + audio apagado ⇒ audioEnabled=false (no el estado del canal)', async () => {
    nvr.store.set(MAIN, streamingChannel({ audioEnabled: 'false', codec: 'MP2L2', bitrate: '64' }))

    const cfg = await getChannelVideoConfig('nvr-1', CREDS, 1)

    expect(cfg.main).toMatchObject({ audioEnabled: false, audioCodecType: 'MP2L2', audioBitrate: 64, audioBlockPresent: true })
  })

  it('sin bloque <Audio> ⇒ audioEnabled=false, codec vacío, bitrate 0', async () => {
    nvr.store.set(MAIN, streamingChannel({ withAudio: false }))

    const cfg = await getChannelVideoConfig('nvr-1', CREDS, 1)

    expect(cfg.main).toMatchObject({ audioEnabled: false, audioCodecType: '', audioBitrate: 0, audioBlockPresent: false })
  })
})
