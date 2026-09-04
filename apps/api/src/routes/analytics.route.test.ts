// Regresión de seguridad — scope de ANALÍTICA por permiso de cámara (canView) (DEV15).
//
// Blinda el invariante RBAC para los eventos/resumen/frame de analítica, consistente
// con el scope de alertas ya mergeado (alerts.route.test.ts):
//   ADMIN          → ve TODOS los eventos / resumen global / cualquier frame.
//   resto de roles → sólo eventos de sus cámaras `canView`.
// A diferencia de las alertas, AnalyticsEvent.cameraId es REQUERIDO: no hay caso
// `cameraId=null` visible para todos.
//
// Rutas ejercidas vía fastify.inject con un prisma falso; ids/credenciales ficticios.
import { describe, it, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { analyticsRoutes } from './analytics'

type Role = 'ADMIN' | 'SUPERVISOR' | 'AUDITOR'

// ── Dataset de eventos de prueba ─────────────────────────────────────────────
// sup1/aud1 tienen canView SÓLO sobre 'cam-a'. 'cam-b' es ajena.
//   e1: cam-a, person,         className person
//   e2: cam-b, vehicle,        className car     (NO visible a no-admin sin cam-b)
//   e3: cam-a, zone_intrusion, className person
function freshEvents(): any[] {
  const t = new Date('2026-09-03T12:00:00Z')
  return [
    { id: 'e1', cameraId: 'cam-a', type: 'person',         className: 'person', confidence: 0.9, trackId: 1, zoneName: null, direction: null, incidentId: null, snapshotUrl: '/u/e1.jpg', occurredAt: t },
    { id: 'e2', cameraId: 'cam-b', type: 'vehicle',        className: 'car',    confidence: 0.8, trackId: 2, zoneName: null, direction: null, incidentId: null, snapshotUrl: null,       occurredAt: t },
    { id: 'e3', cameraId: 'cam-a', type: 'zone_intrusion', className: 'person', confidence: 0.7, trackId: 3, zoneName: 'z1',  direction: null, incidentId: 'i1',  snapshotUrl: '/u/e3.jpg', occurredAt: t },
  ]
}

// Matcher del subconjunto de Prisma.where que produce el código de analytics:
//   AND[], igualdad directa, { in: [] }, { gte/lte/gt/lt }, { not: null }, { contains }.
function matchWhere(ev: any, where: any): boolean {
  if (!where) return true
  for (const key of Object.keys(where)) {
    const cond = (where as any)[key]
    if (key === 'AND') { if (!(cond as any[]).every((c) => matchWhere(ev, c))) return false; continue }
    if (key === 'OR')  { if (!(cond as any[]).some((c) => matchWhere(ev, c))) return false; continue }
    const val = ev[key]
    if (cond === null) { if (val !== null && val !== undefined) return false; continue }
    if (cond && typeof cond === 'object') {
      if ('in' in cond)  { if (!(cond.in as any[]).includes(val)) return false }
      if ('not' in cond) { if (cond.not === null ? (val === null || val === undefined) : val === cond.not) return false }
      if ('contains' in cond) { if (typeof val !== 'string' || !val.toLowerCase().includes(String(cond.contains).toLowerCase())) return false }
      const cmp = (v: any) => (v instanceof Date ? v.getTime() : v)
      if ('gte' in cond) { if (cmp(val) < cmp(cond.gte)) return false }
      if ('lte' in cond) { if (cmp(val) > cmp(cond.lte)) return false }
      if ('gt'  in cond) { if (cmp(val) <= cmp(cond.gt)) return false }
      if ('lt'  in cond) { if (cmp(val) >= cmp(cond.lt)) return false }
      continue
    }
    if (val !== cond) return false
  }
  return true
}

interface Grant { userId: string; cameraId: string }
const CAM_NAMES: Record<string, string> = { 'cam-a': 'Cámara A', 'cam-b': 'Cámara B' }

function makePrisma(events: any[], grants: Grant[], cfgEnabled: Record<string, boolean> = {}) {
  return {
    analyticsEvent: {
      findMany: async ({ where, skip = 0, take = 50 }: any) =>
        events.filter((e) => matchWhere(e, where)).slice(skip, skip + take),
      count: async ({ where }: any) => events.filter((e) => matchWhere(e, where)).length,
      groupBy: async ({ by, where }: any) => {
        const rows = events.filter((e) => matchWhere(e, where))
        const map = new Map<string, any>()
        for (const e of rows) {
          const key = by.map((f: string) => String(e[f])).join('|')
          if (!map.has(key)) {
            const obj: any = { _count: { _all: 0 } }
            by.forEach((f: string) => { obj[f] = e[f] })
            map.set(key, obj)
          }
          map.get(key)._count._all++
        }
        return [...map.values()]
      },
    },
    // series / distinct / heatmap: no se asertan aquí (dependen de SQL crudo);
    // devolver [] mantiene los KPIs derivados de count/groupBy intactos.
    $queryRaw: async () => [] as any[],
    camera: {
      findMany: async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? []
        return ids.map((id) => ({ id, name: CAM_NAMES[id] ?? id, nvr: { name: 'NVR-1' } }))
      },
    },
    cameraAnalyticsConfig: {
      findUnique: async ({ where }: any) =>
        where.cameraId in cfgEnabled ? { enabled: cfgEnabled[where.cameraId] } : null,
    },
    userPermission: {
      findMany: async ({ where }: any) =>
        grants
          .filter((g) => g.userId === where.userId && g.cameraId != null)
          .map((g) => ({ cameraId: g.cameraId })),
    },
  } as any
}

async function buildApp(user: { sub: string; role: Role }, prisma: any): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = user })
  app.decorate('authorize', (_roles: Role[]) => async (req: any) => { req.user = user })
  app.decorate('prisma', prisma)
  // El plugin usa server.redis (opcional) y helpers de registry; con undefined
  // cae al backend de memoria — suficiente para ejercitar las rutas de consulta.
  await app.register(analyticsRoutes, { prefix: '/api/analytics' })
  await app.ready()
  return app
}

const SUP = { sub: 'sup1', role: 'SUPERVISOR' as Role }
const AUD = { sub: 'aud1', role: 'AUDITOR' as Role }
const ADMIN = { sub: 'adm1', role: 'ADMIN' as Role }
const supGrants: Grant[] = [{ userId: 'sup1', cameraId: 'cam-a' }]
const audGrants: Grant[] = [{ userId: 'aud1', cameraId: 'cam-a' }]

describe('GET /api/analytics/events — listado scopeado por cámara (canView)', () => {
  it('(a) no-admin NO ve eventos de una cámara sin canView (cam-b)', async () => {
    const app = await buildApp(SUP, makePrisma(freshEvents(), supGrants))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/events' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const ids = body.events.map((e: any) => e.id)
    expect(ids).not.toContain('e2')      // cam-b ajena
    expect(body.total).toBe(2)           // el conteo usa el MISMO where scopeado
    await app.close()
  })

  it('(b) no-admin SÍ ve los eventos de su cámara (cam-a)', async () => {
    const app = await buildApp(SUP, makePrisma(freshEvents(), supGrants))
    const ids = (await app.inject({ method: 'GET', url: '/api/analytics/events' })).json().events.map((e: any) => e.id).sort()
    expect(ids).toEqual(['e1', 'e3'])
    await app.close()
  })

  it('(c) ADMIN ve TODOS los eventos', async () => {
    const app = await buildApp(ADMIN, makePrisma(freshEvents(), []))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/events' })
    expect(res.json().total).toBe(3)
    await app.close()
  })

  it('AUDITOR sin ninguna cámara canView ve 0 eventos', async () => {
    const app = await buildApp(AUD, makePrisma(freshEvents(), []))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/events' })
    expect(res.json().total).toBe(0)
    expect(res.json().events).toEqual([])
    await app.close()
  })

  it('(f) no-admin pidiendo ?cameraId=<ajena> ⇒ resultado vacío (intersección con canView)', async () => {
    const app = await buildApp(SUP, makePrisma(freshEvents(), supGrants))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/events?cameraId=cam-b' })
    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe(0)
    await app.close()
  })

  it('control positivo: no-admin pidiendo ?cameraId=<propia> ve sólo esa cámara', async () => {
    const app = await buildApp(SUP, makePrisma(freshEvents(), supGrants))
    const ids = (await app.inject({ method: 'GET', url: '/api/analytics/events?cameraId=cam-a' })).json().events.map((e: any) => e.id).sort()
    expect(ids).toEqual(['e1', 'e3'])
    await app.close()
  })

  it('ADMIN pidiendo ?cameraId=cam-b SÍ lo ve (sin restricción)', async () => {
    const app = await buildApp(ADMIN, makePrisma(freshEvents(), []))
    const ids = (await app.inject({ method: 'GET', url: '/api/analytics/events?cameraId=cam-b' })).json().events.map((e: any) => e.id)
    expect(ids).toEqual(['e2'])
    await app.close()
  })
})

describe('GET /api/analytics/summary — agregaciones scopeadas por cámara', () => {
  const range = 'from=2026-09-01T00:00:00Z&to=2026-09-05T00:00:00Z'

  it('(d) no-admin SIN filtro sólo cuenta sus cámaras (canView), no todas', async () => {
    const app = await buildApp(SUP, makePrisma(freshEvents(), supGrants))
    const body = (await app.inject({ method: 'GET', url: `/api/analytics/summary?${range}` })).json()
    expect(body.totalEvents).toBe(2)              // e1 + e3 (cam-a); e2 cam-b excluido
    expect(body.kpis.totalEvents).toBe(2)
    expect(body.kpis.persons).toBe(1)             // e1
    expect(body.kpis.intrusions).toBe(1)          // e3
    expect(body.kpis.vehicles).toBe(0)            // e2 (cam-b) fuera de scope
    const camIds = body.byCamera.map((c: any) => c.cameraId)
    expect(camIds).toEqual(['cam-a'])
    await app.close()
  })

  it('no-admin con filtro ?cameraIds=cam-b (ajena) ⇒ intersección vacía ⇒ 0', async () => {
    const app = await buildApp(SUP, makePrisma(freshEvents(), supGrants))
    const body = (await app.inject({ method: 'GET', url: `/api/analytics/summary?${range}&cameraIds=cam-b` })).json()
    expect(body.totalEvents).toBe(0)
    expect(body.byCamera).toEqual([])
    await app.close()
  })

  it('ADMIN SIN filtro cuenta TODAS las cámaras', async () => {
    const app = await buildApp(ADMIN, makePrisma(freshEvents(), []))
    const body = (await app.inject({ method: 'GET', url: `/api/analytics/summary?${range}` })).json()
    expect(body.totalEvents).toBe(3)
    expect(body.byCamera.map((c: any) => c.cameraId).sort()).toEqual(['cam-a', 'cam-b'])
    await app.close()
  })
})

describe('GET /api/analytics/live-frame/:cameraId — frame scopeado por cámara', () => {
  it('(e) no-admin pidiendo el frame de una cámara ajena ⇒ 403', async () => {
    const app = await buildApp(SUP, makePrisma(freshEvents(), supGrants, { 'cam-b': true }))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/live-frame/cam-b' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('no-admin con canView pasa el gate RBAC (no 403 aunque el servicio no responda)', async () => {
    const app = await buildApp(SUP, makePrisma(freshEvents(), supGrants, { 'cam-a': true }))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/live-frame/cam-a' })
    expect(res.statusCode).not.toBe(403)
    await app.close()
  })

  it('ADMIN pasa el gate RBAC para cualquier cámara (no 403)', async () => {
    const app = await buildApp(ADMIN, makePrisma(freshEvents(), [], { 'cam-b': true }))
    const res = await app.inject({ method: 'GET', url: '/api/analytics/live-frame/cam-b' })
    expect(res.statusCode).not.toBe(403)
    await app.close()
  })
})
