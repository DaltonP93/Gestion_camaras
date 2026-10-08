// Suite conjunta de seguridad — MFA (#190 × #189 × #182 sobre server.ts real).
//
// Cubre la dependencia de merge MFA-01/CHW-01: con #189 y sin #190 el tempToken del
// primer factor abría hls-auth y el heartbeat. Aquí TODOS los tokens se obtienen
// de las rutas reales (login → tempToken / enrollToken, step-up, refresh) y se
// prueban como Bearer y como cookie access_token contra el server.ts completo.
// Ver harness.ts (qué es real y qué se simula).
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
  jointInfraAvailable, startJointServer, totpNow, decodeJwt, signHs256,
  JOINT_PASSWORD, type JointEnv, type SimBrowser,
} from './harness'

const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-01T10:05:00.000Z'

describe.skipIf(!jointInfraAvailable())('conjunta · MFA: tokens intermedios, 2FA, enrolamiento, step-up y refresh', { timeout: 60_000 }, () => {
  let env: JointEnv
  let nvrId = ''
  let camA = ''
  let camB = ''
  const users: Record<string, { id: string; username: string; secret?: string }> = {}
  /** Tokens NO-access emitidos por las rutas reales. */
  const tokens: Record<'tempToken2fa' | 'enrollToken' | 'stepUpToken' | 'refreshToken', string> = {} as any
  let admin: SimBrowser

  const hlsUri = (channel: number, type = 'sub') => `/hls/nvr_${nvrId}_ch${String(channel).padStart(2, '0')}_${type}/index.m3u8`

  beforeAll(async () => {
    env = await startJointServer({ label: 'mfa', nativePlayback: true })
    // Política MFA activa con gracia: el ADMIN sin MFA entra por gracia (access
    // completo); op_mfa recibe desafío 2FA; op_enrol, enrolamiento forzoso.
    await env.setSecurity({ mfaRequired: true, mfaGracePeriodLogins: 10 })
    nvrId = (await env.createNvr('NVR conjunto MFA', '192.0.2.10')).id
    camA = (await env.createCamera(nvrId, 1)).id
    camB = (await env.createCamera(nvrId, 2)).id
    users.admin = await env.createUser('admin_mfa', 'ADMIN')
    users.admin2 = await env.createUser('admin_refresh', 'ADMIN')
    users.opMfa = await env.createMfaUser('op_mfa', 'OPERATOR')
    users.opEnrol = await env.createUser('op_enrol', 'OPERATOR', { forceMfaEnrollment: true })
    for (const u of [users.opMfa, users.opEnrol]) await env.grant(u.id, nvrId, camA, { canView: true })

    // Tokens intermedios reales.
    const l1 = await env.browser('obtiene-temp').login('op_mfa')
    expect(l1.status).toBe(200)
    expect(l1.json().requiresTwoFactor).toBe(true)
    expect(l1.setCookies.map(c => c.name)).not.toContain('access_token')
    tokens.tempToken2fa = l1.json().tempToken

    const l2 = await env.browser('obtiene-enroll').login('op_enrol')
    expect(l2.json().requiresMfaEnrollment).toBe(true)
    expect(l2.setCookies.map(c => c.name)).not.toContain('access_token')
    tokens.enrollToken = l2.json().enrollToken

    admin = env.browser('admin')
    await admin.signIn('admin_mfa')
    const su = await admin.post('/api/auth/step-up', { password: JOINT_PASSWORD })
    expect(su.status).toBe(200)
    tokens.stepUpToken = su.json().stepUpToken
    tokens.refreshToken = admin.refreshToken!
    expect(tokens.refreshToken).toBeTruthy()

    // Forma de cada token (lo que #190 distingue).
    expect(decodeJwt(tokens.tempToken2fa)).toMatchObject({ sub: users.opMfa.id, step: '2fa' })
    expect(decodeJwt(tokens.enrollToken)).toMatchObject({ sub: users.opEnrol.id, step: 'mfa-enroll' })
    expect(decodeJwt(tokens.stepUpToken)).toMatchObject({ sub: users.admin.id, step: 'elevated' })
    expect(decodeJwt(tokens.refreshToken)).toHaveProperty('jti')
  }, 120_000)

  afterAll(async () => { await env?.stop() })

  /** Rutas que un token intermedio NO debe abrir (método, url, cuerpo). */
  const protectedRoutes = (): Array<[string, string, unknown?]> => [
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/ws-ticket'],
    ['POST', '/api/auth/step-up', { password: JOINT_PASSWORD }],
    ['GET', '/api/auth/2fa/setup'],
    ['POST', '/api/auth/change-password', { currentPassword: JOINT_PASSWORD, newPassword: 'Otra-Clave-Distinta-2026!' }],
    ['POST', '/api/auth/logout', {}],
    ['POST', '/api/live-view/heartbeat', { viewId: 'v-matriz', visibleCameraIds: [camA, camB] }],
    ['POST', '/api/live-view/media-grant', { viewId: 'v-matriz', cameraId: camA, transport: 'whep', device: 'sim' }],
    ['POST', `/api/cameras/${camA}/start-stream`, { viewId: 'v-matriz' }],
    ['GET', `/api/recordings/search?cameraId=${camA}&startTime=${T0}&endTime=${T1}`],
    ['POST', '/api/recordings/playback', { cameraId: camA, startTime: T0, endTime: T1 }],
    ['PUT', '/api/appearance', { siteName: 'tomado' }],
    ['GET', '/api/users'],
    ['PUT', '/api/security/settings', { mfaRequired: false }],
  ]

  it('matriz: tempToken 2fa / enrollToken / step-up / refresh × (Bearer | cookie access_token) ⇒ 401 en todas las rutas, hls-auth y WS; sin efectos', async () => {
    const mark = infra.mark()
    const auditBefore = await env.prisma.auditLog.count()
    const failures: string[] = []
    let checked = 0
    for (const [kind, token] of Object.entries(tokens)) {
      for (const via of ['bearer', 'cookie'] as const) {
        // Navegador "limpio" del atacante: sólo el token bajo prueba.
        const b = env.browser(`atacante-${kind}-${via}`)
        if (via === 'cookie') b.plantCookie('access_token', token)
        const headers = via === 'bearer' ? { authorization: `Bearer ${token}` } : undefined
        for (const [method, url, body] of protectedRoutes()) {
          const r = await b.request(method, url, { body, headers })
          checked++
          if (r.status !== 401) failures.push(`${kind}/${via} ${method} ${url} ⇒ ${r.status}`)
        }
        // nginx → /internal/hls-auth desde loopback, con la cookie/Bearer del navegador.
        const h = await env.hlsAuth(hlsUri(1), via === 'cookie' ? { browser: b } : { bearer: token })
        checked++
        if (h.status !== 401) failures.push(`${kind}/${via} hls-auth ⇒ ${h.status}`)
      }
    }
    expect(failures).toEqual([])
    expect(checked).toBe(4 * 2 * (protectedRoutes().length + 1))

    // Ningún efecto: ni MediaMTX, ni FFmpeg, ni NVR, ni descifrado de credenciales.
    expect(infra.externalEffectsSince(mark)).toEqual([])
    // Ningún cambio de estado: política, contraseña y apariencia intactas; sin
    // auditoría de acceso a recursos.
    expect((await env.prisma.securitySettings.findUnique({ where: { id: 'singleton' } }))?.mfaRequired).toBe(true)
    const actions = (await env.prisma.auditLog.findMany({ skip: auditBefore, select: { action: true } })).map(a => a.action)
    expect(actions.filter(a => /RECORDING|SECURITY_SETTINGS|PASSWORD|LOGOUT|STEP_UP/.test(a))).toEqual([])
    expect((await env.browser('verifica-clave').login('admin_mfa')).status).toBe(200)

    // WebSocket sin ticket o con un JWT en lugar de ticket ⇒ 4001.
    const noTicket = await env.openWs(undefined)
    expect(await noTicket.closed).toBe(4001)
    const jwtAsTicket = await env.openWs(tokens.tempToken2fa)
    expect(await jwtAsTicket.closed).toBe(4001)
  })

  it('precedencia de cabecera: Bearer intermedio + cookie access válida ⇒ 401; Authorization no-Bearer (Basic) + cookie válida ⇒ 200', async () => {
    const withTemp = await admin.get('/api/auth/me', { headers: { authorization: `Bearer ${tokens.tempToken2fa}` } })
    expect(withTemp.status).toBe(401)
    const withBasic = await admin.get('/api/auth/me', { headers: { authorization: 'Basic dXN1YXJpbzpmYWxzbw==' } })
    expect(withBasic.status).toBe(200)
    expect(withBasic.json().id).toBe(users.admin.id)
  })

  it('2fa/verify con TOTP real ⇒ cookies HttpOnly/SameSite=Strict; el access abre sólo la cámara propia (hls-auth y heartbeat)', async () => {
    const b = env.browser('op-mfa')
    const l = await b.login('op_mfa')
    expect(l.json().requiresTwoFactor).toBe(true)
    // Antes del 2.º factor el navegador no tiene sesión.
    expect(b.accessToken).toBeUndefined()
    expect((await b.heartbeat('v-op', [camA])).status).toBe(401)

    const v = await b.verify2fa(l.json().tempToken, await totpNow(users.opMfa.secret!))
    expect(v.status).toBe(200)
    const access = v.setCookies.find(c => c.name === 'access_token')
    const refresh = v.setCookies.find(c => c.name === 'refresh_token')
    expect(access).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Strict' })
    expect(refresh).toMatchObject({ path: '/api/auth', httpOnly: true, sameSite: 'Strict' })
    // El JWT no viaja en el cuerpo (sólo en cookies HttpOnly).
    expect(v.text).not.toContain(access!.value)
    const claims = decodeJwt(b.accessToken!)
    expect(claims).toMatchObject({ sub: users.opMfa.id, role: 'OPERATOR' })
    expect(claims).not.toHaveProperty('step')
    expect(claims).not.toHaveProperty('jti')

    expect((await b.get('/api/auth/me')).json().username).toBe('op_mfa')
    expect((await env.hlsAuth(hlsUri(1), { browser: b })).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(2), { browser: b })).status).toBe(403)

    const mark = infra.mark()
    const hb = await b.heartbeat('v-op', [camA, camB])
    expect(hb.status).toBe(200)
    expect(Object.keys(hb.json().streams)).toEqual([camA])
    expect(hb.json().errors[camB]?.code).toBe('NO_PERMISSION')
    expect(infra.of('mediamtx.publish', mark).map(c => c.detail.cameraId)).toEqual([camA])

    const ws = await b.openAlerts()
    expect(await ws.opened).toBe(true)
    ws.ws.close()
  })

  it('step-up: sin cabecera 403 STEP_UP_REQUIRED; el propio 200; el de otro usuario, vencido o firmado con otro secreto ⇒ 403; nunca 500', async () => {
    const put = (headers?: Record<string, string>) => admin.put('/api/security/settings', { maxSessions: 5 }, { headers })
    const none = await put()
    expect(none.status).toBe(403)
    expect(none.json().code).toBe('STEP_UP_REQUIRED')

    const st = await admin.post('/api/auth/step-up', { password: JOINT_PASSWORD })
    expect(st.status).toBe(200)
    expect((await put({ 'x-step-up-token': st.json().stepUpToken })).status).toBe(200)

    // Step-up de op_mfa (TOTP: con MFA activo la contraseña no alcanza).
    const op = env.browser('op-mfa-stepup')
    await op.signIn('op_mfa', users.opMfa.secret)
    const byPassword = await op.post('/api/auth/step-up', { password: JOINT_PASSWORD })
    expect(byPassword.status).toBe(400)
    expect(byPassword.json().code).toBe('CODE_REQUIRED')
    const opStep = await op.post('/api/auth/step-up', { code: await totpNow(users.opMfa.secret!) })
    expect(opStep.status).toBe(200)
    const foreign = await put({ 'x-step-up-token': opStep.json().stepUpToken })
    expect(foreign.status).toBe(403)
    expect(foreign.json().code).toBe('STEP_UP_REQUIRED')

    const now = Math.floor(Date.now() / 1000)
    const expired = signHs256({ sub: users.admin.id, step: 'elevated', iat: now - 600, exp: now - 300 }, env.jwtSecret)
    expect((await put({ 'x-step-up-token': expired })).status).toBe(403)
    const otherKey = signHs256({ sub: users.admin.id, step: 'elevated', iat: now, exp: now + 300 }, 'otra-clave-que-no-es-la-del-servidor-0123456789')
    expect((await put({ 'x-step-up-token': otherKey })).status).toBe(403)
    // Un access token en x-step-up-token no eleva (falta step=elevated).
    expect((await put({ 'x-step-up-token': admin.accessToken! })).status).toBe(403)
  })

  it('enrolamiento forzoso: enrollToken no abre /2fa/setup; start+complete emiten cookies y 10 códigos; el access sólo abre su cámara; un código de respaldo es de un solo uso', async () => {
    const e = env.browser('op-enrol')
    const l = await e.login('op_enrol')
    const enrollToken = l.json().enrollToken as string
    expect((await e.get('/api/auth/2fa/setup', { headers: { authorization: `Bearer ${enrollToken}` } })).status).toBe(401)

    const start = await e.post('/api/auth/mfa/enroll/start', { enrollToken })
    expect(start.status).toBe(200)
    const secret = start.json().secret as string
    const done = await e.post('/api/auth/mfa/enroll/complete', { enrollToken, code: await totpNow(secret), rememberMe: true })
    expect(done.status).toBe(200)
    const backupCodes = done.json().backupCodes as string[]
    expect(backupCodes).toHaveLength(10)
    expect(e.accessToken).toBeTruthy()
    expect((await e.get('/api/auth/me')).json()).toMatchObject({ id: users.opEnrol.id, twoFactorEnabled: true })
    expect((await env.hlsAuth(hlsUri(1), { browser: e })).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(2), { browser: e })).status).toBe(403)
    // Completado el enrolamiento, el mismo enrollToken ya no arranca otro.
    expect((await e.post('/api/auth/mfa/enroll/start', { enrollToken })).status).toBe(400)

    // Próximo login: desafío 2FA; el código de respaldo sirve UNA vez.
    const b1 = env.browser('op-enrol-backup-1')
    const t1 = (await b1.login('op_enrol')).json().tempToken as string
    expect((await b1.verify2fa(t1, backupCodes[0])).status).toBe(200)
    const b2 = env.browser('op-enrol-backup-2')
    const t2 = (await b2.login('op_enrol')).json().tempToken as string
    expect((await b2.verify2fa(t2, backupCodes[0])).status).toBe(401)
    expect(b2.accessToken).toBeUndefined()
    const stored = await env.prisma.user.findUniqueOrThrow({ where: { id: users.opEnrol.id } })
    expect(JSON.parse(stored.twoFactorBackupCodes!)).toHaveLength(9)
  })

  it('refresh por cookie: rota y emite un access sin jti/step; sin Origin ⇒ CSRF; el viejo dentro de 30 s ⇒ TOKEN_ROTATED; fuera ⇒ TOKEN_REUSE y revoca la familia; access como refresh ⇒ 401', async () => {
    const b = env.browser('admin-refresh')
    await b.signIn('admin_refresh')
    const oldRefresh = b.refreshToken!

    const r1 = await b.post('/api/auth/refresh', {})
    expect(r1.status).toBe(200)
    // El refresh rota (jti nuevo). El access NO lleva jti: dentro del mismo segundo
    // puede salir byte a byte igual al anterior, así que sólo se verifica su forma.
    expect(b.refreshToken).not.toBe(oldRefresh)
    expect(r1.setCookies.map(c => c.name).sort()).toEqual(['access_token', 'refresh_token'])
    const claims = decodeJwt(b.accessToken!)
    expect(claims).toMatchObject({ sub: users.admin2.id, role: 'ADMIN' })
    expect(claims).not.toHaveProperty('jti')
    expect(claims).not.toHaveProperty('step')
    expect((await b.get('/api/auth/me')).status).toBe(200)

    // Con la cookie y sin Origin (o con uno ajeno) ⇒ CSRF antes de tocar la sesión.
    const noOrigin = await b.post('/api/auth/refresh', {}, { origin: null })
    expect(noOrigin.status).toBe(403)
    expect(noOrigin.json().code).toBe('CSRF_BLOCKED')
    expect((await b.post('/api/auth/refresh', {}, { origin: 'https://atacante.example' })).json().code).toBe('CSRF_BLOCKED')

    // Reuso del refresh rotado dentro de la gracia (otra pestaña): benigno.
    const stale = env.browser('admin-refresh-vieja')
    stale.plantCookie('refresh_token', oldRefresh, '/api/auth')
    const rotated = await stale.post('/api/auth/refresh', {})
    expect(rotated.status).toBe(401)
    expect(rotated.json().code).toBe('TOKEN_ROTATED')
    expect(await env.prisma.session.count({ where: { userId: users.admin2.id } })).toBe(1)

    // Un access no es un refresh.
    const accessAsRefresh = await env.browser('access-como-refresh').post('/api/auth/refresh', { refreshToken: b.accessToken })
    expect(accessAsRefresh.status).toBe(401)

    // Fuera de la gracia ⇒ posible robo: se revoca toda la familia.
    await env.prisma.usedRefreshToken.updateMany({ where: { userId: users.admin2.id }, data: { usedAt: new Date(Date.now() - 31_000) } })
    const reuse = await stale.post('/api/auth/refresh', {})
    expect(reuse.status).toBe(401)
    expect(reuse.json().code).toBe('TOKEN_REUSE')
    expect(await env.prisma.session.count({ where: { userId: users.admin2.id } })).toBe(0)
    expect((await b.post('/api/auth/refresh', {})).status).toBe(401)
  })

  it('compatibilidad de despliegue: un access con la forma previa a #190 {sub, username, role} sigue válido; con jti, step o rol desconocido ⇒ 401', async () => {
    const now = Math.floor(Date.now() / 1000)
    const base = { sub: users.admin.id, username: 'admin_mfa', role: 'ADMIN', iat: now, exp: now + 300 }
    const call = (claims: Record<string, unknown>) => env.browser('legacy').get('/api/auth/me', {
      headers: { authorization: `Bearer ${signHs256(claims, env.jwtSecret)}` },
    })
    expect((await call(base)).status).toBe(200)
    expect((await call({ ...base, jti: 'x' })).status).toBe(401)
    expect((await call({ ...base, step: '2fa' })).status).toBe(401)
    expect((await call({ ...base, role: 'ROOT' })).status).toBe(401)
    expect((await call({ ...base, exp: now - 1 })).status).toBe(401)
  })

  it('higiene: sin red saliente, jobs simulados, re-registro diferido capturado y sin contacto con el NVR', () => {
    expect(env.blockedConnections).toEqual([])
    expect(env.deferredReregister).toBe(1)
    expect(infra.of('jobs.healthWorker')).toHaveLength(1)
    expect(infra.of('jobs.syncWorker')).toHaveLength(1)
    expect(infra.of('streams.reregister')).toEqual([])
    expect(infra.of('nvr.isapi')).toEqual([])
    expect(infra.of('proc.spawn')).toEqual([])
  })
})
