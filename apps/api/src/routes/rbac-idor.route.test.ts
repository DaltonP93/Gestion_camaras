// Regresión de seguridad — IDOR / acceso cruzado (RBAC por recurso).
//
// Blinda el invariante RBAC ("un usuario sólo ve cámaras, grabaciones y PTZ
// permitidos"): un usuario NO-privilegiado (OPERATOR/AUDITOR) no puede acceder a
// una cámara ajena, a una grabación ajena, ni ejecutar PTZ sobre una cámara para
// la que no tiene permiso. Las rutas se ejercen vía fastify.inject con prisma
// falso; sólo se comprueban las ramas 403/404 (no se toca red ni NVR/MediaMTX).
//
// Credenciales/ids: 100% ficticios.
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { cameraRoutes } from './cameras'
import { recordingRoutes } from './recordings'

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'
type PermKey = 'canView' | 'canPtz' | 'canPlayback'
interface Grant { userId: string; cameraId: string; perm: PermKey }

// Cámaras del set de prueba (ambas existen; ptzEnabled para poder llegar al
// chequeo de permiso PTZ). cam-own = del usuario; cam-other = ajena.
const camerasById: Record<string, any> = {
  'cam-own': {
    id: 'cam-own', channel: 1, name: 'Cam Propia', ptzEnabled: true, active: true,
    mainCodec: 'H264', subCodec: 'H264',
    nvr: { id: 'nvr-1', name: 'NVR Test', ipAddress: '10.0.0.1', password: 'enc', model: 'X' },
  },
  'cam-other': {
    id: 'cam-other', channel: 9, name: 'Cam Ajena', ptzEnabled: true, active: true,
    mainCodec: 'H264', subCodec: 'H264',
    nvr: { id: 'nvr-1', name: 'NVR Test', ipAddress: '10.0.0.1', password: 'enc', model: 'X' },
  },
}

function makePrisma(grants: Grant[]) {
  return {
    camera: {
      findUnique: async ({ where }: any) => camerasById[where.id] ?? null,
      findMany: async () => [],
    },
    userPermission: {
      findFirst: async ({ where }: any) => {
        const permKey = (['canView', 'canPtz', 'canPlayback'] as PermKey[]).find((k) => where[k] === true)
        if (!permKey) return null
        const ok = grants.some((g) => g.userId === where.userId && g.cameraId === where.cameraId && g.perm === permKey)
        return ok ? { id: 'perm-1' } : null
      },
      findMany: async () => [],
    },
    auditLog: { create: async () => ({}) },
  } as any
}

async function buildCameras(user: { sub: string; role: Role }, grants: Grant[]): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (_roles: Role[]) => async (req: any) => { req.user = user })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', makePrisma(grants))
  await app.register(cameraRoutes, { prefix: '/api/cameras' })
  await app.ready()
  return app
}

async function buildRecordings(user: { sub: string; role: Role }, grants: Grant[]): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (_roles: Role[]) => async (req: any) => { req.user = user })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', makePrisma(grants))
  await app.register(recordingRoutes, { prefix: '/api/recordings' })
  await app.ready()
  return app
}

describe('IDOR — cámara ajena (GET /api/cameras/:id)', () => {
  it('OPERATOR sin permiso NO puede leer una cámara ajena ⇒ 403', async () => {
    const app = await buildCameras({ sub: 'op1', role: 'OPERATOR' }, [{ userId: 'op1', cameraId: 'cam-own', perm: 'canView' }])
    const res = await app.inject({ method: 'GET', url: '/api/cameras/cam-other' })
    expect(res.statusCode).toBe(403)
    expect(res.statusCode).not.toBe(200)
    await app.close()
  })

  it('AUDITOR sin permiso NO puede leer una cámara ajena ⇒ 403', async () => {
    const app = await buildCameras({ sub: 'aud1', role: 'AUDITOR' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/cameras/cam-other' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('control positivo: OPERATOR con canView SÍ lee su propia cámara ⇒ 200 (no es un 403 espurio)', async () => {
    const app = await buildCameras({ sub: 'op1', role: 'OPERATOR' }, [{ userId: 'op1', cameraId: 'cam-own', perm: 'canView' }])
    const res = await app.inject({ method: 'GET', url: '/api/cameras/cam-own' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('contraste: cámara inexistente ⇒ 404 (no 403), el 403 viene del permiso y no de un deny general', async () => {
    const app = await buildCameras({ sub: 'op1', role: 'OPERATOR' }, [{ userId: 'op1', cameraId: 'cam-own', perm: 'canView' }])
    const res = await app.inject({ method: 'GET', url: '/api/cameras/cam-inexistente' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('ADMIN accede a cualquier cámara ⇒ 200 (RBAC de rol, no IDOR)', async () => {
    const app = await buildCameras({ sub: 'adm1', role: 'ADMIN' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/cameras/cam-other' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('IDOR — PTZ no permitido (POST /api/cameras/:id/ptz)', () => {
  const ptzBody = { command: 'UP', speed: 50 }

  it('OPERATOR con canPtz SOLO en su cámara NO puede mover PTZ de una cámara ajena ⇒ 403', async () => {
    const app = await buildCameras({ sub: 'op1', role: 'OPERATOR' }, [{ userId: 'op1', cameraId: 'cam-own', perm: 'canPtz' }])
    const res = await app.inject({ method: 'POST', url: '/api/cameras/cam-other/ptz', payload: ptzBody })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('OPERATOR con canView pero SIN canPtz sobre su propia cámara NO puede mover PTZ ⇒ 403 (permiso PTZ específico)', async () => {
    const app = await buildCameras({ sub: 'op1', role: 'OPERATOR' }, [{ userId: 'op1', cameraId: 'cam-own', perm: 'canView' }])
    const res = await app.inject({ method: 'POST', url: '/api/cameras/cam-own/ptz', payload: ptzBody })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('AUDITOR nunca puede ejecutar PTZ ⇒ 403', async () => {
    const app = await buildCameras({ sub: 'aud1', role: 'AUDITOR' }, [{ userId: 'aud1', cameraId: 'cam-own', perm: 'canPtz' }])
    const res = await app.inject({ method: 'POST', url: '/api/cameras/cam-own/ptz', payload: ptzBody })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe('IDOR — grabación/evento ajeno (GET /api/recordings/search)', () => {
  const qs = (cameraId: string) =>
    `/api/recordings/search?cameraId=${cameraId}&startTime=${encodeURIComponent('2026-01-01T00:00:00.000Z')}&endTime=${encodeURIComponent('2026-01-01T01:00:00.000Z')}`

  it('AUDITOR sin canPlayback NO puede buscar grabaciones de una cámara ajena ⇒ 403', async () => {
    const app = await buildRecordings({ sub: 'aud1', role: 'AUDITOR' }, [{ userId: 'aud1', cameraId: 'cam-own', perm: 'canPlayback' }])
    const res = await app.inject({ method: 'GET', url: qs('cam-other') })
    expect(res.statusCode).toBe(403)
    expect(res.statusCode).not.toBe(200)
    await app.close()
  })

  it('OPERATOR no tiene acceso a grabaciones ⇒ 403', async () => {
    const app = await buildRecordings({ sub: 'op1', role: 'OPERATOR' }, [])
    const res = await app.inject({ method: 'GET', url: qs('cam-other') })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('contraste: AUDITOR sobre cámara inexistente ⇒ 404 (no 403 general): el flujo llega al chequeo de recurso', async () => {
    const app = await buildRecordings({ sub: 'aud1', role: 'AUDITOR' }, [])
    const res = await app.inject({ method: 'GET', url: qs('cam-inexistente') })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
