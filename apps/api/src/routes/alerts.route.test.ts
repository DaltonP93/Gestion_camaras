// Regresión de seguridad — scope de ALERTAS por permiso de cámara (canView) (DEV14).
//
// Blinda el nuevo invariante RBAC para alertas/eventos:
//   ADMIN          → ve/acciona TODAS las alertas.
//   resto de roles → sólo alertas de sus cámaras canView, MÁS las alertas sin
//                    cameraId (sistema/NVR), que siguen visibles para todos.
//
// Se ejercen las rutas vía fastify.inject con un prisma falso; ids/credenciales
// 100% ficticios. Además se prueba el broadcast WS scopeado (broadcastAlertScoped)
// de forma aislada con sockets simulados.
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { alertRoutes } from './alerts'
import { broadcastAlertScoped, wsClients } from './websocket'

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

// ── Dataset de alertas de prueba ─────────────────────────────────────────────
// op1/sup1 tienen canView SÓLO sobre 'cam-a'. 'cam-b' es ajena.
//   a1: cam-a, unread, HIGH        (visible a op1)
//   a2: cam-b, unread, LOW         (NO visible a op1)
//   a3: cameraId=null (sistema), unread, CRITICAL  (visible a todos)
//   a4: cam-a, resolved+read, MEDIUM  (visible a op1)
function freshAlerts(): any[] {
  return [
    { id: 'a1', cameraId: 'cam-a', nvrId: 'nvr-1', severity: 'HIGH',     resolved: false, readAt: null,       resolvedAt: null, createdAt: new Date('2026-09-01T00:00:04Z') },
    { id: 'a2', cameraId: 'cam-b', nvrId: 'nvr-1', severity: 'LOW',      resolved: false, readAt: null,       resolvedAt: null, createdAt: new Date('2026-09-01T00:00:03Z') },
    { id: 'a3', cameraId: null,    nvrId: 'nvr-1', severity: 'CRITICAL', resolved: false, readAt: null,       resolvedAt: null, createdAt: new Date('2026-09-01T00:00:02Z') },
    { id: 'a4', cameraId: 'cam-a', nvrId: 'nvr-1', severity: 'MEDIUM',   resolved: true,  readAt: new Date(), resolvedAt: new Date(), createdAt: new Date('2026-09-01T00:00:01Z') },
  ]
}

// Matcher recursivo del subconjunto de Prisma.where que produce el código:
//   AND[], OR[], igualdad directa, null, { in: [] }, { not: null }.
function matchWhere(alert: any, where: any): boolean {
  if (!where) return true
  for (const key of Object.keys(where)) {
    const cond = (where as any)[key]
    if (key === 'AND') { if (!(cond as any[]).every((c) => matchWhere(alert, c))) return false; continue }
    if (key === 'OR')  { if (!(cond as any[]).some((c) => matchWhere(alert, c))) return false; continue }
    const val = alert[key]
    if (cond === null) { if (val !== null && val !== undefined) return false; continue }
    if (cond && typeof cond === 'object') {
      if ('in' in cond)  { if (!(cond.in as any[]).includes(val)) return false }
      if ('not' in cond) {
        if (cond.not === null) { if (val === null || val === undefined) return false }
        else if (val === cond.not) return false
      }
      continue
    }
    if (val !== cond) return false
  }
  return true
}

interface Grant { userId: string; cameraId: string }

function makePrisma(alerts: any[], grants: Grant[], adminUserIds: string[] = []) {
  return {
    alert: {
      count: async ({ where }: any) => alerts.filter((a) => matchWhere(a, where)).length,
      findMany: async ({ where, skip = 0, take = 50 }: any) =>
        alerts.filter((a) => matchWhere(a, where)).slice(skip, skip + take),
      findUnique: async ({ where }: any) => alerts.find((a) => a.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const a = alerts.find((x) => x.id === where.id)
        if (!a) throw new Error('not found')
        Object.assign(a, data)
        return a
      },
      updateMany: async ({ where, data }: any) => {
        const hit = alerts.filter((a) => matchWhere(a, where))
        hit.forEach((a) => Object.assign(a, data))
        return { count: hit.length }
      },
    },
    userPermission: {
      findMany: async ({ where }: any) =>
        grants
          .filter((g) => {
            // userId puede venir como string (getViewableCameraIds) o { in: [...] } (broadcast)
            const uidOk = where.userId?.in ? where.userId.in.includes(g.userId) : g.userId === where.userId
            // cameraId: { not: null } (getViewableCameraIds) ⇒ todos los grants tienen cámara;
            // string (broadcast scopeado) ⇒ igualdad; undefined ⇒ sin filtro.
            const camOk =
              where.cameraId === undefined ? true
              : (where.cameraId && typeof where.cameraId === 'object') ? g.cameraId != null
              : g.cameraId === where.cameraId
            return uidOk && camOk
          })
          .map((g) => ({ cameraId: g.cameraId, userId: g.userId })),
    },
    user: {
      findMany: async ({ where }: any) =>
        adminUserIds
          .filter((id) => (where.id?.in ? where.id.in.includes(id) : true))
          .map((id) => ({ id })),
    },
  } as any
}

async function buildApp(user: { sub: string; role: Role }, prisma: any): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (_roles: Role[]) => async (req: any) => { req.user = user })
  app.decorate('requireStepUp', async () => {})
  app.decorate('prisma', prisma)
  await app.register(alertRoutes, { prefix: '/api/alerts' })
  await app.ready()
  return app
}

const OP = { sub: 'op1', role: 'OPERATOR' as Role }
const SUP = { sub: 'sup1', role: 'SUPERVISOR' as Role }
const ADMIN = { sub: 'adm1', role: 'ADMIN' as Role }
const opGrants: Grant[] = [{ userId: 'op1', cameraId: 'cam-a' }]
const supGrants: Grant[] = [{ userId: 'sup1', cameraId: 'cam-a' }]

describe('GET /api/alerts — listado scopeado por cámara', () => {
  it('(a) OPERATOR NO ve la alerta de una cámara sin canView (cam-b)', async () => {
    const app = await buildApp(OP, makePrisma(freshAlerts(), opGrants))
    const res = await app.inject({ method: 'GET', url: '/api/alerts?status=all' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const ids = body.items.map((i: any) => i.id)
    expect(ids).not.toContain('a2')        // cam-b ajena
    expect(body.total).toBe(3)
    await app.close()
  })

  it('(b) OPERATOR SÍ ve las de su cámara (cam-a) y las de cameraId=null', async () => {
    const app = await buildApp(OP, makePrisma(freshAlerts(), opGrants))
    const res = await app.inject({ method: 'GET', url: '/api/alerts?status=all' })
    const ids = res.json().items.map((i: any) => i.id).sort()
    expect(ids).toEqual(['a1', 'a3', 'a4'])  // cam-a (a1,a4) + sistema (a3)
    await app.close()
  })

  it('(c) ADMIN ve TODAS las alertas', async () => {
    const app = await buildApp(ADMIN, makePrisma(freshAlerts(), []))
    const res = await app.inject({ method: 'GET', url: '/api/alerts?status=all' })
    expect(res.json().total).toBe(4)
    await app.close()
  })

  it('OPERATOR sin permisos sólo ve las alertas de sistema (cameraId=null)', async () => {
    const app = await buildApp(OP, makePrisma(freshAlerts(), []))
    const ids = (await app.inject({ method: 'GET', url: '/api/alerts?status=all' })).json().items.map((i: any) => i.id)
    expect(ids).toEqual(['a3'])
    await app.close()
  })
})

describe('conteos scopeados (summary / unread-count)', () => {
  it('OPERATOR: summary y unread cuentan sólo lo visible (cam-a + null)', async () => {
    const app = await buildApp(OP, makePrisma(freshAlerts(), opGrants))
    const summary = (await app.inject({ method: 'GET', url: '/api/alerts/summary' })).json()
    // unread visibles: a1 (cam-a) + a3 (null) = 2  (a2 cam-b excluida)
    expect(summary.unread).toBe(2)
    expect(summary.resolved).toBe(1)          // a4
    expect(summary.criticalPending).toBe(2)   // a1 HIGH + a3 CRITICAL
    const uc = (await app.inject({ method: 'GET', url: '/api/alerts/unread-count' })).json()
    expect(uc.count).toBe(2)
    await app.close()
  })

  it('ADMIN: unread cuenta todas (a1,a2,a3)', async () => {
    const app = await buildApp(ADMIN, makePrisma(freshAlerts(), []))
    const summary = (await app.inject({ method: 'GET', url: '/api/alerts/summary' })).json()
    expect(summary.unread).toBe(3)
    const uc = (await app.inject({ method: 'GET', url: '/api/alerts/unread-count' })).json()
    expect(uc.count).toBe(3)
    await app.close()
  })
})

describe('(d) mutaciones fuera de scope ⇒ 403 / 404', () => {
  it('OPERATOR NO puede marcar leída una alerta ajena (cam-b) ⇒ 403', async () => {
    const app = await buildApp(OP, makePrisma(freshAlerts(), opGrants))
    const res = await app.inject({ method: 'POST', url: '/api/alerts/a2/read' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('control positivo: OPERATOR SÍ marca leída una de su cámara ⇒ 200', async () => {
    const app = await buildApp(OP, makePrisma(freshAlerts(), opGrants))
    const res = await app.inject({ method: 'POST', url: '/api/alerts/a1/read' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('OPERATOR marca leída una alerta de sistema (null) ⇒ 200', async () => {
    const app = await buildApp(OP, makePrisma(freshAlerts(), opGrants))
    const res = await app.inject({ method: 'POST', url: '/api/alerts/a3/read' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('contraste: alerta inexistente ⇒ 404 (no 403)', async () => {
    const app = await buildApp(OP, makePrisma(freshAlerts(), opGrants))
    const res = await app.inject({ method: 'POST', url: '/api/alerts/nope/read' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('SUPERVISOR NO puede resolver una alerta ajena (cam-b) ⇒ 403', async () => {
    const app = await buildApp(SUP, makePrisma(freshAlerts(), supGrants))
    const res = await app.inject({ method: 'PUT', url: '/api/alerts/a2/resolve' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('SUPERVISOR SÍ resuelve una de su cámara ⇒ 200', async () => {
    const app = await buildApp(SUP, makePrisma(freshAlerts(), supGrants))
    const res = await app.inject({ method: 'PUT', url: '/api/alerts/a1/resolve' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('ADMIN resuelve cualquier alerta (cam-b) ⇒ 200', async () => {
    const app = await buildApp(ADMIN, makePrisma(freshAlerts(), []))
    const res = await app.inject({ method: 'PUT', url: '/api/alerts/a2/resolve' })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('read-all sólo afecta las alertas visibles del usuario', async () => {
    const alerts = freshAlerts()
    const app = await buildApp(OP, makePrisma(alerts, opGrants))
    const res = await app.inject({ method: 'POST', url: '/api/alerts/read-all' })
    // unread visibles = a1 (cam-a) + a3 (null) = 2; a2 (cam-b) NO se toca
    expect(res.json().updated).toBe(2)
    expect(alerts.find((a) => a.id === 'a2')!.readAt).toBeNull()
    await app.close()
  })
})

// ── (e) broadcast WS scopeado ────────────────────────────────────────────────
describe('(e) broadcastAlertScoped — WS filtra por canView', () => {
  beforeEach(() => { wsClients.clear() })

  function fakeSocket() {
    const sent: string[] = []
    return { readyState: 1, send: (m: string) => sent.push(m), sent } as any
  }

  it('alerta de cámara concreta: NO llega a un usuario sin canView', async () => {
    const opSock = fakeSocket()   // op1 → canView cam-a
    const otherSock = fakeSocket() // other1 → sin permisos
    wsClients.set('op1', new Set([opSock]))
    wsClients.set('other1', new Set([otherSock]))
    const prisma = makePrisma([], [{ userId: 'op1', cameraId: 'cam-a' }], [])
    await broadcastAlertScoped(prisma, 'cam-a', { type: 'alert', alert: { id: 'x', cameraId: 'cam-a' } })
    expect(opSock.sent.length).toBe(1)
    expect(otherSock.sent.length).toBe(0)   // sin canView → no recibe
  })

  it('ADMIN conectado recibe la alerta de cámara aunque no tenga permiso explícito', async () => {
    const admSock = fakeSocket()
    wsClients.set('adm1', new Set([admSock]))
    const prisma = makePrisma([], [], ['adm1'])
    await broadcastAlertScoped(prisma, 'cam-a', { type: 'alert', alert: { id: 'x', cameraId: 'cam-a' } })
    expect(admSock.sent.length).toBe(1)
  })

  it('alerta de sistema (cameraId=null) → broadcast global a todos', async () => {
    const s1 = fakeSocket(); const s2 = fakeSocket()
    wsClients.set('op1', new Set([s1]))
    wsClients.set('other1', new Set([s2]))
    const prisma = makePrisma([], [], [])
    await broadcastAlertScoped(prisma, null, { type: 'alert', alert: { id: 'sys' } })
    expect(s1.sent.length).toBe(1)
    expect(s2.sent.length).toBe(1)
  })
})
