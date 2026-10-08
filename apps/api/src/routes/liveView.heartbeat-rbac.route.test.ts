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
const ffmpeg = vi.hoisted(() => ({ alive: new Set<string>(), stopped: [] as string[] }))

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
  spawnTranscodeProcess: (_n: any, _c: any, path: string) => { ffmpeg.alive.add(path); return { once: () => {}, pid: 9001 } },
  isTranscodeProcessAlive: (p: string) => ffmpeg.alive.has(p),
  stopTranscodeProcess: (p: string) => { ffmpeg.stopped.push(p); ffmpeg.alive.delete(p); return true },
  getTranscodeStderr: () => '',
  getStreamDetails: async () => ({ sourceType: 'rtspSession', active: true }),
  getActiveTranscodesList: () => [],
  getTranscodeRawStderr: () => '',
  getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
}))

const { liveViewRoutes } = await import('./liveView')
const {
  getActiveSessions, getStreamOutcomeCounters, __seedSessionForTest,
  __resetSessionsForTest, __resetClosedViewsForTest, __resetTombstonesForTest, __resetOutcomesForTest,
} = await import('../services/stream-manager')

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

const camera = (id: string, channel: number) => ({
  id, active: true, online: true, channel, name: id,
  mainCodec: 'h264', subCodec: 'h264', rtspSubOk: true, rtspMainOk: true, streamHealthStatus: 'HEALTHY',
  nvr: { id: 'nvr1', name: 'NVR', password: 'x', username: 'u', ipAddress: '192.0.2.10', rtspPort: 554 },
})
const CAMERAS: Record<string, any> = {
  'cam-ok': camera('cam-ok', 1),
  'cam-ajena': camera('cam-ajena', 2),
  // Sub y main HEVC: el backend redirige el `sub` de la grilla a `main_h264` con FFmpeg.
  'cam-hevc': { ...camera('cam-hevc', 3), mainCodec: 'hevc', subCodec: 'hevc' },
}

/** userId → cameraIds con canView=true (filas camera-scoped). */
let grants: Record<string, string[]> = {}
const cameraLookups: string[] = []
const permissionQueries: string[][] = []

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
        permissionQueries.push(ids)
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
  __resetOutcomesForTest()
  published.length = 0
  cameraLookups.length = 0
  permissionQueries.length = 0
  ffmpeg.alive.clear()
  ffmpeg.stopped.length = 0
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
      // Mismo contrato que el 403 de POST /cameras/:id/start-stream.
      expect(body.errors['cam-ajena']).toEqual({ code: 'NO_PERMISSION', message: 'Sin permiso para ver esta cámara' })
      expect(getStreamOutcomeCounters(user.sub).rejectedPermission).toBe(1)
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
    expect(second.errors['cam-ajena'].code).toBe('NO_PERMISSION')
    expect(getActiveSessions().map(s => s.cameraId)).toEqual(['cam-ok'])
    await app.close()
  })

  it('suppressStartCameraIds no sirve para colar ni tocar una cámara ajena', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    grants = { [user.sub]: ['cam-ok'] }
    const app = await build(user)
    const body = (await heartbeat(app, ['cam-ajena'], { suppressStartCameraIds: ['cam-ajena'] })).json()
    expect(body.errors['cam-ajena'].code).toBe('NO_PERMISSION')
    expect(body.streams).toEqual({})
    expect(published).toEqual([])
    await app.close()
  })

  it('una sesión existente de cámara no permitida no se reafirma vía suppress: se cierra', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    grants = { [user.sub]: ['cam-ok'] }
    const old = new Date(Date.now() - 20_000)
    __seedSessionForTest({ cameraId: 'cam-ajena', userId: user.sub, viewId: 'v1', streamType: 'sub',
      streamPath: 'p_cam-ajena_sub', startedAt: old, lastClientHeartbeat: old })
    const app = await build(user)
    const body = (await heartbeat(app, ['cam-ajena'], { suppressStartCameraIds: ['cam-ajena'] })).json()
    expect(body.errors['cam-ajena'].code).toBe('NO_PERMISSION')
    expect(body.streams).toEqual({})
    expect(body.stoppedIds).toEqual(['cam-ajena'])
    expect(getActiveSessions().filter(s => s.cameraId === 'cam-ajena')).toEqual([])
    await app.close()
  })

  it('ids duplicados: una sola consulta de permisos, sin duplicados, y un solo arranque', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    grants = { [user.sub]: ['cam-ok'] }
    const app = await build(user)
    const body = (await heartbeat(app, ['cam-ok', 'cam-ok', 'cam-ajena', 'cam-ajena'])).json()
    expect(permissionQueries).toEqual([['cam-ok', 'cam-ajena']])
    expect(Object.keys(body.streams)).toEqual(['cam-ok'])
    expect(published).toEqual(['cam-ok'])
    expect(getStreamOutcomeCounters(user.sub).rejectedPermission).toBe(1)
    await app.close()
  })

  it('revocación con sub HEVC redirigido a main_h264: se cierra la sesión y se detiene su FFmpeg', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    grants = { [user.sub]: ['cam-ok', 'cam-hevc'] }
    const app = await build(user)
    await heartbeat(app, ['cam-ok', 'cam-hevc'])
    const hevc = getActiveSessions().filter(s => s.cameraId === 'cam-hevc')
    expect(hevc.map(s => s.streamType)).toEqual(['main_h264'])
    expect(ffmpeg.alive.size).toBe(1)
    const path = hevc[0].streamPath

    grants = { [user.sub]: ['cam-ok'] }
    const body = (await heartbeat(app, ['cam-ok', 'cam-hevc'])).json()
    expect(body.errors['cam-hevc'].code).toBe('NO_PERMISSION')
    expect(body.stoppedIds).toContain('cam-hevc')
    expect(getActiveSessions().filter(s => s.cameraId === 'cam-hevc')).toEqual([])
    expect(ffmpeg.stopped).toContain(path)
    expect(getActiveSessions().map(s => s.cameraId)).toEqual(['cam-ok']) // la permitida sigue
    await app.close()
  })

  it('revocación con HD de foco co-ubicado: también se cierra el `main` de esa cámara', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    grants = { [user.sub]: ['cam-ok', 'cam-ajena'] }
    const app = await build(user)
    await heartbeat(app, ['cam-ok', 'cam-ajena'])
    const now = new Date()
    __seedSessionForTest({ cameraId: 'cam-ajena', userId: user.sub, viewId: 'v1', streamType: 'main',
      streamPath: 'p_cam-ajena_main', startedAt: now, lastClientHeartbeat: now })
    expect(getActiveSessions().filter(s => s.cameraId === 'cam-ajena').map(s => s.streamType).sort()).toEqual(['main', 'sub'])

    grants = { [user.sub]: ['cam-ok'] }
    await heartbeat(app, ['cam-ok', 'cam-ajena'])
    expect(getActiveSessions().filter(s => s.cameraId === 'cam-ajena')).toEqual([])
    await app.close()
  })

  it('sesiones de OTRA vista del mismo usuario no se tocan al revocar en esta vista', async () => {
    const user = { sub: 'u-op', role: 'OPERATOR' as const }
    const now = new Date()
    __seedSessionForTest({ cameraId: 'cam-ajena', userId: user.sub, viewId: 'otra-vista', streamType: 'sub',
      streamPath: 'p_cam-ajena_sub', startedAt: now, lastClientHeartbeat: now })
    const app = await build(user)
    await heartbeat(app, ['cam-ajena'])
    expect(getActiveSessions().filter(s => s.viewId === 'otra-vista')).toHaveLength(1)
    await app.close()
  })
})
