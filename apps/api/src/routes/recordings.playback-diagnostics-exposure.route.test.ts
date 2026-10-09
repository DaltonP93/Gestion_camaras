// Diagnóstico de REPRODUCCIÓN — respuestas sin usuario ni IP/host del NVR.
//
// Defectos que blinda:
//   1. GET /api/recordings/preview/:id/status (dueño de la sesión: SUPERVISOR, o
//      AUDITOR con canPlayback) devolvía detail/errorDetail/stderrTail con el stderr de
//      ffprobe/FFmpeg: maskUrlCredentials sólo tapa la clave y dejaba
//      `rtsp://<usuario>:***@<ip>:554/...` del NVR. Igual el cuerpo de error de
//      GET /preview/:id/stream (`detail`).
//   2. POST /api/recordings/diagnostics/playback (ADMIN) devolvía sanitizedUri
//      (`rtsp://<usuario>:***@<ip>:554/...`) y stderrSample con usuario e IP.
// Criterio igual al diagnóstico de cámaras: ni usuario ni IP/host del NVR en NINGUNA
// forma; se conserva path/query (track, starttime/endtime) y el texto del error.
// La reproducción no cambia: se redacta sólo en el borde de la respuesta.
//
// Sin red: ffprobe y ffmpeg son scripts falsos locales (imprimen la línea de error
// típica de FFmpeg con la URL de entrada, clave incluida, y salen con 1) y el reloj /
// búsqueda ISAPI del NVR están simulados. Datos 100% ficticios: IPs TEST-NET
// (RFC 5737), credenciales inventadas.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'

const NVR_USER = 'nvr-fixture-svc'
const NVR_PASS = 'Fixture!Pass0'
const NVR_IP = '192.0.2.10'
const CAM_IP = '198.51.100.20'

vi.mock('../services/hikvision', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/hikvision')>()
  return {
    ...real,
    getNvrSystemTime: vi.fn(async () => null),
    searchRecordings: vi.fn(async () => []),
  }
})

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

// Cualquier forma de IPv4, también enmascarada parcialmente (a.b.x.x).
const ANY_IPV4 = /\b\d{1,3}\.\d{1,3}\.(?:\d{1,3}|x)\.(?:\d{1,3}|x)\b/

const START = '2026-10-02T08:00:00.000Z'
const END = '2026-10-02T08:10:00.000Z'
const PLAYBACK_URI = '/Streaming/tracks/101/?starttime=20261002T080000Z&endtime=20261002T081000Z&name=00000000001&size=1024'

let workDir = ''
let callLog = ''
let recordingRoutes: typeof import('./recordings').recordingRoutes
let encryptedPass = ''

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'vc-playdiag-'))
  callLog = path.join(workDir, 'calls.log')
  // ffprobe/ffmpeg falsos: registran la invocación, imprimen la línea de error de
  // FFmpeg con la URL de entrada TAL CUAL (como el binario real) y fallan. No abren red.
  for (const bin of ['ffprobe', 'ffmpeg']) {
    const fake = path.join(workDir, bin)
    writeFileSync(fake, [
      '#!/bin/sh',
      `echo ${bin} >> '${callLog}'`,
      'url=""',
      'for a in "$@"; do case "$a" in rtsp://*) url="$a";; esac; done',
      'echo "$url: Invalid data found when processing input" >&2',
      'exit 1',
      '',
    ].join('\n'))
    chmodSync(fake, 0o755)
  }
  vi.stubEnv('PATH', `${workDir}:${process.env.PATH}`) // spawn('ffmpeg'/'ffprobe')
  vi.stubEnv('FFPROBE_PATH', path.join(workDir, 'ffprobe')) // rtsp-probe (preview con sonda)
  vi.stubEnv('RECORDINGS_PREVIEW_PROBE', 'true')
  vi.stubEnv('RECORDINGS_PLAYBACK_STREAM', 'main')
  vi.stubEnv('RECORDINGS_PREVIEW_RETRY_DELAY_MS', '1')
  vi.stubEnv('NVR_CREDENTIAL_KEY', 'test-only-credential-key-not-real')
  const creds = await import('../services/credentials')
  encryptedPass = creds.encryptNvrPassword(NVR_PASS)
  ;({ recordingRoutes } = await import('./recordings'))
})

afterAll(() => {
  vi.unstubAllEnvs()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const calls = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length : 0)

function makePrisma() {
  const camera = {
    id: 'cam-1', nvrId: 'nvr-1', channel: 1, channelCode: 'D1', name: 'Cam Fixture',
    ipAddress: CAM_IP, active: true, online: true, mainCodec: 'H264', subCodec: 'H264', audioMode: null,
    nvr: {
      id: 'nvr-1', name: 'NVR Fixture', model: 'DS-FIXTURE', ipAddress: NVR_IP, port: 80, rtspPort: 554,
      username: NVR_USER, password: encryptedPass, online: true, active: true, audioMode: null,
      maxConcurrentPlaybackSessions: null,
    },
  }
  return {
    camera: { findUnique: async ({ where }: any) => (where.id === 'cam-1' ? camera : null) },
    // AUDITOR: canPlayback sobre cam-1.
    userPermission: { findFirst: async ({ where }: any) => (where.cameraId === 'cam-1' && where.canPlayback ? { id: 'p1' } : null) },
    recordingsSettings: { findUnique: async () => null },
    auditLog: { create: async () => ({}) },
  }
}

async function build(role: Role) {
  // `sid`: el medio de grabación queda ligado a usuario + sesión + cámara y se
  // revalida al servir (#197); el doble de `user.findFirst` mantiene vivo al titular.
  const user = { sub: `u-${role}`, username: `fixture-${role.toLowerCase()}`, role, sid: `s-${role}` }
  const app: FastifyInstance = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  // Réplica del authorize real: 403 si el rol no está en la lista.
  app.decorate('authorize', (roles: Role[]) => async (req: any, reply: any) => {
    req.user = user
    if (!roles.includes(user.role)) return reply.status(403).send({ statusCode: 403, message: 'No tienes permisos para realizar esta acción' })
  })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', {
    ...makePrisma(),
    user: { findFirst: async ({ where }: any) => (where?.id === user.sub && where?.sessions?.some?.id === user.sid ? { role: user.role, username: user.username } : null) },
  } as any)
  await app.register(recordingRoutes, { prefix: '/api/recordings' })
  await app.ready()
  return app
}

/** Escaneo PROFUNDO: claves de host/credencial y strings con usuario, clave o IP del NVR. */
function leaks(value: unknown, at = '$'): string[] {
  if (typeof value === 'string') {
    const needles = [NVR_USER, NVR_PASS, encodeURIComponent(NVR_PASS), encryptedPass]
    return needles.some((n) => value.includes(n)) || ANY_IPV4.test(value) ? [`${at} = ${JSON.stringify(value).slice(0, 140)}`] : []
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, `${at}[${i}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => [
    ...(['ipAddress', 'username', 'password'].includes(k) ? [`${at}.${k}`] : []),
    ...leaks(v, `${at}.${k}`),
  ])
}

async function startPreview(app: FastifyInstance) {
  const res = await app.inject({
    method: 'POST', url: '/api/recordings/preview/start',
    payload: { cameraId: 'cam-1', slotIndex: 0, startTime: START, endTime: END, playbackURI: PLAYBACK_URI },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.status).toBe('ready')
  expect(leaks(body)).toEqual([])
  return body as { sessionId: string; streamUrl: string }
}

describe('GET /preview/:id/status — dueño no-ADMIN: detail/stderrTail sin usuario ni IP del NVR', () => {
  for (const role of ['SUPERVISOR', 'AUDITOR'] as Role[]) {
    it(`${role}: fallo de la sonda retenido tras DELETE ⇒ detail redactado (path y motivo se conservan)`, async () => {
      const app = await build(role)
      try {
        const before = calls()
        const { sessionId } = await startPreview(app)
        expect(calls()).toBe(before + 1) // la sonda corrió de verdad (ffprobe falso)
        const del = await app.inject({ method: 'DELETE', url: `/api/recordings/preview/${sessionId}` })
        expect(del.statusCode).toBe(200)

        const res = await app.inject({ method: 'GET', url: `/api/recordings/preview/${sessionId}/status` })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.status).toBe('error')
        expect(leaks(body)).toEqual([])
        expect(body.detail).toContain('/Streaming/tracks/101')
        expect(body.detail).toContain('Command failed')
        expect(body.errorDetail).toBe(body.detail)
      } finally {
        await app.close()
      }
    })

    it(`${role}: FFmpeg falla en /stream ⇒ el cuerpo de error y el status en vivo salen redactados`, async () => {
      const app = await build(role)
      try {
        const { sessionId, streamUrl } = await startPreview(app)
        const before = calls()
        const stream = await app.inject({ method: 'GET', url: streamUrl })
        expect(calls()).toBeGreaterThan(before) // FFmpeg (falso) se lanzó de verdad
        expect(stream.statusCode).toBeGreaterThanOrEqual(400)
        expect(leaks(stream.json())).toEqual([])
        expect(stream.json().detail).toContain('Invalid data found')

        const res = await app.inject({ method: 'GET', url: `/api/recordings/preview/${sessionId}/status` })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(body.status).toBe('error')
        expect(leaks(body)).toEqual([])
        expect(body.stderrTail ?? body.detail).toContain('/Streaming/tracks/101')
        await app.inject({ method: 'DELETE', url: `/api/recordings/preview/${sessionId}` })
      } finally {
        await app.close()
      }
    }, 60_000)
  }

  it('OPERATOR sigue sin acceso a grabaciones (403)', async () => {
    const app = await build('OPERATOR')
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/recordings/preview/start',
        payload: { cameraId: 'cam-1', slotIndex: 0, startTime: START, endTime: END, playbackURI: PLAYBACK_URI },
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })
})

describe('POST /diagnostics/playback — ADMIN: sanitizedUri y stderrSample sin usuario ni IP del NVR', () => {
  it('ADMIN: sondea cada estrategia de verdad y responde sólo path/query y el error', async () => {
    const app = await build('ADMIN')
    try {
      const before = calls()
      const res = await app.inject({
        method: 'POST', url: '/api/recordings/diagnostics/playback',
        payload: { cameraId: 'cam-1', playbackURI: PLAYBACK_URI, perStrategyTimeoutMs: 2000 },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.results.length).toBeGreaterThan(0)
      expect(calls()).toBeGreaterThanOrEqual(before + 2 * body.results.length) // probe + mux por estrategia
      expect(leaks(body)).toEqual([])
      for (const r of body.results) {
        expect(r.sanitizedUri).toMatch(/^rtsp:\/\/\*\*\*\/Streaming\/tracks\/101/)
        expect(r.stderrSample).toContain('Invalid data found')
      }
    } finally {
      await app.close()
    }
  }, 60_000)

  for (const role of ['SUPERVISOR', 'OPERATOR', 'AUDITOR'] as Role[]) {
    it(`${role}: diagnostics/playback y diagnostics/nvr-time siguen siendo sólo ADMIN (403)`, async () => {
      const app = await build(role)
      try {
        const before = calls()
        const a = await app.inject({ method: 'POST', url: '/api/recordings/diagnostics/playback', payload: { cameraId: 'cam-1', playbackURI: PLAYBACK_URI } })
        const b = await app.inject({ method: 'GET', url: '/api/recordings/diagnostics/nvr-time?cameraId=cam-1' })
        expect(a.statusCode).toBe(403)
        expect(b.statusCode).toBe(403)
        expect(calls()).toBe(before)
      } finally {
        await app.close()
      }
    })
  }
})
