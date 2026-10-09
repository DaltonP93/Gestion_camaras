// Arranque aislado de los jobs en background: con STAGING_ISOLATION no se agenda
// nada que contacte NVR/MediaMTX y, al ejecutar los jobs que SÍ quedan (limpiezas
// internas, expiración de sesiones de login, retención), ningún espía de NVR,
// MediaMTX ni notificaciones se dispara. Todo con mocks: sin red.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const scheduled = vi.hoisted(() => [] as Array<{ expr: string; fn: () => unknown }>)
vi.mock('node-cron', () => ({
  default: { schedule: (expr: string, fn: () => unknown) => { scheduled.push({ expr, fn }); return { stop() {} } } },
}))

// Todo export funcional de estos módulos se reemplaza por un espía.
function spyAll(mod: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(mod).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v]))
}
vi.mock('../services/hikvision', async (orig) => spyAll(await orig() as any))
vi.mock('../services/nvrSync', async (orig) => spyAll(await orig() as any))
vi.mock('../services/stream', async (orig) => spyAll(await orig() as any))
vi.mock('../services/notification.service', async (orig) => spyAll(await orig() as any))
vi.mock('../services/stream-manager', async (orig) => ({
  ...(spyAll(await orig() as any)),
  cleanupIdleSessions: vi.fn(async () => 0),
}))

import * as hikvision from '../services/hikvision'
import * as nvrSync from '../services/nvrSync'
import * as stream from '../services/stream'
import * as notification from '../services/notification.service'
import { startHealthWorker } from './healthWorker'
import { startSyncWorker } from './syncWorker'
import { resolveIsolationConfig } from '../services/staging-isolation'

const NVR_POLL = '*/60 * * * * *'
const STREAM_REGISTER = '*/5 * * * *'

function fakeServer() {
  const nvr = { id: 'n1', name: 'NVR', active: true, online: true, password: 'enc', cameras: [] }
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    prisma: {
      nVR: { findMany: vi.fn(async () => [nvr]), findUnique: vi.fn(async () => nvr) },
      session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      alert: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      notificationDelivery: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      auditLog: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      analyticsEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    },
  } as any
}

function allSpiesUntouched() {
  for (const mod of [hikvision, nvrSync, stream, notification] as Array<Record<string, unknown>>) {
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn === 'function' && 'mock' in fn) {
        expect((fn as any).mock.calls.length, name).toBe(0)
      }
    }
  }
}

beforeEach(() => { scheduled.length = 0; vi.clearAllMocks() })

describe('jobs en background — sin aislamiento (comportamiento actual)', () => {
  it('agenda el sondeo de NVR, el re-registro de MediaMTX y el sync', () => {
    const server = fakeServer()
    startHealthWorker(server, resolveIsolationConfig({}))
    startSyncWorker(server, resolveIsolationConfig({}))
    const exprs = scheduled.map(s => s.expr)
    expect(exprs).toContain(NVR_POLL)
    expect(exprs).toContain(STREAM_REGISTER)
    expect(scheduled.length).toBe(6) // 5 del healthWorker + 1 del syncWorker
  })
})

describe('jobs en background — STAGING_ISOLATION=true', () => {
  it('no agenda nada que contacte NVR/MediaMTX y conserva las limpiezas internas', () => {
    const server = fakeServer()
    const cfg = resolveIsolationConfig({ STAGING_ISOLATION: 'true' })
    startHealthWorker(server, cfg)
    startSyncWorker(server, cfg)
    const exprs = scheduled.map(s => s.expr)
    expect(exprs).not.toContain(NVR_POLL)
    expect(exprs).not.toContain(STREAM_REGISTER)
    // Limpieza de sesiones de stream idle, expiración de sesiones de login y retención.
    expect(exprs.sort()).toEqual(['*/2 * * * *', '0 * * * *', '30 3 * * *'].sort())
  })

  it('ejecutar todos los jobs que quedan no contacta NVR, MediaMTX ni notificaciones', async () => {
    const server = fakeServer()
    const cfg = resolveIsolationConfig({ STAGING_ISOLATION: 'true' })
    startHealthWorker(server, cfg)
    startSyncWorker(server, cfg)
    for (const job of scheduled) await job.fn()
    allSpiesUntouched()
    // Las limpiezas internas sí corrieron (auth/sesiones siguen vivas).
    expect(server.prisma.session.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('flags individuales: sólo NVR_SYNC_ENABLED=false deja el sondeo de salud', () => {
    const server = fakeServer()
    const cfg = resolveIsolationConfig({ NVR_SYNC_ENABLED: 'false' })
    startHealthWorker(server, cfg)
    startSyncWorker(server, cfg)
    expect(scheduled.map(s => s.expr)).toContain(NVR_POLL)
    expect(scheduled.length).toBe(5)
  })
})
