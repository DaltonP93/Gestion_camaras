// Suite conjunta de seguridad — aislamiento de staging (#187) sobre server.ts real,
// combinado con #182/#186/#189/#190.
//
// Lo que las CI de #187 no prueban en combinación: server.startup.test.ts arranca
// server.ts con PostgreSQL/Redis EN MEMORIA y los jobs reemplazados por espías;
// staging-isolation.workers.test.ts corre los jobs con un servidor falso. Acá:
//   - PostgreSQL/Redis efímeros REALES (harness) y los jobs REALES (healthWorker,
//     syncWorker). node-cron se captura (joint-doubles): ningún job corre solo y la
//     prueba los ejecuta a mano para ver qué contactan;
//   - el re-registro diferido de streams lo captura el harness (`deferredReregister`);
//   - NVR/MediaMTX/FFmpeg/ffprobe/credenciales con los dobles de infra-doubles; SMTP
//     (nodemailer) y HTTP saliente (axios) con dobles que registran y fallan sin red;
//   - y AL MISMO TIEMPO la seguridad de los demás PRs con login real: #190 (sólo
//     access), MFA, #189 (heartbeat con RBAC), borde HLS y #186 (playbackURI).
//
// Cada `describe` arranca su PROPIO server.ts (`vi.resetModules()` entre arranques).
// Los módulos MOCKEADOS no se reinician (vitest conserva el registro de mocks), así
// que sus dobles siguen escribiendo en el `infra` del import estático de este
// archivo; un `import('./infra-doubles')` dinámico tras el reinicio daría OTRA
// instancia vacía (verificado). `joint` vive además en globalThis.
//
// Cada flag individual se prueba TAMBIÉN sin STAGING_ISOLATION (OUTBOUND_NOTIFICATIONS_
// ENABLED=false y STREAM_AUTO_REGISTER_ENABLED=false): cada una apaga sólo lo suyo.
// Las pruebas unitarias de #187 lo cubren con dobles; acá queda de punta a punta.
//
// STG-01 (opt-in con RUN_KNOWN_DEFECTS=1, al final) NO es un defecto de la
// implementación de #187: es una DECISIÓN PENDIENTE de alcance. El contrato de #187
// (cabecera de services/staging-isolation.ts) cubre lo que la API hace SOLA; una
// acción de USUARIO en staging (vista en vivo, búsqueda de grabaciones) sigue
// descifrando la clave del NVR y contactándolo. Aislar o no ese contacto (flag
// propia, bloqueo de salida de red) lo decide el usuario: bloquearlo sin más
// chocaría con las mediciones autorizadas con los NVR.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Jobs REALES (sin healthWorkerDouble/syncWorkerDouble): node-cron capturado.
vi.mock('node-cron', async () => (await import('./joint-doubles')).nodeCronDouble())
vi.mock('nodemailer', async () => (await import('./joint-doubles')).nodemailerDouble())
vi.mock('axios', async (orig) => (await import('./joint-doubles')).axiosModuleDouble(await orig() as any))
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))

import net from 'node:net'
import { randomBytes } from 'node:crypto'
import Redis from 'ioredis'
import { PrismaClient } from '@prisma/client'
import { infra } from './infra-doubles'
import { joint, resetCapturedCron } from './joint-doubles'
import {
  jointInfraAvailable, startJointServer, totpNow,
  type JointEnv, type SimBrowser,
} from './harness'
import { obtainNonAccessTokens, nonAccessFailures, type NonAccessTokens } from './joint-helpers'

const RUN_KNOWN_DEFECTS = process.env.RUN_KNOWN_DEFECTS === '1'

const NVR_IP = '192.0.2.90'
const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-01T10:05:00.000Z'
const W = 'starttime=20261001T100000Z&endtime=20261001T100500Z'

const NVR_POLL = '*/60 * * * * *'
const FIVE_MIN = '*/5 * * * *'          // re-registro de MediaMTX (healthWorker)
// syncWorker: la misma expresión que arma jobs/syncWorker.ts (NVR_SYNC_INTERVAL_MINUTES, 5 por defecto).
const SYNC_MIN = Number(process.env.NVR_SYNC_INTERVAL_MINUTES || 5)
const SYNC_CRON = SYNC_MIN <= 1 ? '* * * * *' : `*/${SYNC_MIN} * * * *`
const INTERNAL_JOBS = ['*/2 * * * *', '0 * * * *', '30 3 * * *']   // limpieza de stream idle, sesiones vencidas, retención

const ISOLATION_FLAGS = ['STAGING_ISOLATION', 'NVR_POLLING_ENABLED', 'NVR_SYNC_ENABLED', 'STREAM_AUTO_REGISTER_ENABLED', 'OUTBOUND_NOTIFICATIONS_ENABLED']

/** Lo mínimo que toda ruta de usuario necesita: NVR TEST-NET, dos cámaras y usuarios por rol. */
async function seed(env: JointEnv, tag: string) {
  const nvrId = (await env.createNvr(`NVR staging ${tag}`, NVR_IP)).id
  const camA = (await env.createCamera(nvrId, 1)).id
  const camB = (await env.createCamera(nvrId, 2)).id
  const ids: Record<string, string> = {}
  ids.admin = (await env.createUser(`admin_${tag}`, 'ADMIN')).id
  ids.op = (await env.createUser(`op_${tag}`, 'OPERATOR')).id
  ids.aud = (await env.createUser(`aud_${tag}`, 'AUDITOR')).id
  await env.grant(ids.op, nvrId, camA, { canView: true })
  await env.grant(ids.aud, nvrId, camA, { canView: false, canPlayback: true })
  const b: Record<string, SimBrowser> = {}
  for (const k of ['admin', 'op', 'aud'] as const) {
    b[k] = env.browser(`${tag}-${k}`)
    await b[k].signIn(`${k}_${tag}`)
  }
  return { nvrId, camA, camB, ids, b }
}

const sortedExprs = () => joint.cron.map(j => j.expr).sort()

describe.skipIf(!jointInfraAvailable())('conjunta · aislamiento de staging (#187) con server.ts real', { timeout: 90_000 }, () => {
  // ───────────────────────────────────────────────────────────────────────────
  describe('STAGING_ISOLATION=true (con NVR_POLLING_ENABLED=true, que NO puede re-habilitar nada)', () => {
    let env: JointEnv
    let s: Awaited<ReturnType<typeof seed>>
    let tokens: NonAccessTokens

    const hlsUri = (channel: number) => `/hls/nvr_${s.nvrId}_ch${String(channel).padStart(2, '0')}_sub/index.m3u8`

    beforeAll(async () => {
      resetCapturedCron()
      env = await startJointServer({ label: 'stgiso', env: { STAGING_ISOLATION: 'true', NVR_POLLING_ENABLED: 'true' } })
      s = await seed(env, 'stg')
      tokens = await obtainNonAccessTokens(env, s.b.admin, 'stg')
    }, 120_000)

    afterAll(async () => {
      await env?.stop()
      vi.resetModules()
    })

    it('arranque: sólo se agendan las limpiezas internas, NO el sondeo de NVR, el re-registro de MediaMTX ni el sync; tampoco el re-registro diferido de 5 s', () => {
      expect(sortedExprs()).toEqual([...INTERNAL_JOBS].sort())
      expect(sortedExprs()).not.toContain(NVR_POLL)
      expect(sortedExprs()).not.toContain(FIVE_MIN)
      expect(env.deferredReregister).toBe(0)
      expect(infra.of('streams.reregister')).toEqual([])
    })

    it('ejecutar TODOS los jobs agendados (con NVR activo y online en la DB) no contacta NVR, MediaMTX, FFmpeg, SMTP ni HTTP, ni descifra; las limpiezas internas sí corren', async () => {
      const expired = await env.prisma.session.create({
        data: { userId: s.ids.op, refreshToken: `vencida-${Date.now()}`, expiresAt: new Date(Date.now() - 3_600_000) },
      })
      const mark = infra.mark()
      const jMark = joint.mark()
      for (const job of [...joint.cron]) await job.fn()
      expect(infra.externalEffectsSince(mark)).toEqual([])
      expect(joint.of('outbound.smtp', jMark)).toEqual([])
      expect(joint.of('outbound.http', jMark)).toEqual([])
      expect(await env.prisma.session.count({ where: { id: expired.id } })).toBe(0)   // la limpieza corrió
      expect(env.blockedConnections).toEqual([])
    })

    it('autenticación intacta: login + 2FA real dan access; los tokens no-access (#190) ⇒ 401 en /me, heartbeat, ws-ticket y el borde HLS; el WS de alertas abre con ticket', async () => {
      const mfa = await env.createMfaUser('op_mfa_stg', 'OPERATOR')
      await env.grant(mfa.id, s.nvrId, s.camA, { canView: true })
      const mb = env.browser('stg-mfa')
      const l = await mb.login('op_mfa_stg')
      expect(l.json().requiresTwoFactor).toBe(true)
      expect(l.setCookies.map(c => c.name)).not.toContain('access_token')
      const v = await mb.verify2fa(l.json().tempToken, await totpNow(mfa.secret))
      expect(v.status).toBe(200)
      expect((await mb.get('/api/auth/me')).json().id).toBe(mfa.id)

      const failures = [
        ...await nonAccessFailures(env, tokens, (atk, headers) => atk.get('/api/auth/me', { headers }), 'me'),
        ...await nonAccessFailures(env, tokens, (atk, headers) => atk.heartbeat('v-stg-atk', [s.camA], { headers }), 'heartbeat'),
        ...await nonAccessFailures(env, tokens, (atk, headers) => atk.post('/api/auth/ws-ticket', undefined, { headers }), 'ws-ticket'),
      ]
      expect(failures).toEqual([])
      for (const tok of Object.values(tokens)) {
        expect((await env.hlsAuth(hlsUri(1), { cookie: tok })).status).toBe(401)
        expect((await env.hlsAuth(hlsUri(1), { bearer: tok })).status).toBe(401)
      }
      const ws = await s.b.op.openAlerts()
      expect(ws.ws.readyState).toBe(1)
      ws.ws.close()
    })

    it('#189 bajo aislamiento: el heartbeat sólo devuelve (y sólo podría publicar) la cámara permitida; la denegada nunca llega a MediaMTX; el borde HLS decide igual (200/403/401, IP externa 403)', async () => {
      const mark = infra.mark()
      const hb = await s.b.op.heartbeat('v-stg', [s.camA, s.camB])
      expect(hb.status).toBe(200)
      expect(Object.keys(hb.json().streams)).toEqual([s.camA])
      expect(hb.json().streams[s.camA].hls).toBe(hlsUri(1))
      const published = infra.of('mediamtx.publish', mark).map(c => c.detail.cameraId)
      expect(published).not.toContain(s.camB)
      for (const cam of published) expect(cam).toBe(s.camA)
      expect((await env.hlsAuth(hlsUri(1), { browser: s.b.op })).status).toBe(200)
      expect((await env.hlsAuth(hlsUri(2), { browser: s.b.op })).status).toBe(403)
      expect((await env.hlsAuth(hlsUri(1))).status).toBe(401)
      expect((await env.hlsAuth(hlsUri(1), { browser: s.b.op, remoteAddress: '198.51.100.77' })).status).toBe(403)
      // Revocación por la ruta real: corta en la próxima petición del borde.
      expect((await s.b.admin.put(`/api/users/${s.ids.op}/permissions`, { cameraPermissions: [{ cameraId: s.camA, canView: false }] })).status).toBe(200)
      expect((await env.hlsAuth(hlsUri(1), { browser: s.b.op })).status).toBe(403)
      // Restauración (precondición de STG-01): debe aplicarse de verdad.
      const restored = await s.b.admin.post(`/api/users/${s.ids.op}/permissions`, [{ nvrId: s.nvrId, cameraId: s.camA, canView: true }])
      expect(restored.status, restored.text).toBe(200)
      expect(restored.json().count).toBe(1)
      expect((await env.hlsAuth(hlsUri(1), { browser: s.b.op })).status).toBe(200)
    })

    it('#186 bajo aislamiento: URI de OTRO canal ⇒ 403 PLAYBACK_URI_FORBIDDEN, malformada ⇒ 400, OPERATOR ⇒ 403 y tokens no-access ⇒ 401; nada de eso descifra ni contacta el NVR', async () => {
      const mark = infra.mark()
      const foreign = await s.b.aud.post('/api/recordings/playback', { cameraId: s.camA, startTime: T0, endTime: T1, playbackURI: `/Streaming/tracks/201/?${W}` })
      expect(foreign.status).toBe(403)
      expect(foreign.json().code).toBe('PLAYBACK_URI_FORBIDDEN')
      const bad = await s.b.aud.post('/api/recordings/preview/start', { cameraId: s.camA, slotIndex: 0, startTime: T0, endTime: T1, playbackURI: `/Streaming/tracks/101?__proto__=1&${W}` })
      expect(bad.status).toBe(400)
      expect(bad.json().code).toBe('PLAYBACK_URI_INVALID')
      expect((await s.b.op.get(`/api/recordings/search?cameraId=${s.camA}&startTime=${T0}&endTime=${T1}`)).status).toBe(403)
      const failures = await nonAccessFailures(env, tokens, (atk, headers) => atk.get(`/api/recordings/search?cameraId=${s.camA}&startTime=${T0}&endTime=${T1}`, { headers }), 'search')
      expect(failures).toEqual([])
      expect(infra.externalEffectsSince(mark)).toEqual([])
    })

    it('notificaciones salientes: correo de prueba ⇒ 409 OUTBOUND_DISABLED; recuperación de contraseña ⇒ respuesta genérica y token, sin SMTP; el despacho real de una alerta deja cada canal en "skipped" sin SMTP ni HTTP', async () => {
      const cfg = await s.b.admin.put('/api/alerts/settings', {
        emailEnabled: true, smtpHost: 'smtp.example.test', smtpPort: 587, smtpFromEmail: 'alertas@example.test',
        recipientEmails: 'operaciones@example.test', minSeverity: 'LOW',
        webhookEnabled: true, webhookUrl: 'https://hooks.example.test/visioncore',
      })
      expect(cfg.status, cfg.text).toBe(200)
      const jMark = joint.mark()
      const test = await s.b.admin.post('/api/alerts/settings/test-email', { testEmail: 'operaciones@example.test' })
      expect(test.status).toBe(409)
      expect(test.json().code).toBe('OUTBOUND_DISABLED')

      const forgot = await env.browser('stg-olvido').post('/api/auth/forgot-password', { email: 'admin_stg@example.test' })
      expect(forgot.status).toBe(200)
      expect(forgot.json().message).toMatch(/Si el correo existe/)
      expect((await env.prisma.user.findUniqueOrThrow({ where: { id: s.ids.admin } })).passwordResetToken).toBeTruthy()

      const alert = await env.prisma.alert.create({ data: { nvrId: s.nvrId, cameraId: s.camA, type: 'CAMERA_OFFLINE', severity: 'HIGH', message: 'Cámara simulada sin señal' } })
      const ns = await import('../services/notification.service')
      await ns.sendAlertNotification(env.server.prisma, { id: alert.id, type: alert.type, severity: alert.severity, message: alert.message, detail: null, cameraId: alert.cameraId, nvrId: alert.nvrId } as any)
      const deliveries = await env.prisma.notificationDelivery.findMany({ where: { alertId: alert.id }, select: { channel: true, status: true, errorCode: true } })
      expect(deliveries.sort((a, z) => a.channel.localeCompare(z.channel))).toEqual([
        { channel: 'email', status: 'skipped', errorCode: 'OUTBOUND_DISABLED' },
        { channel: 'webhook', status: 'skipped', errorCode: 'OUTBOUND_DISABLED' },
      ])
      expect(joint.of('outbound.smtp', jMark)).toEqual([])
      expect(joint.of('outbound.http', jMark)).toEqual([])
      expect(env.blockedConnections).toEqual([])
    })

    // ── DECISIÓN PENDIENTE (alcance de #187, fuera de su contrato) — opt-in ───
    it.runIf(RUN_KNOWN_DEFECTS)('STG-01 (decisión pendiente) — con STAGING_ISOLATION=true una acción de USUARIO no descifra la clave del NVR ni lo contacta (vista en vivo, búsqueda de grabaciones)', async () => {
      const mark = infra.mark()
      const hb = await s.b.op.heartbeat('v-stg-01', [s.camA])
      expect(hb.status).toBe(200)
      // Precondición: el OPERATOR TIENE la cámara (restaurada al final de la prueba
      // #189). Sin esto, "sin descifrar / sin publicar" pasaría en vacío.
      expect(Object.keys(hb.json().streams)).toEqual([s.camA])
      // Fuera del contrato de #187 (sólo apaga lo autónomo): el heartbeat descifra la
      // clave y da de alta en MediaMTX el path con la URL RTSP del NVR (MediaMTX lo
      // contactaría); con la DB copiada de producción, el NVR es el real.
      expect.soft(infra.of('credentials.decrypt', mark).length, 'vivo: clave del NVR descifrada').toBe(0)
      expect.soft(infra.of('mediamtx.publish', mark).map(c => c.detail.streamPath), 'vivo: fuente RTSP del NVR entregada a MediaMTX').toEqual([])
      const m2 = infra.mark()
      const search = await s.b.aud.get(`/api/recordings/search?cameraId=${s.camA}&startTime=${T0}&endTime=${T1}`)
      expect.soft(infra.of('nvr.isapi', m2).map(c => `${c.detail.fn}@${c.detail.nvrHost}`), `grabaciones (${search.status}): ISAPI del NVR`).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('sin variables de aislamiento (comportamiento actual)', () => {
    let env: JointEnv
    let s: Awaited<ReturnType<typeof seed>>

    beforeAll(async () => {
      for (const k of ISOLATION_FLAGS) expect(process.env[k], k).toBeUndefined()
      resetCapturedCron()
      env = await startJointServer({ label: 'stgoff' })
      s = await seed(env, 'stgoff')
    }, 120_000)

    afterAll(async () => {
      await env?.stop()
      vi.resetModules()
    })

    it('agenda sondeo de NVR (60 s), re-registro de MediaMTX y sync (5 min), además de las limpiezas; y el re-registro diferido de 5 s tras escuchar', () => {
      expect(sortedExprs()).toEqual([NVR_POLL, FIVE_MIN, SYNC_CRON, ...INTERNAL_JOBS].sort())
      expect(env.deferredReregister).toBe(1)
    })

    it('el sondeo agendado SÍ contacta el NVR (descifra su clave y consulta ISAPI) y el correo de prueba SÍ intenta SMTP (falla sin red)', async () => {
      const mark = infra.mark()
      const poll = joint.cron.find(j => j.expr === NVR_POLL)!
      await poll.fn()
      expect(infra.of('credentials.decrypt', mark).length).toBeGreaterThan(0)
      expect(infra.of('nvr.isapi', mark).map(c => c.detail.nvrHost)).toContain(NVR_IP)

      const cfg = await s.b.admin.put('/api/alerts/settings', { smtpHost: 'smtp.example.test', smtpPort: 587, smtpFromEmail: 'alertas@example.test' })
      expect(cfg.status).toBe(200)
      const jMark = joint.mark()
      const test = await s.b.admin.post('/api/alerts/settings/test-email', { testEmail: 'operaciones@example.test' })
      expect(test.status).toBe(500)
      expect(joint.of('outbound.smtp', jMark).map(c => c.detail.op)).toEqual(['createTransport', 'sendMail'])
      expect(env.blockedConnections).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Flags individuales SIN el interruptor general: cada una apaga sólo lo suyo. Sin
  // estos dos arranques, que resolveIsolationConfig ignore OUTBOUND_NOTIFICATIONS_
  // ENABLED=false o STREAM_AUTO_REGISTER_ENABLED=false fuera de staging sobrevivía a
  // la suite conjunta (mutantes verificados).
  describe('OUTBOUND_NOTIFICATIONS_ENABLED=false SIN STAGING_ISOLATION: sólo se apagan las salidas (correo, webhooks)', () => {
    let env: JointEnv
    let s: Awaited<ReturnType<typeof seed>>

    beforeAll(async () => {
      for (const k of ISOLATION_FLAGS) expect(process.env[k], k).toBeUndefined()
      resetCapturedCron()
      env = await startJointServer({ label: 'stgout', env: { OUTBOUND_NOTIFICATIONS_ENABLED: 'false' } })
      s = await seed(env, 'stgout')
    }, 120_000)

    afterAll(async () => {
      await env?.stop()
      vi.resetModules()
    })

    it('arranque: el sondeo de NVR, el re-registro de MediaMTX, el sync, las limpiezas y el re-registro diferido de 5 s siguen agendados', () => {
      expect(sortedExprs()).toEqual([NVR_POLL, FIVE_MIN, SYNC_CRON, ...INTERNAL_JOBS].sort())
      expect(env.deferredReregister).toBe(1)
    })

    it('correo de prueba ⇒ 409 OUTBOUND_DISABLED; recuperación de contraseña ⇒ respuesta genérica y token, sin SMTP; el despacho real de una alerta deja cada canal en "skipped" sin SMTP ni HTTP; el sondeo agendado SÍ contacta el NVR', async () => {
      const cfg = await s.b.admin.put('/api/alerts/settings', {
        emailEnabled: true, smtpHost: 'smtp.example.test', smtpPort: 587, smtpFromEmail: 'alertas@example.test',
        recipientEmails: 'operaciones@example.test', minSeverity: 'LOW',
        webhookEnabled: true, webhookUrl: 'https://hooks.example.test/visioncore',
      })
      expect(cfg.status, cfg.text).toBe(200)
      const jMark = joint.mark()
      const test = await s.b.admin.post('/api/alerts/settings/test-email', { testEmail: 'operaciones@example.test' })
      expect(test.status).toBe(409)
      expect(test.json().code).toBe('OUTBOUND_DISABLED')

      const forgot = await env.browser('stgout-olvido').post('/api/auth/forgot-password', { email: 'admin_stgout@example.test' })
      expect(forgot.status).toBe(200)
      expect(forgot.json().message).toMatch(/Si el correo existe/)
      expect((await env.prisma.user.findUniqueOrThrow({ where: { id: s.ids.admin } })).passwordResetToken).toBeTruthy()

      const alert = await env.prisma.alert.create({ data: { nvrId: s.nvrId, cameraId: s.camA, type: 'CAMERA_OFFLINE', severity: 'HIGH', message: 'Cámara simulada sin señal' } })
      const ns = await import('../services/notification.service')
      await ns.sendAlertNotification(env.server.prisma, { id: alert.id, type: alert.type, severity: alert.severity, message: alert.message, detail: null, cameraId: alert.cameraId, nvrId: alert.nvrId } as any)
      const deliveries = await env.prisma.notificationDelivery.findMany({ where: { alertId: alert.id }, select: { channel: true, status: true, errorCode: true } })
      expect(deliveries.sort((a, z) => a.channel.localeCompare(z.channel))).toEqual([
        { channel: 'email', status: 'skipped', errorCode: 'OUTBOUND_DISABLED' },
        { channel: 'webhook', status: 'skipped', errorCode: 'OUTBOUND_DISABLED' },
      ])

      // El resto NO se apagó: el sondeo agendado descifra la clave y consulta el NVR.
      const mark = infra.mark()
      await joint.cron.find(j => j.expr === NVR_POLL)!.fn()
      expect(infra.of('credentials.decrypt', mark).length).toBeGreaterThan(0)
      expect(infra.of('nvr.isapi', mark).map(c => c.detail.nvrHost)).toContain(NVR_IP)

      expect(joint.of('outbound.smtp', jMark)).toEqual([])
      expect(joint.of('outbound.http', jMark)).toEqual([])
      expect(env.blockedConnections).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe('STREAM_AUTO_REGISTER_ENABLED=false SIN STAGING_ISOLATION: sólo se apaga el registro automático en MediaMTX', () => {
    let env: JointEnv
    let s: Awaited<ReturnType<typeof seed>>

    beforeAll(async () => {
      for (const k of ISOLATION_FLAGS) expect(process.env[k], k).toBeUndefined()
      resetCapturedCron()
      env = await startJointServer({ label: 'stgnoreg', env: { STREAM_AUTO_REGISTER_ENABLED: 'false' } })
      s = await seed(env, 'stgnoreg')
    }, 120_000)

    afterAll(async () => {
      await env?.stop()
      vi.resetModules()
    })

    it('arranque: NO se agenda el re-registro de 5 min ni el diferido de 5 s; el sondeo, el sync y las limpiezas sí', () => {
      // Lista EXACTA (con repeticiones): con el intervalo por defecto el sync usa la
      // misma expresión que el re-registro ('*/5 * * * *'), así que lo que distingue
      // es que quede UNA sola entrada '*/5' (la del sync), no que falte.
      expect(sortedExprs()).toEqual([NVR_POLL, SYNC_CRON, ...INTERNAL_JOBS].sort())
      expect(sortedExprs().filter(e => e === FIVE_MIN).length).toBe(SYNC_CRON === FIVE_MIN ? 1 : 0)
      expect(env.deferredReregister).toBe(0)
      expect(infra.of('streams.reregister')).toEqual([])
    })

    it('el resto sigue activo: el sondeo contacta el NVR y las salidas intentan SMTP (correo de prueba y recuperación de contraseña, que fallan sin red)', async () => {
      const mark = infra.mark()
      await joint.cron.find(j => j.expr === NVR_POLL)!.fn()
      expect(infra.of('credentials.decrypt', mark).length).toBeGreaterThan(0)
      expect(infra.of('nvr.isapi', mark).map(c => c.detail.nvrHost)).toContain(NVR_IP)

      const cfg = await s.b.admin.put('/api/alerts/settings', {
        emailEnabled: true, smtpHost: 'smtp.example.test', smtpPort: 587, smtpFromEmail: 'alertas@example.test',
        recipientEmails: 'operaciones@example.test',
      })
      expect(cfg.status, cfg.text).toBe(200)
      const jMark = joint.mark()
      const test = await s.b.admin.post('/api/alerts/settings/test-email', { testEmail: 'operaciones@example.test' })
      expect(test.status).toBe(500)
      expect(joint.of('outbound.smtp', jMark).map(c => c.detail.op)).toEqual(['createTransport', 'sendMail'])
      // Control positivo de la recuperación: con las salidas activas, el mismo flujo SÍ
      // intenta SMTP (así el "sin SMTP" de los otros arranques no pasa en vacío).
      const j2 = joint.mark()
      const forgot = await env.browser('stgnoreg-olvido').post('/api/auth/forgot-password', { email: 'admin_stgnoreg@example.test' })
      expect(forgot.status).toBe(200)
      expect(forgot.json().message).toMatch(/Si el correo existe/)
      expect(joint.of('outbound.smtp', j2).map(c => c.detail.op)).toEqual(['createTransport', 'sendMail'])
      expect(env.blockedConnections).toEqual([])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Qué prueba cada parte:
  //   - que server.ts ABORTA (process.exit(1) espiado) con el mensaje de la flag;
  //   - que server.ts no llegó a PostgreSQL ni a Redis: sin los decoradores `prisma`
  //     y `redis` (sus plugins conectan al registrarse) y sin otra conexión TCP al
  //     puerto de Redis que la del cliente administrativo del harness (el Redis del
  //     rate-limit, server.ts:154, sería la segunda). El schema efímero y su `db
  //     push` SÍ existen durante el intento: los crea el harness ANTES de importar
  //     server.ts;
  //   - que el harness no deja nada: listeners, parches, schema, claves ni jobs.
  // Si una regresión hiciera ARRANCAR a server.ts, la prueba falla y además detiene
  // ese servidor (env.stop) para no dejar schema ni parches en el PG compartido.
  describe('variable presente pero vacía, con espacios o inválida ⇒ el arranque aborta antes de PG/Redis y no deja nada colgado', () => {
    const cases: Array<[string, string]> = [
      ['STAGING_ISOLATION', ''],
      ['STREAM_AUTO_REGISTER_ENABLED', '   '],
      ['NVR_POLLING_ENABLED', ' true'],
      ['OUTBOUND_NOTIFICATIONS_ENABLED', 'no'],
    ]
    for (const [name, value] of cases) {
      it(`${name}=${JSON.stringify(value)} ⇒ server.ts sale con 1 sin conectar a PG/Redis; el harness no deja listeners, schema, claves Redis, jobs ni parches`, async () => {
        vi.resetModules()
        resetCapturedCron()
        // Etiqueta ÚNICA por intento: el schema (`joint_<etiqueta>_…`) y el prefijo Redis
        // quedan identificados sin ambigüedad aunque otra corrida de la suite (otro
        // proceso) esté arrancando a la vez. Con una etiqueta fija, el schema EN CURSO
        // del otro proceso daba un falso "quedó el schema" bajo carga (visto en la
        // corrida paralela con la suite API completa).
        const label = `sv${randomBytes(5).toString('hex')}`
        const jMark = joint.mark()
        // Conexiones TCP al puerto de Redis durante el intento (por debajo del
        // centinela del harness, que se instala encima y la restaura al salir).
        const proto = net.Socket.prototype as any
        const realConnect = proto.connect
        const redisPort = Number(new URL(process.env.REDIS_TEST_URL!).port || 6379)
        let redisConnects = 0
        proto.connect = function countingConnect(this: net.Socket, ...args: any[]) {
          const o = Array.isArray(args[0]) ? args[0][0] : args[0]
          if (o && typeof o === 'object' && Number(o.port) === redisPort) redisConnects++
          return realConnect.apply(this, args)
        }
        let started: JointEnv | null = null
        try {
          const before = {
            sigterm: process.listeners('SIGTERM').length, sigint: process.listeners('SIGINT').length,
            exit: process.exit, connect: net.Socket.prototype.connect, setTimeout: globalThis.setTimeout,
          }
          const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
          let failure: Error | null = null
          let logged = ''
          try {
            started = await startJointServer({ label, env: { [name]: value } })
          } catch (e) {
            failure = e as Error
          } finally {
            logged = errSpy.mock.calls.map(c => c.map(String).join(' ')).join('\n')
            errSpy.mockRestore()
          }
          const redisConnectsDuringBoot = redisConnects
          // Regresión: server.ts arrancó. Se lo detiene ANTES de las aserciones.
          let stopProblem = ''
          if (started) {
            try { await started.stop() } catch (e) { stopProblem = (e as Error).message }
          }
          expect(started === null, `server.ts ARRANCÓ con ${name}=${JSON.stringify(value)}${stopProblem ? ` (y su limpieza: ${stopProblem})` : ''}`).toBe(true)
          expect(failure?.message).toMatch(/abortó el arranque \(process\.exit\(1\)\)/)
          expect(logged).toContain(`${name} presente pero inválida`)
          // server.ts no llegó a PostgreSQL ni a Redis.
          const { server } = await import('../server')
          expect(server.hasDecorator('prisma'), 'plugin de Prisma registrado (conecta a PG)').toBe(false)
          expect(server.hasDecorator('redis'), 'plugin de Redis registrado (conecta a Redis)').toBe(false)
          expect(redisConnectsDuringBoot, 'conexiones TCP a Redis además de la del harness').toBeLessThanOrEqual(1)
          // Ningún listener, parche ni variable del harness queda colgado.
          expect(process.listeners('SIGTERM').length).toBe(before.sigterm)
          expect(process.listeners('SIGINT').length).toBe(before.sigint)
          expect(process.exit).toBe(before.exit)
          expect(net.Socket.prototype.connect).toBe(before.connect)
          expect(globalThis.setTimeout).toBe(before.setTimeout)
          expect(process.env[name]).toBeUndefined()
          // server.ts no llegó a escuchar ni a agendar jobs.
          expect(server.server.listening).toBe(false)
          expect(joint.of('cron.schedule', jMark)).toEqual([])
          // Ni schema efímero ni claves Redis de esta etiqueta (limpieza del harness).
          const pg = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL_TEST! } } })
          const redis = new Redis(process.env.REDIS_TEST_URL!, { maxRetriesPerRequest: 2 })
          try {
            const rows = await pg.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM information_schema.schemata WHERE schema_name LIKE ${`joint_${label}_%`}`
            expect(Number(rows[0]?.n ?? 0)).toBe(0)
            const keys: string[] = []
            let cursor = '0'
            do {
              const [next, batch] = await redis.scan(cursor, 'MATCH', `vc_joint:${label}:*`, 'COUNT', 1000)
              cursor = next
              keys.push(...batch)
            } while (cursor !== '0')
            expect(keys).toEqual([])
          } finally {
            await pg.$disconnect()
            redis.disconnect()
          }
        } finally {
          proto.connect = realConnect
        }
      })
    }
  })
})
