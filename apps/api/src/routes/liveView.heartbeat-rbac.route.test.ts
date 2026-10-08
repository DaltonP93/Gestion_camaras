// Regresión de seguridad (invariante 2) — POST /api/live-view/heartbeat.
//
// El heartbeat reconcilia las cámaras visibles e INICIA las que no tienen sesión
// (reconcileView → startStream). Antes no consultaba ni el rol ni UserPermission:
// cualquier autenticado podía mandar ids de cámaras ajenas y el servidor abría
// la sesión RTSP del NVR, registraba el path en MediaMTX (y FFmpeg si es HEVC) y
// devolvía la URL. Ahora aplica el MISMO criterio que POST /cameras/:id/start-stream
// (userCanAccessCamera): ADMIN y SUPERVISOR sin restricción; el resto necesita
// UserPermission.canView sobre ESA cámara.
//
// Se ejercita la ruta real y el stream-manager real; sólo `services/stream`
// (MediaMTX/FFmpeg) está simulado y espiado. Ids e IPs ficticios.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const published = vi.hoisted(() => [] as string[])

vi.mock('../services/stream', () => ({
  getStreamPath: (_n: any, cam: any, type = 'sub') => `p_${cam?.id ?? 'cam'}_${type}`,
  getHlsUrl: (p: string) => `https://h/${p}/index.m3u8`,
  getWebRtcUrl: (p: string) => `https://w/${p}/whep`,
  publishStream: async (_n: any, cam: any) => { published.push(cam.id); return true },
  removeStream: async () => true,
  removeTranscodedPath: async () => true,
  getStreamStatus: async () => ({ ready: true }),
  publishTranscodedStream: async () => true,
  getTranscodedStreamPath: (_n: any, cam: any) => `p_${cam.id}_main_h264`,
  isTranscodingEnabled: () => true,
  getFfmpegCapabilities: () => ({ available: true, encoders: [] }),
  waitForHlsReady: async () => ({ ready: true, lastStatus: 200, elapsedMs: 1, processExited: false, manifestVisible: true }),
  spawnTranscodeProcess: () => ({ once: () => {}, pid: 9001 }),
  isTranscodeProcessAlive: () => false,
  stopTranscodeProcess: () => true,
  getTranscodeStderr: () => '',
  getStreamDetails: async () => ({ sourceType: 'rtspSession', active: true }),
  getActiveTranscodesList: () => [],
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const { liveViewRoutes } = await import('./liveView')
const { getActiveSessions, __resetSessionsForTest, __resetClosedViewsForTest, __resetTombstonesForTest } =
  await import('../services/stream-manager')

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

const camera = (id: string, channel: number) => ({
  id, active: true, online: true, channel, name: id,
  mainCodec: 'h264', subCodec: 'h264', rtspSubOk: true, rtspMainOk: true, streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '192.0.2.10', rtspPort: 554 },
})
const CAMERAS: Record<string, any> = { 'cam-ok': camera('cam-ok', 1), 'cam-ajena': camera('cam-ajena', 2) }

/** userId → cameraIds con canView=true (filas camera-scoped). */
let grants: Record<string, string[]> = {}
const cameraLookups: string[] = []

async function build(user: { sub: string; role: Role }): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', () => async (req: any) => { req.user = user })
  app.decorate('prisma', {
    camera: {
      findUnique: async ({ where }: any) => { cameraLookups.push(where.id); return CAMERAS[where.id] ?? null },
    },
    userPermission: {
      findMany: async ({ where }: any) => {
        expect(where.userId).toBe(user.sub)
        expect(where.canView).toBe(true)
        const ids: string[] = where.cameraId?.in ?? []
        return ids.filter(id => (grants[user.sub] ?? []).includes(id)).map(cameraId => ({ cameraId }))
      },
      findFirst: async () => null,
    },
    $executeRaw: async () => 0,
  } as any)
  await app.register(liveViewRoutes, { prefix: '/api/live-view' })
  await app.ready()
  return app
}

function heartbeat(app: FastifyInstance, visibleCameraIds: string[], extra: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/live-view/heartbeat', payload: { viewId: 'v1', visibleCameraIds, ...extra } })
}

beforeEach(() => {
  __resetSessionsForTest()
  __resetClosedViewsForTest()
  __resetTombstonesForTest()
  published.length = 0
  cameraLookups.length = 0
  grants = {}
})

describe('POST /api/live-view/heartbeat — RBAC por cámara', () => {
  for (const role of ['OPERATOR', 'AUDITOR'] as const) {
    it(`${role} sin canView sobre una cámara: no se busca, no se publica, no hay sesión ni URL; error FORBIDDEN`, async () => {
      const user = { sub: `u-${role}`, role }
      grants = { [user.sub]: ['cam-ok'] }
      const app = await build(user)
      const res = await heartbeat(app, ['cam-ok', 'cam-ajena'])
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(Object.keys(body.streams)).toEqual(['cam-ok'])
      expect(body.startedIds).toEqual(['cam-ok'])
      expect(body.errors['cam-ajena']).toEqual({ code: 'FORBIDDEN', message: 'Sin permiso para esta cámara' })
      expect(JSON.stringify(body)).not.toContain('p_cam-ajena')
      expect(published).toEqual(['cam-ok'])
      expect(cameraLookups).not.toContain('cam-ajena')
      expect(getActiveSessions().map(s => s.cameraId)).toEqual(['cam-ok'])
      await app.close()
    })
  }

  it('sin ningún permiso: nada se inicia', async () => {
    const app = await build({ sub: 'u-op', role: 'OPERATOR' })
    const body = (await heartbeat(app, ['cam-ok', 'cam-ajena', 'no-existe'])).json()
    expect(body.streams).toEqual({})
    expect(Object.keys(body.errors).sort()).toEqual(['cam-ajena', 'cam-ok', 'no-existe'])
    expect(published).toEqual([])
    expect(cameraLookups).toEqual([])
    expect(getActiveSessions()).toEqual([])
    await app.close()
  })

  for (const role of ['ADMIN', 'SUPERVISOR'] as const) {
    it(`${role}: sin restricción por cámara (comportamiento de start-stream)`, async () => {
      const app = await build({ sub: `u-${role}`, role })
      const body = (await heartbeat(app, ['cam-ok', 'cam-ajena'])).json()
      expect(Object.keys(body.streams).sort()).toEqual(['cam-ajena', 'cam-ok'])
      expect(body.errors).toEqual({})
      expect(published.sort()).toEqual(['cam-ajena', 'cam-ok'])
      await app.close()
    })
  }

  it('permiso revocado entre heartbeats: la sesión existente se detiene y deja de devolverse', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    grants = { [user.sub]: ['cam-ok', 'cam-ajena'] }
    const app = await build(user)
    const first = (await heartbeat(app, ['cam-ok', 'cam-ajena'])).json()
    expect(Object.keys(first.streams).sort()).toEqual(['cam-ajena', 'cam-ok'])
    expect(getActiveSessions().map(s => s.cameraId).sort()).toEqual(['cam-ajena', 'cam-ok'])

    grants = { [user.sub]: ['cam-ok'] } // se revoca cam-ajena
    const second = (await heartbeat(app, ['cam-ok', 'cam-ajena'])).json()
    expect(Object.keys(second.streams)).toEqual(['cam-ok'])
    expect(second.stoppedIds).toEqual(['cam-ajena'])
    expect(second.errors['cam-ajena'].code).toBe('FORBIDDEN')
    expect(getActiveSessions().map(s => s.cameraId)).toEqual(['cam-ok'])
    await app.close()
  })

  it('suppressStartCameraIds no sirve para colar ni tocar una cámara ajena', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    grants = { [user.sub]: ['cam-ok'] }
    const app = await build(user)
    const body = (await heartbeat(app, ['cam-ajena'], { suppressStartCameraIds: ['cam-ajena'] })).json()
    expect(body.errors['cam-ajena'].code).toBe('FORBIDDEN')
    expect(body.streams).toEqual({})
    expect(published).toEqual([])
    await app.close()
  })

  it('ids duplicados se consultan una vez y no duplican trabajo', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    grants = { [user.sub]: ['cam-ok'] }
    const app = await build(user)
    const body = (await heartbeat(app, ['cam-ok', 'cam-ok', 'cam-ajena'])).json()
    expect(Object.keys(body.streams)).toEqual(['cam-ok'])
    expect(published).toEqual(['cam-ok'])
    await app.close()
  })
})
