// Suite conjunta de seguridad — DEFECTOS conocidos (server.ts real, misma harness).
//
// Cada prueba está escrita esperando el COMPORTAMIENTO SEGURO y hoy FALLA a
// propósito: documenta un defecto real reproducido en la rama integrada
// (#182 + #186 + #187 + #189 + #190 + #191 + #192 + #193 + #195 + #196 + #197).
// Ninguno es introducido por la combinación: son pendientes previos que la
// combinación deja a la vista. NO se deben debilitar ni marcar como `fails`: se
// ponen en verde corrigiendo el código. Se agrupan en este archivo para que las
// suites temáticas sigan siendo una regresión verde de la combinación.
//
// Corren SÓLO con RUN_KNOWN_DEFECTS=1 (`npm run test:known-defects`): son evidencia
// ejecutable de defectos PREVIOS y no deben poner en rojo el job de la combinación.
// Al corregir un defecto, su prueba sale de este archivo y la cubre la suite del PR
// que lo corrige (informe: docs/security/JOINT_REVIEW_182_186_189_190.md, en #194).
//
// Corregidos y retirados de aquí (cubiertos por la suite del PR que los corrige):
//   - MFA-03/CHW-06/CHW-11 (rate-limit detrás de nginx) y CHW-08 validate (origen
//     interno): #195, proxy-confiable.joint.test.ts.
//   - CHW-09 (JWT_SECRET público): #196, jwt-secret-publico.joint.test.ts.
//   - MFA-02/CHW-08, CHW-05, CHW-05/REV-08/PB-03, CHW-07, CHW-08 (sesiones,
//     contraseña, 2FA) y REV-01/PB-02/CHW-14 (×3, medios de grabación): #197,
//     revocation-effective.joint.test.ts.
//   - MFA-05 y PB-05: #193, profile-diag.joint.test.ts.
// Siguen abiertos (aquí o en su suite):
//   - CHW-08/CHW-10: grants del relay nativo (flags NO-GO); #197 lo declara fuera de
//     alcance.
//   - MFA-04, PB-01/REV-02 (decisión D5), PB-04 (requiere NVR real), PB-06, PB-10,
//     REV-03, REV-04/CHW-03, REV-05, CHW-04 (decisión D2).
//   - LOG-01 (abajo): previo; el console.info con `rtsp=rtsp://<usuario>:***@<ip>`
//     de stream-manager.ts ya está en origin/main (invariante 6).
//   - En su propia suite (necesitan su server.ts o dobles propios):
//       · STG-01 en staging.joint.test.ts: NO es un defecto de #187 sino una
//         DECISIÓN PENDIENTE de alcance (aislar o no el contacto con el NVR que
//         inician los USUARIOS en staging);
//       · AUD-BK-01 en nvr-audio.joint.test.ts: previo; el backup que deja la UI en
//         PUT /video-audio no guarda el audio y …/video-config/restore no lo
//         interpreta (responde OK y el audio queda como estaba).
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

import { infra } from './infra-doubles'
import { settle } from './joint-helpers'
import {
  jointInfraAvailable, startJointServer, totpNow, waitFor, JOINT_PASSWORD, NVR_FAKE_USER, NVR_FAKE_PASS,
  type JointEnv, type SimBrowser, type JointResponse,
} from './harness'

const RUN_KNOWN_DEFECTS = process.env.RUN_KNOWN_DEFECTS === '1'

const NVR_IP = '192.0.2.60'
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

  beforeAll(async () => {
    env = await startJointServer({ label: 'def', nativeRelay: true })
    sm = await import('../services/stream-manager')
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
    // El camino normal la escribe SIN await: se espera con tope para que un arreglo
    // que siga ese patrón no dé un falso rojo por la carrera con el INSERT.
    const viewAudits = await settle(
      () => env.prisma.auditLog.count({ where: { userId: second.id, action: 'VIEW_RECORDING' } }), n => n >= 1, 3_000,
    )
    expect.soft(viewAudits, 'VIEW_RECORDING en acierto de caché').toBe(1)
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

  it('LOG-01 — arrancar un stream en vivo no escribe en los logs el usuario ni la IP del NVR (invariante 6)', async () => {
    const { b } = await newUser('op_log_def', 'OPERATOR', [[camB, { canView: true }]])
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) }))
    try {
      const hb = await b.heartbeat('v-log', [camB])
      expect(hb.status).toBe(200)
      expect(Object.keys(hb.json().streams)).toEqual([camB])
    } finally {
      for (const sp of spies) sp.mockRestore()
    }
    // DEFECTO: stream-manager.ts (startStream) hace console.info de
    // `rtsp=rtsp://<usuario>:***@<ip>:<puerto>/...` del NVR en cada arranque de stream:
    // la clave se tapa, pero el usuario y la IP completa quedan en el log del contenedor.
    expect.soft(lines.filter(l => l.includes(NVR_FAKE_USER)), 'usuario del NVR en logs').toEqual([])
    expect.soft(lines.filter(l => l.includes(NVR_IP)), 'IP completa del NVR en logs').toEqual([])
    expect(lines.join('\n')).not.toContain(NVR_FAKE_PASS)   // la clave sí se enmascara
  })

  it('higiene: sin red saliente; todo contacto con el NVR fue a su IP TEST-NET', () => {
    expect(env.blockedConnections).toEqual([])
    for (const c of infra.of('nvr.isapi')) expect(c.detail.nvrHost).toBe(NVR_IP)
    for (const t of infra.rtspTargetsSince(0)) expect(t.host).toBe(NVR_IP)
  })
})
