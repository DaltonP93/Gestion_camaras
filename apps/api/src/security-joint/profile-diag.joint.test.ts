// Suite conjunta de seguridad — perfil y diagnósticos sin credenciales del NVR
// (#193 × #186 × #190 × #189 sobre server.ts real).
//
// Lo que las CI de #193 no prueban en combinación: el login REAL por rol (con 2FA
// donde aplica), las respuestas completas de server.ts y las fuentes REALES de la
// fuga que #193 cierra:
//   - services/rtsp-probe corre REAL; sólo ffprobe está simulado y falla como lo hace
//     Node (`Command failed: ffprobe … rtsp://<usuario>:<clave>@<ip>…`), así que el
//     texto que llega a la redacción es el de producción (joint-doubles.ts);
//   - MediaMTX devuelve la fuente en el formato LEGADO `rtsp://<usuario>:***@<ip>…`;
//   - la cámara arrastra columnas legadas: `rtspUrl` con la clave en claro y
//     `lastRtspError` con usuario e IP del NVR (filas escritas antes del fix);
//   - el FFmpeg de preview simulado imprime la URL de entrada con credenciales.
// "Ninguna forma" = literal, url-encoded y la IP enmascarada `a.b.x.x`.
//
// Incluye MFA-05 y PB-05, que estaban en defectos-conocidos.joint.test.ts y quedan en
// verde con #193 (ahora son regresión normal de la combinación).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./joint-doubles')).streamLegacySourceDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./joint-doubles')).hikvisionWithFixturesDouble(await orig() as any))
// services/rtsp-probe NO se reemplaza: corre real sobre el ffprobe simulado.
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./joint-doubles')).childProcessFfprobeDouble(await orig() as any))

import { infra } from './infra-doubles'
import { joint } from './joint-doubles'
import {
  jointInfraAvailable, startJointServer, waitFor, NVR_FAKE_USER, NVR_FAKE_PASS,
  type JointEnv, type SimBrowser, type JointResponse,
} from './harness'
import {
  obtainNonAccessTokens, nonAccessFailures, findSecrets, ipLeakForms, bodyOf, type NonAccessTokens,
} from './joint-helpers'

const NVR_IP = '192.0.2.70'
const T0 = '2026-10-01T12:00:00.000Z'
const T1 = '2026-10-01T12:05:00.000Z'
const W = 'starttime=20261001T120000Z&endtime=20261001T120500Z'
const LEGACY_RTSP_URL = `rtsp://${NVR_FAKE_USER}:${NVR_FAKE_PASS}@${NVR_IP}:554/Streaming/Channels/101`
const LEGACY_RTSP_ERROR = `rtsp:***@${NVR_IP}:554/Streaming/Channels/102: Command failed: ffprobe -rtsp_transport tcp rtsp://${NVR_FAKE_USER}:***@${NVR_IP}:554/Streaming/Channels/102`

/** /auth/me: lo que el web lee (authStore, Sidebar, ProfilePage, StepUpModal, guards). */
const ME_KEYS = ['avatarUrl', 'email', 'featurePermissions', 'fullName', 'id', 'phone', 'role', 'twoFactorEnabled', 'username']
const FEATURE_FLAGS = [
  'canDownloadRecordings', 'canManageAppearance', 'canManageCameras', 'canManageNVRs', 'canManageSettings', 'canManageUsers',
  'canManageViews', 'canResolveAlerts', 'canRestartStreams', 'canTranscode', 'canViewAlerts', 'canViewDashboard',
  'canViewDiagnostics', 'canViewLive', 'canViewRecordings',
]

describe.skipIf(!jointInfraAvailable())('conjunta · perfil y diagnósticos sin credenciales del NVR (#193)', { timeout: 60_000 }, () => {
  let env: JointEnv
  let nvrId = ''
  let camA = ''
  let camB = ''
  let encPass = ''
  const ids: Record<string, string> = {}
  const b: Record<string, SimBrowser> = {}
  let tokens: NonAccessTokens

  /** Secretos del NVR que no deben salir en NINGUNA forma (usuario, clave en claro y cifrada, IP y a.b.x.x). */
  const nvrSecrets = () => [NVR_FAKE_USER, NVR_FAKE_PASS, encPass, LEGACY_RTSP_URL, ...ipLeakForms(NVR_IP)]
  /** Credenciales del NVR (sin la IP): lo que #193 saca de /api/nvrs* y /api/cameras* para no-ADMIN. */
  const nvrCredentials = () => [NVR_FAKE_USER, NVR_FAKE_PASS, encPass, LEGACY_RTSP_URL]
  const diagRoutes = (cameraId: string): Array<[string, string, unknown?]> => [
    ['GET', `/api/cameras/${cameraId}/diagnostics`],
    ['POST', `/api/cameras/${cameraId}/test-rtsp`, { stream: 'sub' }],
    ['POST', `/api/cameras/${cameraId}/test-rtsp`, { stream: 'main' }],
    ['GET', `/api/cameras/${cameraId}/debug-stream`],
    ['POST', `/api/cameras/${cameraId}/validate-stream`, {}],
  ]
  const getPreviewStream = async (who: SimBrowser, url: string, ms = 20_000): Promise<JointResponse | null> =>
    Promise.race([who.get(url), new Promise<null>(r => setTimeout(() => r(null), ms))])

  beforeAll(async () => {
    env = await startJointServer({ label: 'profdiag' })
    nvrId = (await env.createNvr('NVR conjunto perfil', NVR_IP)).id
    camA = (await env.createCamera(nvrId, 1)).id
    camB = (await env.createCamera(nvrId, 2)).id
    encPass = (await env.prisma.nVR.findUniqueOrThrow({ where: { id: nvrId } })).password
    // Filas LEGADAS: clave en claro en rtspUrl y usuario/IP del NVR en lastRtspError.
    await env.prisma.camera.update({ where: { id: camA }, data: { rtspUrl: LEGACY_RTSP_URL, lastRtspError: LEGACY_RTSP_ERROR } })
    joint.legacySource = (streamPath) => `rtsp://${NVR_FAKE_USER}:***@${NVR_IP}:554/Streaming/Channels/${/_ch(\d+)_/.exec(streamPath)?.[1] ?? '01'}01`

    ids.admin = (await env.createUser('admin_prof', 'ADMIN')).id
    const sup = await env.createMfaUser('sup_prof', 'SUPERVISOR')
    ids.sup = sup.id
    ids.opNvr = (await env.createUser('op_nvr_prof', 'OPERATOR')).id
    ids.opCam = (await env.createUser('op_cam_prof', 'OPERATOR')).id
    const aud = await env.createMfaUser('aud_prof', 'AUDITOR')
    ids.aud = aud.id
    ids.aud2 = (await env.createUser('aud2_prof', 'AUDITOR')).id
    // AUDITOR CON acceso a la cámara (canView): su 403 en diagnósticos sólo puede venir del rol.
    const audView = await env.createMfaUser('aud_view_prof', 'AUDITOR')
    ids.audView = audView.id
    await env.grant(ids.opNvr, nvrId, null, { canView: true })
    await env.grant(ids.opCam, nvrId, camA, { canView: true })
    await env.grant(ids.aud, nvrId, camA, { canView: false, canPlayback: true })
    await env.grant(ids.aud2, nvrId, camA, { canView: false, canPlayback: true })
    await env.grant(ids.audView, nvrId, camA, { canView: true, canPlayback: true })
    // Fila de featurePermissions: /me debe devolver sólo los flags (sin id/userId).
    await env.prisma.userFeaturePermissions.create({ data: { userId: ids.opCam, canViewRecordings: true } })

    const logins: Array<[string, string, string?]> = [
      ['admin', 'admin_prof'], ['sup', 'sup_prof', sup.secret], ['opNvr', 'op_nvr_prof'],
      ['opCam', 'op_cam_prof'], ['aud', 'aud_prof', aud.secret], ['aud2', 'aud2_prof'],
      ['audView', 'aud_view_prof', audView.secret],
    ]
    for (const [k, user, secret] of logins) {
      b[k] = env.browser(k)
      await b[k].signIn(user, secret)
    }
    tokens = await obtainNonAccessTokens(env, b.admin, 'prof')
  }, 120_000)

  afterAll(async () => {
    joint.legacySource = null
    infra.ffmpegMode = 'vod-ok'
    await env?.stop()
  })

  it('/auth/me por rol (login real; SUPERVISOR y AUDITOR con 2FA): allowlist EXACTA de claves y de featurePermissions; sin credenciales ni datos internos del NVR/cámara a ninguna profundidad', async () => {
    const failures: string[] = []
    for (const k of ['admin', 'sup', 'opNvr', 'opCam', 'aud', 'aud2']) {
      const me = await b[k].get('/api/auth/me')
      expect(me.status, k).toBe(200)
      const body = me.json()
      expect(Object.keys(body).sort(), k).toEqual(ME_KEYS)
      expect(Object.keys(body.featurePermissions).sort(), k).toEqual(FEATURE_FLAGS)
      expect(body.id, k).toBe(ids[k])
      const leaks = findSecrets(body, [...nvrSecrets(), '198.51.100.201', nvrId, camA, 'passwordHash', 'twoFactorSecret'])
      if (leaks.length) failures.push(`${k}: ${leaks.join(', ')}`)
    }
    expect(failures).toEqual([])
    expect((await b.opCam.get('/api/auth/me')).json().featurePermissions.canViewRecordings).toBe(true)   // la fila sí se aplica
  })

  it('MFA-05 (en verde con #193) — /api/auth/me no expone credenciales del NVR (ni cifradas) ni datos internos de la cámara', async () => {
    const me = await b.opCam.get('/api/auth/me')
    expect(me.status).toBe(200)
    const cam = await env.prisma.camera.findUniqueOrThrow({ where: { id: camA } })
    // Antes: userMeSelect incluía `permissions: { include: { nvr: true, camera: true } }`
    // y el web persistía /me en localStorage ('visioncore-auth').
    expect(me.text, 'usuario del NVR').not.toContain(NVR_FAKE_USER)
    expect(me.text, 'contraseña cifrada del NVR').not.toContain(encPass)
    expect(me.text, 'IP del NVR').not.toContain(NVR_IP)
    expect(me.text, 'rtspUrl de la cámara').not.toContain(cam.rtspUrl!)
    expect(me.text, 'IP de la cámara').not.toContain(cam.ipAddress!)
  })

  it('/api/nvrs*: el usuario del NVR sólo a ADMIN; la clave nunca (ni cifrada); rtspUrl nunca; lastRtspError legado redactado para no-ADMIN; /api/cameras* igual', async () => {
    // ADMIN: recibe el usuario (formulario de edición) pero nunca la clave.
    const adminList = (await b.admin.get('/api/nvrs')).json()
    const adminNvr = adminList.find((n: any) => n.id === nvrId)
    expect(adminNvr.username).toBe(NVR_FAKE_USER)
    expect('password' in adminNvr).toBe(false)
    const adminOne = (await b.admin.get(`/api/nvrs/${nvrId}`)).json()
    expect(adminOne.username).toBe(NVR_FAKE_USER)
    expect(findSecrets(adminOne, [NVR_FAKE_PASS, encPass, LEGACY_RTSP_URL])).toEqual([])

    const failures: string[] = []
    const check = (label: string, r: JointResponse) => {
      if (r.status !== 200) { failures.push(`${label} ⇒ ${r.status}`); return }
      const leaks = findSecrets(bodyOf(r), nvrCredentials())
      if (leaks.length) failures.push(`${label}: ${leaks.join(', ')}`)
    }
    for (const k of ['sup', 'opNvr', 'opCam']) {
      check(`${k} GET /api/nvrs`, await b[k].get('/api/nvrs'))
      check(`${k} GET /api/nvrs/:id/cameras`, await b[k].get(`/api/nvrs/${nvrId}/cameras`))
      check(`${k} GET /api/cameras`, await b[k].get('/api/cameras'))
      check(`${k} POST /api/cameras/batch`, await b[k].post('/api/cameras/batch', { ids: [camA, camB] }))
    }
    // GET /api/cameras/:id sólo mira filas de CÁMARA: la fila NVR de opNvr da 403
    // (incoherencia de herencia NVR→cámara ya registrada como REV-04/CHW-03).
    for (const k of ['sup', 'opCam']) check(`${k} GET /api/cameras/:id`, await b[k].get(`/api/cameras/${camA}`))
    for (const k of ['sup', 'opNvr']) check(`${k} GET /api/nvrs/:id`, await b[k].get(`/api/nvrs/${nvrId}`))
    expect(failures).toEqual([])
    // Forma: sin la clave username para no-ADMIN; camera-scoped sigue mínimo; NVR-wide para camera-scoped ⇒ 403.
    expect('username' in (await b.sup.get(`/api/nvrs/${nvrId}`)).json()).toBe(false)
    expect('username' in (await b.opNvr.get(`/api/nvrs/${nvrId}`)).json()).toBe(false)
    expect(Object.keys((await b.opCam.get('/api/nvrs')).json()[0]).sort()).toEqual(['cameras', 'id', 'name'])
    expect((await b.opCam.get(`/api/nvrs/${nvrId}`)).status).toBe(403)
    // El error legado conserva lo útil (path del canal) sin usuario ni IP del NVR.
    const camRow = (await b.opCam.get(`/api/cameras/${camA}`)).json()
    expect(camRow.lastRtspError).toContain('/Streaming/Channels/102')
    expect('rtspUrl' in camRow).toBe(false)
  })

  it('diagnósticos de cámara (ffprobe y MediaMTX simulados con salida real): ADMIN y SUPERVISOR 200 sin usuario/IP del NVR en NINGUNA forma ni la clave; la IP de la cámara sólo a ADMIN; lo persistido en lastRtspError también queda redactado', async () => {
    const failures: string[] = []
    for (const who of ['admin', 'sup'] as const) {
      const mark = infra.mark()
      for (const [method, url, body] of diagRoutes(camA)) {
        const r = await b[who].request(method, url, { body })
        if (r.status !== 200) { failures.push(`${who} ${method} ${url} ⇒ ${r.status}`); continue }
        const leaks = findSecrets(bodyOf(r), nvrSecrets())
        if (leaks.length) failures.push(`${who} ${method} ${url}: ${leaks.join(', ')}`)
      }
      // La fuente de la fuga EXISTIÓ: ffprobe recibió la URL con usuario y clave del NVR.
      const probes = infra.of('proc.exec', mark).map(c => c.detail.rtsp as { host: string; hadUserinfo: boolean } | null)
      expect(probes.length, `${who}: sondas ffprobe reales`).toBeGreaterThanOrEqual(5)
      for (const p of probes) expect(p).toMatchObject({ host: NVR_IP, hadUserinfo: true })
    }
    expect(failures).toEqual([])

    const adminDiag = (await b.admin.get(`/api/cameras/${camA}/diagnostics`)).json()
    const supDiag = (await b.sup.get(`/api/cameras/${camA}/diagnostics`)).json()
    expect(adminDiag.camera.ipAddress).toBe('198.51.100.201')
    expect('ipAddress' in supDiag.camera).toBe(false)
    expect(supDiag.rtsp.subUrlMasked).toBe('rtsp://***/Streaming/Channels/102')
    expect(supDiag.rtsp.mainError).toContain('/Streaming/Channels/101')   // el error útil se conserva
    expect(supDiag.mediaServer.sourceMasked).toContain('/Streaming/Channels/')
    const row = await env.prisma.camera.findUniqueOrThrow({ where: { id: camA } })
    expect(findSecrets({ lastRtspError: row.lastRtspError }, nvrSecrets())).toEqual([])
  })

  it('OPERATOR y AUDITOR (con 2FA) ⇒ 403 en los diagnósticos SIN sondas, sin descifrar y sin consultar MediaMTX, AUNQUE tengan la cámara; tokens no-access ⇒ 401 igual', async () => {
    // Quién ejercita el guard de ROL (authorize(['ADMIN','SUPERVISOR'])): opCam y
    // audView TIENEN la cámara (control positivo: GET /api/cameras/:id ⇒ 200), así que
    // su 403 sólo puede venir del rol. opNvr (sólo fila de NVR: userCanAccessCamera
    // exige fila de cámara, REV-04) y aud (canView:false) darían 403 aunque el guard
    // volviera a `authenticate`; se mantienen como casos de "sin acceso".
    for (const who of ['opCam', 'audView'] as const) {
      expect((await b[who].get(`/api/cameras/${camA}`)).status, `${who}: acceso real a la cámara`).toBe(200)
    }
    const mark = infra.mark()
    const failures: string[] = []
    for (const who of ['opNvr', 'opCam', 'aud', 'audView'] as const) {
      for (const [method, url, body] of diagRoutes(camA)) {
        const r = await b[who].request(method, url, { body })
        if (r.status !== 403) failures.push(`${who} ${method} ${url} ⇒ ${r.status}`)
      }
    }
    for (const [method, url, body] of diagRoutes(camA)) {
      failures.push(...await nonAccessFailures(env, tokens, (atk, headers) => atk.request(method, url, { body, headers }), `${method} ${url}`))
    }
    expect(failures).toEqual([])
    expect(infra.externalEffectsSince(mark)).toEqual([])
  })

  it('PB-05 (en verde con #193) — preview fallida con la pista PROPIA (#186): status y stream del dueño sin usuario ni IP del NVR; otro AUDITOR ⇒ 403; ADMIN lo ve igual de redactado', async () => {
    infra.ffmpegMode = 'fail-404'
    try {
      // #186: la URI de otro canal se corta antes de todo.
      const mark = infra.mark()
      const foreign = await b.aud.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 1, startTime: T0, endTime: T1, playbackURI: `/Streaming/tracks/201/?${W}` })
      expect(foreign.status).toBe(403)
      expect(infra.externalEffectsSince(mark)).toEqual([])

      const pv = await b.aud.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 2, startTime: T0, endTime: T1, playbackURI: `/Streaming/tracks/101/?${W}` })
      expect(pv.status, pv.text).toBe(200)
      expect(pv.json().status).toBe('ready')
      const stream = await getPreviewStream(b.aud, pv.json().streamUrl)
      const status = await waitFor(async () => {
        const st = await b.aud.get(`/api/recordings/preview/${pv.json().sessionId}/status`)
        return st.json().status === 'error' ? st : null
      }, 'preview en error', 20_000, 100)
      // El FFmpeg simulado SÍ recibió la URL con credenciales: la fuga existía en origen.
      expect(infra.rtspTargetsSince(mark).some(t => t.host === NVR_IP && t.hadUserinfo)).toBe(true)
      const visible = status.text + (stream ? stream.text : '')
      expect(visible).not.toContain(NVR_FAKE_PASS)
      expect(visible, 'usuario del NVR en el diagnóstico').not.toContain(NVR_FAKE_USER)
      for (const ip of ipLeakForms(NVR_IP)) expect(visible, `IP del NVR (${ip}) en el diagnóstico`).not.toContain(ip)
      expect(status.json().detail ?? status.json().stderrTail ?? '').toMatch(/Streaming\/tracks\/101|404|rtsp/i)   // sigue siendo útil

      expect((await b.aud2.get(`/api/recordings/preview/${pv.json().sessionId}/status`)).status).toBe(403)
      const asAdmin = await b.admin.get(`/api/recordings/preview/${pv.json().sessionId}/status`)
      expect(asAdmin.status).toBe(200)
      expect(findSecrets(bodyOf(asAdmin), nvrSecrets())).toEqual([])
      await b.aud.del(`/api/recordings/preview/${pv.json().sessionId}`)
    } finally {
      infra.ffmpegMode = 'vod-ok'
    }
  })

  it('POST /api/recordings/diagnostics/playback: sólo ADMIN; sanitizedUri y stderrSample sin usuario ni IP del NVR (aunque FFmpeg imprime la URL con credenciales); URI de otro canal ⇒ 403 antes de descifrar', async () => {
    const body = { cameraId: camA, playbackURI: `/Streaming/tracks/101/?${W}`, perStrategyTimeoutMs: 3000, transports: ['tcp'] }
    for (const who of ['sup', 'aud', 'opNvr'] as const) expect((await b[who].post('/api/recordings/diagnostics/playback', body)).status, who).toBe(403)
    const mark = infra.mark()
    const r = await b.admin.post('/api/recordings/diagnostics/playback', body)
    expect(r.status, r.text.slice(0, 200)).toBe(200)
    expect(infra.rtspTargetsSince(mark).some(t => t.host === NVR_IP && t.hadUserinfo)).toBe(true)
    expect(findSecrets(bodyOf(r), nvrSecrets())).toEqual([])
    expect(r.text).toContain('/Streaming/tracks/101')

    const m2 = infra.mark()
    const foreign = await b.admin.post('/api/recordings/diagnostics/playback', { ...body, playbackURI: `/Streaming/tracks/201/?${W}` })
    expect(foreign.status).toBe(403)
    expect(infra.externalEffectsSince(m2)).toEqual([])
  })

  it('higiene: sin red saliente; todo contacto con el NVR fue a su IP TEST-NET', () => {
    expect(env.blockedConnections).toEqual([])
    expect(joint.of('outbound.http')).toEqual([])
    for (const c of infra.of('nvr.isapi')) expect(c.detail.nvrHost).toBe(NVR_IP)
    for (const t of infra.rtspTargetsSince(0)) expect(t.host).toBe(NVR_IP)
  })
})
