// Suite conjunta de seguridad — DEFECTOS conocidos (server.ts real, misma harness).
//
// Cada prueba está escrita esperando el COMPORTAMIENTO SEGURO y hoy FALLA a
// propósito: documenta un defecto real reproducido en la rama integrada
// (#182 + #186 + #189 + #190). Ninguno es introducido por la combinación: son
// pendientes previos que la combinación deja a la vista (ver hallazgos citados).
// NO se deben debilitar ni marcar como `fails`: se ponen en verde corrigiendo el
// código. Se agrupan en este archivo para que las cinco suites temáticas
// (mfa, cookies-csrf, hls, revocation, playback) sigan siendo una regresión verde
// de la combinación.
//
// Corren SÓLO con RUN_KNOWN_DEFECTS=1 (`npm run test:known-defects`): son evidencia
// ejecutable de defectos PREVIOS, fuera del alcance de estos PRs, y no deben poner
// en rojo el job de la combinación. El estado de cada uno (y el PR que lo corrige,
// si existe) está en docs/security/JOINT_REVIEW_182_186_189_190.md. Al corregir un
// defecto, su prueba se mueve a la suite temática correspondiente. El defecto de configuración de arranque (CHW-09) vive en
// arranque.joint.test.ts porque necesita su propio server.ts.
//
// Las aserciones usan `expect.soft` cuando un mismo defecto se ve en varias rutas,
// para que el reporte liste TODAS las violaciones de una vez.
//
// El plano de medios nativo (NATIVE_PLAYBACK/NATIVE_MEDIA_RELAY) se activa SÓLO en
// esta corrida para ejercer el auth-hook de MediaMTX y el revoke→kick (kicker espía);
// en producción esas flags siguen NO-GO.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))

import WebSocket from 'ws'
import { infra } from './infra-doubles'
import {
  jointInfraAvailable, startJointServer, totpNow, waitFor, decodeJwt, JOINT_PASSWORD, NVR_FAKE_USER, NVR_FAKE_PASS,
  JOINT_HOST, JOINT_ORIGIN, NGINX_INTERNAL_IP,
  type JointEnv, type SimBrowser, type JointResponse,
} from './harness'

const RUN_KNOWN_DEFECTS = process.env.RUN_KNOWN_DEFECTS === '1'

const NVR_IP = '192.0.2.60'
const DENIED = [401, 403, 404, 410]
const win = (fromMin: number) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  const s = `2026-10-01T11:${pad(fromMin)}:00.000Z`
  const e = `2026-10-01T11:${pad(fromMin + 5)}:00.000Z`
  const uri = `/Streaming/tracks/101/?starttime=20261001T11${pad(fromMin)}00Z&endtime=20261001T11${pad(fromMin + 5)}00Z`
  return { startTime: s, endTime: e, playbackURI: uri }
}

describe.runIf(jointInfraAvailable() && RUN_KNOWN_DEFECTS)('conjunta · DEFECTOS conocidos (esperan el comportamiento seguro)', { timeout: 60_000 }, () => {
  let env: JointEnv
  let sm: typeof import('../services/stream-manager')
  let wsMod: typeof import('../routes/websocket')
  let gs: typeof import('../services/media/grant-service')
  let nvrId = ''
  let camA = ''
  let camB = ''
  let admin: SimBrowser

  const hlsUri = (channel: number) => `/hls/nvr_${nvrId}_ch${String(channel).padStart(2, '0')}_sub/index.m3u8`
  const newUser = async (username: string, role: 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR', perms: Array<[string, Record<string, boolean>]> = []) => {
    const u = await env.createUser(username, role)
    for (const [cameraId, p] of perms) await env.grant(u.id, nvrId, cameraId, p)
    const b = env.browser(username)
    await b.signIn(username)
    return { id: u.id, b }
  }
  /** Reproducción VOD hasta 'ready' (FFmpeg simulado escribe bytes sintéticos). */
  const playUntilReady = async (b: SimBrowser, cameraId: string, w: ReturnType<typeof win>) => {
    infra.ffmpegMode = 'vod-ok'
    const p = await b.post('/api/recordings/playback', { cameraId, ...w })
    expect(p.status).toBe(200)
    if (p.json().status === 'ready') return p.json()
    return waitFor(async () => {
      const st = await b.get(p.json().pollUrl)
      return st.json().status === 'ready' ? { ...st.json(), sessionId: p.json().sessionId, pollUrl: p.json().pollUrl } : null
    }, 'VOD listo', 15_000, 50)
  }
  /** Step-up real del ADMIN (contraseña) para las rutas que lo exigen. */
  const adminStepUp = async (): Promise<Record<string, string>> => {
    const su = await admin.post('/api/auth/step-up', { password: JOINT_PASSWORD })
    expect(su.status).toBe(200)
    return { 'x-step-up-token': su.json().stepUpToken }
  }
  /** GET del stream de preview (hijack): se espera con tope y nunca se deja colgado. */
  const getPreviewStream = async (b: SimBrowser, url: string, ms = 15_000): Promise<JointResponse | null> =>
    Promise.race([b.get(url), new Promise<null>(r => setTimeout(() => r(null), ms))])

  beforeAll(async () => {
    env = await startJointServer({ label: 'def', nativeRelay: true })
    sm = await import('../services/stream-manager')
    wsMod = await import('../routes/websocket')
    gs = await import('../services/media/grant-service')
    nvrId = (await env.createNvr('NVR conjunto defectos', NVR_IP)).id
    camA = (await env.createCamera(nvrId, 1)).id
    camB = (await env.createCamera(nvrId, 2)).id
    await env.createUser('admin_def', 'ADMIN')
    admin = env.browser('admin'); await admin.signIn('admin_def')
  }, 120_000)

  afterAll(async () => {
    infra.ffmpegMode = 'vod-ok'
    try { sm?.__resetSessionsForTest() } catch { /* noop */ }
    await env?.stop()
  })

  it('REV-01/PB-02/CHW-14 — revocar canPlayback corta el MP4 (fileToken), la descarga (24 h), el status y el stream de preview ya emitidos', async () => {
    const { id, b } = await newUser('aud_rev_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true, canDownload: true }]])
    const ready = await playUntilReady(b, camA, win(0))
    expect(ready.downloadUrl).toMatch(/^\/api\/recordings\/download\?t=/)
    const pv = await b.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 0, ...win(0) })
    expect(pv.json().status).toBe('ready')

    const rev = await admin.put(`/api/users/${id}/permissions`, { cameraPermissions: [{ cameraId: camA, canView: false, canPlayback: false, canDownload: false }] })
    expect(rev.status).toBe(200)
    expect((await b.post('/api/recordings/playback', { cameraId: camA, ...win(0) })).status).toBe(403)   // esto ya funciona

    // DEFECTO: los tokens opacos (file.mp4 30 min, download 24 h, stream de preview)
    // no se atan al usuario ni se revalidan: siguen sirviendo tras la revocación.
    const mark = infra.mark()
    expect.soft(DENIED, 'file.mp4 tras revocar').toContain((await b.get(ready.url)).status)
    expect.soft(DENIED, 'download tras revocar').toContain((await env.browser('cualquiera').get(ready.downloadUrl)).status)
    const st = await b.get(`/api/recordings/playback/${ready.sessionId}/status`)
    expect.soft(st.status === 200 ? (st.json().url ?? st.json().downloadUrl ?? null) : null, 'status re-expone url/downloadUrl').toBeNull()
    const stream = await getPreviewStream(b, pv.json().streamUrl)
    expect.soft(infra.of('proc.spawn', mark).length, 'FFmpeg relanzado contra el NVR tras revocar').toBe(0)
    expect.soft(stream ? DENIED.includes(stream.status) : false, 'stream de preview tras revocar').toBe(true)
    await admin.del(`/api/recordings/preview/${pv.json().sessionId}`)
  })

  it('REV-01/PB-02 — tras el logout del titular, la descarga y el MP4 ya emitidos dejan de servir', async () => {
    const { b } = await newUser('aud_logout_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true, canDownload: true }]])
    const ready = await playUntilReady(b, camA, win(10))
    expect((await b.post('/api/auth/logout', {})).status).toBe(200)
    // DEFECTO: el token de descarga (24 h) y el fileToken no se revocan en el logout.
    expect.soft(DENIED, 'download tras logout').toContain((await env.browser('tercero').get(ready.downloadUrl)).status)
    expect.soft(DENIED, 'file.mp4 tras logout').toContain((await env.browser('tercero2').get(ready.url)).status)
  })

  it('PB-01/REV-02 — sin canDownload (cámara) ni canDownloadRecordings (función) no se emite exportación MP4', async () => {
    const { id, b } = await newUser('aud_nodl_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true, canDownload: false }]])
    await env.prisma.userFeaturePermissions.create({ data: { userId: id, canViewRecordings: true, canDownloadRecordings: false } })
    const ready = await playUntilReady(b, camA, win(20))
    expect(ready.url).toBeTruthy()   // ver sí (reproducción)
    // DEFECTO: exportar no debería ser posible sin permiso de descarga, pero se
    // emite downloadUrl (attachment) a todo el que puede reproducir.
    expect.soft(ready.downloadUrl ?? null, 'downloadUrl emitido sin canDownload').toBeNull()
    if (ready.downloadUrl) {
      const dl = await b.get(ready.downloadUrl)
      expect.soft(dl.status, 'descarga servida sin canDownload').not.toBe(200)
    }
  })

  it('MFA-02/CHW-08 — tras el logout, el access copiado ya no abre /me, el heartbeat ni hls-auth', async () => {
    const { b } = await newUser('op_logout_def', 'OPERATOR', [[camA, { canView: true }]])
    const copied = b.accessToken!
    expect((await b.post('/api/auth/logout', {})).status).toBe(200)
    const mark = infra.mark()
    const thief = env.browser('ladron-logout')
    // DEFECTO: el access JWT es stateless (sin sid/epoch) y vive hasta su exp.
    expect.soft((await thief.get('/api/auth/me', { headers: { authorization: `Bearer ${copied}` } })).status, '/me con access post-logout').toBe(401)
    expect.soft((await thief.heartbeat('v-ladron', [camA], { headers: { authorization: `Bearer ${copied}` } })).status, 'heartbeat con access post-logout').toBe(401)
    expect.soft(infra.of('mediamtx.publish', mark), 'stream iniciado con access post-logout').toEqual([])
    expect.soft((await env.hlsAuth(hlsUri(1), { cookie: copied })).status, 'hls-auth con access post-logout').toBe(401)
    expect((await thief.post('/api/auth/ws-ticket', undefined, { headers: { authorization: `Bearer ${copied}` } })).status).toBe(401) // ya funciona
  })

  it('CHW-05 — desactivar al usuario corta hls-auth y el heartbeat del access vigente (no sólo el WS)', async () => {
    const { id, b } = await newUser('op_baja_def', 'OPERATOR', [[camA, { canView: true }]])
    const ws = await b.openAlerts()
    expect((await admin.put(`/api/users/${id}`, { active: false })).status).toBe(200)
    expect(await ws.closed).toBe(4003)                                   // ya funciona
    expect((await b.post('/api/auth/ws-ticket')).status).toBe(403)       // ya funciona
    const mark = infra.mark()
    // DEFECTO: hls-auth y heartbeat no consultan `active` ni la sesión.
    expect.soft(DENIED, 'hls-auth de usuario desactivado').toContain((await env.hlsAuth(hlsUri(1), { browser: b })).status)
    const hb = await b.heartbeat('v-baja', [camA])
    expect.soft(hb.status === 200 ? Object.keys(hb.json().streams) : [], 'heartbeat de usuario desactivado').toEqual([])
    expect.soft(infra.of('mediamtx.publish', mark), 'stream iniciado por usuario desactivado').toEqual([])
    expect((await b.post('/api/auth/refresh', {})).status).toBe(401)     // ya funciona
  })

  it('CHW-05/REV-08/PB-03 — degradar SUPERVISOR→OPERATOR o ADMIN→OPERATOR y borrar al usuario surte efecto en la siguiente petición', async () => {
    const sup = await newUser('sup_deg_def', 'SUPERVISOR')
    expect((await admin.put(`/api/users/${sup.id}`, { role: 'OPERATOR' })).status).toBe(200)
    const mark = infra.mark()
    // DEFECTO: el rol sale del claim del JWT, no de la DB.
    expect.soft((await env.hlsAuth(hlsUri(2), { browser: sup.b })).status, 'hls-auth con rol degradado').toBe(403)
    const hb = await sup.b.heartbeat('v-deg', [camB])
    expect.soft(Object.keys(hb.json().streams ?? {}), 'heartbeat con rol degradado').toEqual([])
    const search = await sup.b.get(`/api/recordings/search?cameraId=${camB}&startTime=2026-10-01T11:00:00.000Z&endTime=2026-10-01T11:05:00.000Z`)
    expect.soft(search.status, 'grabaciones con rol degradado').toBe(403)
    expect.soft(infra.of('credentials.decrypt', mark), 'credenciales NVR descifradas para un rol degradado').toEqual([])

    // Lo que YA corta: el refresh relee rol/activo de la DB y emite un access OPERATOR,
    // con el que el borde deniega. La ventana es la del access viejo (sessionTimeoutMinutes).
    const refreshed = env.browser('sup_deg_refresh')
    refreshed.plantCookie('refresh_token', sup.b.refreshToken!, '/api/auth')
    expect((await refreshed.post('/api/auth/refresh', {})).status).toBe(200)
    expect(decodeJwt(refreshed.accessToken!).role).toBe('OPERATOR')
    expect((await env.hlsAuth(hlsUri(2), { browser: refreshed })).status).toBe(403)

    const adm2 = await newUser('admin_deg_def', 'ADMIN')
    expect((await admin.put(`/api/users/${adm2.id}`, { role: 'OPERATOR' })).status).toBe(200)
    expect.soft((await adm2.b.get('/api/users')).status, 'ADMIN degradado sigue administrando').toBe(403)

    const del = await newUser('sup_borrado_def', 'SUPERVISOR')
    const su = await admin.post('/api/auth/step-up', { password: JOINT_PASSWORD })
    expect((await admin.del(`/api/users/${del.id}`, { headers: { 'x-step-up-token': su.json().stepUpToken } })).status).toBe(200)
    expect.soft(DENIED, 'hls-auth de usuario borrado').toContain((await env.hlsAuth(hlsUri(2), { browser: del.b })).status)
  })

  it('MFA-04 — el tempToken y el código TOTP son de un solo uso', async () => {
    const u = await env.createMfaUser('op_totp_def', 'OPERATOR')
    const b1 = env.browser('totp-1')
    const temp = (await b1.login('op_totp_def')).json().tempToken as string
    const code = await totpNow(u.secret)
    expect((await b1.verify2fa(temp, code)).status).toBe(200)
    // DEFECTO: ni el tempToken ni el timestep TOTP se consumen.
    const replay = await env.browser('totp-replay').verify2fa(temp, code)
    expect.soft(replay.status, 'mismo tempToken + mismo código').toBe(401)
    const b3 = env.browser('totp-3')
    const temp2 = (await b3.login('op_totp_def')).json().tempToken as string
    expect.soft((await b3.verify2fa(temp2, code)).status, 'mismo código TOTP con otro login').toBe(401)
    expect.soft(await env.prisma.session.count({ where: { userId: u.id } }), 'sesiones creadas con un único código').toBe(1)
    // El mismo código tampoco debería servir para elevar (step-up) en la sesión ya abierta.
    expect.soft((await b1.post('/api/auth/step-up', { code })).status, 'step-up con el código TOTP ya usado').not.toBe(200)
  })

  it('REV-05 — un heartbeat en vuelo que cruza el commit de la revocación no arranca ni devuelve la cámara revocada (invariante 4)', async () => {
    const { id, b } = await newUser('op_carrera_def', 'OPERATOR', [[camA, { canView: true }], [camB, { canView: true }]])
    const delegate = (env.server as any).prisma.userPermission
    const realFindMany = delegate.findMany.bind(delegate)
    let release: (() => void) | null = null
    let entered: (() => void) | null = null
    const enteredP = new Promise<void>(r => { entered = r })
    const spy = vi.spyOn(delegate, 'findMany').mockImplementation((async (args: any) => {
      const rows = await realFindMany(args)
      if (args?.where?.userId === id && args?.where?.cameraId?.in) {
        entered!()
        await new Promise<void>(r => { release = r })
      }
      return rows
    }) as any)
    let res: JointResponse
    const mark = infra.mark()
    try {
      const inflight = b.heartbeat('v-carrera', [camA, camB])
      await enteredP
      expect((await admin.put(`/api/users/${id}/permissions`, { cameraPermissions: [{ cameraId: camB, canView: false }] })).status).toBe(200)
      release!()
      res = await inflight
    } finally {
      spy.mockRestore()
    }
    // DEFECTO: la lectura de permisos ocurre antes de reconcileView; la respuesta
    // "vieja" arranca B, crea su sesión y devuelve su URL.
    expect.soft(Object.keys(res!.json().streams), 'respuesta en vuelo con la cámara revocada').toEqual([camA])
    expect.soft(infra.of('mediamtx.publish', mark).map(c => c.detail.cameraId), 'publicación de la cámara revocada').not.toContain(camB)
    expect.soft(sm.getActiveSessions().filter(s => s.userId === id && s.cameraId === camB), 'sesión creada para la cámara revocada').toEqual([])
    expect((await env.hlsAuth(hlsUri(2), { browser: b })).status).toBe(403)   // el borde sí corta
  })

  it('CHW-07 — un ticket WS emitido antes de desactivar al usuario no abre un WS para el inactivo', async () => {
    const { id, b } = await newUser('op_ticket_def', 'OPERATOR', [[camA, { canView: true }]])
    const t = await b.post('/api/auth/ws-ticket')
    expect(t.status).toBe(200)
    expect((await admin.put(`/api/users/${id}`, { active: false })).status).toBe(200)
    const h = await env.openWs(t.json().ticket)
    await h.opened
    await new Promise(r => setTimeout(r, 150))
    wsMod.broadcastAlert({ type: 'alert', alert: { id: 'alerta-carrera-def', title: 'NVR sin disco' } })
    await new Promise(r => setTimeout(r, 150))
    // DEFECTO: el canje del ticket no revalida `active` ni la sesión.
    expect.soft(h.ws.readyState, 'WS abierto para un usuario desactivado').not.toBe(WebSocket.OPEN)
    expect.soft(h.messages.some(m => m.includes('alerta-carrera-def')), 'alerta entregada a un usuario desactivado').toBe(false)
    h.ws.terminate()
  })

  it('MFA-05 — /api/auth/me no expone credenciales del NVR (ni cifradas) ni datos internos de la cámara', async () => {
    const { b } = await newUser('op_me_def', 'OPERATOR', [[camA, { canView: true }]])
    const me = await b.get('/api/auth/me')
    expect(me.status).toBe(200)
    const nvr = await env.prisma.nVR.findUniqueOrThrow({ where: { id: nvrId } })
    const cam = await env.prisma.camera.findUniqueOrThrow({ where: { id: camA } })
    // DEFECTO: userMeSelect incluye `permissions: { include: { nvr: true, camera: true } }`
    // y el web persiste /me en localStorage ('visioncore-auth').
    expect.soft(me.text, 'usuario del NVR').not.toContain(NVR_FAKE_USER)
    expect.soft(me.text, 'contraseña cifrada del NVR').not.toContain(nvr.password)
    expect.soft(me.text, 'IP del NVR').not.toContain(NVR_IP)
    expect.soft(me.text, 'rtspUrl de la cámara').not.toContain(cam.rtspUrl!)
    expect.soft(me.text, 'IP de la cámara').not.toContain(cam.ipAddress!)
  })

  it('REV-03 — el modal granular guarda permisos NVR-scoped (PUT con nvrPermissions) y aplica la revocación de cámara en el mismo guardado', async () => {
    const u = await env.createUser('op_modal_def', 'OPERATOR')
    const body = { featurePermissions: {}, nvrPermissions: [{ nvrId, canView: true }], cameraPermissions: [] as Array<Record<string, unknown>> }
    // DEFECTO: upsert con `cameraId: null` en la clave compuesta ⇒ Prisma lo rechaza ⇒ ROLLBACK ⇒ 503.
    expect.soft((await admin.put(`/api/users/${u.id}/permissions`, body)).status, 'PUT con nvrPermissions').toBe(200)
    expect.soft((await admin.put(`/api/users/${u.id}/permissions`, body)).status, 'PUT repetido con nvrPermissions').toBe(200)
    expect.soft(await env.prisma.userPermission.count({ where: { userId: u.id, nvrId, cameraId: null } }), 'filas NVR-scoped').toBe(1)
    const withRevoke = await admin.put(`/api/users/${u.id}/permissions`, { ...body, cameraPermissions: [{ cameraId: camA, canView: false }] })
    expect.soft(withRevoke.status, 'guardado del modal que además revoca una cámara').toBe(200)
    const rowA = await env.prisma.userPermission.findFirst({ where: { userId: u.id, cameraId: camA } })
    expect.soft(rowA?.canView ?? null, 'revocación de A aplicada').toBe(false)
  })

  it('PB-05 — el diagnóstico de una reproducción fallida no entrega usuario ni IP del NVR a un no-ADMIN', async () => {
    const { b } = await newUser('aud_diag_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true }]])
    infra.ffmpegMode = 'fail-404'
    try {
      const pv = await b.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 2, ...win(30) })
      expect(pv.json().status).toBe('ready')
      const stream = await getPreviewStream(b, pv.json().streamUrl, 20_000)
      const status = await waitFor(async () => {
        const st = await b.get(`/api/recordings/preview/${pv.json().sessionId}/status`)
        return st.json().status === 'error' ? st : null
      }, 'preview en error', 20_000, 100)
      const visible = status.text + (stream ? stream.text : '')
      expect(visible).not.toContain(NVR_FAKE_PASS)   // la contraseña sí se enmascara
      // DEFECTO: maskUrlCredentials sólo oculta la contraseña; usuario e IP llegan al AUDITOR.
      expect.soft(visible, 'usuario del NVR en el diagnóstico').not.toContain(NVR_FAKE_USER)
      expect.soft(visible, 'IP del NVR en el diagnóstico').not.toContain(NVR_IP)
      await b.del(`/api/recordings/preview/${pv.json().sessionId}`)
    } finally {
      infra.ffmpegMode = 'vod-ok'
    }
  })

  it('PB-10 (HTTP) — Range en file.mp4 según RFC 9110: sufijo "bytes=-N", fin más allá del tamaño y multirango', async () => {
    const { b } = await newUser('aud_range_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true }]])
    const ready = await playUntilReady(b, camA, win(40))
    const size = 65536
    // DEFECTO: `bytes=-100` se interpreta como 0-100, un fin fuera de rango da 416 y
    // un multirango devuelve sólo el primer rango (RFC 9110 §14.1.2/§15.3.7: sufijo =
    // últimos N bytes; fin ≥ tamaño se recorta). Esto NO prueba el <video> real (PB-10).
    const suffix = await b.get(ready.url, { headers: { range: 'bytes=-100' } })
    expect.soft(`${suffix.status} ${suffix.headers['content-range']}`, 'sufijo bytes=-100').toBe(`206 bytes ${size - 100}-${size - 1}/${size}`)
    const beyond = await b.get(ready.url, { headers: { range: 'bytes=0-1048575' } })
    expect.soft(`${beyond.status} ${beyond.headers['content-range']}`, 'fin fuera de rango').toBe(`206 bytes 0-${size - 1}/${size}`)
    // Multirango: se acepta ignorarlo (200 completo), responder multipart/byteranges o
    // coalescer en un rango que cubra ambos; NO devolver sólo el primero como si fuera todo.
    const multi = await b.get(ready.url, { headers: { range: 'bytes=0-1,5-6' } })
    const multiOk = multi.status === 200 ||
      (multi.status === 206 && (/multipart\/byteranges/.test(String(multi.headers['content-type'])) || multi.headers['content-range'] === `bytes 0-6/${size}`))
    expect.soft(multiOk, `multirango bytes=0-1,5-6 ⇒ ${multi.status} ${multi.headers['content-range']}`).toBe(true)
    expect((await b.get(ready.url, { headers: { range: `bytes=${size}-` } })).status).toBe(416)   // ya correcto
  })

  it('PB-06 — un acierto de caché también registra VIEW_RECORDING del usuario que reproduce', async () => {
    const first = await newUser('aud_cache1_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true }]])
    await playUntilReady(first.b, camA, win(50))
    const second = await newUser('aud_cache2_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true }]])
    const hit = await second.b.post('/api/recordings/playback', { cameraId: camA, ...win(50) })
    expect(hit.json().status).toBe('ready')   // acierto de caché inmediato
    // DEFECTO: el camino de caché retorna antes de AuditAction('VIEW_RECORDING').
    expect.soft(await env.prisma.auditLog.count({ where: { userId: second.id, action: 'VIEW_RECORDING' } }), 'VIEW_RECORDING en acierto de caché').toBe(1)
  })

  it('CHW-08 — revocar las sesiones (admin), cambiar la contraseña o resetear el 2FA invalida el access ya emitido', async () => {
    const cases: Array<[string, string, (id: string, b: SimBrowser) => Promise<JointResponse>]> = [
      ['DELETE /users/:id/sessions', 'op_sesiones_def', (id) => admin.del(`/api/users/${id}/sessions`)],
      ['change-password', 'op_clave_def', (_id, b) => b.post('/api/auth/change-password', { currentPassword: JOINT_PASSWORD, newPassword: 'Otra-Clave-Distinta-2026!' })],
      ['reset-2fa (admin)', 'op_reset2fa_def', async (id) => admin.post(`/api/users/${id}/reset-2fa`, {}, { headers: await adminStepUp() })],
    ]
    for (const [label, username, action] of cases) {
      const { id, b } = await newUser(username, 'OPERATOR', [[camA, { canView: true }]])
      const copied = b.accessToken!
      expect((await action(id, b)).status, label).toBe(200)
      expect(await env.prisma.session.count({ where: { userId: id } }), `${label}: sesiones en DB`).toBe(0)   // ya funciona
      expect((await b.post('/api/auth/refresh', {})).status, `${label}: refresh`).toBe(401)                  // ya funciona
      const mark = infra.mark()
      // DEFECTO: el access no está ligado a la sesión (sin sid/epoch) y sigue hasta su exp.
      const thief = env.browser(`ladron-${username}`)
      expect.soft((await thief.get('/api/auth/me', { headers: { authorization: `Bearer ${copied}` } })).status, `${label}: /me con el access copiado`).toBe(401)
      expect.soft((await env.hlsAuth(hlsUri(1), { cookie: copied })).status, `${label}: hls-auth con el access copiado`).toBe(401)
      const hb = await thief.heartbeat(`v-${username}`, [camA], { headers: { authorization: `Bearer ${copied}` } })
      expect.soft(hb.status === 200 ? Object.keys(hb.json().streams) : [], `${label}: heartbeat con el access copiado`).toEqual([])
      expect.soft(infra.of('mediamtx.publish', mark), `${label}: stream iniciado con el access copiado`).toEqual([])
    }
  })

  it('REV-01/PB-02 — desactivar y después borrar al titular corta el MP4 y la descarga ya emitidos', async () => {
    const { id, b } = await newUser('aud_baja_dl_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true, canDownload: true }]])
    const ready = await playUntilReady(b, camA, win(5))
    expect((await admin.put(`/api/users/${id}`, { active: false })).status).toBe(200)
    // DEFECTO (CHW-05/PB-03): el access vigente de un usuario desactivado sigue reproduciendo.
    expect.soft(DENIED, 'POST /playback con el access vigente tras desactivar').toContain((await b.post('/api/recordings/playback', { cameraId: camA, ...win(5) })).status)
    // DEFECTO: los tokens opacos no consultan `active`.
    expect.soft(DENIED, 'file.mp4 tras desactivar').toContain((await b.get(ready.url)).status)
    expect.soft(DENIED, 'download tras desactivar').toContain((await env.browser('tercero-baja').get(ready.downloadUrl)).status)
    expect((await admin.del(`/api/users/${id}`, { headers: await adminStepUp() })).status).toBe(200)
    expect(await env.prisma.user.count({ where: { id } })).toBe(0)
    // DEFECTO: ni siquiera el borrado del usuario invalida los tokens ya emitidos.
    expect.soft(DENIED, 'file.mp4 tras borrar al usuario').toContain((await env.browser('tercero-borrado-1').get(ready.url)).status)
    expect.soft(DENIED, 'download tras borrar al usuario').toContain((await env.browser('tercero-borrado-2').get(ready.downloadUrl)).status)
  })

  it('PB-04 — #186 residual: la pista propia con el `name` de un archivo de OTRO canal no llega al NVR con ese name', async () => {
    const { b } = await newUser('aud_name_def', 'AUDITOR', [[camA, { canView: false, canPlayback: true }]])
    const w = win(15)
    const foreignName = infra.recordingName(2)
    infra.ffmpegMode = 'vod-ok'
    const mark = infra.mark()
    const p = await b.post('/api/recordings/playback', {
      cameraId: camA, startTime: w.startTime, endTime: w.endTime,
      playbackURI: `${w.playbackURI}&name=${foreignName}&size=1048576`,
    })
    if (p.status === 200 && p.json().status !== 'ready') {
      await waitFor(async () => ['ready', 'error'].includes((await b.get(p.json().pollUrl)).json().status), 'VOD terminado', 15_000, 50)
    }
    const targets = infra.rtspTargetsSince(mark)
    // Lo que #186 sí garantiza: la PISTA queda ligada al canal autorizado.
    for (const t of targets) expect(t.pathname).toMatch(/^\/Streaming\/tracks\/10[12]\/?$/)
    // DEFECTO (potencial): `name`/`size` sólo se validan por sintaxis y viajan al NVR.
    // Que el firmware ubique el archivo por `name` sin cruzarlo con la pista NO se
    // verificó (requiere un NVR real y autorización); la prueba fija el contrato seguro.
    const carried = targets.filter(t => t.search.includes(`name=${foreignName}`))
    expect.soft(p.status === 200 ? carried.length : 0, 'DESCRIBE al NVR con el name de otro canal').toBe(0)
  })

  it('REV-04/CHW-03 — fila NVR + denegación explícita de cámara: heartbeat, start-stream y borde HLS deciden lo mismo; canal sin cámara ⇒ 403', async () => {
    const u = await env.createUser('op_nvr_def', 'OPERATOR')
    // La fila NVR-scoped se crea por la ruta real de reemplazo (el modal PUT no puede: REV-03).
    expect((await admin.post(`/api/users/${u.id}/permissions`, [{ nvrId, canView: true }])).status).toBe(200)
    // El admin revoca A explícitamente con el modal granular.
    expect((await admin.put(`/api/users/${u.id}/permissions`, { cameraPermissions: [{ cameraId: camA, canView: false }] })).status).toBe(200)
    const b = env.browser('op_nvr_def')
    await b.signIn('op_nvr_def')
    const hb = (await b.heartbeat('v-nvr', [camA, camB])).json()
    const decisions: Record<string, Record<string, boolean>> = {}
    for (const [label, cameraId, ch] of [['A', camA, 1], ['B', camB, 2]] as const) {
      const start = await b.post(`/api/cameras/${cameraId}/start-stream`, { viewId: 'v-nvr-start' })
      decisions[label] = {
        heartbeat: !!hb.streams?.[cameraId],
        startStream: start.status === 200,
        hlsAuth: (await env.hlsAuth(hlsUri(ch), { browser: b })).status === 200,
      }
    }
    // DEFECTO: hls-auth usa userCanAccessNvrChannel (fila NVR O fila de cámara) e
    // ignora la denegación explícita; heartbeat y start-stream sólo aceptan filas de
    // cámara. La UI muestra "Sin permiso" mientras el borde sigue sirviendo el HLS.
    expect.soft(decisions.A, `A con denegación explícita: ${JSON.stringify(decisions.A)}`).toEqual({ heartbeat: false, startStream: false, hlsAuth: false })
    expect.soft(new Set(Object.values(decisions.B)).size, `B sólo por herencia NVR, decisiones incoherentes: ${JSON.stringify(decisions.B)}`).toBe(1)
    expect.soft((await env.hlsAuth(`/hls/nvr_${nvrId}_ch33_sub/index.m3u8`, { browser: b })).status, 'canal sin cámara registrada').toBe(403)
  })

  it('CHW-04 — AUDITOR con fila de cámara (canPlayback, canView por defecto): GET /stream, start-stream, heartbeat y borde HLS dan la MISMA decisión de vivo', async () => {
    const { b } = await newUser('aud_vivo_def', 'AUDITOR', [[camA, { canView: true, canPlayback: true }]])
    const getStream = await b.get(`/api/cameras/${camA}/stream`)
    const start = await b.post(`/api/cameras/${camA}/start-stream`, { viewId: 'v-aud-start' })
    const hb = await b.heartbeat('v-aud-hb', [camA])
    const hls = await env.hlsAuth(hlsUri(1), { browser: b })
    const decisions = {
      getStream: getStream.status === 200, startStream: start.status === 200,
      heartbeat: !!hb.json().streams?.[camA], hlsAuth: hls.status === 200,
    }
    // DEFECTO: GET /stream (y /snapshot) niegan a AUDITOR por rol; start-stream, el
    // heartbeat de #189 y hls-auth sólo miran canView. Cualquiera sea el contrato
    // (AUDITOR = sólo grabaciones, o vivo con canView), las cuatro deben coincidir.
    expect.soft(new Set(Object.values(decisions)).size, `decisiones de vivo para AUDITOR: ${JSON.stringify(decisions)}`).toBe(1)
  })

  it('CHW-08/CHW-10 — desactivar, revocar sesiones, degradar el rol, cambiar la contraseña o resetear el 2FA invalida el grant de relay en el hook de MediaMTX y expulsa la conexión', async () => {
    const mgr = gs.getMediaGrantManager(env.server)
    const sp = `nvr_${nvrId}_ch01_sub`
    if (!(await mgr.currentInstance(sp))) await mgr.registerSource(sp, 300_000)
    const cases: Array<[string, string, 'OPERATOR' | 'SUPERVISOR', (id: string, b: SimBrowser) => Promise<JointResponse>]> = [
      ['PUT active=false', 'op_mg_baja_def', 'OPERATOR', (id) => admin.put(`/api/users/${id}`, { active: false })],
      ['DELETE /users/:id/sessions', 'op_mg_ses_def', 'OPERATOR', (id) => admin.del(`/api/users/${id}/sessions`)],
      ['degradación SUPERVISOR→OPERATOR (sin filas)', 'sup_mg_rol_def', 'SUPERVISOR', (id) => admin.put(`/api/users/${id}`, { role: 'OPERATOR' })],
      ['change-password', 'op_mg_clave_def', 'OPERATOR', (_id, b) => b.post('/api/auth/change-password', { currentPassword: JOINT_PASSWORD, newPassword: 'Otra-Clave-Distinta-2026!' })],
      ['reset-2fa (admin)', 'op_mg_2fa_def', 'OPERATOR', async (id) => admin.post(`/api/users/${id}/reset-2fa`, {}, { headers: await adminStepUp() })],
    ]
    for (const [label, username, role, action] of cases) {
      const { id, b } = await newUser(username, role, role === 'OPERATOR' ? [[camA, { canView: true }]] : [])
      const r = await mgr.issueSession({
        userId: id, viewId: `relay-${username}`, cameraId: camA, streamPath: sp, effectiveType: 'sub', codec: 'h264',
        transport: 'rtsps', device: 'relay-simulado', ttlMs: 120_000,
      })
      if (!r.ok) throw new Error(`issueSession ${label}: ${r.code}`)
      const grant = { grantId: r.issued.grantId, secret: r.issued.secret }
      const conn = `conn-${username}`
      expect((await env.mediamtxAuth(grant, sp, conn)).status, `${label}: antes`).toBe(200)
      const before = env.kicked.length
      expect((await action(id, b)).status, label).toBe(200)
      // DEFECTO: sólo el cambio de permisos y el logout suben el epoch y expulsan.
      expect.soft((await env.mediamtxAuth(grant, sp, `${conn}-2`)).status, `${label}: el hook re-valida el grant`).toBe(403)
      expect.soft(env.kicked.slice(before), `${label}: conexión expulsada`).toContain(conn)
    }
  })

  it('CHW-08 — POST /api/live-view/internal/media-grant/validate (alcanzable por la location /api/ de nginx) exige además origen interno', async () => {
    const { b } = await newUser('op_validate_def', 'OPERATOR', [[camA, { canView: true }]])
    const mgr = gs.getMediaGrantManager(env.server)
    const sp = `nvr_${nvrId}_ch01_sub`
    if (!(await mgr.currentInstance(sp))) await mgr.registerSource(sp, 300_000)
    const g = await b.post('/api/live-view/media-grant', { viewId: 'v-validate', cameraId: camA, transport: 'rtsps', device: 'navegador-simulado' })
    expect(g.status).toBe(200)
    const r = await env.server.inject({
      method: 'POST', url: '/api/live-view/internal/media-grant/validate', remoteAddress: '198.51.100.240',
      headers: { host: JOINT_HOST, 'x-media-relay-secret': env.relaySecret! },
      payload: { grantId: g.json().grantId, secret: g.json().secret, streamPath: g.json().streamPath, transport: 'rtsps', cameraId: camA },
    })
    // DEFECTO (defensa en profundidad): sólo lo protege el secreto compartido; desde
    // una IP externa valida (y consume) el grant. Debe ser 403/404 por origen.
    expect.soft([403, 404], `validate desde IP externa ⇒ ${r.statusCode}`).toContain(r.statusCode)
  })

  it('MFA-03/CHW-06/CHW-11 — detrás de nginx (socket interno + X-Forwarded-For/X-Real-IP) el cupo de login y de 2FA es por cliente; el borde HLS sigue decidiendo por la IP del socket', async () => {
    const u = await env.createMfaUser('op_proxy_def', 'OPERATOR')
    await env.grant(u.id, nvrId, camA, { canView: true })
    // tempToken legítimo obtenido antes, desde la IP propia del cliente.
    const temp = (await env.browser('cliente-legitimo').login('op_proxy_def')).json().tempToken as string
    const viaNginx = async (clientIp: string, url: string, payload: unknown) => (await env.server.inject({
      method: 'POST', url, remoteAddress: NGINX_INTERNAL_IP, payload: payload as any,
      headers: { host: JOINT_HOST, origin: JOINT_ORIGIN, 'x-forwarded-for': clientIp, 'x-real-ip': clientIp },
    })).statusCode
    const fails: number[] = []
    for (let i = 1; i <= 8; i++) fails.push(await viaNginx(`198.51.100.${150 + i}`, '/api/auth/login', { username: `no-existe-${i}`, password: 'clave-falsa-123' }))
    expect(fails).toEqual(Array(8).fill(401))
    // DEFECTO: Fastify sin trustProxy ⇒ request.ip es la de nginx para TODOS: el 9.º
    // cliente (otro, con la contraseña correcta) recibe 429. Lo mismo con el 2FA.
    expect.soft(await viaNginx('198.51.100.159', '/api/auth/login', { username: 'op_proxy_def', password: JOINT_PASSWORD }), 'login de un 9.º cliente distinto').not.toBe(429)
    for (let i = 1; i <= 10; i++) await viaNginx(`198.51.100.${170 + i}`, '/api/auth/2fa/verify', { tempToken: 'basura', code: '000000' })
    expect.soft(await viaNginx('198.51.100.181', '/api/auth/2fa/verify', { tempToken: temp, code: await totpNow(u.secret) }), '2FA legítimo de otro cliente').toBe(200)

    // Lo que debe seguir valiendo cuando se corrija (trustProxy acotado): el borde
    // HLS decide "interno" por la IP del SOCKET, no por X-Forwarded-For.
    const cookie = admin.cookieHeaderFor('/hls/x/index.m3u8')!
    const viaProxy = await env.server.inject({
      method: 'GET', url: '/internal/hls-auth', remoteAddress: NGINX_INTERNAL_IP,
      headers: { host: JOINT_HOST, cookie, 'x-original-uri': hlsUri(1), 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' },
    })
    expect(viaProxy.statusCode).toBe(200)
    const forged = await env.server.inject({
      method: 'GET', url: '/internal/hls-auth', remoteAddress: '203.0.113.9',
      headers: { host: JOINT_HOST, cookie, 'x-original-uri': hlsUri(1), 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
    })
    expect(forged.statusCode).toBe(403)
  })

  it('higiene: sin red saliente; todo contacto con el NVR fue a su IP TEST-NET', () => {
    expect(env.blockedConnections).toEqual([])
    for (const c of infra.of('nvr.isapi')) expect(c.detail.nvrHost).toBe(NVR_IP)
    for (const t of infra.rtspTargetsSince(0)) expect(t.host).toBe(NVR_IP)
  })
})
