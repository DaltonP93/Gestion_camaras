// Suite conjunta de seguridad — revocación de permisos en vivo (#189 × #190 sobre
// server.ts real).
//
// Línea de tiempo: un OPERATOR con 2FA mira A, B, C y D (grilla + otra pestaña con
// B); un ADMIN mira B (comparte el FFmpeg main_h264) y otro OPERATOR mira C
// (comparte el path `main`). El ADMIN revoca B, C y D por la ruta REAL de usuarios.
// Se verifica: borde HLS cortado al instante, WS cerrado, heartbeat NO_PERMISSION y
// cierre de TODAS las sesiones revocadas de esa vista (incluidas main y main_h264),
// A intacta, y que la revocación nunca mata lo que sostiene otro espectador
// autorizado (FFmpeg compartido / path compartido). El FFmpeg sin otro espectador
// (D) sí se termina por su vía terminal (razón permission_revoked).
//
// Plano de medios nativo: las flags (NATIVE_PLAYBACK/NATIVE_MEDIA_RELAY) se activan
// SÓLO en esta corrida; el relay y MediaMTX son simulados (grants de sesión emitidos
// como los emitiría el relay, auth-hook real y kicker espía). La revocación sube el
// epoch del usuario: su grant de un solo uso ya no valida y su conexión de relay se
// expulsa, sin tocar la del ADMIN que mira la misma cámara.
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
import { jointInfraAvailable, startJointServer, totpNow, waitFor, type JointEnv, type SimBrowser } from './harness'

describe.skipIf(!jointInfraAvailable())('conjunta · revocación de permisos en vivo', { timeout: 60_000 }, () => {
  let env: JointEnv
  let sm: typeof import('../services/stream-manager')
  let gs: typeof import('../services/media/grant-service')
  let nvrId = ''
  const cam: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' }
  const ids: Record<string, string> = {}
  let opSecret = ''
  let op: SimBrowser
  let op2: SimBrowser
  let admin: SimBrowser

  const pathOf = (channel: number, type: string) => `nvr_${nvrId}_ch${String(channel).padStart(2, '0')}_${type}`
  const hlsOf = (channel: number, type: string) => `/hls/${pathOf(channel, type)}/index.m3u8`
  const sessionsOf = (userId: string, cameraId?: string, viewId?: string) => sm.getActiveSessions()
    .filter(s => s.userId === userId && (!cameraId || s.cameraId === cameraId) && (!viewId || s.viewId === viewId))
  /** Grant de SESIÓN de relay (lo que emitiría el relay nativo; no hay ruta HTTP en F0). */
  const relayGrant = async (userId: string, cameraId: string, streamPath: string) => {
    const r = await gs.getMediaGrantManager(env.server).issueSession({
      userId, viewId: `relay-${userId}`, cameraId, streamPath, effectiveType: 'main', codec: 'hevc',
      transport: 'rtsps', device: 'relay-simulado', ttlMs: 120_000,
    })
    if (!r.ok) throw new Error(`issueSession: ${r.code}`)
    return { grantId: r.issued.grantId, secret: r.issued.secret }
  }
  /** El relay valida (y consume) un grant de un solo uso: POST interno con el secreto del relay. */
  const relayValidate = async (grant: { grantId: string; secret: string; streamPath: string }, cameraId: string) => {
    const r = await env.server.inject({
      method: 'POST', url: '/api/live-view/internal/media-grant/validate', remoteAddress: '127.0.0.1',
      headers: { 'x-media-relay-secret': env.relaySecret! },
      payload: { grantId: grant.grantId, secret: grant.secret, streamPath: grant.streamPath, transport: 'rtsps', cameraId },
    })
    return { status: r.statusCode, body: JSON.parse(r.body) }
  }

  beforeAll(async () => {
    env = await startJointServer({ label: 'rev', nativeRelay: true })
    sm = await import('../services/stream-manager')
    gs = await import('../services/media/grant-service')
    nvrId = (await env.createNvr('NVR conjunto revocación', '192.0.2.40')).id
    cam.A = (await env.createCamera(nvrId, 1)).id                                       // sub H.264
    cam.B = (await env.createCamera(nvrId, 2, { main: 'hevc', sub: 'hevc' })).id        // ⇒ main_h264 (FFmpeg)
    cam.C = (await env.createCamera(nvrId, 3, { main: 'h264', sub: 'hevc' })).id        // ⇒ main (sin FFmpeg)
    cam.D = (await env.createCamera(nvrId, 4, { main: 'hevc', sub: 'hevc' })).id        // ⇒ main_h264, único espectador
    ids.admin = (await env.createUser('admin_rev', 'ADMIN')).id
    const opMfa = await env.createMfaUser('op_rev', 'OPERATOR')
    ids.op = opMfa.id
    opSecret = opMfa.secret
    ids.op2 = (await env.createUser('op2_rev', 'OPERATOR')).id
    for (const c of Object.values(cam)) await env.grant(ids.op, nvrId, c, { canView: true })
    await env.grant(ids.op2, nvrId, cam.C, { canView: true })
    admin = env.browser('admin'); await admin.signIn('admin_rev')
    op2 = env.browser('op2'); await op2.signIn('op2_rev')
  }, 120_000)

  afterAll(async () => {
    try { sm?.__resetSessionsForTest() } catch { /* noop */ }
    await env?.stop()
  })

  it('línea de tiempo: MFA → vivo en 2 pestañas → revocación por la ruta real ⇒ borde, WS y heartbeat cortan B/C/D; A intacta; lo compartido no se mata', async () => {
    // ── t0: login con 2FA. El tempToken no abre nada.
    op = env.browser('op-mfa')
    const l = await op.login('op_rev')
    const temp = l.json().tempToken as string
    expect((await env.hlsAuth(hlsOf(1, 'sub'), { cookie: temp })).status).toBe(401)
    const tempBrowser = env.browser('op-temp'); tempBrowser.plantCookie('access_token', temp)
    expect((await tempBrowser.heartbeat('op-grilla', [cam.A])).status).toBe(401)
    expect((await op.verify2fa(temp, await totpNow(opSecret))).status).toBe(200)

    // ── t1: el OPERATOR mira A, B, C, D en la grilla y B en otra pestaña; ADMIN mira B; op2 mira C.
    const g1 = (await op.heartbeat('op-grilla', [cam.A, cam.B, cam.C, cam.D])).json()
    expect(g1.streams[cam.A].streamPath).toBe(pathOf(1, 'sub'))
    expect(g1.streams[cam.B].streamPath).toBe(pathOf(2, 'main_h264'))
    expect(g1.streams[cam.C].streamPath).toBe(pathOf(3, 'main'))
    expect(g1.streams[cam.D].streamPath).toBe(pathOf(4, 'main_h264'))
    expect((await op.heartbeat('op-pestana2', [cam.B])).json().streams[cam.B].streamPath).toBe(pathOf(2, 'main_h264'))
    const a1 = (await admin.heartbeat('adm', [cam.B])).json()
    expect(a1.streams[cam.B].streamPath).toBe(pathOf(2, 'main_h264'))
    expect((await op2.heartbeat('op2', [cam.C])).json().streams[cam.C].streamPath).toBe(pathOf(3, 'main'))
    const spawnsB = () => infra.of('ffmpeg.transcode.spawn').filter(c => c.detail.streamPath === pathOf(2, 'main_h264')).length
    expect(spawnsB()).toBe(1)                                  // un proceso, tres espectadores
    expect(sessionsOf(ids.op, cam.B)).toHaveLength(2)
    expect(sessionsOf(ids.op, cam.C).map(s => s.streamType)).toEqual(['main'])
    expect(sessionsOf(ids.op, cam.D).map(s => s.streamType)).toEqual(['main_h264'])
    for (const [ch, type] of [[1, 'sub'], [2, 'main_h264'], [3, 'main'], [4, 'main_h264']] as const) {
      expect((await env.hlsAuth(hlsOf(ch, type), { browser: op })).status).toBe(200)
    }
    const ws = await op.openAlerts()

    // ── t1': plano de medios nativo. Fuentes vigentes (instancia real simulada) para
    // A (sub) y B (main HEVC); grant HTTP de un solo uso del OPERATOR sobre A y grants
    // de sesión de relay del OPERATOR y del ADMIN sobre B, con su conexión abierta.
    const mgr = gs.getMediaGrantManager(env.server)
    await mgr.registerSource(pathOf(1, 'sub'), 120_000)
    await mgr.registerSource(pathOf(2, 'main'), 120_000)
    const oneShot = await op.post('/api/live-view/media-grant', { viewId: 'op-grilla', cameraId: cam.A, transport: 'rtsps', device: 'navegador-simulado' })
    expect(oneShot.status).toBe(200)
    expect(oneShot.json().streamPath).toBe(pathOf(1, 'sub'))
    const relayOp = await relayGrant(ids.op, cam.B, pathOf(2, 'main'))
    const relayAdm = await relayGrant(ids.admin, cam.B, pathOf(2, 'main'))
    expect((await env.mediamtxAuth(relayOp, pathOf(2, 'main'), 'conn-op-B')).status).toBe(200)
    expect((await env.mediamtxAuth(relayAdm, pathOf(2, 'main'), 'conn-adm-B')).status).toBe(200)
    // El hook sólo atiende a MediaMTX: origen externo ⇒ 403 aun con el secreto.
    expect((await env.mediamtxAuth(relayOp, pathOf(2, 'main'), 'conn-ext', '198.51.100.99')).status).toBe(403)
    expect(env.kicked).toEqual([])

    // ── t2: el ADMIN revoca B, C y D con el modal granular (PUT real).
    const rev = await admin.put(`/api/users/${ids.op}/permissions`, {
      cameraPermissions: [cam.B, cam.C, cam.D].map(cameraId => ({ cameraId, canView: false })),
    })
    expect(rev.status).toBe(200)
    const audit = await env.prisma.auditLog.findFirst({ where: { action: 'PERMISSIONS_UPDATED', resource: ids.op }, orderBy: { createdAt: 'desc' } })
    expect(audit?.userId).toBe(ids.admin)
    expect(JSON.stringify(audit?.detail)).toContain('applied')   // epoch de grants confirmado en Redis real
    expect(await ws.closed).toBe(4003)

    // ── t2: plano de medios. Epoch del usuario subido ⇒ su conexión de relay se
    // expulsa y su grant ya no valida; el grant de un solo uso emitido antes (sobre
    // A, que conserva) tampoco: la revocación es por usuario, sobra-revoca pero es
    // segura. El ADMIN que mira la misma cámara no se toca.
    expect(env.kicked).toContain('conn-op-B')
    expect(env.kicked).not.toContain('conn-adm-B')
    expect((await env.mediamtxAuth(relayOp, pathOf(2, 'main'), 'conn-op-B-2')).status).toBe(403)
    expect((await env.mediamtxAuth(relayAdm, pathOf(2, 'main'), 'conn-adm-B-2')).status).toBe(200)
    const stale = await relayValidate(oneShot.json(), cam.A)
    expect(stale.status).toBe(403)
    expect(stale.body.ok).toBe(false)
    // Un grant NUEVO sobre B ya no se emite (RBAC); sobre A sí, con el epoch nuevo.
    expect((await op.post('/api/live-view/media-grant', { viewId: 'op-grilla', cameraId: cam.B, transport: 'rtsps', device: 'navegador-simulado' })).status).toBe(403)
    const fresh = await op.post('/api/live-view/media-grant', { viewId: 'op-grilla', cameraId: cam.A, transport: 'rtsps', device: 'navegador-simulado' })
    expect(fresh.status).toBe(200)
    expect((await relayValidate(fresh.json(), cam.A)).body.ok).toBe(true)

    // ── t2+ε: el borde corta YA con la misma cookie; A sigue.
    expect((await env.hlsAuth(hlsOf(1, 'sub'), { browser: op })).status).toBe(200)
    expect((await env.hlsAuth(hlsOf(2, 'main_h264'), { browser: op })).status).toBe(403)
    expect((await env.hlsAuth(hlsOf(3, 'main'), { browser: op })).status).toBe(403)
    expect((await env.hlsAuth(hlsOf(4, 'main_h264'), { browser: op })).status).toBe(403)

    // ── t3: heartbeat de la grilla ⇒ NO_PERMISSION y cierre de B (main_h264), C (main) y D.
    const mark = infra.mark()
    const g3 = (await op.heartbeat('op-grilla', [cam.A, cam.B, cam.C, cam.D])).json()
    for (const c of [cam.B, cam.C, cam.D]) expect(g3.errors[c]?.code).toBe('NO_PERMISSION')
    expect(g3.stoppedIds).toEqual(expect.arrayContaining([cam.B, cam.C, cam.D]))
    expect(Object.keys(g3.streams)).toEqual([cam.A])
    expect(g3.streams[cam.A].streamPath).toBe(g1.streams[cam.A].streamPath)
    expect(infra.of('mediamtx.publish', mark)).toEqual([])          // A no se re-publica
    expect(sessionsOf(ids.op, undefined, 'op-grilla').map(s => s.cameraId)).toEqual([cam.A])
    expect(sessionsOf(ids.op, cam.B, 'op-pestana2')).toHaveLength(1) // la otra pestaña cierra en su heartbeat
    // D no tenía otro espectador ⇒ su FFmpeg termina por la vía terminal.
    await waitFor(() => infra.of('ffmpeg.transcode.stop', mark).some(c => c.detail.streamPath === pathOf(4, 'main_h264')), 'stop del FFmpeg de D')
    expect(infra.transcodeAlive.has(pathOf(4, 'main_h264'))).toBe(false)
    // B lo comparten el ADMIN y la otra pestaña ⇒ NO se mata.
    expect(infra.of('ffmpeg.transcode.stop', mark).map(c => c.detail.streamPath)).not.toContain(pathOf(2, 'main_h264'))
    expect(infra.transcodeAlive.has(pathOf(2, 'main_h264'))).toBe(true)

    // ── Los demás espectadores no notan nada.
    const a3 = (await admin.heartbeat('adm', [cam.B])).json()
    expect(a3.streams[cam.B].streamPath).toBe(pathOf(2, 'main_h264'))
    expect(sessionsOf(ids.admin, cam.B)).toHaveLength(1)
    expect(spawnsB()).toBe(1)
    expect((await env.hlsAuth(hlsOf(2, 'main_h264'), { browser: admin })).status).toBe(200)
    const c3 = (await op2.heartbeat('op2', [cam.C])).json()
    expect(c3.streams[cam.C].streamPath).toBe(pathOf(3, 'main'))
    expect(sessionsOf(ids.op2, cam.C)).toHaveLength(1)
    expect((await env.hlsAuth(hlsOf(3, 'main'), { browser: op2 })).status).toBe(200)

    // ── t4: la otra pestaña del OPERATOR también recibe NO_PERMISSION y cierra.
    const p4 = (await op.heartbeat('op-pestana2', [cam.B])).json()
    expect(p4.errors[cam.B]?.code).toBe('NO_PERMISSION')
    expect(p4.stoppedIds).toContain(cam.B)
    expect(sessionsOf(ids.op, cam.B)).toEqual([])
    expect(infra.transcodeAlive.has(pathOf(2, 'main_h264'))).toBe(true)  // el ADMIN sigue mirando

    // ── t5: el refresh emite un access nuevo, pero el borde decide con la DB: B sigue 403.
    expect((await op.post('/api/auth/refresh', {})).status).toBe(200)
    expect((await env.hlsAuth(hlsOf(2, 'main_h264'), { browser: op })).status).toBe(403)
    expect((await env.hlsAuth(hlsOf(1, 'sub'), { browser: op })).status).toBe(200)
  })

  it('re-concesión: devolver canView sobre B vuelve a habilitar heartbeat y borde sin re-login', async () => {
    const put = await admin.put(`/api/users/${ids.op}/permissions`, { cameraPermissions: [{ cameraId: cam.B, canView: true }] })
    expect(put.status).toBe(200)
    const hb = (await op.heartbeat('op-grilla', [cam.A, cam.B])).json()
    expect(Object.keys(hb.streams).sort()).toEqual([cam.A, cam.B].sort())
    expect(hb.errors[cam.B]).toBeUndefined()
    expect((await env.hlsAuth(hlsOf(2, 'main_h264'), { browser: op })).status).toBe(200)
  })

  it('reemplazo total (POST []) ⇒ el siguiente heartbeat cierra todas las cámaras del usuario y el borde corta todas', async () => {
    const post = await admin.post(`/api/users/${ids.op}/permissions`, [])
    expect(post.status).toBe(200)
    expect((await env.hlsAuth(hlsOf(1, 'sub'), { browser: op })).status).toBe(403)
    const hb = (await op.heartbeat('op-grilla', [cam.A, cam.B])).json()
    expect(hb.errors[cam.A]?.code).toBe('NO_PERMISSION')
    expect(hb.errors[cam.B]?.code).toBe('NO_PERMISSION')
    expect(hb.streams).toEqual({})
    expect(sessionsOf(ids.op)).toEqual([])
    // El ADMIN sigue con B.
    expect(sessionsOf(ids.admin, cam.B)).toHaveLength(1)
  })

  it('último espectador: el ADMIN cierra B como el web (DELETE keepalive) ⇒ su FFmpeg main_h264 termina por la vía terminal; no quedan procesos huérfanos', async () => {
    const mark = infra.mark()
    // Como lib/sessionClose.ts al desmontar la celda: cierre TERMINANTE explícito del tipo HD
    // (cleanup_unmount está en TRANSCODE_KILL_REASONS; una razón conservadora retendría el proceso).
    const close = await admin.del(`/api/cameras/${cam.B}/stream?streamType=main_h264&reason=cleanup_unmount&viewId=adm`)
    expect(close.status).toBe(200)
    expect(close.json().outcome).toBe('session_closed')
    expect((await admin.heartbeat('adm', [])).status).toBe(200)
    expect(sessionsOf(ids.admin)).toEqual([])
    expect(sessionsOf(ids.op)).toEqual([])
    await waitFor(() => infra.of('ffmpeg.transcode.stop', mark).some(c => c.detail.streamPath === pathOf(2, 'main_h264')), 'stop del FFmpeg de B')
    expect(infra.transcodeAlive.size).toBe(0)
    // Cada FFmpeg lanzado en la corrida terminó por su vía terminal (ninguno huérfano).
    const spawned = [...new Set(infra.of('ffmpeg.transcode.spawn').map(c => String(c.detail.streamPath)))].sort()
    const stopped = [...new Set(infra.of('ffmpeg.transcode.stop').map(c => String(c.detail.streamPath)))].sort()
    expect(stopped).toEqual(spawned)
    // op2 sigue mirando C (path `main`, sin FFmpeg): nada de lo anterior lo tocó.
    expect(sessionsOf(ids.op2, cam.C)).toHaveLength(1)
  })

  it('higiene: sin red saliente ni contacto con el NVR', () => {
    expect(env.blockedConnections).toEqual([])
    expect(infra.of('nvr.isapi')).toEqual([])
    expect(infra.of('proc.spawn')).toEqual([])
  })
})
