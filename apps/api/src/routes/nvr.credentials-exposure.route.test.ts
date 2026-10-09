// GET /api/nvrs, GET /api/nvrs/:id y GET /api/nvrs/:id/cameras — credenciales del NVR
// por rol.
//
// Defectos que blinda:
//   1. GET /api/nvrs y /:id devolvían `{ ...nvr, password: undefined }`: el USUARIO
//      del NVR salía a SUPERVISOR y a OPERATOR/AUDITOR con permiso NVR-scoped. Regla:
//      el usuario del NVR sólo a ADMIN (formulario de edición); la clave a nadie, ni
//      cifrada. No hay otros campos de credencial en el modelo NVR.
//   2. Las cámaras anidadas de /:id (`include: { cameras: true }`) y las de
//      /:id/cameras son filas completas: `rtspUrl` legado (usuario:clave@ip) y
//      `lastRtspError` viejo (`rtsp://<usuario>:***@<ip>`) llevaban el usuario del NVR
//      a esos mismos roles (y a camera-scoped en /:id/cameras).
//
// Fuera de alcance, y por eso se mira usuario/clave y no "ninguna IPv4": IP y puertos
// del NVR siguen saliendo a quien hoy los recibe (política de permisos pendiente); se
// verifica que el resto del contrato no cambió.
//
// Sin red: la enumeración ISAPI (getIpCameraList) está simulada. Datos 100% ficticios:
// IPs TEST-NET (RFC 5737), credenciales inventadas.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const NVR_USER = 'nvr-fixture-svc'
const NVR_PASS = 'Fixture!Pass0'
const NVR_IP = '192.0.2.10'
const CAM_IP = '198.51.100.20'

vi.mock('../services/hikvision', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/hikvision')>()
  return {
    ...real,
    getIpCameraList: vi.fn(async () => [
      { channel: 1, channelCode: 'D1', name: 'Cam Fixture', ipAddress: CAM_IP, protocol: 'HIKVISION', managementPort: 8000, securityStatus: '', status: 'online' },
    ]),
  }
})

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'
type Scope = 'nvr' | 'camera' | 'none'

// Lo que dejaba el código anterior en la fila de la cámara.
const LEGACY_ERROR =
  `rtsp:***@${NVR_IP}:554/Streaming/Channels/102: Command failed: /usr/bin/ffprobe -v quiet ` +
  `rtsp://${NVR_USER}:***@${NVR_IP}:554/Streaming/Channels/102\n`
const LEGACY_RTSP_URL = `rtsp://${NVR_USER}:${encodeURIComponent(NVR_PASS)}@${NVR_IP}:554/Streaming/Channels/101`

let nvrRoutes: typeof import('./nvr').nvrRoutes
let encryptedPass = ''

beforeAll(async () => {
  vi.stubEnv('NVR_CREDENTIAL_KEY', 'test-only-credential-key-not-real')
  const creds = await import('../services/credentials')
  encryptedPass = creds.encryptNvrPassword(NVR_PASS)
  ;({ nvrRoutes } = await import('./nvr'))
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function nvrRow() {
  return {
    id: 'nvr-1', name: 'NVR Fixture', model: 'DS-FIXTURE', serialNumber: 'SN-FIXTURE',
    ipAddress: NVR_IP, port: 80, rtspPort: 554, sdkPort: 8000,
    username: NVR_USER, password: encryptedPass,
    channels: 4, hddCount: 1, firmware: 'V0.0', location: 'Lab', active: true, online: true,
    recordingProvider: 'ISAPI', lastError: null,
  }
}
function cameraRow() {
  return {
    id: 'cam-1', nvrId: 'nvr-1', channel: 1, channelCode: 'D1', name: 'Cam Fixture',
    ipAddress: CAM_IP, online: true, active: true, streamHealthStatus: 'UNKNOWN',
    rtspSubOk: false, lastRtspError: LEGACY_ERROR, rtspUrl: LEGACY_RTSP_URL,
  }
}

function makePrisma(userId: string, scope: Scope) {
  const perms = scope === 'nvr' ? [{ nvrId: 'nvr-1', cameraId: null, camera: null }]
    : scope === 'camera' ? [{ nvrId: null, cameraId: 'cam-1', camera: { id: 'cam-1', nvrId: 'nvr-1' } }]
    : []
  return {
    nVR: {
      findMany: async () => [{
        ...nvrRow(),
        cameras: [{ id: 'cam-1', channel: 1, name: 'Cam Fixture', online: true, active: true, channelCode: 'D1' }],
        hdds: [{ id: 'hdd-1', diskNumber: 1, capacity: 4000 }],
      }],
      findUnique: async ({ where, include }: any) => {
        if (where.id !== 'nvr-1') return null
        return include ? { ...nvrRow(), cameras: [cameraRow()], hdds: [] } : nvrRow()
      },
    },
    camera: { findMany: async () => [cameraRow()] },
    userPermission: {
      findFirst: async ({ where }: any) => {
        if (where.userId !== userId || where.canView !== true) return null
        if (where.OR) return perms.length ? { id: 'p1' } : null         // userCanAccessNvr
        if (where.cameraId === null) return scope === 'nvr' ? { id: 'p1' } : null // NVR-wide
        return null
      },
      findMany: async ({ where }: any) => (where.userId === userId ? perms : []),
    },
    auditLog: { create: async () => ({}) },
  }
}

async function build(role: Role, scope: Scope = 'none') {
  const user = { sub: `u-${role}`, username: `fixture-${role.toLowerCase()}`, role }
  const app: FastifyInstance = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (roles: Role[]) => async (req: any, reply: any) => {
    req.user = user
    if (!roles.includes(user.role)) return reply.status(403).send({ statusCode: 403, message: 'No tienes permisos para realizar esta acción' })
  })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', makePrisma(user.sub, scope) as any)
  await app.register(nvrRoutes, { prefix: '/api/nvrs' })
  await app.ready()
  return app
}

/** Recorre TODO el JSON: claves de credencial y strings con usuario/clave del NVR. */
function credentialLeaks(value: unknown, at = '$'): string[] {
  if (typeof value === 'string') {
    const needles = [NVR_USER, NVR_PASS, encodeURIComponent(NVR_PASS), encryptedPass]
    return needles.some((n) => value.includes(n)) ? [`${at} = ${JSON.stringify(value).slice(0, 80)}`] : []
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => credentialLeaks(v, `${at}[${i}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([k, v]) => [
    ...(['username', 'password', 'rtspUrl'].includes(k) ? [`${at}.${k}`] : []),
    ...credentialLeaks(v, `${at}.${k}`),
  ])
}

const LIST = '/api/nvrs'
const DETAIL = '/api/nvrs/nvr-1'
const CAMERAS = '/api/nvrs/nvr-1/cameras'

describe('ADMIN · recibe el usuario del NVR (formulario de edición); nunca la clave', () => {
  it('GET /api/nvrs y /:id: username presente; password ausente (ni cifrada) y sin rtspUrl legado', async () => {
    const app = await build('ADMIN')
    try {
      for (const url of [LIST, DETAIL, CAMERAS]) {
        const res = await app.inject({ method: 'GET', url })
        expect(res.statusCode).toBe(200)
        if (url !== CAMERAS) {
          const nvr = url === LIST ? res.json()[0] : res.json()
          expect(nvr.username).toBe(NVR_USER)
          expect('password' in nvr).toBe(false)
        }
        // La clave no sale en ninguna forma: ni cifrada ni en claro/url-encoded
        // dentro del rtspUrl legado de las cámaras.
        for (const secret of [encryptedPass, NVR_PASS, encodeURIComponent(NVR_PASS)]) expect(res.body).not.toContain(secret)
        expect(res.body).not.toContain('"rtspUrl"')
      }
    } finally {
      await app.close()
    }
  })
})

const NON_ADMIN: Array<{ role: Role; scope: Scope; label: string }> = [
  { role: 'SUPERVISOR', scope: 'none', label: 'SUPERVISOR' },
  { role: 'OPERATOR', scope: 'nvr', label: 'OPERATOR con permiso NVR-scoped' },
  { role: 'AUDITOR', scope: 'nvr', label: 'AUDITOR con permiso NVR-scoped' },
]

describe('no-ADMIN · ni usuario ni clave del NVR en ninguna clave ni string (escaneo profundo)', () => {
  for (const { role, scope, label } of NON_ADMIN) {
    it(`${label}: GET /api/nvrs, /:id y /:id/cameras sin credenciales; el resto del contrato intacto`, async () => {
      const app = await build(role, scope)
      try {
        const list = await app.inject({ method: 'GET', url: LIST })
        const detail = await app.inject({ method: 'GET', url: DETAIL })
        const cams = await app.inject({ method: 'GET', url: CAMERAS })
        for (const res of [list, detail, cams]) {
          expect(res.statusCode).toBe(200)
          expect(credentialLeaks(res.json())).toEqual([])
        }

        // Contrato restante sin cambios (IP/puertos: política de permisos, no ahora).
        const fromList = list.json()[0]
        const fromDetail = detail.json()
        for (const nvr of [fromList, fromDetail]) {
          expect(nvr).toMatchObject({ id: 'nvr-1', name: 'NVR Fixture', model: 'DS-FIXTURE', ipAddress: NVR_IP, port: 80, rtspPort: 554, channels: 4 })
        }
        expect(fromList.hdds).toHaveLength(1)
        expect(fromDetail.cameras).toHaveLength(1)
        // lastRtspError viejo: se conserva lo útil (canal y motivo), sin el usuario.
        const cam = fromDetail.cameras[0]
        expect(cam.lastRtspError).toContain('/Streaming/Channels/102')
        expect(cam.lastRtspError).toContain('Command failed')
        expect(cams.json().fromDb[0].lastRtspError).toContain('/Streaming/Channels/102')
        expect(cams.json().fromNvr).toHaveLength(1)
      } finally {
        await app.close()
      }
    })
  }

  it('OPERATOR camera-scoped: proyección mínima del listado y /:id/cameras sin credenciales', async () => {
    const app = await build('OPERATOR', 'camera')
    try {
      const list = await app.inject({ method: 'GET', url: LIST })
      expect(list.statusCode).toBe(200)
      expect(Object.keys(list.json()[0]).sort()).toEqual(['cameras', 'id', 'name'])
      const detail = await app.inject({ method: 'GET', url: DETAIL })
      expect(detail.statusCode).toBe(403) // NVR-wide: sigue exigiendo NVR-scoped
      const cams = await app.inject({ method: 'GET', url: CAMERAS })
      expect(cams.statusCode).toBe(200)
      expect(credentialLeaks(cams.json())).toEqual([])
    } finally {
      await app.close()
    }
  })
})
