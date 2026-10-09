// GET /api/cameras/:id/diagnostics — quién puede disparar sondas activas y qué sale.
//
// Defectos que blinda:
//   1. Cualquier usuario con acceso a la cámara (OPERATOR/AUDITOR incluidos) disparaba
//      DOS sondas RTSP contra el NVR (main+sub, consumen cupo RTSP del equipo) y una
//      escritura en DB. Ahora sólo ADMIN/SUPERVISOR, como restart-stream/test-rtsp.
//   2. La respuesta llevaba el USUARIO y la IP del NVR: rtsp.mainUrlMasked/subUrlMasked
//      (buildRtspUrlMasked sólo tapa la clave), rtsp.mainError/subError (el error del
//      probe antepone la URL con usuario+IP), mediaServer.sourceMasked (IP "a.b.x.x")
//      y camera.ipAddress para no-ADMIN. Además persistía ese error en lastRtspError,
//      que GET /api/cameras devuelve a todos los roles.
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

/** Rutas de claves `ipAddress`/`username`/`password` a cualquier profundidad. */
function findSensitiveKeys(value: unknown, at = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSensitiveKeys(v, `${at}[${i}]`))
  if (value === null || typeof value !== 'object') return []
  const hits: string[] = []
  for (const [k, v] of Object.entries(value)) {
    const here = `${at}.${k}`
    if (['ipAddress', 'username', 'password', 'rtspPort', 'httpPort'].includes(k)) hits.push(here)
    hits.push(...findSensitiveKeys(v, here))
  }
  return hits
}

let workDir = ''
let probeLog = ''
let cameraRoutes: typeof import('./cameras').cameraRoutes
let encryptedPass = ''

beforeAll(async () => {
  // ffprobe falso: registra cada invocación y falla sin salida (no abre red).
  workDir = mkdtempSync(path.join(tmpdir(), 'vc-diag-'))
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

function makeCamera() {
  return {
    id: 'cam-1', nvrId: 'nvr-1', channel: 1, channelCode: 'D1', name: 'Cam Fixture',
    ipAddress: CAM_IP, protocol: 'HIKVISION', preferredStream: 'sub', online: true, onlineInNvr: true,
    mainCodec: 'H264', subCodec: 'H264', streamHealthStatus: 'UNKNOWN',
    nvr: {
      id: 'nvr-1', name: 'NVR Fixture', ipAddress: NVR_IP, port: 80, rtspPort: 554,
      username: NVR_USER, password: encryptedPass, online: true, lastSeen: null,
    },
  }
}

async function build(role: Role) {
  const user = { sub: `u-${role}`, username: `fixture-${role.toLowerCase()}`, role }
  const updates: any[] = []
  const prisma = {
    camera: {
      findUnique: async ({ where }: any) => (where.id === 'cam-1' ? makeCamera() : null),
      update: async ({ data }: any) => { updates.push(data); return { ...makeCamera(), ...data } },
    },
    // OPERATOR/AUDITOR tienen canView sobre cam-1: el acceso a la cámara NO basta.
    userPermission: { findFirst: async ({ where }: any) => (where.cameraId === 'cam-1' && where.canView ? { id: 'p1' } : null) },
    auditLog: { create: async () => ({}) },
  }
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
  return { app, updates }
}

describe('GET /api/cameras/:id/diagnostics — sondas activas sólo ADMIN/SUPERVISOR', () => {
  for (const role of ['OPERATOR', 'AUDITOR'] as Role[]) {
    it(`${role} con canView sobre la cámara ⇒ 403, sin sondas RTSP ni escritura en DB`, async () => {
      const { app, updates } = await build(role)
      try {
        const before = probeCount()
        const res = await app.inject({ method: 'GET', url: '/api/cameras/cam-1/diagnostics' })
        expect(res.statusCode).toBe(403)
        expect(probeCount()).toBe(before)
        expect(updates).toEqual([])
        expect(res.body).not.toContain(NVR_USER)
        expect(res.body).not.toMatch(ANY_IPV4)
      } finally {
        await app.close()
      }
    })
  }
})

describe('GET /api/cameras/:id/diagnostics — sin usuario ni IP del NVR en ninguna forma', () => {
  for (const role of ['ADMIN', 'SUPERVISOR'] as Role[]) {
    it(`${role}: respuesta y lastRtspError persistido sin usuario/clave/IP del NVR (tampoco enmascarados)`, async () => {
      const { app, updates } = await build(role)
      try {
        const before = probeCount()
        const res = await app.inject({ method: 'GET', url: '/api/cameras/cam-1/diagnostics' })
        expect(res.statusCode).toBe(200)
        expect(probeCount()).toBe(before + 2) // main + sub: el diagnóstico sigue sondeando de verdad
        const body = res.json()

        // Ni usuario ni clave del NVR, en ningún campo.
        expect(res.body).not.toContain(NVR_USER)
        expect(res.body).not.toContain(NVR_PASS)
        expect(res.body).not.toContain(encodeURIComponent(NVR_PASS))
        expect(res.body).not.toContain(encryptedPass)
        // La IP del NVR no sale ni completa ni enmascarada; la de la cámara, sólo a ADMIN.
        const withoutCamIp = res.body.split(CAM_IP).join('')
        expect(withoutCamIp).not.toMatch(ANY_IPV4)
        const keys = findSensitiveKeys(body)
        expect(keys).toEqual(role === 'ADMIN' ? ['$.camera.ipAddress'] : [])
        if (role === 'ADMIN') expect(body.camera.ipAddress).toBe(CAM_IP)
        else expect(res.body).not.toContain(CAM_IP)

        // Lo útil del diagnóstico se conserva: canal/stream y el error.
        expect(body.rtsp.mainOk).toBe(false)
        expect(body.rtsp.subOk).toBe(false)
        expect(body.rtsp.mainUrlMasked).toContain('/Streaming/Channels/101')
        expect(body.rtsp.subUrlMasked).toContain('/Streaming/Channels/102')
        expect(body.rtsp.mainError).toContain('/Streaming/Channels/101')
        expect(body.mediaServer.sourceMasked).toContain('/Streaming/Channels/102')

        // Lo que se PERSISTE (GET /api/cameras lo devuelve a todos los roles).
        expect(updates).toHaveLength(1)
        const stored = String(updates[0].lastRtspError)
        expect(stored).toContain('/Streaming/Channels/10')
        expect(stored).not.toContain(NVR_USER)
        expect(stored).not.toMatch(ANY_IPV4)
      } finally {
        await app.close()
      }
    })
  }
})
