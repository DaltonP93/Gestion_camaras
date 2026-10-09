// Suite conjunta de seguridad — borde HLS (/internal/hls-auth) sobre server.ts real.
//
// nginx hace `auth_request /internal/hls-auth` ANTES de proxyear cada playlist o
// segmento a MediaMTX, reenviando la Cookie del navegador y la URI del request
// padre en X-Original-URI. Aquí "nginx" es el harness: llama desde loopback con la
// cookie que el tarro del navegador mandaría a /hls/… (Path=/ ⇒ access sí, refresh
// no). El permiso se consulta en la DB en CADA petición: la revocación corta en la
// siguiente playlist/segmento, sin esperar heartbeat.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))

import { infra } from './infra-doubles'
import {
  jointInfraAvailable, startJointServer, signHs256, JOINT_PASSWORD,
  type JointEnv, type SimBrowser,
} from './harness'

describe.skipIf(!jointInfraAvailable())('conjunta · borde HLS por espectador', { timeout: 60_000 }, () => {
  let env: JointEnv
  let nvrId = ''
  let otherNvrId = ''
  let camA = ''
  let camC = ''
  const ids: Record<string, string> = {}
  let op: SimBrowser
  let sup: SimBrowser
  let admin: SimBrowser

  const hlsUri = (nvr: string, channel: number, type = 'sub', file = 'index.m3u8') =>
    `/hls/nvr_${nvr}_ch${String(channel).padStart(2, '0')}_${type}/${file}`

  beforeAll(async () => {
    env = await startJointServer({ label: 'hls' })
    nvrId = (await env.createNvr('NVR conjunto HLS', '192.0.2.30')).id
    otherNvrId = (await env.createNvr('NVR conjunto HLS 2', '192.0.2.31')).id
    camA = (await env.createCamera(nvrId, 1)).id
    await env.createCamera(nvrId, 2)   // canal 2 existe, pero op no tiene permiso
    camC = (await env.createCamera(nvrId, 3, { main: 'hevc', sub: 'hevc' })).id
    await env.createCamera(otherNvrId, 1)
    ids.admin = (await env.createUser('admin_hls', 'ADMIN')).id
    ids.op = (await env.createUser('op_hls', 'OPERATOR')).id
    ids.sup = (await env.createUser('sup_hls', 'SUPERVISOR')).id
    await env.grant(ids.op, nvrId, camA, { canView: true })
    await env.grant(ids.op, nvrId, camC, { canView: true })
    op = env.browser('op'); await op.signIn('op_hls')
    sup = env.browser('sup'); await sup.signIn('sup_hls')
    admin = env.browser('admin'); await admin.signIn('admin_hls')
  }, 120_000)

  afterAll(async () => { await env?.stop() })

  it('permitido 200 (playlist, segmento y HEAD); sin permiso 403; sin cookie 401; otro NVR 403; SUPERVISOR sin filas 200', async () => {
    expect((await env.hlsAuth(hlsUri(nvrId, 1), { browser: op })).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(nvrId, 1, 'sub', 'segment_0001.mp4'), { browser: op })).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(nvrId, 1), { browser: op, method: 'HEAD' })).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(nvrId, 2), { browser: op })).status).toBe(403)
    expect((await env.hlsAuth(hlsUri(otherNvrId, 1), { browser: op })).status).toBe(403)
    expect((await env.hlsAuth(hlsUri(nvrId, 1))).status).toBe(401)
    expect((await env.hlsAuth(hlsUri(nvrId, 1), { browser: env.browser('sin-sesion') })).status).toBe(401)
    expect((await env.hlsAuth(hlsUri(nvrId, 2), { browser: sup })).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(nvrId, 2), { browser: admin })).status).toBe(200)
  })

  it('IP externa ⇒ 403 aunque la cookie sea válida; path con ".." o "." ⇒ 403 (BAD_PATH)', async () => {
    expect((await env.hlsAuth(hlsUri(nvrId, 1), { browser: op, remoteAddress: '198.51.100.77' })).status).toBe(403)
    expect((await env.hlsAuth(hlsUri(nvrId, 1), { browser: admin, remoteAddress: '203.0.113.9' })).status).toBe(403)
    expect((await env.hlsAuth(`/hls/nvr_${nvrId}_ch01_sub/../nvr_${nvrId}_ch02_sub/index.m3u8`, { browser: op })).status).toBe(403)
    expect((await env.hlsAuth(`/hls/./nvr_${nvrId}_ch01_sub/index.m3u8`, { browser: op })).status).toBe(403)
    expect((await env.hlsAuth('/hls/otra-cosa/index.m3u8', { browser: admin })).status).toBe(403)
  })

  it('tokens no-access ⇒ 401: refresh, step-up, firmado con otra clave y access vencido', async () => {
    const st = await op.post('/api/auth/step-up', { password: JOINT_PASSWORD })
    expect(st.status).toBe(200)
    const now = Math.floor(Date.now() / 1000)
    const forgedOtherKey = signHs256({ sub: ids.admin, username: 'admin_hls', role: 'ADMIN', iat: now, exp: now + 300 }, 'clave-ajena-0123456789abcdef0123456789abcdef')
    const expired = signHs256({ sub: ids.op, username: 'op_hls', role: 'OPERATOR', iat: now - 7200, exp: now - 60 }, env.jwtSecret)
    for (const tok of [op.refreshToken!, st.json().stepUpToken as string, forgedOtherKey, expired]) {
      expect((await env.hlsAuth(hlsUri(nvrId, 1), { cookie: tok })).status).toBe(401)
      expect((await env.hlsAuth(hlsUri(nvrId, 1), { bearer: tok })).status).toBe(401)
    }
  })

  it('el path que devuelve el heartbeat (incluido el transcodificado main_h264) es exactamente el que el borde autoriza, sólo para quien tiene permiso', async () => {
    const mark = infra.mark()
    const hb = await op.heartbeat('v-hls', [camA, camC])
    expect(hb.status).toBe(200)
    const streams = hb.json().streams
    expect(streams[camA].hls).toBe(hlsUri(nvrId, 1))
    expect(streams[camC].hls).toBe(hlsUri(nvrId, 3, 'main_h264'))
    expect(infra.of('ffmpeg.transcode.spawn', mark).map(c => c.detail.streamPath)).toEqual([`nvr_${nvrId}_ch03_main_h264`])
    for (const cam of [camA, camC]) {
      expect((await env.hlsAuth(streams[cam].hls, { browser: op })).status).toBe(200)
    }
    // Otro usuario autenticado, sin permiso sobre esas cámaras, no reusa las URL.
    const otro = env.browser('otro-operador')
    await env.createUser('op_hls_otro', 'OPERATOR')
    await otro.signIn('op_hls_otro')
    expect((await env.hlsAuth(streams[camA].hls, { browser: otro })).status).toBe(403)
    expect((await env.hlsAuth(streams[camC].hls, { browser: otro })).status).toBe(403)
  })

  it('revocar canView corta el borde en la PRÓXIMA petición con la misma cookie (playlist OK, segmento siguiente 403), sin esperar heartbeat', async () => {
    const playlistA = hlsUri(nvrId, 1)
    const segA = hlsUri(nvrId, 1, 'sub', 'segment_0002.mp4')
    const playlistC = hlsUri(nvrId, 3, 'main_h264')
    expect((await env.hlsAuth(playlistA, { browser: op })).status).toBe(200)

    // Modal granular (PUT): revoca sólo A.
    const put = await admin.put(`/api/users/${ids.op}/permissions`, { cameraPermissions: [{ cameraId: camA, canView: false }] })
    expect(put.status).toBe(200)
    expect((await env.hlsAuth(segA, { browser: op })).status).toBe(403)
    expect((await env.hlsAuth(playlistA, { browser: op })).status).toBe(403)
    expect((await env.hlsAuth(playlistC, { browser: op })).status).toBe(200)

    // Reemplazo total (POST []): también C.
    const post = await admin.post(`/api/users/${ids.op}/permissions`, [])
    expect(post.status).toBe(200)
    expect((await env.hlsAuth(playlistC, { browser: op })).status).toBe(403)
    // Sigue autenticado (no es 401): el corte es por permiso.
    expect((await op.get('/api/auth/me')).status).toBe(200)

    // Re-concesión: vuelve a abrir sin re-login.
    await admin.post(`/api/users/${ids.op}/permissions`, [{ nvrId, cameraId: camA, canView: true }])
    expect((await env.hlsAuth(playlistA, { browser: op })).status).toBe(200)
  })

  it('higiene: sin red saliente ni contacto con el NVR', () => {
    expect(env.blockedConnections).toEqual([])
    expect(infra.of('nvr.isapi')).toEqual([])
    expect(infra.of('proc.spawn')).toEqual([])
  })
})
