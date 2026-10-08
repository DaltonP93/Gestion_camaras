// Suite conjunta de seguridad — reproducción de grabaciones (#186 × #190 × #189
// sobre server.ts real).
//
// El NVR está simulado (ISAPI de búsqueda y sondas/FFmpeg contra RTSP): cada llamada
// queda registrada con host y path, nunca con credenciales. El FFmpeg simulado de
// VOD escribe bytes SINTÉTICOS (no es video) para que el servidor tenga qué servir.
// Se verifica que la playbackURI sólo llega al NVR para el canal de la cámara
// autorizada (#186) y que todo rechazo ocurre ANTES de descifrar credenciales,
// contactar el NVR o lanzar FFmpeg.
//
// Nota de contrato: una URI de OTRO canal se rechaza con 403 PLAYBACK_URI_FORBIDDEN
// (es una autorización, ver playback-uri-policy.ts); una URI malformada o con claves
// no permitidas (incluidas las heredadas de Object.prototype) con 400
// PLAYBACK_URI_INVALID.
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
  jointInfraAvailable, startJointServer, totpNow, waitFor, JOINT_PASSWORD,
  type JointEnv, type SimBrowser,
} from './harness'

const NVR_IP = '192.0.2.50'
const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-01T10:05:00.000Z'
const W = 'starttime=20261001T100000Z&endtime=20261001T100500Z'
const TIMES = { startTime: T0, endTime: T1 }
const OWN_TRACK = /^\/Streaming\/tracks\/10[12]\/?$/

describe.skipIf(!jointInfraAvailable())('conjunta · reproducción de grabaciones', { timeout: 60_000 }, () => {
  let env: JointEnv
  let nvrId = ''
  let camA = ''
  let camB = ''
  const ids: Record<string, string> = {}
  let audMfaSecret = ''
  const b: Record<string, SimBrowser> = {}

  const searchUrl = (cameraId: string) => `/api/recordings/search?cameraId=${cameraId}&startTime=${T0}&endTime=${T1}`
  /** Rutas de grabaciones que llegan (o podrían llegar) a credenciales del NVR. */
  const nvrRoutes = (): Array<[string, string, unknown?]> => [
    ['GET', searchUrl(camA)],
    ['GET', `/api/recordings/calendar?cameraId=${camA}&year=2026&month=10`],
    ['POST', '/api/recordings/batch-search', { nvrId, cameraIds: [camA, camB], from: T0, to: T1 }],
    ['POST', '/api/recordings/playback', { cameraId: camA, ...TIMES, playbackURI: `/Streaming/tracks/101/?${W}` }],
    ['POST', '/api/recordings/preview/start', { cameraId: camA, slotIndex: 0, ...TIMES, playbackURI: `/Streaming/tracks/101/?${W}` }],
    ['POST', '/api/recordings/diagnostics/playback', { cameraId: camA, playbackURI: `/Streaming/tracks/101/?${W}` }],
    ['GET', `/api/recordings/diagnostics/nvr-time?cameraId=${camA}`],
  ]

  beforeAll(async () => {
    env = await startJointServer({ label: 'pb' })
    nvrId = (await env.createNvr('NVR conjunto grabaciones', NVR_IP)).id
    camA = (await env.createCamera(nvrId, 1)).id
    camB = (await env.createCamera(nvrId, 2)).id
    ids.admin = (await env.createUser('admin_pb', 'ADMIN')).id
    ids.aud = (await env.createUser('aud_pb', 'AUDITOR')).id
    const am = await env.createMfaUser('aud_mfa_pb', 'AUDITOR')
    ids.audMfa = am.id; audMfaSecret = am.secret
    ids.audAB = (await env.createUser('aud_ab_pb', 'AUDITOR')).id
    ids.sup = (await env.createUser('sup_pb', 'SUPERVISOR')).id
    ids.op = (await env.createUser('op_pb', 'OPERATOR')).id
    await env.grant(ids.aud, nvrId, camA, { canView: false, canPlayback: true })
    await env.grant(ids.audMfa, nvrId, camA, { canView: false, canPlayback: true })
    await env.grant(ids.audAB, nvrId, camA, { canView: false, canPlayback: true })
    await env.grant(ids.audAB, nvrId, camB, { canView: false, canPlayback: true })
    await env.grant(ids.op, nvrId, camA, { canView: true })
    for (const [k, user] of [['admin', 'admin_pb'], ['aud', 'aud_pb'], ['audAB', 'aud_ab_pb'], ['sup', 'sup_pb'], ['op', 'op_pb']] as const) {
      b[k] = env.browser(k)
      await b[k].signIn(user)
    }
  }, 120_000)

  afterAll(async () => { await env?.stop() })

  it('AUDITOR con canPlayback en A: la búsqueda consulta el NVR con el canal de A y la reproducción sólo abre pistas del canal 1; el MP4 se sirve con Range sólo con su token', async () => {
    infra.ffmpegMode = 'vod-ok'
    const mark = infra.mark()
    const s = await b.aud.get(searchUrl(camA))
    expect(s.status).toBe(200)
    const isapi = infra.of('nvr.isapi', mark)
    expect(isapi.map(c => c.detail)).toEqual([{ fn: 'searchRecordings', nvrId, nvrHost: NVR_IP, channel: 1 }])
    expect(infra.of('credentials.decrypt', mark).length).toBeGreaterThan(0)   // descifrado REAL de la clave guardada
    const playbackURI = s.json().recordings[0].playbackURI as string
    expect(playbackURI.startsWith('/Streaming/tracks/101/')).toBe(true)

    const p = await b.aud.post('/api/recordings/playback', { cameraId: camA, ...TIMES, playbackURI })
    expect(p.status).toBe(200)
    const { sessionId, pollUrl } = p.json()
    const ready = await waitFor(async () => {
      const st = await b.aud.get(pollUrl)
      return st.json().status === 'ready' ? st.json() : null
    }, 'VOD listo', 15_000, 50)

    const targets = infra.rtspTargetsSince(mark)
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) {
      expect(t.host).toBe(NVR_IP)
      expect(t.pathname).toMatch(OWN_TRACK)
      expect(t.hadUserinfo).toBe(true)
    }
    expect(infra.of('proc.spawn', mark).map(c => c.detail.cmd)).toContain('ffmpeg')

    const ranged = await b.aud.get(ready.url, { headers: { range: 'bytes=0-1023' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe('bytes 0-1023/65536')
    expect(ranged.headers['cache-control']).toBe('private, no-store')
    // Token equivocado ⇒ 401 aun con la cookie del dueño.
    expect((await b.aud.get(ready.url.replace(/token=[0-9a-f]+/, 'token=' + '0'.repeat(48)))).status).toBe(401)
    // El status de la sesión es sólo del dueño (o ADMIN).
    expect((await b.audAB.get(pollUrl)).status).toBe(403)
    expect((await b.admin.get(pollUrl)).status).toBe(200)

    const audit = await env.prisma.auditLog.findMany({ where: { userId: ids.aud }, select: { action: true, resource: true } })
    expect(audit).toEqual(expect.arrayContaining([
      { action: 'SEARCH_RECORDINGS', resource: camA },
      { action: 'VIEW_RECORDING', resource: camA },
    ]))
    expect((await b.aud.del(`/api/recordings/playback/${sessionId}`)).status).toBe(200)
  })

  it('#186: URI con el canal de B (pista, subpista, cero a la izquierda o name ajeno) sobre la cámara A ⇒ 403 PLAYBACK_URI_FORBIDDEN para AUDITOR y SUPERVISOR, sin descifrar, sin NVR y sin FFmpeg', async () => {
    const mark = infra.mark()
    const foreign = [
      `/Streaming/tracks/201?${W}`,
      `/Streaming/tracks/202/?${W}`,
      `/Streaming/tracks/0201?${W}`,
      `/Streaming/tracks/201/?${W}&name=${infra.recordingName(2)}&size=1`,
      `/Streaming/tracks/1/?${W}`,
      `/Streaming/tracks/103?${W}`,
    ]
    const failures: string[] = []
    for (const playbackURI of foreign) {
      for (const [url, extra] of [['/api/recordings/playback', {}], ['/api/recordings/preview/start', { slotIndex: 0 }]] as const) {
        for (const who of ['aud', 'sup'] as const) {
          const r = await b[who].post(url, { cameraId: camA, ...TIMES, ...extra, playbackURI })
          if (r.status !== 403 || r.json().code !== 'PLAYBACK_URI_FORBIDDEN') failures.push(`${who} ${url} ${playbackURI} ⇒ ${r.status} ${r.text.slice(0, 80)}`)
        }
      }
    }
    expect(failures).toEqual([])
    expect(infra.externalEffectsSince(mark)).toEqual([])

    // La URI propia sí se acepta (SUPERVISOR, preview): descifra, pero aún sin FFmpeg ni NVR.
    const own = await b.sup.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 1, ...TIMES, playbackURI: `/Streaming/tracks/102/?${W}` })
    expect(own.status).toBe(200)
    expect(own.json().status).toBe('ready')
    expect(infra.of('proc.spawn', mark)).toEqual([])
    expect((await b.sup.del(`/api/recordings/preview/${own.json().sessionId}`)).status).toBe(200)
  })

  it('#186: claves heredadas (constructor, __proto__, toString…) y URIs malformadas ⇒ 400 PLAYBACK_URI_INVALID sin descifrar (playback, preview y diagnóstico)', async () => {
    const mark = infra.mark()
    const invalid = [
      `/Streaming/tracks/101?constructor=1&${W}`,
      `/Streaming/tracks/101?__proto__=1&${W}`,
      `/Streaming/tracks/101?${W}&toString=1`,
      `/Streaming/tracks/101?${W}&hasOwnProperty=x`,
      `/Streaming/tracks/101?${W}&valueOf=1`,
      `/Streaming/tracks/101?${W}&starttime=20261001T100000Z`,
      `/Streaming/tracks/101?endtime=20261001T100500Z`,
      `/Streaming/tracks/101/../201?${W}`,
      `/Streaming/tracks/101?${W}%26name=x`,
      `/Streaming/tracks/101?${W}#x`,
      `/Streaming/channels/101?${W}`,
    ]
    const failures: string[] = []
    for (const playbackURI of invalid) {
      const calls: Array<[SimBrowser, string, Record<string, unknown>]> = [
        [b.aud, '/api/recordings/playback', { cameraId: camA, ...TIMES, playbackURI }],
        [b.aud, '/api/recordings/preview/start', { cameraId: camA, slotIndex: 0, ...TIMES, playbackURI }],
        [b.admin, '/api/recordings/diagnostics/playback', { cameraId: camA, playbackURI }],
      ]
      for (const [who, url, body] of calls) {
        const r = await who.post(url, body)
        if (r.status !== 400 || r.json().code !== 'PLAYBACK_URI_INVALID') failures.push(`${url} ${playbackURI} ⇒ ${r.status} ${r.text.slice(0, 80)}`)
      }
    }
    expect(failures).toEqual([])
    expect(infra.externalEffectsSince(mark)).toEqual([])
  })

  it('OPERATOR (vivo, sin grabaciones) ⇒ 403 en búsqueda, calendario, búsqueda múltiple, playback y preview, sin descifrar', async () => {
    const mark = infra.mark()
    for (const [method, url, body] of nvrRoutes().slice(0, 5)) {
      const r = await b.op.request(method, url, { body })
      expect(r.status, `${method} ${url}`).toBe(403)
    }
    expect(infra.externalEffectsSince(mark)).toEqual([])
  })

  it('#190: tempToken 2fa, enrollToken, refresh y step-up (Bearer o cookie) ⇒ 401 en las 7 rutas de grabaciones sin descifrar ni NVR ni FFmpeg; tras /2fa/verify el access abre A y no B', async () => {
    const lb = env.browser('aud-mfa')
    const l = await lb.login('aud_mfa_pb')
    expect(l.json().requiresTwoFactor).toBe(true)
    const st = await b.aud.post('/api/auth/step-up', { password: JOINT_PASSWORD })
    expect(st.status).toBe(200)
    // enrollToken real: política MFA activa sólo durante este login (enrolamiento forzoso).
    const enrolUser = await env.createUser('aud_enrol_pb', 'AUDITOR', { forceMfaEnrollment: true })
    await env.grant(enrolUser.id, nvrId, camA, { canView: false, canPlayback: true })
    await env.setSecurity({ mfaRequired: true, mfaGracePeriodLogins: 0 })
    let enrollToken = ''
    try {
      const le = await env.browser('aud-enrol').login('aud_enrol_pb')
      expect(le.json().requiresMfaEnrollment).toBe(true)
      enrollToken = le.json().enrollToken
    } finally {
      await env.setSecurity({ mfaRequired: false })
    }
    const tokens = {
      tempToken2fa: l.json().tempToken as string, enrollToken,
      refresh: b.aud.refreshToken!, stepUp: st.json().stepUpToken as string,
    }
    const mark = infra.mark()
    const failures: string[] = []
    for (const [kind, token] of Object.entries(tokens)) {
      for (const via of ['bearer', 'cookie'] as const) {
        const atk = env.browser(`atk-${kind}-${via}`)
        if (via === 'cookie') atk.plantCookie('access_token', token)
        for (const [method, url, body] of nvrRoutes()) {
          const r = await atk.request(method, url, { body, headers: via === 'bearer' ? { authorization: `Bearer ${token}` } : undefined })
          if (r.status !== 401) failures.push(`${kind}/${via} ${method} ${url} ⇒ ${r.status}`)
        }
      }
    }
    expect(failures).toEqual([])
    expect(infra.externalEffectsSince(mark)).toEqual([])
    const leaked = await env.prisma.auditLog.count({ where: { userId: { in: [ids.audMfa, enrolUser.id] }, action: { in: ['SEARCH_RECORDINGS', 'VIEW_RECORDING'] } } })
    expect(leaked).toBe(0)

    expect((await lb.verify2fa(tokens.tempToken2fa, await totpNow(audMfaSecret))).status).toBe(200)
    expect((await lb.get(searchUrl(camA))).status).toBe(200)
    expect((await lb.get(searchUrl(camB))).status).toBe(403)
  })

  it('revocar canPlayback por la ruta real ⇒ 403 inmediato en A (búsqueda, calendario, playback, preview) sin descifrar; B sigue hasta que también se revoca', async () => {
    expect((await b.audAB.get(searchUrl(camA))).status).toBe(200)
    expect((await b.audAB.get(searchUrl(camB))).status).toBe(200)
    const put = await b.admin.put(`/api/users/${ids.audAB}/permissions`, { cameraPermissions: [{ cameraId: camA, canView: false, canPlayback: false }] })
    expect(put.status).toBe(200)
    const mark = infra.mark()
    for (const [method, url, body] of nvrRoutes().slice(0, 5)) {
      if (url.includes('batch-search')) continue
      const r = await b.audAB.request(method, url, { body })
      expect(r.status, `${method} ${url}`).toBe(403)
    }
    // La búsqueda múltiple filtra: sólo B (canal 2) llega al NVR.
    const bs = await b.audAB.post('/api/recordings/batch-search', { nvrId, cameraIds: [camA, camB], from: T0, to: T1 })
    expect(bs.status).toBe(200)
    expect(infra.of('nvr.isapi', mark).map(c => c.detail.channel)).toEqual([2])
    expect((await b.audAB.get(searchUrl(camB))).status).toBe(200)

    // #186 × revocación: con B (canal 2) permitida y A revocada, la URI del canal de A
    // presentada a través de B no es un atajo lateral: 403 antes de descifrar.
    const lateral = infra.mark()
    for (const [url, extra] of [['/api/recordings/playback', {}], ['/api/recordings/preview/start', { slotIndex: 3 }]] as const) {
      const r = await b.audAB.post(url, { cameraId: camB, ...TIMES, ...extra, playbackURI: `/Streaming/tracks/101/?${W}` })
      expect(r.status, url).toBe(403)
      expect(r.json().code).toBe('PLAYBACK_URI_FORBIDDEN')
    }
    expect(infra.externalEffectsSince(lateral)).toEqual([])

    const post = await b.admin.post(`/api/users/${ids.audAB}/permissions`, [])
    expect(post.status).toBe(200)
    const mark2 = infra.mark()
    expect((await b.audAB.get(searchUrl(camB))).status).toBe(403)
    expect((await b.audAB.post('/api/recordings/playback', { cameraId: camB, ...TIMES })).status).toBe(403)
    expect(infra.externalEffectsSince(mark2)).toEqual([])
  })

  it('higiene: sin red saliente; todo contacto con el NVR fue a su IP TEST-NET y a pistas del canal permitido', () => {
    expect(env.blockedConnections).toEqual([])
    for (const c of infra.of('nvr.isapi')) expect(c.detail.nvrHost).toBe(NVR_IP)
    for (const t of infra.rtspTargetsSince(0)) {
      expect(t.host).toBe(NVR_IP)
      expect(t.pathname).toMatch(OWN_TRACK)
    }
  })
})
