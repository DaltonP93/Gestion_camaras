// Suite conjunta de seguridad — cookies y CSRF (#190 × #189 × #182 sobre server.ts real).
//
// El navegador simulado guarda Set-Cookie en un tarro que respeta Path y borrado, y
// manda Origin en las mutaciones same-origin como cualquier fetch/XHR de apps/web.
// El hook CSRF de server.ts corre en onRequest (antes de autenticar): una mutación
// con cookie y sin Origin válido se corta aunque la cookie traiga un token no-access.
// También se ejerce el listener TCP real (login/me/heartbeat/hls-auth por HTTP).
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
  jointInfraAvailable, startJointServer, parseSetCookie, JOINT_ORIGIN, JOINT_PASSWORD,
  type JointEnv, type SimBrowser,
} from './harness'

const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-01T10:05:00.000Z'

describe.skipIf(!jointInfraAvailable())('conjunta · cookies HttpOnly y CSRF', { timeout: 60_000 }, () => {
  let env: JointEnv
  let sm: typeof import('../services/stream-manager')
  let nvrId = ''
  let camA = ''
  const ids: Record<string, string> = {}
  let admin: SimBrowser
  let op: SimBrowser
  let aud: SimBrowser

  const hlsUri = (channel: number) => `/hls/nvr_${nvrId}_ch${String(channel).padStart(2, '0')}_sub/index.m3u8`
  const sessionsOf = (userId: string) => sm.getActiveSessions().filter(s => s.userId === userId)

  beforeAll(async () => {
    env = await startJointServer({ label: 'cookies' })
    sm = await import('../services/stream-manager')
    nvrId = (await env.createNvr('NVR conjunto cookies', '192.0.2.20')).id
    camA = (await env.createCamera(nvrId, 1)).id
    ids.admin = (await env.createUser('admin_ck', 'ADMIN')).id
    ids.op = (await env.createUser('op_ck', 'OPERATOR')).id
    ids.op2 = (await env.createUser('op2_ck', 'OPERATOR')).id
    ids.aud = (await env.createUser('aud_ck', 'AUDITOR')).id
    await env.grant(ids.op, nvrId, camA, { canView: true })
    await env.grant(ids.op2, nvrId, camA, { canView: true })
    await env.grant(ids.aud, nvrId, camA, { canView: false, canPlayback: true })
    admin = env.browser('admin'); await admin.signIn('admin_ck')
    op = env.browser('op'); await op.signIn('op_ck')
    aud = env.browser('aud'); await aud.signIn('aud_ck')
  }, 120_000)

  afterAll(async () => { await env?.stop() })

  it('login: access_token (Path=/, HttpOnly, SameSite=Strict, de sesión) y refresh_token (Path=/api/auth); el JWT no va en el cuerpo; el tarro no manda el refresh fuera de /api/auth', async () => {
    const b = env.browser('login-cookies')
    const r = await b.login('op_ck', JOINT_PASSWORD, true)
    expect(r.status).toBe(200)
    const access = r.setCookies.find(c => c.name === 'access_token')!
    const refresh = r.setCookies.find(c => c.name === 'refresh_token')!
    expect(access).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Strict' })
    expect(access.maxAge).toBeUndefined()
    expect(refresh).toMatchObject({ path: '/api/auth', httpOnly: true, sameSite: 'Strict', maxAge: 7 * 24 * 3600 })
    expect(r.text).not.toContain(access.value)
    expect(r.text).not.toContain(refresh.value)
    expect(Object.keys(r.json())).toEqual(['user'])

    expect(b.cookieHeaderFor('/api/live-view/heartbeat')).toBe(`access_token=${access.value}`)
    expect(b.cookieHeaderFor('/hls/x/index.m3u8')).toBe(`access_token=${access.value}`)
    expect(b.cookieHeaderFor('/api/auth/refresh')).toContain(`refresh_token=${refresh.value}`)
    expect(b.cookieHeaderFor('/api/authx')).not.toContain('refresh_token')

    expect((await b.get('/api/auth/me')).json().id).toBe(ids.op)
    expect((await env.browser('anonimo').get('/api/auth/me')).status).toBe(401)

    // "Recordarme" desmarcado ⇒ refresh de sesión (sin Max-Age).
    const r2 = await env.browser('login-sin-recordar').login('op_ck', JOINT_PASSWORD, false)
    expect(r2.setCookies.find(c => c.name === 'refresh_token')?.maxAge).toBeUndefined()
  })

  it('el refresh real puesto en la cookie access_token ⇒ 401 en /me, heartbeat, ws-ticket y hls-auth (y como Bearer)', async () => {
    const mark = infra.mark()
    const forged = env.browser('refresh-como-access')
    forged.plantCookie('access_token', op.refreshToken!)
    expect((await forged.get('/api/auth/me')).status).toBe(401)
    expect((await forged.heartbeat('v-forjada', [camA])).status).toBe(401)
    expect((await forged.post('/api/auth/ws-ticket')).status).toBe(401)
    expect((await env.hlsAuth(hlsUri(1), { browser: forged })).status).toBe(401)
    expect((await env.hlsAuth(hlsUri(1), { bearer: op.refreshToken! })).status).toBe(401)
    expect(infra.externalEffectsSince(mark)).toEqual([])
  })

  it('CSRF: mutación con cookie sin Origin/Referer u Origin ajeno ⇒ 403 CSRF_BLOCKED sin efectos; Referer o Origin propios ⇒ OK; Bearer sin cookie exento; GET no se bloquea', async () => {
    sm.__resetSessionsForTest()
    const mark = infra.mark()
    const blocked = async (p: Promise<{ status: number; json(): any }>) => {
      const r = await p
      expect(r.status).toBe(403)
      expect(r.json().code).toBe('CSRF_BLOCKED')
    }
    await blocked(op.heartbeat('v-csrf', [camA], { origin: null }))
    await blocked(op.heartbeat('v-csrf', [camA], { origin: 'https://atacante.example' }))
    await blocked(op.heartbeat('v-csrf', [camA], { origin: 'http://vms.example.test.atacante.example' }))
    await blocked(op.post('/api/auth/logout', {}, { origin: null }))
    await blocked(op.post('/api/auth/ws-ticket', undefined, { origin: 'null' }))
    await blocked(admin.put(`/api/users/${ids.op}/permissions`, { cameraPermissions: [{ cameraId: camA, canView: false }] }, { origin: null }))
    await blocked(aud.post('/api/recordings/playback', { cameraId: camA, startTime: T0, endTime: T1 }, { origin: null }))
    await blocked(aud.del('/api/recordings/preview/0123456789abcdef', { origin: 'https://atacante.example' }))
    // El CSRF corre ANTES que `trusted`: con un refresh en la cookie y sin Origin
    // la respuesta es CSRF (no 401), y tampoco autentica.
    const forged = env.browser('refresh-sin-origin')
    forged.plantCookie('access_token', op.refreshToken!)
    await blocked(forged.heartbeat('v-csrf', [camA], { origin: null }))

    expect(sm.getActiveSessions()).toEqual([])
    expect(infra.externalEffectsSince(mark)).toEqual([])
    // Nada cambió: el permiso sigue, la sesión sigue (refresh OK) y el logout no ocurrió.
    expect((await env.prisma.userPermission.findFirst({ where: { userId: ids.op, cameraId: camA } }))?.canView).toBe(true)
    expect(await env.prisma.session.count({ where: { userId: ids.op } })).toBeGreaterThan(0)

    // Referer same-origin sin Origin (navegadores viejos) ⇒ aceptado.
    const viaReferer = await op.heartbeat('v-csrf', [camA], { origin: null, headers: { referer: `${JOINT_ORIGIN}/live` } })
    expect(viaReferer.status).toBe(200)
    // Origin propio ⇒ 200 y arranca el stream.
    const ok = await op.heartbeat('v-csrf', [camA])
    expect(ok.status).toBe(200)
    expect(Object.keys(ok.json().streams)).toEqual([camA])
    expect(sessionsOf(ids.op)).toHaveLength(1)
    // Bearer sin cookie (integraciones) ⇒ exento de CSRF.
    const bearer = await env.browser('integracion').heartbeat('v-bearer', [camA], { origin: null, headers: { authorization: `Bearer ${op.accessToken}` } })
    expect(bearer.status).toBe(200)
    // GET con Origin ajeno no se bloquea (método seguro; la defensa es SameSite=Strict).
    expect((await op.get('/api/auth/me', { origin: 'https://atacante.example' })).status).toBe(200)
  })

  it('cierre keepalive (DELETE como lib/sessionClose.ts): sin Origin u Origin ajeno ⇒ CSRF y la sesión sigue; con Origin propio ⇒ 200 y cierra sólo esa pestaña', async () => {
    sm.__resetSessionsForTest()
    expect((await op.heartbeat('v-keep-1', [camA])).status).toBe(200)
    expect((await op.heartbeat('v-keep-2', [camA])).status).toBe(200)
    expect(sessionsOf(ids.op)).toHaveLength(2)

    const closeOne = `/api/cameras/${camA}/stream?streamType=sub&reason=cleanup_unmount&viewId=v-keep-1`
    const closeView = '/api/cameras/my-sessions?viewId=v-keep-2'
    for (const origin of [null, 'https://atacante.example']) {
      const a = await op.del(closeOne, { origin })
      expect(a.status).toBe(403)
      expect(a.json().code).toBe('CSRF_BLOCKED')
      expect((await op.del(closeView, { origin })).json().code).toBe('CSRF_BLOCKED')
    }
    expect(sessionsOf(ids.op)).toHaveLength(2)

    // Un tercero autenticado no cierra la sesión ajena aunque conozca el viewId.
    const tercero = env.browser('op2-cierra-ajena')
    await tercero.signIn('op2_ck')
    expect((await tercero.del(closeView)).status).toBe(200)
    expect(sessionsOf(ids.op)).toHaveLength(2)

    const one = await op.del(closeOne)
    expect(one.status).toBe(200)
    expect(sessionsOf(ids.op).map(s => s.viewId)).toEqual(['v-keep-2'])
    const view = await op.del(closeView)
    expect(view.status).toBe(200)
    expect(view.json().cleaned).toBeGreaterThanOrEqual(1)
    expect(sessionsOf(ids.op)).toEqual([])
    // Idempotente: repetir el cierre no falla.
    expect((await op.del(closeView)).status).toBe(200)
  })

  it('logout por cookie: borra ambas cookies con su Path, la sesión en DB y el WS (4003); después refresh y ws-ticket ⇒ 401', async () => {
    const b = env.browser('op2-logout')
    await b.signIn('op2_ck')
    const ws = await b.openAlerts()
    const sessionsBefore = await env.prisma.session.count({ where: { userId: ids.op2 } })
    const lo = await b.post('/api/auth/logout', {})
    expect(lo.status).toBe(200)
    const cleared = lo.setCookies.map(c => ({ name: c.name, path: c.path, expired: (c.expires?.getTime() ?? Infinity) <= Date.now() || c.maxAge === 0 }))
    expect(cleared).toEqual(expect.arrayContaining([
      { name: 'access_token', path: '/', expired: true },
      { name: 'refresh_token', path: '/api/auth', expired: true },
    ]))
    expect(b.accessToken).toBeUndefined()
    expect(b.refreshToken).toBeUndefined()
    expect(await env.prisma.session.count({ where: { userId: ids.op2 } })).toBe(sessionsBefore - 1)
    expect(await ws.closed).toBe(4003)
    expect((await b.post('/api/auth/refresh', {})).status).toBe(401)
    expect((await b.post('/api/auth/ws-ticket')).status).toBe(401)
  })

  it('listener TCP real (127.0.0.1:<puerto>): login, /me, heartbeat con y sin Origin, y hls-auth desde loopback con la misma cookie; rate-limit en el Redis aislado', async () => {
    const login = await env.tcp('POST', '/api/auth/login', { origin: JOINT_ORIGIN }, { username: 'op_ck', password: JOINT_PASSWORD, rememberMe: false })
    expect(login.status).toBe(200)
    const access = login.setCookies.find(c => c.name === 'access_token')!
    expect(parseSetCookie(access.raw)).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' })
    const cookie = `access_token=${access.value}`
    expect((await env.tcp('GET', '/api/auth/me', { cookie })).json().id).toBe(ids.op)
    const hbNoOrigin = await env.tcp('POST', '/api/live-view/heartbeat', { cookie }, { viewId: 'v-tcp', visibleCameraIds: [camA] })
    expect(hbNoOrigin.status).toBe(403)
    const hb = await env.tcp('POST', '/api/live-view/heartbeat', { cookie, origin: JOINT_ORIGIN }, { viewId: 'v-tcp', visibleCameraIds: [camA] })
    expect(hb.status).toBe(200)
    const hls = await env.tcp('GET', '/internal/hls-auth', { cookie, 'x-original-uri': hb.json().streams[camA].hls })
    expect(hls.status).toBe(200)
    expect((await env.tcp('GET', '/internal/hls-auth', { 'x-original-uri': hlsUri(1) })).status).toBe(401)
    // Cabeceras de seguridad de helmet en la respuesta real.
    expect(login.headers['x-content-type-options']).toBe('nosniff')
    // El contador de rate-limit vive en el Redis de la corrida (prefijo propio).
    expect((await env.redisKeys('*rate-limit*')).length).toBeGreaterThan(0)
  })

  it('higiene: sin red saliente ni contacto con el NVR', () => {
    expect(env.blockedConnections).toEqual([])
    expect(infra.of('nvr.isapi')).toEqual([])
    expect(infra.of('proc.spawn')).toEqual([])
  })
})
