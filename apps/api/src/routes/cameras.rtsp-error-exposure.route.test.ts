// lastRtspError — lo escribe stream-validator (tras cada sync de NVR y en
// POST /:id/validate-stream) y lo devuelven GET /api/cameras, POST /batch y GET /:id
// a TODOS los roles con canView (OPERATOR/AUDITOR incluidos).
//
// Defectos que blinda:
//   1. validateAndUpdateCameraHealth persistía el error de rtsp-probe tal cual. Ese
//      texto trae la URL del NVR con IP (`rtsp:***@<ip>:554/...`) y, en el mensaje de
//      execFile, también el USUARIO (`rtsp://<usuario>:***@<ip>:554/...`).
//   2. Las filas que escribió el código anterior conservan ese texto: las rutas de
//      lectura lo redactan también, sin tocar la DB.
//
// Fuera de alcance, y por eso se mira el campo lastRtspError y no "ninguna IPv4 en
// todo el body": estas rutas siguen devolviendo camera.ipAddress y nvr.ipAddress a
// todos los roles; eso queda para la proyección por rol de la política de permisos.
//
// Sin red: ffprobe es un script falso local (sale con 1, como un ffprobe -v quiet que
// no conecta). Datos 100% ficticios: IPs TEST-NET (RFC 5737), credenciales inventadas.
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
  `rtsp:***@${NVR_IP}:554/Streaming/Channels/102: Command failed: /usr/bin/ffprobe -v quiet -rtsp_transport tcp ` +
  `-select_streams v:0 -of json rtsp://${NVR_USER}:***@${NVR_IP}:554/Streaming/Channels/102\n`

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

// Cualquier forma de IPv4, también enmascarada parcialmente (a.b.x.x).
const ANY_IPV4 = /\b\d{1,3}\.\d{1,3}\.(?:\d{1,3}|x)\.(?:\d{1,3}|x)\b/

let workDir = ''
let probeLog = ''
let cameraRoutes: typeof import('./cameras').cameraRoutes
let validateAndUpdateCameraHealth: typeof import('../services/stream-validator').validateAndUpdateCameraHealth
let encryptedPass = ''

beforeAll(async () => {
  // ffprobe falso: registra cada invocación y falla sin salida (no abre red).
  workDir = mkdtempSync(path.join(tmpdir(), 'vc-rtsperr-'))
  probeLog = path.join(workDir, 'probes.log')
  const fake = path.join(workDir, 'ffprobe')
  writeFileSync(fake, `#!/bin/sh\necho probe >> '${probeLog}'\nexit 1\n`)
  chmodSync(fake, 0o755)
  vi.stubEnv('FFPROBE_PATH', fake) // rtsp-probe lo lee al importar
  vi.stubEnv('NVR_CREDENTIAL_KEY', 'test-only-credential-key-not-real')
  const creds = await import('../services/credentials')
  encryptedPass = creds.encryptNvrPassword(NVR_PASS)
  ;({ cameraRoutes } = await import('./cameras'))
  ;({ validateAndUpdateCameraHealth } = await import('../services/stream-validator'))
})

afterAll(() => {
  vi.unstubAllEnvs()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const probeCount = () => (existsSync(probeLog) ? readFileSync(probeLog, 'utf8').split('\n').filter(Boolean).length : 0)

/** Una cámara en memoria; `update` la modifica como lo haría Prisma. */
function makeStore(lastRtspError: string | null = null) {
  const nvr = {
    id: 'nvr-1', name: 'NVR Fixture', ipAddress: NVR_IP, port: 80, rtspPort: 554,
    username: NVR_USER, password: encryptedPass, online: true, lastSeen: null,
  }
  const row: Record<string, unknown> = {
    id: 'cam-1', nvrId: 'nvr-1', channel: 1, channelCode: 'D1', name: 'Cam Fixture',
    ipAddress: CAM_IP, protocol: 'HIKVISION', preferredStream: 'sub', online: true, onlineInNvr: true,
    streamHealthStatus: 'UNKNOWN', lastRtspError,
  }
  // include: { nvr: { select: { id, name, ipAddress } } } de las rutas de listado.
  const listed = () => ({ ...row, nvr: { id: nvr.id, name: nvr.name, ipAddress: nvr.ipAddress } })
  const prisma = {
    camera: {
      update: async ({ where, data }: any) => { if (where.id === row.id) Object.assign(row, data); return { ...row } },
      findMany: async ({ where }: any) => {
        const ids: string[] | undefined = where?.id?.in
        return !ids || ids.includes(row.id as string) ? [listed()] : []
      },
      findUnique: async ({ where, include }: any) => {
        if (where.id !== row.id) return null
        return include?.nvr === true ? { ...row, nvr } : include?.nvr ? listed() : { ...row }
      },
    },
    // OPERATOR/AUDITOR: canView sobre cam-1.
    userPermission: {
      findMany: async () => [{ cameraId: 'cam-1' }],
      findFirst: async ({ where }: any) => (where.cameraId === 'cam-1' ? { id: 'p1' } : null),
    },
    auditLog: { create: async () => ({}) },
  }
  return { nvr, row, prisma }
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

function expectRedacted(value: unknown) {
  const s = String(value)
  expect(s).toContain('/Streaming/Channels/102') // el canal se conserva: es lo útil
  expect(s).not.toContain(NVR_USER)
  expect(s).not.toContain(NVR_PASS)
  expect(s).not.toContain(encodeURIComponent(NVR_PASS))
  expect(s).not.toMatch(ANY_IPV4)
}

/** GET /api/cameras, POST /batch y GET /:id: cada lastRtspError devuelto, redactado. */
async function expectListingRoutesRedacted(app: FastifyInstance) {
  const responses = [
    await app.inject({ method: 'GET', url: '/api/cameras' }),
    await app.inject({ method: 'POST', url: '/api/cameras/batch', payload: { ids: ['cam-1'] } }),
    await app.inject({ method: 'GET', url: '/api/cameras/cam-1' }),
  ]
  for (const res of responses) {
    expect(res.statusCode).toBe(200)
    // El usuario del NVR no figura en ningún campo de estas rutas.
    expect(res.body).not.toContain(NVR_USER)
    const body = res.json()
    const cams = Array.isArray(body) ? body : [body]
    expect(cams).toHaveLength(1)
    expectRedacted(cams[0].lastRtspError)
  }
}

describe('stream-validator · lastRtspError se persiste sin usuario ni IP del NVR', () => {
  it('validateAndUpdateCameraHealth sondea de verdad y guarda el error redactado (canal y motivo se conservan)', async () => {
    const { nvr, row, prisma } = makeStore()
    const before = probeCount()
    const status = await validateAndUpdateCameraHealth(prisma as any, nvr as any, row as any)
    expect(probeCount()).toBe(before + 2) // main + sub
    expect(status).toBe('UNKNOWN')         // la clasificación usa el texto original
    expect(row.rtspSubOk).toBe(false)
    expectRedacted(row.lastRtspError)
    expect(String(row.lastRtspError)).toContain('Command failed')
  })

  for (const role of ['OPERATOR', 'AUDITOR'] as Role[]) {
    it(`${role}: tras validar, GET /api/cameras, /batch y /:id no traen usuario ni IP del NVR en lastRtspError`, async () => {
      const { nvr, row, prisma } = makeStore()
      await validateAndUpdateCameraHealth(prisma as any, nvr as any, row as any)
      const app = await build(role, prisma)
      try {
        await expectListingRoutesRedacted(app)
      } finally {
        await app.close()
      }
    })
  }

  it('SUPERVISOR: POST /:id/validate-stream devuelve el lastRtspError ya redactado', async () => {
    const { prisma } = makeStore()
    const app = await build('SUPERVISOR', prisma)
    try {
      const res = await app.inject({ method: 'POST', url: '/api/cameras/cam-1/validate-stream' })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain(NVR_USER)
      expectRedacted(res.json().lastRtspError)
    } finally {
      await app.close()
    }
  })
})

describe('filas escritas por el código anterior · las rutas de listado redactan al leer', () => {
  for (const role of ['OPERATOR', 'AUDITOR', 'SUPERVISOR', 'ADMIN'] as Role[]) {
    it(`${role}: lastRtspError viejo con usuario+IP sale redactado en GET /api/cameras, /batch y /:id`, async () => {
      const { prisma, row } = makeStore(LEGACY_ERROR)
      const app = await build(role, prisma)
      try {
        await expectListingRoutesRedacted(app)
        expect(row.lastRtspError).toBe(LEGACY_ERROR) // sólo lectura: no reescribe la DB
      } finally {
        await app.close()
      }
    })
  }
})
