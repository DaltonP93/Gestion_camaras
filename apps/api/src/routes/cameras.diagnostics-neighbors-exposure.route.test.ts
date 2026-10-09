// Endpoints de diagnóstico vecinos de GET /:id/diagnostics — mismo criterio: ni
// usuario ni IP/host del NVR en NINGUNA forma, también para ADMIN/SUPERVISOR (los
// únicos roles que los alcanzan; los roles no cambian).
//
// Defectos que blinda:
//   1. POST /:id/test-rtsp: urlMasked con buildRtspUrlMasked (rtsp://<usuario>:***@<ip>:554)
//      y `error` del probe tal cual (antepone `rtsp:***@<ip>` y repite el comando con
//      `rtsp://<usuario>:***@<ip>`).
//   2. GET /:id/debug-stream: subUrlMasked/mainUrlMasked con usuario+IP, nvr.ipAddress en
//      claro, lastRtspError con sanitizeRtsp (conservaba el usuario) y
//      mediaServer.sourceMasked con la IP "a.b.x.x".
//   3. POST /:id/validate-stream: devolvía lastRtspError releído sin redactar (una fila
//      escrita por otra réplica con el código anterior traía usuario+IP).
//   4. GET /api/cameras, /batch y /:id devolvían `rtspUrl`, columna legado que pudo
//      guardarse con usuario y clave en claro del NVR.
//
// Sin red: ffprobe es un script falso local (sale con 1, como un ffprobe -v quiet que
// no conecta) y MediaMTX se simula; la máscara de sourceMasked es la REAL de stream.ts.
// Datos 100% ficticios: IPs TEST-NET (RFC 5737), credenciales inventadas.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'

const NVR_USER = 'nvr-fixture-svc'
const NVR_PASS = 'Fixture!Pass0'
const NVR_IP = '192.0.2.10'
const CAM_IP = '198.51.100.20'

// Lo que dejaba el código anterior (validator o diagnostics) en la fila.
const LEGACY_ERROR =
  `rtsp:***@${NVR_IP}:554/Streaming/Channels/102: Command failed: /usr/bin/ffprobe -v quiet ` +
  `rtsp://${NVR_USER}:***@${NVR_IP}:554/Streaming/Channels/102\n`
const LEGACY_RTSP_URL = `rtsp://${NVR_USER}:${encodeURIComponent(NVR_PASS)}@${NVR_IP}:554/Streaming/Channels/101`

vi.mock('../services/stream', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/stream')>()
  return {
    ...real,
    // MediaMTX simulado; sourceMasked pasa por la máscara REAL (deja "192.0.x.x").
    getStreamDetails: vi.fn(async () => ({
      active: false, routeExists: true, readers: 0, bytesReceived: 0, sourceType: 'rtspSource',
      sourceMasked: real.sanitizeRtsp(`rtsp://${NVR_USER}:${encodeURIComponent(NVR_PASS)}@${NVR_IP}:554/Streaming/Channels/102`),
    })),
  }
})

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

// Cualquier forma de IPv4, también enmascarada parcialmente (a.b.x.x).
const ANY_IPV4 = /\b\d{1,3}\.\d{1,3}\.(?:\d{1,3}|x)\.(?:\d{1,3}|x)\b/

let workDir = ''
let probeLog = ''
let cameraRoutes: typeof import('./cameras').cameraRoutes
let encryptedPass = ''

beforeAll(async () => {
  // ffprobe falso: registra cada invocación y falla sin salida (no abre red).
  workDir = mkdtempSync(path.join(tmpdir(), 'vc-diagnb-'))
  probeLog = path.join(workDir, 'probes.log')
  const fake = path.join(workDir, 'ffprobe')
  writeFileSync(fake, `#!/bin/sh\necho probe >> '${probeLog}'\nexit 1\n`)
  chmodSync(fake, 0o755)
  vi.stubEnv('FFPROBE_PATH', fake) // rtsp-probe lo lee al importar
  vi.stubEnv('NVR_CREDENTIAL_KEY', 'test-only-credential-key-not-real')
  const creds = await import('../services/credentials')
  encryptedPass = creds.encryptNvrPassword(NVR_PASS)
  ;({ cameraRoutes } = await import('./cameras'))
})

afterAll(() => {
  vi.unstubAllEnvs()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const probeCount = () => (existsSync(probeLog) ? readFileSync(probeLog, 'utf8').split('\n').filter(Boolean).length : 0)

/**
 * Una cámara en memoria. `staleWriter` simula un despliegue escalonado: otra réplica
 * con el código anterior escribe la fila (error sin redactar) entre el update del
 * validador y la relectura de POST /:id/validate-stream.
 */
function makeStore(opts: { staleWriter?: boolean } = {}) {
  const nvr = {
    id: 'nvr-1', name: 'NVR Fixture', ipAddress: NVR_IP, port: 80, rtspPort: 554,
    username: NVR_USER, password: encryptedPass, online: true, lastSeen: null,
  }
  const row: Record<string, unknown> = {
    id: 'cam-1', nvrId: 'nvr-1', channel: 1, channelCode: 'D1', name: 'Cam Fixture',
    ipAddress: CAM_IP, protocol: 'HIKVISION', preferredStream: 'sub', active: true, online: true, onlineInNvr: true,
    streamHealthStatus: 'UNKNOWN', lastRtspError: LEGACY_ERROR, rtspUrl: LEGACY_RTSP_URL,
  }
  const listed = () => ({ ...row, nvr: { id: nvr.id, name: nvr.name, ipAddress: nvr.ipAddress } })
  const prisma = {
    camera: {
      update: async ({ where, data }: any) => {
        if (where.id === row.id) Object.assign(row, data)
        if (opts.staleWriter) row.lastRtspError = LEGACY_ERROR
        return { ...row }
      },
      findMany: async ({ where }: any) => {
        const ids: string[] | undefined = where?.id?.in
        return !ids || ids.includes(row.id as string) ? [listed()] : []
      },
      findUnique: async ({ where, include }: any) => {
        if (where.id !== row.id) return null
        return include?.nvr === true ? { ...row, nvr } : include?.nvr ? listed() : { ...row }
      },
    },
    // OPERATOR/AUDITOR: canView sobre cam-1 (acceder a la cámara NO habilita diagnóstico).
    userPermission: {
      findMany: async () => [{ cameraId: 'cam-1' }],
      findFirst: async ({ where }: any) => (where.cameraId === 'cam-1' ? { id: 'p1' } : null),
    },
    auditLog: { create: async () => ({}) },
  }
  return { row, prisma }
}

async function build(role: Role, prisma: unknown) {
  const user = { sub: `u-${role}`, username: `fixture-${role.toLowerCase()}`, role }
  const app: FastifyInstance = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  // Réplica del authorize real: 403 si el rol no está en la lista.
  app.decorate('authorize', (roles: Role[]) => async (req: any, reply: any) => {
    req.user = user
    if (!roles.includes(user.role)) return reply.status(403).send({ statusCode: 403, message: 'No tienes permisos para realizar esta acción' })
  })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', prisma as any)
  await app.register(cameraRoutes, { prefix: '/api/cameras' })
  await app.ready()
  return app
}

/** Escaneo PROFUNDO: claves de host/credencial y strings con usuario, clave o IP del NVR. */
function leaks(value: unknown, at = '$'): string[] {
  if (typeof value === 'string') {
    const needles = [NVR_USER, NVR_PASS, encodeURIComponent(NVR_PASS), encryptedPass]
    return needles.some((n) => value.includes(n)) || ANY_IPV4.test(value) ? [`${at} = ${JSON.stringify(value).slice(0, 120)}`] : []
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, `${at}[${i}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => [
    ...(['ipAddress', 'username', 'password', 'rtspUrl'].includes(k) ? [`${at}.${k}`] : []),
    ...leaks(v, `${at}.${k}`),
  ])
}

const DIAG_ROLES: Role[] = ['ADMIN', 'SUPERVISOR']

describe('POST /:id/test-rtsp — sin usuario ni IP del NVR (urlMasked y error)', () => {
  for (const role of DIAG_ROLES) {
    for (const stream of ['sub', 'main'] as const) {
      it(`${role} · stream=${stream}: sondea de verdad y responde sólo el path del canal`, async () => {
        const { prisma } = makeStore()
        const app = await build(role, prisma)
        try {
          const before = probeCount()
          const res = await app.inject({ method: 'POST', url: '/api/cameras/cam-1/test-rtsp', payload: { stream } })
          expect(res.statusCode).toBe(200)
          expect(probeCount()).toBe(before + 1)
          const body = res.json()
          expect(leaks(body)).toEqual([])
          const ch = stream === 'sub' ? '/Streaming/Channels/102' : '/Streaming/Channels/101'
          expect(body.ok).toBe(false)
          expect(body.stream).toBe(stream)
          expect(body.urlMasked).toBe(`rtsp://***${ch}`)
          expect(body.error).toContain(ch)            // lo útil se conserva
          expect(body.error).toContain('Command failed')
        } finally {
          await app.close()
        }
      })
    }
  }
})

describe('GET /:id/debug-stream — sin usuario ni IP del NVR en URLs, error, source ni bloque nvr', () => {
  for (const role of DIAG_ROLES) {
    it(`${role}: escaneo profundo limpio; canal, error y estado de MediaMTX se conservan`, async () => {
      const { prisma } = makeStore()
      const app = await build(role, prisma)
      try {
        const res = await app.inject({ method: 'GET', url: '/api/cameras/cam-1/debug-stream' })
        expect(res.statusCode).toBe(200)
        const body = res.json()
        expect(leaks(body)).toEqual([])
        expect(body.subUrlMasked).toBe('rtsp://***/Streaming/Channels/102')
        expect(body.mainUrlMasked).toBe('rtsp://***/Streaming/Channels/101')
        expect(body.lastRtspError).toContain('/Streaming/Channels/102')
        expect(body.mediaServer.sourceMasked).toContain('/Streaming/Channels/102')
        expect(body.mediaServer.routeExists).toBe(true)
        expect(body.nvr).toEqual({ id: 'nvr-1', name: 'NVR Fixture', online: true, lastSeen: null })
      } finally {
        await app.close()
      }
    })
  }
})

describe('POST /:id/validate-stream — lastRtspError redactado también al responder', () => {
  for (const role of DIAG_ROLES) {
    it(`${role}: aunque la fila releída traiga el error viejo de otra réplica, sale sin usuario ni IP`, async () => {
      const { prisma, row } = makeStore({ staleWriter: true })
      const app = await build(role, prisma)
      try {
        const res = await app.inject({ method: 'POST', url: '/api/cameras/cam-1/validate-stream' })
        expect(res.statusCode).toBe(200)
        expect(row.lastRtspError).toBe(LEGACY_ERROR) // sólo lectura: no reescribe la DB
        const body = res.json()
        expect(leaks(body)).toEqual([])
        expect(body.lastRtspError).toContain('/Streaming/Channels/102')
      } finally {
        await app.close()
      }
    })
  }
})

describe('roles sin cambios · OPERATOR/AUDITOR con canView ⇒ 403 sin sondas', () => {
  for (const role of ['OPERATOR', 'AUDITOR'] as Role[]) {
    it(`${role}: test-rtsp, debug-stream y validate-stream ⇒ 403`, async () => {
      const { prisma } = makeStore()
      const app = await build(role, prisma)
      try {
        const before = probeCount()
        for (const [method, url] of [
          ['POST', '/api/cameras/cam-1/test-rtsp'],
          ['GET', '/api/cameras/cam-1/debug-stream'],
          ['POST', '/api/cameras/cam-1/validate-stream'],
        ] as const) {
          const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) })
          expect(res.statusCode).toBe(403)
          expect(res.body).not.toContain(NVR_USER)
          expect(res.body).not.toMatch(ANY_IPV4)
        }
        expect(probeCount()).toBe(before)
      } finally {
        await app.close()
      }
    })
  }
})

describe('GET /api/cameras, /batch y /:id — sin rtspUrl legado (usuario y clave del NVR)', () => {
  for (const role of ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR'] as Role[]) {
    it(`${role}: ninguna respuesta trae rtspUrl ni la clave del NVR`, async () => {
      const { prisma } = makeStore()
      const app = await build(role, prisma)
      try {
        for (const res of [
          await app.inject({ method: 'GET', url: '/api/cameras' }),
          await app.inject({ method: 'POST', url: '/api/cameras/batch', payload: { ids: ['cam-1'] } }),
          await app.inject({ method: 'GET', url: '/api/cameras/cam-1' }),
        ]) {
          expect(res.statusCode).toBe(200)
          expect(res.body).not.toContain('"rtspUrl"')
          expect(res.body).not.toContain(NVR_USER)
          expect(res.body).not.toContain(encodeURIComponent(NVR_PASS))
        }
      } finally {
        await app.close()
      }
    })
  }
})
