// Suite conjunta de seguridad — audio del canal del NVR (#191 × #190 × #182 sobre
// server.ts real).
//
// Lo que las CI de #191 no prueban en combinación: el cambio de audio llega al NVR
// por la RUTA REAL (login real, cookie HttpOnly, CSRF por Origin, `authorize` real,
// credenciales del NVR cifradas en PG y descifradas por la función real) y el NVR
// recibe EXACTAMENTE el XML esperado.
//
// El NVR es un ISAPI simulado EN MEMORIA (joint-doubles.ts): `axios.create` hacia
// TEST-NET-1 devuelve un cliente que exige Digest con las credenciales ficticias
// (si el descifrado o el usuario no fueran los guardados, el PUT no pasaría) y
// guarda/sirve el XML de /ISAPI/Streaming/channels/<NN><01|02>. Nada de red: el
// guard SSRF real se conserva para cualquier host que no sea TEST-NET-1 y el
// centinela del harness bloquea toda conexión no loopback.
//
// El payload "actual de la UI" sale del builder REAL de apps/web
// (lib/streamConfigPayload.ts): si la UI vuelve a mandar audio sin que el usuario
// lo elija, esta suite lo detecta.
//
// El backup previo de PUT /video-audio lo lee services/hikvision.fetchChannelVideoConfig
// REAL (hikvisionRealReadsDouble) contra el mismo ISAPI simulado: la prueba verifica
// su CONTENIDO, no sólo que exista la fila. Esa lectura no trae el audio (su tipo
// HikChannelVideoConfig sólo tiene codec/resolución/fps/bitrate), así que el estado
// previo del audio no queda en ese backup: AUD-BK-01 (previo, opt-in con
// RUN_KNOWN_DEFECTS=1, al final) muestra que restaurarlo no devuelve el audio.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
// fetchChannelVideoConfig REAL (backup previo de /video-audio) contra el ISAPI simulado.
vi.mock('../services/hikvision', async (orig) => (await import('./joint-doubles')).hikvisionRealReadsDouble(await orig() as any, ['fetchChannelVideoConfig']))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))
// ISAPI de configuración (services/nvr-config/hikvision usa axios.create) y guard SSRF.
vi.mock('axios', async (orig) => (await import('./joint-doubles')).axiosModuleDouble(await orig() as any))
vi.mock('../services/net/nvr-host-guard', async (orig) => (await import('./joint-doubles')).nvrHostGuardDouble(await orig() as any))

import { infra } from './infra-doubles'
import { joint, isapiDocKey } from './joint-doubles'
import {
  jointInfraAvailable, startJointServer, NVR_FAKE_USER, NVR_FAKE_PASS,
  type JointEnv, type SimBrowser, type JointResponse,
} from './harness'
import { obtainNonAccessTokens, nonAccessFailures, type NonAccessTokens } from './joint-helpers'
import { buildStreamPayload } from '../../../web/src/lib/streamConfigPayload'

const RUN_KNOWN_DEFECTS = process.env.RUN_KNOWN_DEFECTS === '1'

const NVR_IP = '192.0.2.80'
const MAIN = '/ISAPI/Streaming/channels/0101'
const SUB = '/ISAPI/Streaming/channels/0102'

/** XML de un StreamingChannel Hikvision: <enabled> del canal, Transport, Video y (opcional) Audio. */
function streamingChannel(o: { id: string; withAudio: boolean; audioEnabled?: string }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<StreamingChannel version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">',
    `<id>${o.id}</id>`,
    '<channelName>Camara Simulada 01</channelName>',
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
    ...(o.withAudio ? [
      '<Audio>',
      `<enabled>${o.audioEnabled ?? 'true'}</enabled>`,
      '<audioInputChannelID>1</audioInputChannelID>',
      '<audioCompressionType>G.711ulaw</audioCompressionType>',
      '</Audio>',
    ] : []),
    '</StreamingChannel>',
    '',
  ].join('\n')
}

const channelEnabled = (xml: string) => /<enabled>([^<]*)<\/enabled>/.exec(xml.slice(0, xml.indexOf('<Transport>')))?.[1]
const audioBlock = (xml: string) => /<Audio>[\s\S]*?<\/Audio>/.exec(xml)?.[0] ?? null
const audioEnabled = (xml: string) => /<Audio>\s*<enabled>([^<]*)<\/enabled>/.exec(xml)?.[1]

/** Formulario de "Video y audio" tal como lo arma NVRDetailPage con los valores actuales. */
const CURRENT_FORM = { videoCodecType: 'H.264', width: 1920, height: 1080, fps: 25, bitrateMax: 4096, bitrateType: 'CBR' }
/** Lo que mandaba la UI ANTERIOR a #191 en cada guardado, aunque sólo se cambiara el FPS. */
const LEGACY_UI_PAYLOAD = { streamType: 'main', ...CURRENT_FORM, audioEnabled: false, audioCodecType: '', audioBitrate: 64 }

describe.skipIf(!jointInfraAvailable())('conjunta · audio del canal del NVR (#191) por la ruta real', { timeout: 60_000 }, () => {
  let env: JointEnv
  let nvrId = ''
  const ids: Record<string, string> = {}
  const b: Record<string, SimBrowser> = {}
  let tokens: NonAccessTokens

  const doc = (path: string) => joint.isapi.docs.get(isapiDocKey(NVR_IP, path))!
  const putVideoAudio = (who: SimBrowser, body: unknown, o: { headers?: Record<string, string>; origin?: string | null } = {}) =>
    who.put(`/api/nvrs/${nvrId}/video-audio/1`, body, o)
  const putVideoConfig = (who: SimBrowser, body: unknown, o: { headers?: Record<string, string>; origin?: string | null } = {}) =>
    who.put(`/api/nvrs/${nvrId}/channels/1/video-config`, body, o)

  beforeAll(async () => {
    env = await startJointServer({ label: 'nvraudio' })
    // El NVR simulado sólo acepta las credenciales ficticias que la suite guardó CIFRADAS.
    joint.isapi.accept = { username: NVR_FAKE_USER, password: NVR_FAKE_PASS }
    nvrId = (await env.createNvr('NVR conjunto audio', NVR_IP)).id
    const camA = (await env.createCamera(nvrId, 1)).id
    ids.admin = (await env.createUser('admin_audio', 'ADMIN')).id
    ids.sup = (await env.createUser('sup_audio', 'SUPERVISOR')).id
    ids.op = (await env.createUser('op_audio', 'OPERATOR')).id
    ids.aud = (await env.createUser('aud_audio', 'AUDITOR')).id
    // Permisos amplios sobre el NVR: el 403 debe venir del ROL, no de la falta de filas.
    await env.grant(ids.op, nvrId, null, { canView: true })
    await env.grant(ids.aud, nvrId, camA, { canView: true, canPlayback: true })
    for (const [k, user] of [['admin', 'admin_audio'], ['sup', 'sup_audio'], ['op', 'op_audio'], ['aud', 'aud_audio']] as const) {
      b[k] = env.browser(k)
      await b[k].signIn(user)
    }
    tokens = await obtainNonAccessTokens(env, b.admin, 'audio')
  }, 120_000)

  beforeEach(() => {
    joint.isapi.docs.clear()
    joint.isapi.docs.set(isapiDocKey(NVR_IP, MAIN), streamingChannel({ id: '101', withAudio: true }))
    // Substream sin bloque <Audio> (habitual en el sub): cualquier cambio de audio ⇒ 422 sin PUT.
    joint.isapi.docs.set(isapiDocKey(NVR_IP, SUB), streamingChannel({ id: '102', withAudio: false }))
  })

  afterAll(async () => {
    joint.isapi.accept = null
    joint.isapi.docs.clear()
    await env?.stop()
  })

  it('UI "Deshabilitar": por login real + cookie + CSRF, el NVR recibe un PUT autenticado (Digest con las credenciales descifradas) que SÓLO cambia <Audio><enabled>; el canal sigue habilitado', async () => {
    const before = doc(MAIN)
    const payload = buildStreamPayload('main', { ...CURRENT_FORM, audio: 'off' })
    expect(payload).toEqual({ streamType: 'main', ...CURRENT_FORM, audioEnabled: false })   // contrato de la UI
    const mark = joint.mark()
    const iMark = infra.mark()
    const r = await putVideoAudio(b.admin, payload)
    expect(r.status, r.text).toBe(200)

    // Cada petición recibe primero el desafío Digest (401) y se reintenta autenticada:
    // al NVR le llega exactamente UNA escritura aceptada, sobre el stream principal.
    expect(joint.isapiCalls(mark, 'PUT').filter(p => p.authorized).map(p => p.path)).toEqual([MAIN])
    const after = doc(MAIN)
    expect(after).toBe(before.replace('<Audio>\n<enabled>true</enabled>', '<Audio>\n<enabled>false</enabled>'))
    expect(after).not.toBe(before)
    expect(channelEnabled(after)).toBe('true')
    expect(audioEnabled(after)).toBe('false')
    for (const c of joint.isapiCalls(mark)) expect(c.host).toBe(NVR_IP)
    // Descifrado REAL de la clave guardada y auditoría del cambio.
    expect(infra.of('credentials.decrypt', iMark).length).toBeGreaterThan(0)
    expect(await env.prisma.auditLog.count({ where: { userId: ids.admin, action: 'NVR_CHANNEL_CONFIG_UPDATED', resource: nvrId } })).toBe(1)
    // Backup previo: UNA fila y con el CONTENIDO real del canal, leído del NVR (GET
    // autenticado de main y sub) ANTES del PUT. Sin la lectura real quedaba '{}'.
    const backups = await env.prisma.nvrChannelConfigBackup.findMany({ where: { nvrId, channelNo: 1, createdByUserId: ids.admin } })
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatchObject({ reason: 'before_edit', streamType: 'main' })
    const saved = JSON.parse(backups[0].configJson)
    expect(saved.main).toEqual({ codec: 'H.264', resolution: '1920x1080', fps: 25, bitrate: 4096 })
    expect(saved.sub).toEqual({ codec: 'H.264', resolution: '1920x1080', fps: 25, bitrate: 4096 })
    // Esa lectura NO incluye el audio (HikChannelVideoConfig): ver AUD-BK-01.
    expect(Object.keys(saved.main).filter(k => /audio/i.test(k))).toEqual([])
    expect(backups[0].configJson).not.toContain(NVR_FAKE_PASS)
    expect(backups[0].configJson).not.toContain(NVR_FAKE_USER)
    const gets = joint.isapiCalls(mark, 'GET').filter(g => g.authorized)
    expect(gets.map(g => g.path)).toEqual(expect.arrayContaining([MAIN, SUB]))
    const firstPut = joint.of('isapi.http', mark).find(c => c.detail.method === 'PUT' && c.detail.authorized)!
    const backupReads = joint.of('isapi.http', mark).filter(c => c.detail.method === 'GET' && c.detail.authorized && [MAIN, SUB].includes(String(c.detail.path)))
    expect(backupReads.length).toBeGreaterThanOrEqual(2)
    expect(Math.min(...backupReads.map(c => c.seq))).toBeLessThan(firstPut.seq)
    expect(infra.of('nvr.isapi', iMark).map(c => c.detail.fn)).toEqual(['fetchChannelVideoConfig'])
    // La respuesta no devuelve credenciales del NVR.
    expect(r.text).not.toContain(NVR_FAKE_PASS)
    expect(r.text).not.toContain(NVR_FAKE_USER)
  })

  it('UI "Sin cambios" (payload actual: sólo video) cambia el FPS y NO toca <Audio> (byte a byte); "Habilitar" sólo enciende el audio', async () => {
    const before = doc(MAIN)
    const keep = buildStreamPayload('main', { ...CURRENT_FORM, fps: 15, audio: 'keep' })
    expect(Object.keys(keep).filter(k => k.startsWith('audio'))).toEqual([])
    const mark = joint.mark()
    const r = await putVideoAudio(b.admin, keep)
    expect(r.status, r.text).toBe(200)
    const after = doc(MAIN)
    expect(after).toBe(before.replace('<maxFrameRate>2500</maxFrameRate>', '<maxFrameRate>1500</maxFrameRate>'))
    expect(audioBlock(after)).toBe(audioBlock(before))
    expect(channelEnabled(after)).toBe('true')
    expect(joint.isapiCalls(mark, 'PUT').filter(p => p.authorized).map(p => p.path)).toEqual([MAIN])

    // Habilitar desde un estado apagado: sólo cambia el <enabled> del bloque <Audio>.
    joint.isapi.docs.set(isapiDocKey(NVR_IP, MAIN), streamingChannel({ id: '101', withAudio: true, audioEnabled: 'false' }))
    const off = doc(MAIN)
    const on = await putVideoAudio(b.admin, buildStreamPayload('main', { ...CURRENT_FORM, audio: 'on' }))
    expect(on.status, on.text).toBe(200)
    expect(doc(MAIN)).toBe(off.replace('<Audio>\n<enabled>false</enabled>', '<Audio>\n<enabled>true</enabled>'))
  })

  it('payload de la UI ANTERIOR (audioEnabled:false, audioCodecType:"", audioBitrate:64) y "false" como texto ⇒ 422 SIN PUT al NVR; el XML queda intacto', async () => {
    const before = doc(MAIN)
    const mark = joint.mark()
    const legacy = await putVideoAudio(b.admin, LEGACY_UI_PAYLOAD)
    expect(legacy.status, legacy.text).toBe(422)
    const asText = await putVideoAudio(b.admin, { streamType: 'main', fps: 25, audioEnabled: 'false' })
    expect(asText.status, asText.text).toBe(422)
    // Sub sin bloque <Audio>: no hay dónde aplicarlo ⇒ 422, nunca el <enabled> del canal.
    const noBlock = await putVideoAudio(b.admin, { streamType: 'sub', audioEnabled: false })
    expect(noBlock.status, noBlock.text).toBe(422)
    expect(joint.isapiCalls(mark, 'PUT')).toEqual([])
    expect(doc(MAIN)).toBe(before)
    expect(channelEnabled(doc(SUB))).toBe('true')
  })

  it('PUT …/channels/:ch/video-config (Zod): audioEnabled:false sólo cambia <Audio><enabled> y deja backup; "false" texto ⇒ 400 y sub sin <Audio> ⇒ 422, ambos sin PUT', async () => {
    const before = doc(MAIN)
    const mark = joint.mark()
    const ok = await putVideoConfig(b.admin, { streamType: 'main', update: { audioEnabled: false } })
    expect(ok.status, ok.text).toBe(200)
    expect(doc(MAIN)).toBe(before.replace('<Audio>\n<enabled>true</enabled>', '<Audio>\n<enabled>false</enabled>'))
    expect(channelEnabled(doc(MAIN))).toBe('true')
    expect(ok.json().main.audioEnabled).toBe(false)          // releído del NVR, desde el bloque <Audio>
    expect(joint.isapiCalls(mark, 'PUT').filter(p => p.authorized).map(p => p.path)).toEqual([MAIN])
    const backup = await env.prisma.nvrChannelConfigBackup.findFirst({ where: { nvrId, channelNo: 1, reason: 'before_edit', streamType: 'main' }, orderBy: { createdAt: 'desc' } })
    expect(JSON.parse(backup!.configJson).main.audioBlockPresent).toBe(true)
    expect(backup!.configJson).not.toContain(NVR_FAKE_PASS)

    const mark2 = joint.mark()
    const typed = await putVideoConfig(b.admin, { streamType: 'main', update: { audioEnabled: 'false' } })
    expect(typed.status).toBe(400)
    const sub = await putVideoConfig(b.admin, { streamType: 'sub', update: { audioEnabled: true } })
    expect(sub.status, sub.text).toBe(422)
    expect(joint.isapiCalls(mark2, 'PUT')).toEqual([])
  })

  it('roles: SUPERVISOR, OPERATOR (fila NVR canView) y AUDITOR ⇒ 403 en ambas rutas, sin descifrar ni contactar el ISAPI', async () => {
    const before = doc(MAIN)
    const mark = joint.mark()
    const iMark = infra.mark()
    const failures: string[] = []
    for (const who of ['sup', 'op', 'aud'] as const) {
      for (const [label, send] of [
        ['video-audio', () => putVideoAudio(b[who], buildStreamPayload('main', { ...CURRENT_FORM, audio: 'off' }))],
        ['video-config', () => putVideoConfig(b[who], { streamType: 'main', update: { audioEnabled: false } })],
      ] as Array<[string, () => Promise<JointResponse>]>) {
        const r = await send()
        if (r.status !== 403) failures.push(`${who} ${label} ⇒ ${r.status}`)
      }
    }
    expect(failures).toEqual([])
    expect(joint.isapiCalls(mark)).toEqual([])
    expect(infra.externalEffectsSince(iMark)).toEqual([])
    expect(doc(MAIN)).toBe(before)
  })

  it('#190: tempToken 2fa, enrollToken, step-up y refresh (del propio ADMIN), por Bearer o cookie ⇒ 401 en ambas rutas sin contactar el ISAPI', async () => {
    const before = doc(MAIN)
    const mark = joint.mark()
    const iMark = infra.mark()
    const failures = [
      ...await nonAccessFailures(env, tokens, (atk, headers) => putVideoAudio(atk, buildStreamPayload('main', { ...CURRENT_FORM, audio: 'off' }), { headers }), 'video-audio'),
      ...await nonAccessFailures(env, tokens, (atk, headers) => putVideoConfig(atk, { streamType: 'main', update: { audioEnabled: false } }, { headers }), 'video-config'),
    ]
    expect(failures).toEqual([])
    expect(joint.isapiCalls(mark)).toEqual([])
    expect(infra.externalEffectsSince(iMark)).toEqual([])
    expect(doc(MAIN)).toBe(before)
  })

  it('CSRF: con la cookie del ADMIN pero sin Origin, o con un Origin ajeno ⇒ 403 CSRF_BLOCKED antes de autenticar; el NVR no recibe nada', async () => {
    const before = doc(MAIN)
    const mark = joint.mark()
    for (const origin of [null, 'https://atacante.example']) {
      const r1 = await putVideoAudio(b.admin, buildStreamPayload('main', { ...CURRENT_FORM, audio: 'off' }), { origin })
      const r2 = await putVideoConfig(b.admin, { streamType: 'main', update: { audioEnabled: false } }, { origin })
      for (const r of [r1, r2]) {
        expect(r.status).toBe(403)
        expect(r.json().code).toBe('CSRF_BLOCKED')
      }
    }
    expect(joint.isapiCalls(mark)).toEqual([])
    expect(doc(MAIN)).toBe(before)
  })

  // ── DEFECTO PREVIO (fuera del alcance de #191) — opt-in ─────────────────────
  // El backup que deja la UI (PUT /video-audio) tiene la forma de services/hikvision
  // ({ main: { codec, resolution, fps, bitrate } }), sin audio; …/video-config/restore
  // lo lee como ChannelVideoConfig de nvr-config ({ main: { videoCodecType, width, …,
  // audioBlockPresent } }). Ambos son previos a #191: ya están en los commits borde
  // de este clon superficial (130bfe4 y 9b83584, ancestros de origin/main; el commit
  // que los introdujo no es visible acá). La UI no ofrece "restaurar"; el endpoint es
  // sólo API (ADMIN).
  it.runIf(RUN_KNOWN_DEFECTS)('AUD-BK-01 — restaurar el backup que dejó "Deshabilitar" (UI) devuelve el audio y el resto del canal al estado previo', async () => {
    const before = doc(MAIN)
    const off = await putVideoAudio(b.admin, buildStreamPayload('main', { ...CURRENT_FORM, audio: 'off' }))
    expect(off.status, off.text).toBe(200)
    expect(audioEnabled(doc(MAIN))).toBe('false')
    const backup = await env.prisma.nvrChannelConfigBackup.findFirstOrThrow({
      where: { nvrId, channelNo: 1, createdByUserId: ids.admin, streamType: 'main', reason: 'before_edit' }, orderBy: { createdAt: 'desc' },
    })
    const mark = joint.mark()
    const restore = await b.admin.post(`/api/nvrs/${nvrId}/channels/1/video-config/restore`, { backupId: backup.id, streamType: 'main' })
    // DEFECTO: el restore sólo encuentra `fps` en ese backup (las demás claves no
    // existen en esa forma) y responde OK; el audio queda apagado.
    expect.soft(restore.status, `restore: ${restore.text.slice(0, 160)}`).toBe(200)
    expect.soft(audioEnabled(doc(MAIN)), 'audio restaurado al valor previo').toBe('true')
    expect.soft(doc(MAIN), 'canal idéntico al previo').toBe(before)
    expect.soft(joint.isapiCalls(mark, 'PUT').filter(p => p.authorized).map(p => p.path), 'el restore escribió el canal').toEqual([MAIN])
  })

  it('higiene: sin red saliente; todo contacto con el ISAPI fue a la IP TEST-NET del NVR simulado', () => {
    expect(env.blockedConnections).toEqual([])
    expect(joint.of('outbound.http')).toEqual([])
    expect(joint.isapiCalls(0).length).toBeGreaterThan(0)
    for (const c of joint.isapiCalls(0)) expect(c.host).toBe(NVR_IP)
  })
})
