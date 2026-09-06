// apps/api/src/routes/nvr-ssrf-authz.route.test.ts
//
// Regresión de seguridad para dos hallazgos P1 en las rutas de NVR:
//
//   P1-b (SSRF): al guardar/usar un NVR, el host se valida contra metadatos cloud
//   (169.254.169.254), loopback (127.0.0.1) y demás destinos no-LAN. Una IP LAN
//   privada (10.x / 192.168.x) SÍ se acepta. Se ejerce POST /test-connection: el
//   host bloqueado ⇒ 400 SSRF_BLOCKED antes de tocar red; la IP LAN pasa el guard
//   y sólo se detiene en la validación de contraseña (PASSWORD_MISSING) — probando
//   que no fue bloqueada por SSRF. Nunca se abre una conexión real.
//
//   P1-c (authz): `userCanAccessNvr` exige `canView=true`. Un no-ADMIN con una fila
//   de permiso pero SIN canView recibe 403; con canView pasa; ADMIN pasa siempre.
//   Se ejerce GET /api/nvrs/:id (no toca red).
//
// Credenciales/ids/IPs 100% ficticios (LAN: 10.x/192.168.x; bloqueo: 169.254.169.254).
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { nvrRoutes } from './nvr'

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'
interface Grant { userId: string; nvrId: string; canView: boolean }

const nvrsById: Record<string, any> = {
  'nvr-1': { id: 'nvr-1', name: 'NVR Test', ipAddress: '10.0.0.9', port: 80, username: 'svc', password: 'enc', channels: 4, cameras: [], hdds: [] },
}

function makePrisma(grants: Grant[]) {
  return {
    nVR: {
      findUnique: async ({ where }: any) => nvrsById[where.id] ?? null,
      findMany: async () => [],
      create: async ({ data }: any) => ({ id: 'nvr-new', ...data }),
      update: async ({ where, data }: any) => ({ ...(nvrsById[where.id] ?? {}), ...data }),
    },
    userPermission: {
      // Emula el filtro real de la DB: aplica el OR sobre el nvr y, si el where pide
      // canView:true, filtra por canView. Así, si alguien revierte el endurecimiento
      // (quitando canView:true del where), una fila canView=false volvería a matchear
      // y el test negativo fallaría — exactamente lo que queremos blindar.
      findFirst: async ({ where }: any) => {
        const targetNvr = where.OR ? where.OR.find((c: any) => c.nvrId)?.nvrId : where.nvrId
        let matched = grants.filter((g) => g.userId === where.userId && g.nvrId === targetNvr)
        if (where.canView === true) matched = matched.filter((g) => g.canView === true)
        return matched.length ? { id: 'perm-1' } : null
      },
      findMany: async () => [],
    },
    auditLog: { create: async () => ({}) },
  } as any
}

async function build(user: { sub: string; role: Role }, grants: Grant[]): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (_roles: Role[]) => async (req: any) => { req.user = user })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', makePrisma(grants))
  await app.register(nvrRoutes, { prefix: '/api/nvrs' })
  await app.ready()
  return app
}

const ADMIN = { sub: 'adm1', role: 'ADMIN' as const }

describe('P1-b SSRF — POST /api/nvrs/test-connection valida el host del NVR', () => {
  it('RECHAZA metadatos cloud 169.254.169.254 ⇒ 400 SSRF_BLOCKED', async () => {
    const app = await build(ADMIN, [])
    const res = await app.inject({
      method: 'POST', url: '/api/nvrs/test-connection',
      payload: { ipAddress: '169.254.169.254', port: 80, username: 'svc', password: 'secreta' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().errorCode).toBe('SSRF_BLOCKED')
    await app.close()
  })

  it('RECHAZA loopback 127.0.0.1 ⇒ 400 SSRF_BLOCKED', async () => {
    const app = await build(ADMIN, [])
    const res = await app.inject({
      method: 'POST', url: '/api/nvrs/test-connection',
      payload: { ipAddress: '127.0.0.1', port: 80, username: 'svc', password: 'secreta' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().errorCode).toBe('SSRF_BLOCKED')
    await app.close()
  })

  it('ACEPTA una IP LAN privada (10.0.0.9): el guard no bloquea — se detiene en PASSWORD_MISSING', async () => {
    const app = await build(ADMIN, [])
    const res = await app.inject({
      method: 'POST', url: '/api/nvrs/test-connection',
      payload: { ipAddress: '10.0.0.9', port: 80, username: 'svc' }, // sin password a propósito
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().errorCode).toBe('PASSWORD_MISSING') // NO SSRF_BLOCKED
    await app.close()
  })

  it('ACEPTA otra IP LAN privada (192.168.10.20) — no SSRF_BLOCKED', async () => {
    const app = await build(ADMIN, [])
    const res = await app.inject({
      method: 'POST', url: '/api/nvrs/test-connection',
      payload: { ipAddress: '192.168.10.20', port: 80, username: 'svc' },
    })
    expect(res.json().errorCode).not.toBe('SSRF_BLOCKED')
    await app.close()
  })
})

describe('P1-c authz — GET /api/nvrs/:id exige canView (no-ADMIN)', () => {
  it('OPERATOR con fila de permiso pero canView=false ⇒ 403', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [{ userId: 'op1', nvrId: 'nvr-1', canView: false }])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('OPERATOR sin ningún permiso ⇒ 403', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('control positivo: OPERATOR con canView=true ⇒ 200', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [{ userId: 'op1', nvrId: 'nvr-1', canView: true }])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('ADMIN accede siempre, sin permisos por recurso ⇒ 200', async () => {
    const app = await build(ADMIN, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('SUPERVISOR accede siempre ⇒ 200 (comportamiento sin cambios)', async () => {
    const app = await build({ sub: 'sup1', role: 'SUPERVISOR' }, [])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-1' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('contraste: con canView pero NVR inexistente ⇒ 404 (el 403 viene del permiso, no de un deny general)', async () => {
    const app = await build({ sub: 'op1', role: 'OPERATOR' }, [{ userId: 'op1', nvrId: 'nvr-x', canView: true }])
    const res = await app.inject({ method: 'GET', url: '/api/nvrs/nvr-x' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
