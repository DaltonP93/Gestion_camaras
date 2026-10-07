// Regresión de seguridad — acceso cruzado entre canales vía playbackURI.
//
// El navegador reenvía la playbackURI y el servidor le inyecta las credenciales
// del NVR. Estas pruebas fijan que playback, preview y diagnóstico:
//   - rechazan la pista de OTRO canal del mismo NVR (403) y entradas malformadas o
//     codificadas (400);
//   - lo hacen ANTES de descifrar credenciales, buscar en el NVR, sondear RTSP o
//     iniciar FFmpeg (espías en cero);
//   - mantienen los controles de permiso (OPERATOR / AUDITOR sin canPlayback).
// Una URI válida del propio canal sí llega a descifrar credenciales: el mock
// devuelve '' ⇒ 422, sin red ni procesos.
//
// Ids, IPs y credenciales: 100 % ficticios.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const spies = vi.hoisted(() => ({
  decrypt: vi.fn((_enc: string) => ''),
  spawn: vi.fn(),
  search: vi.fn(async () => []),
  nvrTime: vi.fn(async () => null),
  probe: vi.fn(async () => ({ ok: false })),
}))

vi.mock('../services/credentials', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/credentials')>()
  return { ...orig, decryptNvrPassword: spies.decrypt }
})
vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('child_process')>()
  return { ...orig, spawn: spies.spawn, default: { ...orig, spawn: spies.spawn } }
})
vi.mock('../services/hikvision', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/hikvision')>()
  return { ...orig, searchRecordings: spies.search, getNvrSystemTime: spies.nvrTime }
})
vi.mock('../services/rtsp-probe', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/rtsp-probe')>()
  return { ...orig, probeRtspStream: spies.probe }
})

const { recordingRoutes } = await import('./recordings')

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'
interface Grant { userId: string; cameraId: string }

// cam-3 (canal 3) y cam-9 (canal 9) en el MISMO NVR.
const nvr = { id: 'nvr-1', name: 'NVR Test', ipAddress: '192.0.2.10', rtspPort: 554, username: 'u', password: 'enc', model: 'X' }
const cameras: Record<string, any> = {
  'cam-3': { id: 'cam-3', channel: 3, name: 'Cam 3', nvrId: 'nvr-1', mainCodec: 'H264', subCodec: 'H264', nvr },
  'cam-9': { id: 'cam-9', channel: 9, name: 'Cam 9', nvrId: 'nvr-1', mainCodec: 'H264', subCodec: 'H264', nvr },
}

function makePrisma(grants: Grant[]) {
  return {
    camera: {
      findUnique: async ({ where }: any) => cameras[where.id] ?? null,
      findMany: async () => [],
    },
    userPermission: {
      findFirst: async ({ where }: any) =>
        where.canPlayback === true && grants.some(g => g.userId === where.userId && g.cameraId === where.cameraId)
          ? { id: 'perm' } : null,
      findMany: async () => [],
    },
    auditLog: { create: async () => ({}) },
  } as any
}

async function build(user: { sub: string; role: Role }, grants: Grant[] = []): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (roles: Role[]) => async (req: any, reply: any) => {
    req.user = user
    if (!roles.includes(user.role)) return reply.status(403).send({ message: 'forbidden' })
  })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', makePrisma(grants))
  await app.register(recordingRoutes, { prefix: '/api/recordings' })
  await app.ready()
  return app
}

const WINDOW = 'starttime=20260716T170000Z&endtime=20260716T172206Z'
const OWN = `/Streaming/tracks/301/?${WINDOW}&name=00010000027000300&size=290893180`
const OTHER_CHANNEL = `/Streaming/tracks/901?${WINDOW}`
const TIMES = { startTime: '2026-07-16T17:00:00.000Z', endTime: '2026-07-16T17:22:06.000Z' }

type Route = { name: string; url: string; body: (uri?: string, cameraId?: string) => Record<string, unknown> }
const ROUTES: Route[] = [
  { name: 'POST /playback', url: '/api/recordings/playback',
    body: (uri, cameraId = 'cam-3') => ({ cameraId, ...TIMES, ...(uri !== undefined ? { playbackURI: uri } : {}) }) },
  { name: 'POST /preview/start', url: '/api/recordings/preview/start',
    body: (uri, cameraId = 'cam-3') => ({ cameraId, slotIndex: 0, ...TIMES, ...(uri !== undefined ? { playbackURI: uri } : {}) }) },
]

function noBackendContact() {
  expect(spies.decrypt).not.toHaveBeenCalled()
  expect(spies.spawn).not.toHaveBeenCalled()
  expect(spies.search).not.toHaveBeenCalled()
  expect(spies.nvrTime).not.toHaveBeenCalled()
  expect(spies.probe).not.toHaveBeenCalled()
}

beforeEach(() => { for (const s of Object.values(spies)) s.mockClear() })

for (const route of ROUTES) {
  describe(`${route.name} — playbackURI ligada al canal autorizado`, () => {
    it('AUDITOR con canPlayback en cam-3 pidiendo la pista del canal 9 ⇒ 403 sin contactar NVR/FFmpeg', async () => {
      const app = await build({ sub: 'aud', role: 'AUDITOR' }, [{ userId: 'aud', cameraId: 'cam-3' }])
      const res = await app.inject({ method: 'POST', url: route.url, payload: route.body(OTHER_CHANNEL) })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('PLAYBACK_URI_FORBIDDEN')
      noBackendContact()
      await app.close()
    })

    it('SUPERVISOR tampoco puede desviar la URI a otro canal (la URI se valida para todos)', async () => {
      const app = await build({ sub: 'sup', role: 'SUPERVISOR' })
      const res = await app.inject({ method: 'POST', url: route.url, payload: route.body(OTHER_CHANNEL) })
      expect(res.statusCode).toBe(403)
      noBackendContact()
      await app.close()
    })

    const malformed: Array<[string, string]> = [
      ['ruta de vivo', `/Streaming/Channels/301?${WINDOW}`],
      ['traversal ..', `/Streaming/tracks/301/../901?${WINDOW}`],
      ['traversal codificado', `/Streaming/tracks/301/%2e%2e/901?${WINDOW}`],
      ['CRLF', `/Streaming/tracks/301?${WINDOW}\r\nSETUP rtsp://x RTSP/1.0`],
      ['parámetro inyectado', `/Streaming/tracks/301?${WINDOW}&transport=udp`],
      ['clave duplicada', `/Streaming/tracks/301?starttime=20260716T170000Z&starttime=20260101T000000Z`],
      ['host embebido', `//198.51.100.7/Streaming/tracks/301?${WINDOW}`],
    ]
    for (const [label, uri] of malformed) {
      it(`${label} ⇒ 400 sin contactar NVR/FFmpeg`, async () => {
        const app = await build({ sub: 'adm', role: 'ADMIN' })
        const res = await app.inject({ method: 'POST', url: route.url, payload: route.body(uri) })
        expect(res.statusCode).toBe(400)
        expect(res.json().code).toBe('PLAYBACK_URI_INVALID')
        expect(res.body).not.toContain(uri)
        noBackendContact()
        await app.close()
      })
    }

    it('URI válida del propio canal pasa la validación y recién entonces descifra credenciales', async () => {
      const app = await build({ sub: 'aud', role: 'AUDITOR' }, [{ userId: 'aud', cameraId: 'cam-3' }])
      const res = await app.inject({ method: 'POST', url: route.url, payload: route.body(OWN) })
      // Mock de credenciales devuelve '' ⇒ 422 (no hay red ni FFmpeg en la prueba).
      expect(res.statusCode).toBe(422)
      expect(spies.decrypt).toHaveBeenCalledTimes(1)
      expect(spies.spawn).not.toHaveBeenCalled()
      await app.close()
    })

    it('sin playbackURI se mantiene el camino de fallback (no se rechaza)', async () => {
      const app = await build({ sub: 'adm', role: 'ADMIN' })
      const res = await app.inject({ method: 'POST', url: route.url, payload: route.body(undefined) })
      expect(res.statusCode).toBe(422)
      expect(spies.decrypt).toHaveBeenCalledTimes(1)
      await app.close()
    })

    it('permisos intactos: AUDITOR sin canPlayback (revocado) ⇒ 403 aunque la URI sea válida', async () => {
      const app = await build({ sub: 'aud', role: 'AUDITOR' }, [])
      const res = await app.inject({ method: 'POST', url: route.url, payload: route.body(OWN) })
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBeUndefined()
      noBackendContact()
      await app.close()
    })

    it('permisos intactos: OPERATOR sin acceso a grabaciones ⇒ 403', async () => {
      const app = await build({ sub: 'op', role: 'OPERATOR' })
      const res = await app.inject({ method: 'POST', url: route.url, payload: route.body(OWN) })
      expect(res.statusCode).toBe(403)
      noBackendContact()
      await app.close()
    })

    it('la pista válida de cam-9 sólo se acepta pidiendo cam-9', async () => {
      const app = await build({ sub: 'adm', role: 'ADMIN' })
      const res = await app.inject({ method: 'POST', url: route.url, payload: route.body(OTHER_CHANNEL, 'cam-9') })
      expect(res.statusCode).toBe(422)
      expect(spies.decrypt).toHaveBeenCalledTimes(1)
      await app.close()
    })
  })
}

describe('POST /diagnostics/playback (ADMIN) — mismo mecanismo', () => {
  const url = '/api/recordings/diagnostics/playback'

  it('pista de otro canal ⇒ 403 sin descifrar ni buscar en el NVR', async () => {
    const app = await build({ sub: 'adm', role: 'ADMIN' })
    const res = await app.inject({ method: 'POST', url, payload: { cameraId: 'cam-3', playbackURI: OTHER_CHANNEL } })
    expect(res.statusCode).toBe(403)
    noBackendContact()
    await app.close()
  })

  it('URI malformada ⇒ 400 sin contactar el NVR', async () => {
    const app = await build({ sub: 'adm', role: 'ADMIN' })
    const res = await app.inject({ method: 'POST', url, payload: { cameraId: 'cam-3', playbackURI: `/ISAPI/System/deviceInfo?${WINDOW}` } })
    expect(res.statusCode).toBe(400)
    noBackendContact()
    await app.close()
  })

  it('URI válida del propio canal llega a descifrar credenciales', async () => {
    const app = await build({ sub: 'adm', role: 'ADMIN' })
    const res = await app.inject({ method: 'POST', url, payload: { cameraId: 'cam-3', playbackURI: OWN } })
    expect(res.statusCode).toBe(422)
    expect(spies.decrypt).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('sigue reservado a ADMIN', async () => {
    const app = await build({ sub: 'aud', role: 'AUDITOR' }, [{ userId: 'aud', cameraId: 'cam-3' }])
    const res = await app.inject({ method: 'POST', url, payload: { cameraId: 'cam-3', playbackURI: OWN } })
    expect(res.statusCode).toBe(403)
    noBackendContact()
    await app.close()
  })
})
