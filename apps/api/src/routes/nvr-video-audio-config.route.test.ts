// Rutas que reciben audioEnabled — el cambio de audio llega SÓLO al bloque <Audio>
// y, si no se puede aplicar, la respuesta es un 422 claro SIN PUT al NVR.
//
//   PUT  /api/nvrs/:id/video-audio/:channel                       (routes/nvr.ts; la usa la UI)
//   PUT  /api/nvrs/:nvrId/channels/:channelId/video-config        (routes/nvrConfig.ts)
//   POST /api/nvrs/:nvrId/channels/:channelId/video-config/restore (routes/nvrConfig.ts)
//
// Se usa fastify.inject con el servicio REAL (nvr-config/hikvision) contra un NVR
// simulado EN MEMORIA (axios.create mockeado; nada de red). El guard SSRF se
// reemplaza por passthrough para la IP TEST-NET (se prueba aparte).
//
// Restore: los backups anteriores a esta corrección guardaban en audioEnabled el
// <enabled> del CANAL (true). Restaurarlos NO debe encender el audio, ni fallar por
// un bitrate 0 (tag inexistente en G.711).
// IPs/ids/credenciales 100% ficticios.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

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
    put: async (url: string, body: string) => {
      nvr.calls.push({ method: 'PUT', url, body })
      nvr.store.set(url, body)
      return { status: 200, statusText: 'OK', data: '<ResponseStatus><statusCode>1</statusCode></ResponseStatus>' }
    },
  })
  return { default: { create }, create }
})

vi.mock('../services/net/nvr-host-guard', async (orig) => ({
  ...((await orig()) as object),
  assertSafeNvrHostForUrl: (h: string) => h,
}))

vi.mock('../services/credentials', () => ({
  encryptNvrPassword: (p: string) => p,
  decryptNvrPassword: () => 'clave-ficticia',
  decryptNvrPasswordOrNull: () => 'clave-ficticia',
  isMaskedPassword: () => false,
}))

// El backup previo de routes/nvr.ts usa el lector legacy; se aísla (no es lo probado).
vi.mock('../services/hikvision', async (orig) => ({
  ...((await orig()) as object),
  fetchChannelVideoConfig: vi.fn(async (_nvr: unknown, ch: number) => ({ channel: ch, main: null, sub: null, fetchedAt: 't' })),
}))

import { nvrRoutes } from './nvr'
import { nvrConfigRoutes } from './nvrConfig'

const MAIN = '/ISAPI/Streaming/channels/0101'
const SUB  = '/ISAPI/Streaming/channels/0102'

// bitrate null ⇒ sin <audioBitRate> (típico de G.711); con AAC/MP2L2 sí existe.
function streamingChannel(o: { audioEnabled?: string; withAudio?: boolean; codec?: string; bitrate?: string | null } = {}): string {
  const f = { audioEnabled: 'true', withAudio: true, codec: 'G.711ulaw', bitrate: null, ...o }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<StreamingChannel version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">',
    '<id>101</id>',
    '<channelName>Camara Prueba 01</channelName>',
    '<enabled>true</enabled>',
    '<Transport>',
    '<Unicast>', '<enabled>true</enabled>', '<rtpTransportType>RTP/TCP</rtpTransportType>', '</Unicast>',
    '<Multicast>', '<enabled>true</enabled>', '<destIPAddress>0.0.0.0</destIPAddress>', '</Multicast>',
    '<Security>', '<enabled>true</enabled>', '<certificateType>digest</certificateType>', '</Security>',
    '</Transport>',
    '<Video>',
    '<enabled>true</enabled>',
    '<videoInputChannelID>1</videoInputChannelID>',
    '<videoCodecType>H.264</videoCodecType>',
    '<videoResolutionWidth>1920</videoResolutionWidth>',
    '<videoResolutionHeight>1080</videoResolutionHeight>',
    '<videoQualityControlType>CBR</videoQualityControlType>',
    '<constantBitRate>4096</constantBitRate>',
    '<fixedQuality>60</fixedQuality>',
    '<maxFrameRate>2500</maxFrameRate>',
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
    '',
  ].join('\n')
}

const channelEnabled = (xml: string) => /<enabled>([^<]*)<\/enabled>/.exec(xml.slice(0, xml.indexOf('<Transport>')))?.[1]
const audioEnabled   = (xml: string) => /<Audio>\s*<enabled>([^<]*)<\/enabled>/.exec(xml)?.[1]
const puts = () => nvr.calls.filter((c) => c.method === 'PUT')

const NVR_ROW = { id: 'nvr-1', name: 'NVR Prueba', ipAddress: '192.0.2.10', port: 80, username: 'usuario-prueba', password: 'cifrada-ficticia' }

function makePrisma() {
  const backups: any[] = []
  const audits: any[] = []
  return {
    backups,
    audits,
    nVR: { findUnique: async ({ where }: any) => (where.id === NVR_ROW.id ? { ...NVR_ROW } : null) },
    nvrChannelConfigBackup: {
      create: async ({ data }: any) => { const row = { id: `bk-${backups.length + 1}`, createdAt: new Date(), ...data }; backups.push(row); return row },
      findFirst: async ({ where }: any) => {
        const rows = backups.filter((b) =>
          (!where.id || b.id === where.id) && b.nvrId === where.nvrId && b.channelNo === where.channelNo &&
          (!where.streamType || b.streamType === where.streamType))
        return rows.length ? rows[rows.length - 1] : null
      },
    },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data } },
  }
}

async function build(prisma = makePrisma()): Promise<{ app: FastifyInstance; prisma: ReturnType<typeof makePrisma> }> {
  const app = Fastify()
  const user = { sub: 'admin-1', role: 'ADMIN' }
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', () => async (req: any) => { req.user = user })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', prisma as any)
  await app.register(nvrRoutes, { prefix: '/api/nvrs' })
  await app.register(nvrConfigRoutes, { prefix: '/api/nvrs' })
  await app.ready()
  return { app, prisma }
}

beforeEach(() => {
  nvr.store.clear()
  nvr.calls.length = 0
})

describe('PUT /api/nvrs/:id/video-audio/:channel (routes/nvr.ts) — audioEnabled', () => {
  it('apagar audio ⇒ 200, canal sigue habilitado y sólo cambia <Audio><enabled>', async () => {
    const original = streamingChannel()
    nvr.store.set(MAIN, original)
    nvr.store.set(SUB, streamingChannel())
    const { app } = await build()

    const res = await app.inject({ method: 'PUT', url: '/api/nvrs/nvr-1/video-audio/1', payload: { streamType: 'main', audioEnabled: false } })

    expect(res.statusCode).toBe(200)
    expect(puts()).toHaveLength(1)
    expect(channelEnabled(nvr.store.get(MAIN)!)).toBe('true')
    expect(audioEnabled(nvr.store.get(MAIN)!)).toBe('false')
    expect(puts()[0].body).toBe(streamingChannel({ audioEnabled: 'false' }))
    expect(res.json().main).toMatchObject({ audioEnabled: false, audioBlockPresent: true })
    await app.close()
  })

  it('stream sin bloque <Audio> ⇒ 422 con mensaje claro y NINGÚN PUT', async () => {
    const original = streamingChannel({ withAudio: false })
    nvr.store.set(MAIN, original)
    const { app } = await build()

    const res = await app.inject({ method: 'PUT', url: '/api/nvrs/nvr-1/video-audio/1', payload: { streamType: 'main', audioEnabled: false } })

    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/bloque <Audio>/)
    expect(puts()).toHaveLength(0)
    expect(nvr.store.get(MAIN)).toBe(original)
    await app.close()
  })

  it('audioEnabled "false" (string) ⇒ 422 sin tocar el NVR (antes era truthy ⇒ encendía)', async () => {
    nvr.store.set(MAIN, streamingChannel({ audioEnabled: 'false' }))
    const { app } = await build()

    const res = await app.inject({ method: 'PUT', url: '/api/nvrs/nvr-1/video-audio/1', payload: { streamType: 'main', audioEnabled: 'false' } })

    expect(res.statusCode).toBe(422)
    expect(puts()).toHaveLength(0)
    await app.close()
  })

  // Payload ANTERIOR de NVRDetailPage.handleSave: enterEditMode armaba audioEnabled:false,
  // audioCodecType:'' y audioBitrate:64 aunque el usuario sólo cambiara el FPS (no hay
  // control de codec/bitrate y no precarga el estado real). Un cliente viejo (pestaña
  // abierta antes del deploy) todavía puede mandarlo: debe fallar SIN PUT en vez de
  // apagar el audio y vaciar el codec.
  it.each([
    ['AAC con <audioBitRate>', { codec: 'AAC', bitrate: '64' }],
    ['G.711 sin <audioBitRate>', { codec: 'G.711ulaw', bitrate: null }],
  ])('payload de la UI (audio oculto) en canal %s ⇒ 422 y NINGÚN PUT', async (_caso, fx) => {
    const original = streamingChannel(fx)
    nvr.store.set(MAIN, original)
    const { app } = await build()

    const res = await app.inject({
      method: 'PUT', url: '/api/nvrs/nvr-1/video-audio/1',
      payload: {
        streamType: 'main', videoCodecType: 'H.264', width: 1920, height: 1080, fps: 15, bitrateMax: 4096,
        bitrateType: 'CBR', audioEnabled: false, audioCodecType: '', audioBitrate: 64,
      },
    })

    expect(res.statusCode).toBe(422)
    expect(puts()).toHaveLength(0)
    expect(nvr.store.get(MAIN)).toBe(original)
    await app.close()
  })
})

describe('PUT /api/nvrs/:id/video-audio/:channel — payload ACTUAL de la UI (lib/streamConfigPayload)', () => {
  // La UI ya no manda audio salvo elección explícita ("Sin cambios" por defecto).
  it.each([
    ['AAC con <audioBitRate>', { codec: 'AAC', bitrate: '64' }],
    ['G.711 sin <audioBitRate>', { codec: 'G.711ulaw', bitrate: null }],
  ])('sólo video en canal %s ⇒ 200, cambia el FPS y <Audio> queda intacto', async (_caso, fx) => {
    const original = streamingChannel(fx)
    nvr.store.set(MAIN, original)
    const { app } = await build()

    const res = await app.inject({
      method: 'PUT', url: '/api/nvrs/nvr-1/video-audio/1',
      payload: { streamType: 'main', videoCodecType: 'H.264', width: 1920, height: 1080, fps: 15, bitrateMax: 4096, bitrateType: 'CBR' },
    })

    expect(res.statusCode).toBe(200)
    expect(puts()).toHaveLength(1)
    const sent = puts()[0].body!
    expect(sent).toBe(original.replace('<maxFrameRate>2500</maxFrameRate>', '<maxFrameRate>1500</maxFrameRate>'))
    expect(channelEnabled(sent)).toBe('true')
    expect(audioEnabled(sent)).toBe('true')
    await app.close()
  })

  it('"Deshabilitar" audio + video ⇒ 200, canal habilitado y sólo cambian FPS y <Audio><enabled>', async () => {
    const original = streamingChannel({ codec: 'AAC', bitrate: '64' })
    nvr.store.set(MAIN, original)
    const { app } = await build()

    const res = await app.inject({
      method: 'PUT', url: '/api/nvrs/nvr-1/video-audio/1',
      payload: { streamType: 'main', videoCodecType: 'H.264', width: 1920, height: 1080, fps: 15, bitrateMax: 4096, bitrateType: 'CBR', audioEnabled: false },
    })

    expect(res.statusCode).toBe(200)
    const sent = puts()[0].body!
    expect(sent).toBe(streamingChannel({ codec: 'AAC', bitrate: '64', audioEnabled: 'false' })
      .replace('<maxFrameRate>2500</maxFrameRate>', '<maxFrameRate>1500</maxFrameRate>'))
    expect(channelEnabled(sent)).toBe('true')
    await app.close()
  })
})

describe('PUT /api/nvrs/:nvrId/channels/:channelId/video-config (routes/nvrConfig.ts)', () => {
  it('tipos inválidos ⇒ 400 de Zod (sin cambios); codec vacío pasa Zod y el servicio lo rechaza con 422; ninguno hace PUT', async () => {
    nvr.store.set(MAIN, streamingChannel({ codec: 'AAC', bitrate: '64' }))
    const { app } = await build()
    const put = (update: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: '/api/nvrs/nvr-1/channels/1/video-config', payload: { streamType: 'main', update } })

    expect((await put({ audioEnabled: 'false' })).statusCode).toBe(400)
    expect((await put({ audioBitrate: '64' })).statusCode).toBe(400)
    expect((await put({ audioBitrate: 64.5 })).statusCode).toBe(400)
    const vacio = await put({ audioCodecType: '' })
    expect(vacio.statusCode).toBe(422)
    expect(vacio.json().message).toMatch(/audioCodecType/)
    expect(puts()).toHaveLength(0)
    await app.close()
  })

  it('apagar audio ⇒ 200 y el canal sigue habilitado', async () => {
    nvr.store.set(MAIN, streamingChannel())
    nvr.store.set(SUB, streamingChannel())
    const { app, prisma } = await build()

    const res = await app.inject({ method: 'PUT', url: '/api/nvrs/nvr-1/channels/1/video-config', payload: { streamType: 'main', update: { audioEnabled: false } } })

    expect(res.statusCode).toBe(200)
    expect(channelEnabled(nvr.store.get(MAIN)!)).toBe('true')
    expect(puts()[0].body).toBe(streamingChannel({ audioEnabled: 'false' }))
    expect(res.json().main.audioEnabled).toBe(false)
    // El backup previo ya trae el audio leído del bloque correcto.
    expect(JSON.parse(prisma.backups[0].configJson).main).toMatchObject({ audioEnabled: true, audioBlockPresent: true })
    await app.close()
  })

  it('sin bloque <Audio> ⇒ 422 (no 502/500) y NINGÚN PUT', async () => {
    nvr.store.set(MAIN, streamingChannel({ withAudio: false }))
    const { app } = await build()

    const res = await app.inject({ method: 'PUT', url: '/api/nvrs/nvr-1/channels/1/video-config', payload: { streamType: 'main', update: { audioEnabled: true } } })

    expect(res.statusCode).toBe(422)
    expect(res.json().message).toMatch(/bloque <Audio>/)
    expect(puts()).toHaveLength(0)
    await app.close()
  })
})

describe('POST /api/nvrs/:nvrId/channels/:channelId/video-config/restore — audio del backup', () => {
  const videoOf = {
    streamType: 'main', videoCodecType: 'H.264', videoScanType: 'progressive', width: 1920, height: 1080,
    fps: 25, bitrateType: 'CBR', bitrateMax: 4096, qualityLevel: '60', h265Plus: false, audioInputType: '',
  }

  it('backup anterior (audioEnabled = <enabled> del canal, sin audioBlockPresent) ⇒ no enciende el audio ni falla', async () => {
    const original = streamingChannel({ audioEnabled: 'false' })
    nvr.store.set(MAIN, original)
    nvr.store.set(SUB, streamingChannel({ audioEnabled: 'false' }))
    const prisma = makePrisma()
    prisma.backups.push({
      id: 'bk-legacy', nvrId: 'nvr-1', channelNo: 1, streamType: 'main', createdAt: new Date(),
      configJson: JSON.stringify({ nvrId: 'nvr-1', channel: 1, fetchedAt: 't', sub: null,
        main: { ...videoOf, audioEnabled: true, audioCodecType: 'G.711ulaw', audioBitrate: 0 } }),
    })
    const { app } = await build(prisma)

    const res = await app.inject({ method: 'POST', url: '/api/nvrs/nvr-1/channels/1/video-config/restore', payload: { streamType: 'main' } })

    expect(res.statusCode).toBe(200)
    expect(puts()[0].body).toBe(original)   // video igual al backup ⇒ XML idéntico
    expect(audioEnabled(nvr.store.get(MAIN)!)).toBe('false')
    expect(channelEnabled(nvr.store.get(MAIN)!)).toBe('true')
    await app.close()
  })

  it('backup con audio leído de <Audio> ⇒ restaura sólo <Audio><enabled> (bitrate 0 = tag inexistente, se omite)', async () => {
    nvr.store.set(MAIN, streamingChannel({ audioEnabled: 'false' }))
    nvr.store.set(SUB, streamingChannel({ audioEnabled: 'false' }))
    const prisma = makePrisma()
    prisma.backups.push({
      id: 'bk-new', nvrId: 'nvr-1', channelNo: 1, streamType: 'main', createdAt: new Date(),
      configJson: JSON.stringify({ nvrId: 'nvr-1', channel: 1, fetchedAt: 't', sub: null,
        main: { ...videoOf, audioEnabled: true, audioCodecType: 'G.711ulaw', audioBitrate: 0, audioBlockPresent: true } }),
    })
    const { app } = await build(prisma)

    const res = await app.inject({ method: 'POST', url: '/api/nvrs/nvr-1/channels/1/video-config/restore', payload: { streamType: 'main' } })

    expect(res.statusCode).toBe(200)
    expect(puts()[0].body).toBe(streamingChannel({ audioEnabled: 'true' }))
    expect(channelEnabled(nvr.store.get(MAIN)!)).toBe('true')
    await app.close()
  })
})
