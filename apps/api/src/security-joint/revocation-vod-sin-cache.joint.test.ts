// Suite conjunta de seguridad — REVOCACIÓN EFECTIVA, VOD SIN CACHÉ.
//
// Con RECORDINGS_CACHE_DIR vacío (default del código) nunca hay acierto de caché:
// cada POST /playback de la MISMA ventana vuelve a la deduplicación de trabajos.
// Antes del arreglo, otra sesión del mismo usuario (otro dispositivo, o un re-login)
// recibía la sesión de reproducción de quien inició el trabajo, con sus tokens
// ligados a ESA sesión: el logout del dispositivo 1 dejaba al 2 en 403, y un re-login
// recibía una y otra vez la misma sesión muerta (extendiendo su vencimiento).
//
// Archivo aparte porque CACHE_DIR se lee al importar recordings.ts: este archivo
// arranca su propio server.ts REAL (harness.ts, sin cambios) sin directorio de caché.
// Todo en loopback; NVR y FFmpeg son dobles (infra-doubles.ts).
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
import { jointInfraAvailable, startJointServer, waitFor, type JointEnv, type SimBrowser } from './harness'

const NVR_IP = '192.0.2.71'
const DENIED = [401, 403, 404, 410]
const WINDOW = {
  startTime: '2026-10-01T13:00:00.000Z',
  endTime: '2026-10-01T13:05:00.000Z',
  playbackURI: '/Streaming/tracks/101/?starttime=20261001T130000Z&endtime=20261001T130500Z',
}

describe.skipIf(!jointInfraAvailable())('conjunta · revocación efectiva — VOD sin caché', { timeout: 60_000 }, () => {
  let env: JointEnv
  let nvrId = ''
  let camA = ''

  beforeAll(async () => {
    env = await startJointServer({ label: 'revefnc', env: { RECORDINGS_CACHE_DIR: '' } })
    nvrId = (await env.createNvr('NVR conjunto VOD sin caché', NVR_IP)).id
    camA = (await env.createCamera(nvrId, 1)).id
  }, 120_000)

  afterAll(async () => { await env?.stop() })

  /** POST /playback de WINDOW y sondeo hasta 'ready' (cada sondeo debe ser 200). */
  const play = async (b: SimBrowser) => {
    infra.ffmpegMode = 'vod-ok'
    const p = await b.post('/api/recordings/playback', { cameraId: camA, ...WINDOW })
    expect(p.status).toBe(200)
    if (p.json().status === 'ready') return p.json()
    return waitFor(async () => {
      const st = await b.get(p.json().pollUrl)
      expect(st.status, 'sondeo del VOD').toBe(200)
      return st.json().status === 'ready' ? { ...st.json(), sessionId: p.json().sessionId, pollUrl: p.json().pollUrl } : null
    }, 'VOD listo', 10_000, 50)
  }

  it('otro dispositivo y un re-login con la MISMA ventana reciben medios propios: el logout del iniciador no los deja en 403', async () => {
    const u = await env.createUser('aud_sincache_ref', 'AUDITOR')
    await env.grant(u.id, nvrId, camA, { canView: false, canPlayback: true, canDownload: true })
    const d1 = env.browser('aud_sincache_ref-d1')
    await d1.signIn('aud_sincache_ref')
    const d2 = env.browser('aud_sincache_ref-d2')
    await d2.signIn('aud_sincache_ref')

    const m1 = await play(d1)
    const mark = infra.mark()
    const m2 = await play(d2)
    expect((await d2.get(m2.url)).status).toBe(200)
    // Un tercer dispositivo se suma y cierra su reproducción (DELETE): no es dueño
    // del archivo temporal del trabajo, así que los demás siguen sirviendo.
    const d3 = env.browser('aud_sincache_ref-d3')
    await d3.signIn('aud_sincache_ref')
    const m3 = await play(d3)
    expect((await d3.del(`/api/recordings/playback/${m3.sessionId}`)).status).toBe(200)
    expect((await d1.get(m1.url)).status, 'el archivo del trabajo sigue tras el DELETE de otro dispositivo').toBe(200)
    expect((await d2.get(m2.url)).status).toBe(200)

    // Logout del dispositivo que inició el trabajo.
    expect((await d1.post('/api/auth/logout', {})).status).toBe(200)
    expect(DENIED, 'medios de la sesión cerrada').toContain((await env.browser('sc-1').get(m1.url)).status)
    expect(DENIED).toContain((await env.browser('sc-2').get(m1.downloadUrl)).status)
    expect((await d2.get('/api/auth/me')).status).toBe(200)
    expect((await d2.get(m2.url)).status, 'file.mp4 del dispositivo 2').toBe(200)
    expect((await d2.get(m2.url, { headers: { range: 'bytes=0-99' } })).status).toBe(206)
    expect((await d2.get(m2.pollUrl)).status, 'sondeo del dispositivo 2').toBe(200)
    expect((await env.browser('sc-3').get(m2.downloadUrl)).status, 'descarga del dispositivo 2').toBe(200)

    // Re-login del dispositivo 1 y la MISMA ventana, varias veces: cada intento sirve.
    await d1.signIn('aud_sincache_ref')
    for (let i = 0; i < 3; i++) {
      const m = await play(d1)
      expect((await d1.get(m.url)).status, `re-login, intento ${i + 1}: file.mp4`).toBe(200)
      expect((await d1.get(m.pollUrl)).status, `re-login, intento ${i + 1}: sondeo`).toBe(200)
      expect((await env.browser(`sc-dl-${i}`).get(m.downloadUrl)).status, `re-login, intento ${i + 1}: descarga`).toBe(200)
    }
    // Ningún FFmpeg nuevo: se reutilizó el trabajo ya hecho.
    expect(infra.of('proc.spawn', mark).filter(c => c.detail.cmd === 'ffmpeg')).toEqual([])
  })

  it('higiene: sin red saliente; todo contacto con el NVR fue a su IP TEST-NET', () => {
    expect(env.blockedConnections).toEqual([])
    for (const t of infra.rtspTargetsSince(0)) expect(t.host).toBe(NVR_IP)
  })
})
