// Suite conjunta de seguridad — REVOCACIÓN EFECTIVA (actor vigente + medios ligados)
// con el server.ts REAL, PostgreSQL y Redis efímeros (harness.ts, sin cambios).
//
// Defectos que reproduce (revisión conjunta, grupos C02 y C14, más C12/CHW-07):
//   - el access JWT era stateless: tras logout, revocar sesiones, cambio de
//     contraseña, reset de 2FA, desactivación, borrado o cambio de rol, una copia
//     seguía abriendo /me, el heartbeat y /internal/hls-auth hasta su exp; el rol
//     salía del claim;
//   - los medios de grabación ya emitidos (file.mp4, /download?t= de 24 h, stream
//     de preview) sobrevivían a la revocación;
//   - un ticket de WS emitido antes de desactivar abría el WS del inactivo.
// Los casos vienen de defectos-conocidos.joint.test.ts (REV-01/PB-02/CHW-14 ×3,
// MFA-02/CHW-08, CHW-05, CHW-05/REV-08/PB-03, CHW-08 ×3, CHW-07) y esperan el
// comportamiento SEGURO. Se agregan: re-login, refresh, compatibilidad de un
// access previo al cambio (sin `sid`, incluido el WS de una pestaña con el bundle
// viejo), aislamiento entre sesiones/usuarios (también el WS), base caída (503,
// nunca colgado ni 401) y rendimiento (consultas por petición). De la revisión del
// arreglo: VOD en curso compartido por dos sesiones del mismo usuario, stream de
// preview YA ADJUNTO que se corta al revocar, la carrera del canje del ticket y el
// cierre del WS al cambiar la contraseña desde el perfil o al reutilizar un refresh.
// El VOD sin caché va en revocation-vod-sin-cache.joint.test.ts (otro server.ts).
//
// Todo en loopback: NVR, MediaMTX y FFmpeg son dobles (infra-doubles.ts, más los
// FFmpeg propios de abajo); la prueba de higiene final verifica que no hubo red
// saliente.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))

// FFmpeg simulados PROPIOS de esta suite (infra-doubles.ts queda intacto): por
// defecto delegan en el doble común. Con `ffctl.vodHold`, el FFmpeg de VOD queda EN
// CURSO hasta que se libera la promesa; con `ffctl.previewStream`, el de preview
// emite 1 KiB cada 100 ms hasta que lo maten (stream ya adjunto).
const ffctl = vi.hoisted(() => ({
  vodHold: null as Promise<void> | null,
  previewStream: false,
  /** pids de los FFmpeg de preview simulados que siguen vivos. */
  previewAlive: new Set<number>(),
}))
vi.mock('child_process', async (orig) => {
  const doubles = await import('./infra-doubles')
  const base = doubles.childProcessModuleDouble(await orig() as any) as any
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const fs = await import('node:fs')
  const spawn = (cmd: string, args: string[] = []) => {
    const output = args[args.length - 1]
    const vod = cmd === 'ffmpeg' && args.includes('-y') && typeof output === 'string' && output.endsWith('.mp4')
    const preview = cmd === 'ffmpeg' && output === 'pipe:1'
    if (!(vod && ffctl.vodHold) && !(preview && ffctl.previewStream)) return base.spawn(cmd, args)
    doubles.infra.record('proc.spawn', { cmd, rtsp: doubles.parseRtspTarget(args[args.indexOf('-i') + 1]) })
    const child = new EventEmitter() as any
    const fd3 = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = null
    child.stdio = [null, child.stdout, child.stderr, fd3]
    child.pid = doubles.infra.nextPid()
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    let timer: ReturnType<typeof setInterval> | null = null
    const finish = (code: number | null, signal: string | null) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (timer) clearInterval(timer)
      ffctl.previewAlive.delete(child.pid)
      child.exitCode = code
      child.signalCode = signal
      for (const s of [child.stdout, child.stderr, fd3]) { try { s.end() } catch { /* noop */ } }
      child.emit('exit', code, signal)
      child.emit('close', code, signal)
    }
    child.kill = (sig: string = 'SIGTERM') => { child.killed = true; setImmediate(() => finish(null, sig)); return true }
    if (preview) {
      ffctl.previewAlive.add(child.pid)
      // Bytes SINTÉTICOS (no es video): sólo para medir si el stream sigue entregando.
      timer = setInterval(() => { try { child.stdout.write(Buffer.alloc(1024, 0x5a)) } catch { /* noop */ } }, 100)
    } else {
      void ffctl.vodHold!.then(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try { fs.writeFileSync(output, Buffer.alloc(64 * 1024, 0x5a)) } catch { /* noop */ }
        child.stderr.write('frame=50\nfps=25.0\nout_time_ms=2000000\nspeed=1.0x\nprogress=end\n')
        finish(0, null)
      })
    }
    return child
  }
  const mod = { ...base, spawn }
  return { ...mod, default: mod }
})

import http from 'node:http'
import WebSocket from 'ws'
import { PrismaClient } from '@prisma/client'
import { infra } from './infra-doubles'
import {
  jointInfraAvailable, startJointServer, waitFor, decodeJwt, signHs256, JOINT_PASSWORD, JOINT_HOST,
  type JointEnv, type SimBrowser, type JointResponse, type WsHandle,
} from './harness'

const NVR_IP = '192.0.2.70'
const DENIED = [401, 403, 404, 410]
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
/** Ventana de grabación de 5 min (hora 12) con su playbackURI de la pista 101. */
const win = (fromMin: number) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    startTime: `2026-10-01T12:${pad(fromMin)}:00.000Z`,
    endTime: `2026-10-01T12:${pad(fromMin + 5)}:00.000Z`,
    playbackURI: `/Streaming/tracks/101/?starttime=20261001T12${pad(fromMin)}00Z&endtime=20261001T12${pad(fromMin + 5)}00Z`,
  }
}
/** Código de cierre del WS, o -1 si no cerró dentro del plazo (nunca cuelga la prueba). */
const closedWithin = (h: WsHandle, ms = 3000) => Promise.race([h.closed, sleep(ms).then(() => -1)])

describe.skipIf(!jointInfraAvailable())('conjunta · revocación efectiva (actor vigente y medios ligados)', { timeout: 60_000 }, () => {
  let env: JointEnv
  let sm: typeof import('../services/stream-manager')
  let wsMod: typeof import('../routes/websocket')
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
  /** Otro dispositivo (otra sesión) del mismo usuario. */
  const otherDevice = async (username: string, tag: string) => {
    const b = env.browser(`${username}-${tag}`)
    await b.signIn(username)
    return b
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
  const adminStepUp = async (): Promise<Record<string, string>> => {
    const su = await admin.post('/api/auth/step-up', { password: JOINT_PASSWORD })
    expect(su.status).toBe(200)
    return { 'x-step-up-token': su.json().stepUpToken }
  }
  /** GET del stream de preview (hijack): se espera con tope y nunca se deja colgado. */
  const getPreviewStream = async (b: SimBrowser, url: string, ms = 15_000): Promise<JointResponse | null> =>
    Promise.race([b.get(url), new Promise<null>(r => setTimeout(() => r(null), ms))])
  /**
   * ¿El GET del stream de preview fue ADMITIDO? Se lanza sin esperar, se confirma que
   * arrancó FFmpeg y se cierra la sesión por la vía terminal (DELETE), sin esperar el
   * plan completo de intentos del FFmpeg simulado.
   */
  const previewAdmitted = async (b: SimBrowser, pv: { sessionId: string; streamUrl: string }) => {
    const mark = infra.mark()
    const pending = getPreviewStream(b, pv.streamUrl, 8_000)
    let spawned = false
    try {
      await waitFor(() => infra.of('proc.spawn', mark).length > 0, 'FFmpeg de preview', 5_000)
      spawned = true
    } catch { /* no arrancó */ }
    await b.del(`/api/recordings/preview/${pv.sessionId}`)
    const res = await pending
    return { spawned, status: res?.status ?? null }
  }
  const sessionIdOf = (b: SimBrowser) => decodeJwt(b.accessToken!).sid as string | undefined
  /**
   * GET del stream de preview por TCP REAL (respuesta hijackeada que no termina
   * sola): cuenta los bytes recibidos y avisa cuando el servidor cierra.
   */
  const openPreviewTcp = (streamUrl: string) => new Promise<{
    status: number; bytes: () => number; isEnded: () => boolean; ended: Promise<void>; destroy: () => void
  }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: env.port, path: streamUrl, headers: { host: JOINT_HOST } }, (res) => {
      let n = 0
      let done = false
      const ended = new Promise<void>((r) => {
        const end = () => { done = true; r() }
        res.once('end', end); res.once('close', end); res.once('error', end)
      })
      res.on('data', (c: Buffer) => { n += c.length })
      resolve({ status: res.statusCode ?? 0, bytes: () => n, isEnded: () => done, ended, destroy: () => req.destroy() })
    })
    req.on('error', reject)
  })
  /** Estado del VOD hasta 'ready' (cada sondeo debe ser 200). */
  const pollUntilReady = (b: SimBrowser, pollUrl: string) => waitFor(async () => {
    const st = await b.get(pollUrl)
    expect(st.status, `sondeo ${pollUrl}`).toBe(200)
    return st.json().status === 'ready' ? st.json() : null
  }, 'VOD listo', 10_000, 50)

  beforeAll(async () => {
    env = await startJointServer({ label: 'revef' })
    sm = await import('../services/stream-manager')
    wsMod = await import('../routes/websocket')
    nvrId = (await env.createNvr('NVR conjunto revocación efectiva', NVR_IP)).id
    camA = (await env.createCamera(nvrId, 1)).id
    camB = (await env.createCamera(nvrId, 2)).id
    // Cupo de reproducción del NVR simulado: varias previews simultáneas (aislamiento).
    await env.prisma.nVR.update({ where: { id: nvrId }, data: { maxConcurrentPlaybackSessions: 4 } })
    await env.createUser('admin_revef', 'ADMIN')
    admin = env.browser('admin'); await admin.signIn('admin_revef')
  }, 120_000)

  afterAll(async () => {
    infra.ffmpegMode = 'vod-ok'
    try { sm?.__resetSessionsForTest() } catch { /* noop */ }
    await env?.stop()
  })

  // ─── Access token: actor vigente ───────────────────────────────────────────

  it('MFA-02/CHW-08 — tras el logout, el access copiado ya no abre /me, el heartbeat ni hls-auth', async () => {
    const { b } = await newUser('op_logout_ref', 'OPERATOR', [[camA, { canView: true }]])
    const copied = b.accessToken!
    expect((await b.post('/api/auth/logout', {})).status).toBe(200)
    const mark = infra.mark()
    const thief = env.browser('ladron-logout-ref')
    const bearer = { authorization: `Bearer ${copied}` }
    expect((await thief.get('/api/auth/me', { headers: bearer })).status, '/me con access post-logout').toBe(401)
    expect((await thief.heartbeat('v-ladron-ref', [camA], { headers: bearer })).status, 'heartbeat con access post-logout').toBe(401)
    expect(infra.of('mediamtx.publish', mark), 'stream iniciado con access post-logout').toEqual([])
    expect((await env.hlsAuth(hlsUri(1), { cookie: copied })).status, 'hls-auth con access post-logout').toBe(401)
    expect((await thief.post('/api/auth/ws-ticket', undefined, { headers: bearer })).status).toBe(401)

    // Logout de una integración por Bearer, SIN cookie de refresh: cierra la sesión del `sid`.
    const { id } = await newUser('op_logout_bearer_ref', 'OPERATOR')
    const integ = env.browser('integracion-ref')
    const login2 = env.browser('op_logout_bearer_ref-2')
    await login2.signIn('op_logout_bearer_ref')
    const access = login2.accessToken!
    expect((await integ.post('/api/auth/logout', {}, { headers: { authorization: `Bearer ${access}` } })).status).toBe(200)
    expect((await integ.get('/api/auth/me', { headers: { authorization: `Bearer ${access}` } })).status, 'access tras logout por Bearer').toBe(401)
    expect(await env.prisma.session.count({ where: { userId: id } }), 'sólo queda la sesión del otro login').toBe(1)
  })

  it('CHW-05 — desactivar al usuario corta hls-auth, el heartbeat y el WS del access vigente', async () => {
    const { id, b } = await newUser('op_baja_ref', 'OPERATOR', [[camA, { canView: true }]])
    expect((await env.hlsAuth(hlsUri(1), { browser: b })).status).toBe(200)
    const ws = await b.openAlerts()
    expect((await admin.put(`/api/users/${id}`, { active: false })).status).toBe(200)
    expect(await closedWithin(ws)).toBe(4003)
    expect(DENIED).toContain((await b.post('/api/auth/ws-ticket')).status)
    const mark = infra.mark()
    expect(DENIED, 'hls-auth de usuario desactivado').toContain((await env.hlsAuth(hlsUri(1), { browser: b })).status)
    const hb = await b.heartbeat('v-baja-ref', [camA])
    expect(hb.status === 200 ? Object.keys(hb.json().streams) : [], 'heartbeat de usuario desactivado').toEqual([])
    expect(infra.of('mediamtx.publish', mark), 'stream iniciado por usuario desactivado').toEqual([])
    expect((await b.post('/api/auth/refresh', {})).status).toBe(401)
  })

  it('CHW-05/REV-08/PB-03 — degradar SUPERVISOR→OPERATOR o ADMIN→OPERATOR y borrar al usuario surte efecto en la siguiente petición', async () => {
    const sup = await newUser('sup_deg_ref', 'SUPERVISOR')
    expect((await env.hlsAuth(hlsUri(2), { browser: sup.b })).status).toBe(200)
    expect((await admin.put(`/api/users/${sup.id}`, { role: 'OPERATOR' })).status).toBe(200)
    const mark = infra.mark()
    expect((await env.hlsAuth(hlsUri(2), { browser: sup.b })).status, 'hls-auth con rol degradado').toBe(403)
    // (El filtro por permisos del heartbeat es #189, fuera de esta base: aquí se verifica
    // que la decisión use el rol VIGENTE en el borde, grabaciones y administración.)
    const search = await sup.b.get(`/api/recordings/search?cameraId=${camB}&startTime=2026-10-01T12:00:00.000Z&endTime=2026-10-01T12:05:00.000Z`)
    expect(search.status, 'grabaciones con rol degradado').toBe(403)
    expect(infra.of('credentials.decrypt', mark), 'credenciales NVR descifradas para un rol degradado').toEqual([])
    // /me refleja el rol vigente (el de la base), sin re-login.
    expect((await sup.b.get('/api/auth/me')).json().role).toBe('OPERATOR')

    // El refresh (que ya releía la base) sigue emitiendo un access OPERATOR.
    const refreshed = env.browser('sup_deg_refresh_ref')
    refreshed.plantCookie('refresh_token', sup.b.refreshToken!, '/api/auth')
    expect((await refreshed.post('/api/auth/refresh', {})).status).toBe(200)
    expect(decodeJwt(refreshed.accessToken!).role).toBe('OPERATOR')
    expect((await env.hlsAuth(hlsUri(2), { browser: refreshed })).status).toBe(403)

    const adm2 = await newUser('admin_deg_ref', 'ADMIN')
    expect((await adm2.b.get('/api/users')).status).toBe(200)
    expect((await admin.put(`/api/users/${adm2.id}`, { role: 'OPERATOR' })).status).toBe(200)
    expect((await adm2.b.get('/api/users')).status, 'ADMIN degradado sigue administrando').toBe(403)

    const del = await newUser('sup_borrado_ref', 'SUPERVISOR')
    expect((await admin.del(`/api/users/${del.id}`, { headers: await adminStepUp() })).status).toBe(200)
    expect(DENIED, 'hls-auth de usuario borrado').toContain((await env.hlsAuth(hlsUri(2), { browser: del.b })).status)
    expect((await del.b.get('/api/auth/me')).status, '/me de usuario borrado').toBe(401)
  })

  it('CHW-08 — revocar las sesiones (admin), cambiar la contraseña (también desde el perfil), resetear el 2FA o reutilizar un refresh invalida el access ya emitido y cierra su WS', async () => {
    const cases: Array<[string, string, (id: string, b: SimBrowser) => Promise<JointResponse>, number?]> = [
      ['DELETE /users/:id/sessions', 'op_sesiones_ref', (id) => admin.del(`/api/users/${id}/sessions`)],
      ['change-password', 'op_clave_ref', (_id, b) => b.post('/api/auth/change-password', { currentPassword: JOINT_PASSWORD, newPassword: 'Otra-Clave-Distinta-2026!' })],
      ['PUT /profile/password', 'op_claveperfil_ref', (_id, b) => b.put('/api/profile/password', { currentPassword: JOINT_PASSWORD, newPassword: 'Otra-Clave-Perfil-2026!' })],
      ['reset-2fa (admin)', 'op_reset2fa_ref', async (id) => admin.post(`/api/users/${id}/reset-2fa`, {}, { headers: await adminStepUp() })],
      ['contraseña fijada por el ADMIN', 'op_claveadm_ref', (id) => admin.put(`/api/users/${id}`, { password: 'Clave-Fijada-Por-Admin-2026!' })],
      // Robo de refresh: el token ya rotado vuelve a presentarse fuera de la ventana de
      // gracia (30 s; se envejece su uso en la base efímera) ⇒ se revoca la familia.
      ['reutilización del refresh', 'op_reuso_ref', async (id, b) => {
        const viejo = b.refreshToken!
        expect((await b.post('/api/auth/refresh', {})).status).toBe(200)
        await env.prisma.usedRefreshToken.updateMany({ where: { userId: id }, data: { usedAt: new Date(Date.now() - 60_000) } })
        const atacante = env.browser('atacante-reuso-ref')
        atacante.plantCookie('refresh_token', viejo, '/api/auth')
        return atacante.post('/api/auth/refresh', {})
      }, 401],
    ]
    for (const [label, username, action, expected = 200] of cases) {
      const { id, b } = await newUser(username, 'OPERATOR', [[camA, { canView: true }]])
      const copied = b.accessToken!
      const ws = await b.openAlerts()
      expect((await action(id, b)).status, label).toBe(expected)
      expect(await env.prisma.session.count({ where: { userId: id } }), `${label}: sesiones en DB`).toBe(0)
      expect(await closedWithin(ws), `${label}: WS cerrado`).toBe(4003)
      expect((await b.post('/api/auth/refresh', {})).status, `${label}: refresh`).toBe(401)
      const mark = infra.mark()
      const thief = env.browser(`ladron-${username}`)
      expect((await thief.get('/api/auth/me', { headers: { authorization: `Bearer ${copied}` } })).status, `${label}: /me con el access copiado`).toBe(401)
      expect((await env.hlsAuth(hlsUri(1), { cookie: copied })).status, `${label}: hls-auth con el access copiado`).toBe(401)
      const hb = await thief.heartbeat(`v-${username}`, [camA], { headers: { authorization: `Bearer ${copied}` } })
      expect(hb.status === 200 ? Object.keys(hb.json().streams) : [], `${label}: heartbeat con el access copiado`).toEqual([])
      expect(infra.of('mediamtx.publish', mark), `${label}: stream iniciado con el access copiado`).toEqual([])
    }
  })

  it('contraseña PROPIA fijada por un ADMIN desde Usuarios: conserva la sesión desde la que la cambia y cierra las demás', async () => {
    const a = await newUser('admin_clavepropia_ref', 'ADMIN')
    const otro = await otherDevice('admin_clavepropia_ref', 'd2')
    expect((await a.b.put(`/api/users/${a.id}`, { password: 'Clave-Propia-Nueva-2026!' })).status).toBe(200)
    expect((await a.b.get('/api/auth/me')).status).toBe(200)
    expect((await otro.get('/api/auth/me')).status).toBe(401)
    expect(await env.prisma.session.count({ where: { userId: a.id } })).toBe(1)
  })

  it('CHW-07 — un ticket WS emitido antes de desactivar al usuario, o antes de cerrar su sesión, no abre el WS', async () => {
    const { id, b } = await newUser('op_ticket_ref', 'OPERATOR', [[camA, { canView: true }]])
    const t = await b.post('/api/auth/ws-ticket')
    expect(t.status).toBe(200)
    expect((await admin.put(`/api/users/${id}`, { active: false })).status).toBe(200)
    const h = await env.openWs(t.json().ticket)
    await h.opened
    await sleep(150)
    wsMod.broadcastAlert({ type: 'alert', alert: { id: 'alerta-carrera-ref', title: 'NVR sin disco' } })
    await sleep(150)
    expect(h.ws.readyState, 'WS abierto para un usuario desactivado').not.toBe(WebSocket.OPEN)
    expect(h.messages.some(m => m.includes('alerta-carrera-ref')), 'alerta entregada a un usuario desactivado').toBe(false)
    expect(await closedWithin(h)).toBe(4003)
    h.ws.terminate()

    // Ticket de la sesión del dispositivo 1, que otro dispositivo cierra antes del canje.
    const u2 = await newUser('op_ticket2_ref', 'OPERATOR', [[camA, { canView: true }]])
    const d2 = await otherDevice('op_ticket2_ref', 'd2')
    const t2 = await u2.b.post('/api/auth/ws-ticket')
    expect(t2.status).toBe(200)
    expect((await d2.del(`/api/auth/sessions/${sessionIdOf(u2.b)}`)).status).toBe(200)
    const h2 = await env.openWs(t2.json().ticket)
    expect(await closedWithin(h2), 'ticket de una sesión cerrada').toBe(4003)
    // El otro dispositivo sigue con su WS.
    const ws2 = await d2.openAlerts()
    expect(ws2.ws.readyState).toBe(WebSocket.OPEN)
    ws2.ws.close()
  })

  it('CHW-07 (carrera) — desactivar al usuario mientras se valida el canje: la revalidación posterior al registro cierra el WS', async () => {
    const { id, b } = await newUser('op_ticket_carrera_ref', 'OPERATOR', [[camA, { canView: true }]])
    const t = await b.post('/api/auth/ws-ticket')
    expect(t.status).toBe(200)
    const delegate = (env.server as any).prisma.user
    const realFindFirst = delegate.findFirst.bind(delegate)
    let release: () => void = () => undefined
    const gate = new Promise<void>(r => { release = r })
    let entered: () => void = () => undefined
    const enteredP = new Promise<void>(r => { entered = r })
    let held = false
    // La verificación PREVIA del canje lee al usuario ACTIVO antes de la baja y su
    // respuesta llega DESPUÉS: la baja (revokeUserWs) todavía no encuentra la
    // conexión registrada para cerrarla.
    const spy = vi.spyOn(delegate, 'findFirst').mockImplementation((async (args: any) => {
      if (!held && args?.where?.id === id && args?.where?.sessions) {
        held = true
        const result = await realFindFirst(args)
        entered()
        await gate
        return result
      }
      return realFindFirst(args)
    }) as any)
    try {
      const h = await env.openWs(t.json().ticket)
      await enteredP
      expect((await admin.put(`/api/users/${id}`, { active: false })).status).toBe(200)
      // La baja también publica por el bus de Redis (ws:revoke) y este mismo proceso
      // lo recibe: se deja que llegue ANTES del registro, como en la carrera real
      // (la baja ya pasó por todas partes y la conexión todavía no está registrada).
      await sleep(500)
      expect(wsMod.wsClients.has(id), 'todavía sin registrar').toBe(false)
      release()
      expect(await closedWithin(h), 'WS de un usuario desactivado durante el canje').toBe(4003)
      await waitFor(() => !wsMod.wsClients.has(id), 'baja del registro de conexiones', 2_000)
    } finally {
      spy.mockRestore()
      release()
    }
  })

  it('WS — cerrar una sesión propia corta su WS en el siguiente ping y no el del otro dispositivo; cambiar el rol no lo cierra y las alertas siguen a la base', async () => {
    const u = await newUser('op_wsping_ref', 'OPERATOR', [[camA, { canView: true }]])
    const d2 = await otherDevice('op_wsping_ref', 'd2')
    const ws1 = await u.b.openAlerts()
    const ws2 = await d2.openAlerts()
    expect((await d2.del(`/api/auth/sessions/${sessionIdOf(u.b)}`)).status).toBe(200)
    // La MISMA revalidación que ejecuta el ping de cada conexión (30 s); que el ping
    // real la dispare lo prueba websocket.route.test.ts con temporizadores simulados.
    expect(await wsMod.revalidateWsConnections(env.server.prisma)).toBeGreaterThanOrEqual(1)
    expect(await closedWithin(ws1)).toBe(4003)
    expect(ws2.ws.readyState).toBe(WebSocket.OPEN)
    ws2.ws.close()

    // Cambio de rol: el WS sigue abierto y el filtro de alertas de cámara relee la base.
    const a2 = await newUser('admin_wsrol_ref', 'ADMIN')
    const wsA = await a2.b.openAlerts()
    // El registro del lado del servidor ocurre tras validar el actor (después del handshake).
    await waitFor(() => wsMod.wsClients.has(a2.id), 'WS del ADMIN registrado', 3_000)
    await wsMod.broadcastAlertScoped(env.server.prisma, camB, { type: 'alert', alert: { id: 'alerta-camB-1' } })
    await waitFor(() => wsA.messages.some(m => m.includes('alerta-camB-1')), 'alerta de cámara al ADMIN', 3_000)
    expect((await admin.put(`/api/users/${a2.id}`, { role: 'OPERATOR' })).status).toBe(200)
    await sleep(100)
    expect(wsA.ws.readyState, 'el cambio de rol no corta el WS').toBe(WebSocket.OPEN)
    await wsMod.broadcastAlertScoped(env.server.prisma, camB, { type: 'alert', alert: { id: 'alerta-camB-2' } })
    wsMod.broadcastAlert({ type: 'alert', alert: { id: 'alerta-sistema-1' } })
    await waitFor(() => wsA.messages.some(m => m.includes('alerta-sistema-1')), 'alerta de sistema', 3_000)
    expect(wsA.messages.some(m => m.includes('alerta-camB-2')), 'alerta de cámara al ADMIN degradado').toBe(false)
    wsA.ws.close()
  })

  // ─── Medios de grabación ya emitidos ───────────────────────────────────────

  it('REV-01/PB-02/CHW-14 — revocar canPlayback corta el MP4 (fileToken), la descarga (24 h), el status y el stream de preview ya emitidos', async () => {
    const { id, b } = await newUser('aud_rev_ref', 'AUDITOR', [[camA, { canView: false, canPlayback: true, canDownload: true }]])
    const ready = await playUntilReady(b, camA, win(0))
    expect(ready.downloadUrl).toMatch(/^\/api\/recordings\/download\?t=/)
    expect((await b.get(ready.url)).status).toBe(200)
    const pv = await b.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 0, ...win(0) })
    expect(pv.json().status).toBe('ready')

    const rev = await admin.put(`/api/users/${id}/permissions`, { cameraPermissions: [{ cameraId: camA, canView: false, canPlayback: false, canDownload: false }] })
    expect(rev.status).toBe(200)
    expect((await b.post('/api/recordings/playback', { cameraId: camA, ...win(0) })).status).toBe(403)

    const mark = infra.mark()
    expect(DENIED, 'file.mp4 tras revocar').toContain((await b.get(ready.url)).status)
    expect(DENIED, 'file.mp4 con Range tras revocar').toContain((await b.get(ready.url, { headers: { range: 'bytes=0-99' } })).status)
    expect(DENIED, 'download tras revocar').toContain((await env.browser('cualquiera-ref').get(ready.downloadUrl)).status)
    const st = await b.get(`/api/recordings/playback/${ready.sessionId}/status`)
    expect(st.status === 200 ? (st.json().url ?? st.json().downloadUrl ?? null) : null, 'status re-expone url/downloadUrl').toBeNull()
    const pst = await b.get(`/api/recordings/preview/${pv.json().sessionId}/status`)
    expect(pst.status === 200 ? (pst.json().streamUrl ?? null) : null, 'status de preview re-expone streamUrl').toBeNull()
    const stream = await getPreviewStream(b, pv.json().streamUrl)
    expect(infra.of('proc.spawn', mark).length, 'FFmpeg relanzado contra el NVR tras revocar').toBe(0)
    expect(stream ? DENIED.includes(stream.status) : false, 'stream de preview tras revocar').toBe(true)
    // La sesión de preview del revocado se cerró por la vía terminal (libera el cupo del NVR).
    expect((await admin.get(`/api/recordings/preview/${pv.json().sessionId}/status`)).status).toBe(404)
    await admin.del(`/api/recordings/preview/${pv.json().sessionId}`)
  })

  it('invariante 4: un GET /stream de preview más viejo cuya revalidación termina DESPUÉS que la de uno más nuevo no toma el control', async () => {
    const { id, b } = await newUser('aud_orden_ref', 'AUDITOR', [[camA, { canView: false, canPlayback: true }]])
    const pv = (await b.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 3, ...win(50) })).json()
    expect(pv.status).toBe('ready')
    const delegate = (env.server as any).prisma.user
    const realFindFirst = delegate.findFirst.bind(delegate)
    let release: (() => void) | null = null
    let entered: (() => void) | null = null
    const enteredP = new Promise<void>(r => { entered = r })
    let blocked = false
    const spy = vi.spyOn(delegate, 'findFirst').mockImplementation((async (args: any) => {
      if (!blocked && args?.where?.id === id) {
        blocked = true
        entered!()
        await new Promise<void>(r => { release = r })
      }
      return realFindFirst(args)
    }) as any)
    const mark = infra.mark()
    let older: Promise<JointResponse | null> | null = null
    let newer: Promise<JointResponse | null> | null = null
    try {
      older = getPreviewStream(b, pv.streamUrl, 8_000)          // llega primero; su revalidación queda en vuelo
      await enteredP
      newer = getPreviewStream(b, pv.streamUrl, 8_000)          // llega después y revalida antes
      await waitFor(() => infra.of('proc.spawn', mark).length > 0, 'FFmpeg del GET más nuevo', 5_000)
      const spawnedByNewer = infra.of('proc.spawn', mark).length
      release!()
      const res = await older
      expect(res?.status, 'el GET viejo cede').toBe(409)
      expect(infra.of('proc.spawn', mark).length, 'el GET viejo no relanzó FFmpeg').toBe(spawnedByNewer)
    } finally {
      spy.mockRestore()
      release?.()
      await b.del(`/api/recordings/preview/${pv.sessionId}`)
      await newer
    }
  })

  it('stream de preview YA ADJUNTO: desactivar, quitar canPlayback o cerrar la sesión lo termina y mata su FFmpeg sin esperar otra apertura; el de otro usuario sigue', async () => {
    const perms: Array<[string, Record<string, boolean>]> = [[camA, { canView: false, canPlayback: true }]]
    const users: Array<{ id: string; b: SimBrowser }> = []
    for (const name of ['aud_adj_baja_ref', 'aud_adj_perm_ref', 'aud_adj_logout_ref', 'aud_adj_otro_ref']) {
      users.push(await newUser(name, 'AUDITOR', perms))
    }
    ffctl.previewStream = true
    const opened: Array<{ u: { id: string; b: SimBrowser }; sessionId: string; s: Awaited<ReturnType<typeof openPreviewTcp>> }> = []
    try {
      for (const [i, u] of users.entries()) {
        const pv = (await u.b.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: i, ...win(0) })).json()
        expect(pv.status, `preview ${i}`).toBe('ready')
        const s = await openPreviewTcp(pv.streamUrl)
        expect(s.status).toBe(200)
        opened.push({ u, sessionId: pv.sessionId, s })
      }
      await waitFor(() => opened.every(x => x.s.bytes() >= 2048), 'video fluyendo en los 4 streams', 10_000)
      expect(ffctl.previewAlive.size).toBe(4)
      const [baja, perm, salida, otro] = opened
      expect((await admin.put(`/api/users/${baja.u.id}`, { active: false })).status).toBe(200)
      expect((await admin.put(`/api/users/${perm.u.id}/permissions`, { cameraPermissions: [{ cameraId: camA, canView: false, canPlayback: false, canDownload: false }] })).status).toBe(200)
      expect((await salida.u.b.post('/api/auth/logout', {})).status).toBe(200)

      // Ningún GET nuevo: la revalidación periódica de los streams adjuntos los corta.
      const revoked = [baja, perm, salida]
      await Promise.race([Promise.all(revoked.map(x => x.s.ended)), sleep(12_000)])
      expect(revoked.map(x => x.s.isEnded()), 'streams revocados terminados [desactivar, canPlayback, logout]').toEqual([true, true, true])
      await waitFor(() => ffctl.previewAlive.size === 1, 'FFmpeg de los revocados terminados', 5_000)
      for (const x of revoked) {
        expect((await admin.get(`/api/recordings/preview/${x.sessionId}/status`)).status, 'sesión de preview cerrada').toBe(404)
      }
      // El stream del otro usuario sobrevivió a la misma revalidación y sigue entregando.
      const before = otro.s.bytes()
      await sleep(400)
      expect(otro.s.isEnded()).toBe(false)
      expect(otro.s.bytes()).toBeGreaterThan(before)
    } finally {
      ffctl.previewStream = false
      for (const x of opened) {
        x.s.destroy()
        await admin.del(`/api/recordings/preview/${x.sessionId}`)
      }
    }
  })

  it('REV-01/PB-02 — tras el logout del titular, la descarga y el MP4 ya emitidos dejan de servir', async () => {
    const { b } = await newUser('aud_logout_ref', 'AUDITOR', [[camA, { canView: false, canPlayback: true, canDownload: true }]])
    const ready = await playUntilReady(b, camA, win(10))
    expect((await env.browser('tercero-pre-ref').get(ready.downloadUrl)).status).toBe(200)
    expect((await b.post('/api/auth/logout', {})).status).toBe(200)
    expect(DENIED, 'download tras logout').toContain((await env.browser('tercero-ref').get(ready.downloadUrl)).status)
    expect(DENIED, 'file.mp4 tras logout').toContain((await env.browser('tercero2-ref').get(ready.url)).status)
  })

  it('REV-01/PB-02 — desactivar y después borrar al titular corta POST /playback, el MP4 y la descarga ya emitidos', async () => {
    const { id, b } = await newUser('aud_baja_dl_ref', 'AUDITOR', [[camA, { canView: false, canPlayback: true, canDownload: true }]])
    const ready = await playUntilReady(b, camA, win(5))
    expect((await admin.put(`/api/users/${id}`, { active: false })).status).toBe(200)
    expect(DENIED, 'POST /playback con el access vigente tras desactivar').toContain((await b.post('/api/recordings/playback', { cameraId: camA, ...win(5) })).status)
    expect(DENIED, 'file.mp4 tras desactivar').toContain((await b.get(ready.url)).status)
    expect(DENIED, 'download tras desactivar').toContain((await env.browser('tercero-baja-ref').get(ready.downloadUrl)).status)
    expect((await admin.del(`/api/users/${id}`, { headers: await adminStepUp() })).status).toBe(200)
    expect(await env.prisma.user.count({ where: { id } })).toBe(0)
    expect(DENIED, 'file.mp4 tras borrar al usuario').toContain((await env.browser('tercero-borrado-1-ref').get(ready.url)).status)
    expect(DENIED, 'download tras borrar al usuario').toContain((await env.browser('tercero-borrado-2-ref').get(ready.downloadUrl)).status)
  })

  it('VOD EN CURSO pedido por dos sesiones del mismo usuario (MISMA ventana): el logout de una no deja en 403 a la otra, un re-login con la misma ventana funciona y hay un solo FFmpeg', async () => {
    const perms: Array<[string, Record<string, boolean>]> = [[camA, { canView: false, canPlayback: true, canDownload: true }]]
    const u = await newUser('aud_vodjob_ref', 'AUDITOR', perms)
    const d2 = await otherDevice('aud_vodjob_ref', 'd2')
    const w = win(2)
    let release: () => void = () => undefined
    ffctl.vodHold = new Promise<void>(r => { release = r })
    const mark = infra.mark()
    const vodSpawns = () => infra.of('proc.spawn', mark).filter(c => c.detail.cmd === 'ffmpeg').length
    try {
      const p1 = (await u.b.post('/api/recordings/playback', { cameraId: camA, ...w })).json()
      expect(p1.status).toBe('starting')
      await waitFor(() => vodSpawns() === 1, 'FFmpeg del VOD en curso', 5_000)
      const p2 = (await d2.post('/api/recordings/playback', { cameraId: camA, ...w })).json()
      expect(p2.status, 'el dispositivo 2 se suma al trabajo en curso').toBe('starting')
      expect((await d2.get(p2.pollUrl)).status).toBe(200)

      // Logout del dispositivo 1 con el trabajo EN CURSO (todavía no hay caché).
      expect((await u.b.post('/api/auth/logout', {})).status).toBe(200)
      expect((await d2.get('/api/auth/me')).status).toBe(200)
      expect((await d2.get(p2.pollUrl)).status, 'sondeo del dispositivo 2 tras el logout del 1').toBe(200)
      // Re-login del dispositivo 1 y la MISMA ventana, con el trabajo aún en curso.
      await u.b.signIn('aud_vodjob_ref')
      const p3 = (await u.b.post('/api/recordings/playback', { cameraId: camA, ...w })).json()
      expect((await u.b.get(p3.pollUrl)).status, 'sondeo tras el re-login').toBe(200)
      expect(vodSpawns(), 'sumarse al trabajo no lanza otro FFmpeg sobre el mismo archivo').toBe(1)

      release()
      const r2 = await pollUntilReady(d2, p2.pollUrl)
      const r3 = await pollUntilReady(u.b, p3.pollUrl)
      for (const [b, r, label] of [[d2, r2, 'dispositivo 2'], [u.b, r3, 're-login']] as const) {
        expect((await b.get(r.url)).status, `${label}: file.mp4`).toBe(200)
        expect((await b.get(r.url, { headers: { range: 'bytes=0-99' } })).status, `${label}: Range`).toBe(206)
        expect((await env.browser(`dl-vodjob-${label}`).get(r.downloadUrl)).status, `${label}: descarga`).toBe(200)
      }
      // Los medios ligados a la sesión cerrada siguen muertos (el ADMIN ve su estado).
      expect((await admin.get(p1.pollUrl)).status).toBe(403)
      expect(vodSpawns()).toBe(1)
    } finally {
      ffctl.vodHold = null
      release()
    }
  })

  // ─── Lo legítimo sigue funcionando ─────────────────────────────────────────

  it('re-login tras la revocación: nueva sesión, nuevo access y vivo + grabaciones vuelven a funcionar (también tras reactivar)', async () => {
    const { id, b } = await newUser('aud_relogin_ref', 'AUDITOR', [[camA, { canView: true, canPlayback: true }]])
    const oldSid = sessionIdOf(b)
    const old = await playUntilReady(b, camA, win(15))
    expect((await admin.del(`/api/users/${id}/sessions`)).status).toBe(200)
    expect((await b.get('/api/auth/me')).status).toBe(401)
    expect(DENIED).toContain((await b.get(old.url)).status)

    await b.signIn('aud_relogin_ref')
    expect(sessionIdOf(b)).toBeTruthy()
    expect(sessionIdOf(b)).not.toBe(oldSid)
    expect((await b.get('/api/auth/me')).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(1), { browser: b })).status).toBe(200)
    const ready = await playUntilReady(b, camA, win(15))
    expect((await b.get(ready.url)).status).toBe(200)
    expect((await env.browser('descarga-relogin-ref').get(ready.downloadUrl)).status).toBe(200)
    // El token viejo sigue muerto aunque el usuario volvió a entrar.
    expect(DENIED).toContain((await b.get(old.url)).status)

    // Baja y alta: durante la baja nada vale; al reactivar, las sesiones NO vencidas
    // vuelven a valer (como ya pasaba con el refresh: la baja suspende, no cierra
    // sesiones; para cerrarlas está "revocar sesiones" o fijar una contraseña nueva).
    expect((await admin.put(`/api/users/${id}`, { active: false })).status).toBe(200)
    expect((await b.get('/api/auth/me')).status).toBe(401)
    expect(DENIED).toContain((await b.get(ready.url)).status)
    expect((await admin.put(`/api/users/${id}`, { active: true })).status).toBe(200)
    expect((await b.get('/api/auth/me')).status).toBe(200)
    const again = env.browser('aud_relogin_ref-again')
    await again.signIn('aud_relogin_ref')
    expect((await again.get('/api/auth/me')).status).toBe(200)
  })

  it('refresh: el access renovado conserva la sesión (mismo sid, sin jti ni step) y la revocación posterior corta ambos', async () => {
    const { id, b } = await newUser('op_refresh_ref', 'OPERATOR', [[camA, { canView: true }]])
    const first = b.accessToken!
    const claims = decodeJwt(first)
    const rows = await env.prisma.session.findMany({ where: { userId: id }, select: { id: true } })
    expect(rows.map(r => r.id)).toEqual([claims.sid])
    // Compatible con #190: el access no trae jti ni step.
    expect(claims.jti).toBeUndefined()
    expect(claims.step).toBeUndefined()
    // El refresh token NO lleva sid (no es credencial de petición).
    expect(decodeJwt(b.refreshToken!).sid).toBeUndefined()

    await sleep(1100)   // iat distinto ⇒ access distinto
    expect((await b.post('/api/auth/refresh', {})).status).toBe(200)
    const second = b.accessToken!
    expect(second).not.toBe(first)
    expect(decodeJwt(second).sid).toBe(claims.sid)
    expect((await b.get('/api/auth/me')).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(1), { cookie: first })).status, 'access anterior de la misma sesión viva').toBe(200)

    expect((await b.post('/api/auth/logout', {})).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(1), { cookie: first })).status).toBe(401)
    expect((await env.hlsAuth(hlsUri(1), { cookie: second })).status).toBe(401)
  })

  it('compatibilidad de despliegue: un access emitido ANTES del cambio (sin sid) da 401 y el web se recupera con /auth/refresh por cookie, sin cerrar la sesión; el WS de una pestaña con el bundle viejo se recupera por el puente del ticket', async () => {
    const { id, b } = await newUser('op_legacy_ref', 'OPERATOR', [[camA, { canView: true }]])
    const sessionId = sessionIdOf(b)
    const now = Math.floor(Date.now() / 1000)
    // Forma EXACTA del access que emitía el código anterior: {sub, username, role} + iat/exp.
    const legacy = signHs256({ sub: id, username: 'op_legacy_ref', role: 'OPERATOR', iat: now, exp: now + 3600 }, env.jwtSecret)
    b.plantCookie('access_token', legacy, '/')
    // Un ladrón con ese access viejo tampoco entra.
    expect((await env.browser('ladron-legacy-ref').get('/api/auth/me', { headers: { authorization: `Bearer ${legacy}` } })).status).toBe(401)

    // apps/web/src/lib/api.ts: 401 ⇒ POST /api/auth/refresh (cookie Path=/api/auth) ⇒ reintento.
    expect((await b.get('/api/auth/me')).status).toBe(401)
    const r = await b.post('/api/auth/refresh', {})
    expect(r.status).toBe(200)
    expect(sessionIdOf(b), 'el access nuevo queda ligado a la MISMA sesión').toBe(sessionId)
    expect((await b.get('/api/auth/me')).status).toBe(200)
    expect(await env.prisma.session.count({ where: { userId: id } }), 'la sesión del usuario no se cerró').toBe(1)

    // Vivo: hls.js recibe 401 ⇒ VideoPlayer (HLS_SESSION_EXPIRED) ⇒ heartbeat por axios
    // (refresh si hace falta) ⇒ remonta. Con la cookie renovada el borde vuelve a autorizar.
    b.plantCookie('access_token', legacy, '/')
    expect((await env.hlsAuth(hlsUri(1), { browser: b })).status).toBe(401)
    expect((await b.heartbeat('v-legacy-ref', [camA])).status).toBe(401)
    expect((await b.post('/api/auth/refresh', {})).status).toBe(200)
    const hb = await b.heartbeat('v-legacy-ref', [camA])
    expect(hb.status).toBe(200)
    expect(Object.keys(hb.json().streams)).toEqual([camA])
    expect((await env.hlsAuth(hlsUri(1), { browser: b })).status).toBe(200)

    // WS de una pestaña abierta durante el despliegue: corre el BUNDLE VIEJO, que pide
    // el ticket UNA vez y, ante un 401, no renueva ni reintenta (sin alertas hasta
    // recargar). Puente: el ticket acepta el access previo (sin sid) si la cookie de
    // refresh (Path=/api/auth, el navegador la manda) es la de una sesión VIVA del
    // MISMO usuario; el ticket queda ligado a ESA sesión.
    b.plantCookie('access_token', legacy, '/')
    const ws = await b.openAlerts()
    expect(ws.ws.readyState, 'pestaña con el bundle viejo recupera el WS').toBe(WebSocket.OPEN)
    await waitFor(() => wsMod.wsClients.has(id), 'WS registrado', 3_000)
    // Sin la cookie de refresh (access copiado), o con la de otro usuario: 401.
    expect((await env.browser('ladron-legacy-ws-ref').post('/api/auth/ws-ticket', undefined, { headers: { authorization: `Bearer ${legacy}` } })).status).toBe(401)
    const ajeno = env.browser('ladron-legacy-ws-ajeno-ref')
    ajeno.plantCookie('access_token', legacy, '/')
    ajeno.plantCookie('refresh_token', admin.refreshToken!, '/api/auth')
    expect((await ajeno.post('/api/auth/ws-ticket')).status, 'refresh de otro usuario').toBe(401)
    // Sólo la forma del access previo: un refresh (con jti) presentado como access no pasa.
    const conRefresh = env.browser('legacy-refresh-como-access-ref')
    conRefresh.plantCookie('access_token', b.refreshToken!, '/')
    conRefresh.plantCookie('refresh_token', b.refreshToken!, '/api/auth')
    expect((await conRefresh.post('/api/auth/ws-ticket')).status, 'refresh como access').toBe(401)
    // El puente es sólo para el ticket: el resto sigue exigiendo el access nuevo.
    expect((await b.get('/api/auth/me')).status).toBe(401)
    // El WS quedó ligado a la sesión de esa cookie: cerrarla lo corta.
    expect((await b.post('/api/auth/refresh', {})).status).toBe(200)
    const ultimoRefresh = b.refreshToken!
    expect((await b.post('/api/auth/logout', {})).status).toBe(200)
    expect(await closedWithin(ws), 'WS ligado a la sesión cerrada').toBe(4003)
    // Tras el logout, el access previo + la última cookie de refresh ya no abren nada.
    const tras = env.browser('legacy-tras-logout-ref')
    tras.plantCookie('access_token', legacy, '/')
    tras.plantCookie('refresh_token', ultimoRefresh, '/api/auth')
    expect((await tras.post('/api/auth/ws-ticket')).status).toBe(401)
    expect(await env.prisma.session.count({ where: { userId: id } })).toBe(0)
  })

  it('compatibilidad de despliegue: un token de descarga emitido ANTES del cambio (sin titular) se rechaza', async () => {
    const { b } = await newUser('aud_dl_legacy_ref', 'AUDITOR', [[camA, { canView: false, canPlayback: true }]])
    const ready = await playUntilReady(b, camA, win(20))
    const t = new URL(ready.downloadUrl, 'https://x.test').searchParams.get('t')!
    const redis = (env.server as any).redis
    const stored = JSON.parse(await redis.get(`vc:dltoken:${t}`))
    expect(stored.userId).toBeTruthy()
    // Forma anterior: sin userId/sid/cameraId (era un token al portador de 24 h).
    const legacyToken = `legacy${t.slice(6)}`
    const { userId: _u, sid: _s, cameraId: _c, ...legacy } = { ...stored, token: legacyToken }
    await redis.set(`vc:dltoken:${legacyToken}`, JSON.stringify(legacy), 'PX', 60_000)
    expect((await env.browser('dl-legacy-ref').get(ready.downloadUrl)).status).toBe(200)
    expect((await env.browser('dl-legacy-ref-2').get(`/api/recordings/download?t=${legacyToken}`)).status).toBe(403)
    await redis.del(`vc:dltoken:${legacyToken}`)
  })

  it('aislamiento: el logout de un dispositivo no corta los medios del otro ni los de otro usuario; "cerrar las demás" y la revocación del ADMIN sí', async () => {
    const perms: Array<[string, Record<string, boolean>]> = [[camA, { canView: true, canPlayback: true }]]
    const u = await newUser('aud_iso_ref', 'AUDITOR', perms)
    const d2 = await otherDevice('aud_iso_ref', 'd2')
    const v = await newUser('aud_iso_otro_ref', 'AUDITOR', perms)
    const m1 = await playUntilReady(u.b, camA, win(25))
    const m2 = await playUntilReady(d2, camA, win(30))
    const mv = await playUntilReady(v.b, camA, win(35))
    const pv2 = (await d2.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 1, ...win(30) })).json()
    const pvV = (await v.b.post('/api/recordings/preview/start', { cameraId: camA, slotIndex: 1, ...win(35) })).json()
    expect(pv2.status).toBe('ready')
    expect(pvV.status).toBe('ready')
    const ws1 = await u.b.openAlerts()
    const ws2 = await d2.openAlerts()
    await waitFor(() => (wsMod.wsClients.get(u.id)?.size ?? 0) === 2, 'WS de los dos dispositivos registrados', 3_000)

    // Logout del dispositivo 1.
    expect((await u.b.post('/api/auth/logout', {})).status).toBe(200)
    expect(await closedWithin(ws1), 'WS de la sesión cerrada').toBe(4003)
    expect(DENIED).toContain((await env.browser('iso-1').get(m1.url)).status)
    expect(DENIED).toContain((await env.browser('iso-2').get(m1.downloadUrl)).status)
    // El dispositivo 2 (otra sesión del mismo usuario) sigue, también su WS.
    expect(await closedWithin(ws2, 500), 'WS del otro dispositivo').toBe(-1)
    expect(ws2.ws.readyState).toBe(WebSocket.OPEN)
    ws2.ws.close()
    expect((await d2.get('/api/auth/me')).status).toBe(200)
    expect((await env.hlsAuth(hlsUri(1), { browser: d2 })).status).toBe(200)
    expect((await d2.get(m2.url)).status).toBe(200)
    expect((await env.browser('iso-3').get(m2.downloadUrl)).status).toBe(200)
    expect((await previewAdmitted(d2, pv2)).spawned, 'preview del dispositivo 2').toBe(true)
    // Otro usuario, intacto.
    expect((await v.b.get(mv.url)).status).toBe(200)
    expect((await env.browser('iso-4').get(mv.downloadUrl)).status).toBe(200)

    // Un tercer dispositivo cierra "las demás sesiones": cae el 2, sigue el 3.
    const d3 = await otherDevice('aud_iso_ref', 'd3')
    const m3 = await playUntilReady(d3, camA, win(40))
    expect((await d3.del('/api/auth/sessions')).status).toBe(200)
    expect((await d2.get('/api/auth/me')).status).toBe(401)
    expect(DENIED).toContain((await d2.get(m2.url)).status)
    expect((await d3.get('/api/auth/me')).status).toBe(200)
    expect((await d3.get(m3.url)).status).toBe(200)

    // El ADMIN revoca todas: cae el 3; el otro usuario sigue intacto (MP4, descarga y preview).
    expect((await admin.del(`/api/users/${u.id}/sessions`)).status).toBe(200)
    expect(DENIED).toContain((await d3.get(m3.url)).status)
    expect(DENIED).toContain((await env.browser('iso-5').get(m3.downloadUrl)).status)
    expect((await v.b.get(mv.url)).status).toBe(200)
    expect((await env.browser('iso-6').get(mv.downloadUrl)).status).toBe(200)
    expect((await previewAdmitted(v.b, pvV)).spawned, 'preview del otro usuario').toBe(true)
  })

  // ─── Fallas y costo ────────────────────────────────────────────────────────

  it('base caída al verificar el actor: 503 (no 401, el web no cierra la sesión), hls-auth 403 y nunca una petición colgada', async () => {
    const { b } = await newUser('op_db_ref', 'OPERATOR', [[camA, { canView: true }]])
    const delegate = (env.server as any).prisma.user
    const spy = vi.spyOn(delegate, 'findFirst').mockRejectedValue(Object.assign(new Error('simulada'), { code: 'P1001' }))
    try {
      const me = await Promise.race([b.get('/api/auth/me'), sleep(5_000).then(() => null)])
      expect(me?.status, '/me con la base caída').toBe(503)
      expect(me?.json().code).toBe('AUTH_UNAVAILABLE')
      const hls = await Promise.race([env.hlsAuth(hlsUri(1), { browser: b }), sleep(5_000).then(() => null)])
      expect(hls?.status, 'hls-auth con la base caída (fail-closed)').toBe(403)
      const users = await Promise.race([admin.get('/api/users'), sleep(5_000).then(() => null)])
      expect(users?.status, 'authorize con la base caída').toBe(503)
      // Apariencia verifica con su propio jwtVerify (no pasa por authenticate).
      const look = await Promise.race([admin.put('/api/appearance', {}), sleep(5_000).then(() => null)])
      expect(look?.status, 'apariencia con la base caída').toBe(503)
      expect(look?.json().code).toBe('AUTH_UNAVAILABLE')
    } finally {
      spy.mockRestore()
    }
    expect((await b.get('/api/auth/me')).status).toBe(200)
  })

  it('rendimiento: UNA consulta indexada por petición para el actor, sin caché (cada petición relee la base)', async () => {
    const aud = await newUser('aud_perf_ref', 'AUDITOR', [[camA, { canView: true, canPlayback: true }]])
    const ready = await playUntilReady(aud.b, camA, win(45))
    const ops: string[] = []
    let counting = false
    ;(env.server as any).prisma.$use(async (params: any, next: any) => {
      if (counting) ops.push(`${params.model}.${params.action}`)
      return next(params)
    })
    const measure = async (fn: () => Promise<unknown>) => {
      ops.length = 0; counting = true
      try { await fn() } finally { counting = false }
      return [...ops]
    }
    const actorOps = (l: string[]) => l.filter(o => o === 'User.findFirst').length

    // Borde HLS de un ADMIN: antes, 0 consultas; ahora, sólo la del actor.
    expect(await measure(() => env.hlsAuth(hlsUri(1), { browser: admin }))).toEqual(['User.findFirst'])
    // Borde HLS de un AUDITOR con fila de cámara: actor + RBAC que ya existía.
    const hlsAud = await measure(() => env.hlsAuth(hlsUri(1), { browser: aud.b }))
    expect(hlsAud[0]).toBe('User.findFirst')
    expect(actorOps(hlsAud)).toBe(1)
    // /me: actor + la lectura del perfil.
    const me = await measure(() => aud.b.get('/api/auth/me'))
    expect(me[0]).toBe('User.findFirst')
    expect(actorOps(me)).toBe(1)
    // Cada Range del MP4: actor + permiso de reproducción.
    expect(await measure(() => aud.b.get(ready.url, { headers: { range: 'bytes=0-1023' } }))).toEqual(['User.findFirst', 'UserPermission.findFirst'])
    // Sin caché: N peticiones ⇒ N lecturas del actor (la revocación es inmediata por construcción).
    const many = await measure(async () => { for (let i = 0; i < 20; i++) await env.hlsAuth(hlsUri(1), { browser: admin }) })
    expect(actorOps(many)).toBe(20)

    // Nivel SQL: la verificación del actor es UNA sentencia, por PK de users y de sessions.
    const { loadCurrentActor } = await import('../services/current-actor')
    const sqlClient = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } }, log: [{ emit: 'event', level: 'query' }] })
    const statements: Array<{ query: string; params: string }> = []
    sqlClient.$on('query', (e) => { statements.push({ query: e.query, params: e.params }) })
    try {
      await sqlClient.$connect()
      statements.length = 0
      const r = await loadCurrentActor(sqlClient, { sub: aud.id, sid: sessionIdOf(aud.b) })
      expect(r.ok).toBe(true)
      expect(statements.length, statements.map(s => s.query).join('\n')).toBe(1)
      expect(statements[0].query).toMatch(/FROM "[^"]+"\."users"/)
      expect(statements[0].query).toMatch(/"sessions"/)
      // Plan con los índices de PK (seq scan apagado sólo en esta transacción: tablas chicas).
      // Los parámetros llegan serializados; la fecha vuelve a Date para tipar el `>`.
      const params = (JSON.parse(statements[0].params) as unknown[]).map(v =>
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v) ? new Date(v.replace(' UTC', 'Z').replace(' ', 'T')) : v)
      const plan = await sqlClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
        return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${statements[0].query}`, ...params)
      })
      const text = plan.map(p => p['QUERY PLAN']).join('\n')
      expect(text).toMatch(/users_pkey/)
      expect(text).toMatch(/sessions_pkey/)
    } finally {
      await sqlClient.$disconnect()
    }
  })

  it('higiene: sin red saliente; todo contacto con el NVR fue a su IP TEST-NET', () => {
    expect(env.blockedConnections).toEqual([])
    for (const c of infra.of('nvr.isapi')) expect(c.detail.nvrHost).toBe(NVR_IP)
    for (const t of infra.rtspTargetsSince(0)) expect(t.host).toBe(NVR_IP)
  })
})
