// GET /api/auth/me — exposición MÍNIMA contra PostgreSQL REAL y EFÍMERO.
//
// Defecto que blinda: `userMeSelect` hacía `permissions: { include: { nvr: true,
// camera: true } }`, así que /me devolvía a CUALQUIER rol la fila completa de cada
// NVR/cámara asignados (usuario y clave cifrada del NVR, IP, puertos, rtspUrl
// legado…). El web persistía ese objeto en localStorage ('visioncore-auth').
//
// Por qué Postgres real (no prisma falso): lo que se prueba es el `select` de
// Prisma — qué columnas salen de verdad de la DB. Un prisma falso devolvería lo que
// el test le diga. El schema se crea con `prisma db push` del schema.prisma
// versionado, dentro de un SCHEMA aislado (`t_<rand>`) que se borra al terminar.
// El guard exige loopback + PG_TEST_DISPOSABLE=1 ANTES de conectar.
//
// Datos 100% ficticios: IPs TEST-NET (RFC 5737), credenciales inventadas.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { authRoutes } from './auth'
import { assertPgRequiredOrSkip, buildScopedUrl } from '../services/media/pg-real-harness'
import { assertDestructiveTestAllowed } from '../services/media/test-host-guard'

const HAVE_PG = assertPgRequiredOrSkip()
const TEST_URL = process.env.DATABASE_URL_TEST ?? ''

// ── Valores ficticios que NUNCA deben aparecer en la respuesta ──
const NVR_USER = 'nvr-fixture-svc'
const NVR_PASS_ENC = 'ENCv1-fixture-ciphertext-0000'
const NVR_IP = '192.0.2.10'
const CAM_IP = '198.51.100.20'
const CAM_RTSP_LEGACY = `rtsp://${NVR_USER}:FixturePass0@${NVR_IP}:554/Streaming/Channels/101`
const FORBIDDEN_VALUES = [NVR_USER, NVR_PASS_ENC, NVR_IP, CAM_IP, 'FixturePass0']

// Claves sensibles que no pueden aparecer a NINGUNA profundidad. `username` sólo se
// admite en la raíz (es el usuario de la propia cuenta, no el del NVR).
const FORBIDDEN_KEYS = new Set([
  'password', 'passwordHash', 'passwordHistory', 'passwordResetToken',
  'twoFactorSecret', 'twoFactorBackupCodes',
  'ipAddress', 'port', 'rtspPort', 'httpPort', 'sdkPort', 'managementPort',
  'rtspUrl', 'mainRtspPath', 'subRtspPath',
])

/** Recorre TODO el JSON y devuelve las rutas de claves sensibles encontradas. */
function findSensitiveKeys(value: unknown, at = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSensitiveKeys(v, `${at}[${i}]`))
  if (value === null || typeof value !== 'object') return []
  const hits: string[] = []
  for (const [k, v] of Object.entries(value)) {
    const here = `${at}.${k}`
    if (FORBIDDEN_KEYS.has(k) || (k === 'username' && at !== '$')) hits.push(here)
    hits.push(...findSensitiveKeys(v, here))
  }
  return hits
}

// Lo ÚNICO que el web lee de /me (authStore, Sidebar, ProfilePage, StepUpModal,
// guards de rol). Cualquier otra clave en la raíz es exposición de más.
const ME_KEYS = [
  'avatarUrl', 'email', 'featurePermissions', 'fullName', 'id', 'phone', 'role',
  'twoFactorEnabled', 'username',
]
const FEATURE_KEYS = [
  'canDownloadRecordings', 'canManageAppearance', 'canManageCameras', 'canManageNVRs',
  'canManageSettings', 'canManageUsers', 'canManageViews', 'canResolveAlerts',
  'canRestartStreams', 'canTranscode', 'canViewAlerts', 'canViewDashboard',
  'canViewDiagnostics', 'canViewLive', 'canViewRecordings',
]

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'
const ROLES: Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR']

describe.skipIf(!HAVE_PG)('GET /api/auth/me · sin credenciales ni direcciones de NVR/cámara (Postgres REAL)', () => {
  let prisma: PrismaClient
  let schema = ''
  const userIdByRole = {} as Record<Role, string>

  beforeAll(async () => {
    // Guard ANTES de conectar o crear/borrar nada.
    assertDestructiveTestAllowed(TEST_URL, 'DATABASE_URL_TEST', 'PG_TEST_DISPOSABLE')
    schema = `t_me_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const scopedUrl = buildScopedUrl(TEST_URL, schema)

    // Schema REAL (schema.prisma versionado) dentro del schema aislado.
    execFileSync(process.execPath, [
      require.resolve('prisma/build/index.js'), 'db', 'push',
      '--skip-generate', '--accept-data-loss',
      '--schema', path.resolve(process.cwd(), '../../prisma/schema.prisma'),
    ], { env: { ...process.env, DATABASE_URL: scopedUrl }, stdio: 'pipe' })

    prisma = new PrismaClient({ datasources: { db: { url: scopedUrl } } })
    const nvr = await prisma.nVR.create({
      data: {
        name: 'NVR Fixture', model: 'DS-FIXTURE', ipAddress: NVR_IP, port: 80, rtspPort: 554,
        sdkPort: 8000, username: NVR_USER, password: NVR_PASS_ENC,
      },
    })
    const cam = await prisma.camera.create({
      data: {
        nvrId: nvr.id, channel: 1, name: 'Cam Fixture', ipAddress: CAM_IP, managementPort: 8000,
        mainRtspPath: '/Streaming/Channels/101', subRtspPath: '/Streaming/Channels/102',
        rtspUrl: CAM_RTSP_LEGACY,
      },
    })
    for (const role of ROLES) {
      const u = await prisma.user.create({
        data: {
          username: `fixture-${role.toLowerCase()}`, email: `${role.toLowerCase()}@example.test`,
          passwordHash: 'not-a-real-hash', fullName: `Fixture ${role}`, role,
          twoFactorSecret: 'FIXTURESECRET', phone: '+000 000',
          // Permiso a nivel NVR y a nivel cámara: ambos traían la fila completa.
          permissions: {
            create: [
              { nvrId: nvr.id, canView: true },
              { nvrId: nvr.id, cameraId: cam.id, canView: true, canPlayback: true },
            ],
          },
          // Override explícito (sólo efectivo para no-ADMIN): debe seguir resolviéndose.
          featurePermissions: { create: { canViewRecordings: true } },
        },
      })
      userIdByRole[role] = u.id
    }
  }, 60_000)

  afterAll(async () => {
    if (!prisma) return
    try { await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch { /* noop */ }
    await prisma.$disconnect()
  })

  async function buildApp(role: Role): Promise<FastifyInstance> {
    const app = Fastify()
    app.decorate('authenticate', async (req: any) => {
      req.user = { sub: userIdByRole[role], username: `fixture-${role.toLowerCase()}`, role }
    })
    app.decorate('prisma', prisma as any)
    await app.register(authRoutes, { prefix: '/api/auth' })
    await app.ready()
    return app
  }

  for (const role of ROLES) {
    it(`${role}: ninguna clave sensible a ninguna profundidad y ningún valor del NVR/cámara`, async () => {
      const app = await buildApp(role)
      try {
        const res = await app.inject({ method: 'GET', url: '/api/auth/me' })
        expect(res.statusCode).toBe(200)
        const body = res.json()

        expect(findSensitiveKeys(body)).toEqual([])
        for (const v of FORBIDDEN_VALUES) expect(res.body).not.toContain(v)
        // Ni rastro de permisos granulares con relaciones NVR/cámara.
        expect(body).not.toHaveProperty('permissions')
      } finally {
        await app.close()
      }
    })

    it(`${role}: allowlist exacta de lo que usa el web, con permisos de funcionalidad resueltos`, async () => {
      const app = await buildApp(role)
      try {
        const body = (await app.inject({ method: 'GET', url: '/api/auth/me' })).json()
        expect(Object.keys(body).sort()).toEqual(ME_KEYS)
        expect(body.id).toBe(userIdByRole[role])
        expect(body.role).toBe(role)
        expect(body.username).toBe(`fixture-${role.toLowerCase()}`)
        expect(body.phone).toBe('+000 000')
        // Sólo flags booleanos (sin id/userId de la fila).
        expect(Object.keys(body.featurePermissions).sort()).toEqual(FEATURE_KEYS)
        // El override de DB se respeta para no-ADMIN (AUDITOR/SUPERVISOR ya lo
        // tienen por defecto; OPERATOR sólo por el override). ADMIN: todo true.
        expect(body.featurePermissions.canViewRecordings).toBe(true)
        if (role === 'OPERATOR') expect(body.featurePermissions.canManageUsers).toBe(false)
        if (role === 'ADMIN') expect(Object.values(body.featurePermissions).every((v) => v === true)).toBe(true)
      } finally {
        await app.close()
      }
    })
  }
})
