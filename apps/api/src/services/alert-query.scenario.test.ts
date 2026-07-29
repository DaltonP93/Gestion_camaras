import { describe, it, expect } from 'vitest'
import { alertWhere, alertStatusWhere } from './alert-query'
import { deriveAlertSummary } from './alert-summary'

// Escenario del PR A: 604 alertas, con las 2 unread MÁS ANTIGUAS que las primeras 200.
// Emula la semántica de `where` de Prisma para los campos que usa el builder, para
// demostrar que la lista paginada (mismo where) y el summary son coherentes: si
// summary.unread=2, status=unread devuelve exactamente esas 2 filas.
type A = { id: string; resolved: boolean; readAt: string | null; severity: string; createdAt: number }

function matches(a: A, where: any): boolean {
  if ('resolved' in where && a.resolved !== where.resolved) return false
  if ('readAt' in where) {
    if (where.readAt === null && a.readAt !== null) return false
    if (where.readAt && typeof where.readAt === 'object' && 'not' in where.readAt) {
      if (where.readAt.not === null && a.readAt === null) return false
    }
  }
  if ('severity' in where && a.severity !== where.severity) return false
  return true
}
function query(data: A[], where: any, page: number, limit: number) {
  const all = data.filter((a) => matches(a, where)).sort((x, y) => y.createdAt - x.createdAt)
  return { items: all.slice(page * limit, page * limit + limit), total: all.length }
}

describe('escenario 604 alertas (PR A)', () => {
  const data: A[] = []
  let t = 100000
  for (let i = 0; i < 352; i++) data.push({ id: `r${i}`, resolved: true, readAt: 'x', severity: 'LOW', createdAt: t-- })
  for (let i = 0; i < 250; i++) data.push({ id: `a${i}`, resolved: false, readAt: 'x', severity: i < 3 ? 'CRITICAL' : 'LOW', createdAt: t-- })
  // Las 2 unread son las MÁS ANTIGUAS (quedarían fuera de un top-200 por createdAt desc).
  data.push({ id: 'u1', resolved: false, readAt: null, severity: 'HIGH', createdAt: t-- })
  data.push({ id: 'u2', resolved: false, readAt: null, severity: 'LOW', createdAt: t-- })

  const summary = deriveAlertSummary({
    unread: data.filter((a) => matches(a, alertStatusWhere('unread'))).length,
    acknowledged: data.filter((a) => matches(a, alertStatusWhere('acknowledged'))).length,
    resolved: data.filter((a) => matches(a, alertStatusWhere('resolved'))).length,
    criticalPending: 0,
  })

  it('summary: unread=2, acknowledged=250, resolved=352, total=604', () => {
    expect(summary).toMatchObject({ unread: 2, acknowledged: 250, resolved: 352, total: 604 })
  })

  it('status=unread devuelve exactamente las 2, aunque sean las más antiguas', () => {
    const r = query(data, alertWhere('unread', 'all'), 0, 50)
    expect(r.total).toBe(2)
    expect(r.items.map((a) => a.id).sort()).toEqual(['u1', 'u2'])
  })

  it('acknowledged / resolved / all coherentes con summary', () => {
    expect(query(data, alertWhere('acknowledged', 'all'), 0, 50).total).toBe(250)
    expect(query(data, alertWhere('resolved', 'all'), 0, 50).total).toBe(352)
    expect(query(data, alertWhere('all', 'all'), 0, 50).total).toBe(604)
  })

  it('cambiar de tab no conserva filas del anterior', () => {
    const unread = query(data, alertWhere('unread', 'all'), 0, 50).items
    expect(unread.every((a) => !a.resolved && a.readAt === null)).toBe(true)
  })

  it('severity + status combinados', () => {
    expect(query(data, alertWhere('acknowledged', 'CRITICAL'), 0, 50).total).toBe(3)
    expect(query(data, alertWhere('unread', 'HIGH'), 0, 50).total).toBe(1)
  })

  it('paginación: páginas 0 y 1 no se solapan', () => {
    const p0 = query(data, alertWhere('all', 'all'), 0, 50).items.map((a) => a.id)
    const p1 = query(data, alertWhere('all', 'all'), 1, 50).items.map((a) => a.id)
    expect(p0).toHaveLength(50)
    expect(p1).toHaveLength(50)
    expect(p0.some((id) => p1.includes(id))).toBe(false)
  })
})
