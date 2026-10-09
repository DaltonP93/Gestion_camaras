// Arranque REAL de server.ts (main()) bajo aislamiento de staging.
//
// Se importa el módulo tal cual —registra todos los plugins y rutas reales y escucha
// en 127.0.0.1 con puerto efímero— reemplazando sólo lo que tocaría infraestructura:
//   - plugins de PostgreSQL/Redis ⇒ dobles en memoria (sin conexiones);
//   - jobs en background y re-registro de streams ⇒ espías (su lógica interna está
//     cubierta en jobs/staging-isolation.workers.test.ts);
//   - publishStream ⇒ espía (sin MediaMTX ni FFmpeg).
// Cubre el re-registro DIFERIDO de server.ts (setTimeout de 5 s tras listen): se
// captura el temporizador y se ejecuta a mano para comprobar qué haría.
// Mantiene autenticación (ruta protegida ⇒ 401) y revocación (outbox durable
// exigido, recuperación y suscriptor de revocación de WS cableados).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

const spies = vi.hoisted(() => ({
  prismaPluginRegistered: vi.fn(),
  redisPluginRegistered: vi.fn(),
  nvrFindMany: vi.fn(async () => [{ id: 'nvr-1', name: 'NVR', active: true, password: 'enc', cameras: [{ id: 'cam-1', channel: 1 }] }]),
  startHealthWorker: vi.fn(),
  startSyncWorker: vi.fn(),
  reRegisterStreams: vi.fn(async () => ({ total: 1, published: 1, failed: 0, skipped: 0 })),
  publishStream: vi.fn(async () => undefined),
  startRevokeRecovery: vi.fn(),
  assertRevokeOutboxAvailable: vi.fn(),
  startWsRevokeSubscriber: vi.fn(),
  redisOn: vi.fn(),
}))

vi.mock('./plugins/prisma', async () => {
  const fp = (await import('fastify-plugin')).default
  return {
    prismaPlugin: fp(async (server: FastifyInstance) => {
      spies.prismaPluginRegistered()
      server.decorate('prisma', {
        nVR: { findMany: spies.nvrFindMany },
        // Delegate durable del outbox de revocación: assertRevokeOutboxAvailable lo exige.
        mediaRevokeOutbox: {
          findMany: async () => [], findFirst: async () => null, count: async () => 0,
          create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }),
        },
        $transaction: async (fn: any) => (typeof fn === 'function' ? fn({}) : []),
        $queryRaw: async () => [{ '?column?': 1 }],
      } as any)
    }),
  }
})
vi.mock('./plugins/redis', async () => {
  const fp = (await import('fastify-plugin')).default
  return {
    redisPlugin: fp(async (server: FastifyInstance) => {
      spies.redisPluginRegistered()
      const sub = { on: vi.fn(), subscribe: vi.fn(async () => 1), quit: vi.fn(async () => 'OK') }
      server.decorate('redis', { on: spies.redisOn, off: vi.fn(), duplicate: () => sub, ping: async () => 'PONG' } as any)
    }),
  }
})
vi.mock('./jobs/healthWorker', () => ({ startHealthWorker: spies.startHealthWorker }))
vi.mock('./jobs/syncWorker', () => ({ startSyncWorker: spies.startSyncWorker }))
vi.mock('./services/stream-reregister', () => ({ reRegisterStreams: spies.reRegisterStreams }))
vi.mock('./services/stream', async (orig) => ({ ...(await orig() as object), publishStream: spies.publishStream }))
// Revocación: espías que DELEGAN en la implementación real (se ejecuta el cableado de verdad).
vi.mock('./services/media/grant-service', async (orig) => {
  const real: any = await orig()
  spies.startRevokeRecovery.mockImplementation((...a: unknown[]) => real.startRevokeRecovery(...a))
  spies.assertRevokeOutboxAvailable.mockImplementation((...a: unknown[]) => real.assertRevokeOutboxAvailable(...a))
  return { ...real, startRevokeRecovery: spies.startRevokeRecovery, assertRevokeOutboxAvailable: spies.assertRevokeOutboxAvailable }
})
vi.mock('./services/ws-revoke-bus', async (orig) => {
  const real: any = await orig()
  spies.startWsRevokeSubscriber.mockImplementation((...a: unknown[]) => real.startWsRevokeSubscriber(...a))
  return { ...real, startWsRevokeSubscriber: spies.startWsRevokeSubscriber }
})

const FLAGS = ['STAGING_ISOLATION', 'NVR_POLLING_ENABLED', 'NVR_SYNC_ENABLED', 'STREAM_AUTO_REGISTER_ENABLED', 'OUTBOUND_NOTIFICATIONS_ENABLED']
const ENV_KEYS = [...FLAGS, 'JWT_SECRET', 'API_HOST', 'API_PORT', 'UPLOADS_DIR', 'REDIS_URL', 'CORS_ORIGINS']
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const realSetTimeout = globalThis.setTimeout
const STARTUP_REREGISTER_DELAY_MS = 5000

let uploadsDir = ''
let deferred: Array<() => unknown> = []
let exitSpy: ReturnType<typeof vi.spyOn>
let signalListenersBefore: { SIGTERM: Function[]; SIGINT: Function[] }
let booted: FastifyInstance | null = null

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.JWT_SECRET = 'test-secret-for-startup-isolation-0123456789abcdef'
  process.env.API_HOST = '127.0.0.1'
  process.env.API_PORT = '0'
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-startup-'))
  process.env.UPLOADS_DIR = uploadsDir
  for (const s of Object.values(spies)) s.mockClear()
  deferred = []
  // Captura SÓLO los temporizadores de 5 s (el re-registro diferido); el resto corre real.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => unknown, ms?: number, ...args: unknown[]) => {
    if (ms === STARTUP_REREGISTER_DELAY_MS) {
      deferred.push(fn)
      return { unref() { return this }, ref() { return this }, hasRef: () => false, refresh() { return this } } as any
    }
    return realSetTimeout(fn, ms, ...args)
  }) as typeof setTimeout)
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  signalListenersBefore = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') }
  vi.resetModules()
})

afterEach(async () => {
  if (booted) { await booted.close(); booted = null }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    for (const l of process.listeners(sig)) if (!signalListenersBefore[sig].includes(l)) process.removeListener(sig, l as any)
  }
  vi.restoreAllMocks()
  fs.rmSync(uploadsDir, { recursive: true, force: true })
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
})

/** Importa server.ts (ejecuta main()) y espera al final del arranque. */
async function boot(): Promise<FastifyInstance> {
  const { server } = await import('./server')
  booted = server
  // main() registra SIGTERM justo antes de agendar el re-registro diferido (mismo bloque síncrono).
  await vi.waitFor(() => {
    expect(process.listeners('SIGTERM').length).toBeGreaterThan(signalListenersBefore.SIGTERM.length)
  }, { timeout: 15_000, interval: 20 })
  expect(server.server.listening).toBe(true)
  return server
}

async function runDeferred() {
  for (const fn of deferred) await fn()
}

async function expectAuthAndRevocationIntact(server: FastifyInstance) {
  // Autenticación: una ruta protegida sin credenciales sigue respondiendo 401.
  const res = await server.inject({ method: 'GET', url: '/api/users' })
  expect(res.statusCode).toBe(401)
  // Revocación: outbox durable exigido, recuperación cableada a redis 'ready' y suscriptor de WS.
  expect(spies.assertRevokeOutboxAvailable).toHaveBeenCalledTimes(1)
  expect(spies.startRevokeRecovery).toHaveBeenCalledTimes(1)
  expect(spies.redisOn).toHaveBeenCalledWith('ready', expect.any(Function))
  expect(spies.startWsRevokeSubscriber).toHaveBeenCalledTimes(1)
}

describe('arranque de server.ts — sin variables de aislamiento (comportamiento actual)', () => {
  it('arranca los jobs con todo ON y agenda el re-registro diferido, que contacta NVR→MediaMTX', async () => {
    const server = await boot()
    expect(spies.startHealthWorker).toHaveBeenCalledWith(server, {
      stagingIsolation: false, nvrPolling: true, nvrSync: true, streamAutoRegister: true, outboundNotifications: true,
    })
    expect(spies.startSyncWorker).toHaveBeenCalledTimes(1)
    expect(deferred.length).toBe(1)
    await runDeferred()
    expect(spies.nvrFindMany).toHaveBeenCalledTimes(1)
    expect(spies.reRegisterStreams).toHaveBeenCalledTimes(1)
    // El re-registro recibe las dependencias reales de server.ts (publishStream incluido).
    const deps = (spies.reRegisterStreams.mock.calls[0] as unknown[])[1] as { publishStream: (n: unknown, c: unknown) => Promise<unknown> }
    await deps.publishStream({ id: 'nvr-1' }, { id: 'cam-1' })
    expect(spies.publishStream).toHaveBeenCalledTimes(1)
    await expectAuthAndRevocationIntact(server)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

describe('arranque de server.ts — STAGING_ISOLATION=true', () => {
  it('no agenda re-registro diferido; ejecutar todo lo diferido no toca NVR, MediaMTX ni FFmpeg', async () => {
    process.env.STAGING_ISOLATION = 'true'
    const server = await boot()
    expect(spies.startHealthWorker).toHaveBeenCalledWith(server, {
      stagingIsolation: true, nvrPolling: false, nvrSync: false, streamAutoRegister: false, outboundNotifications: false,
    })
    expect(spies.startSyncWorker).toHaveBeenCalledWith(server, expect.objectContaining({ nvrSync: false }))
    expect(deferred.length).toBe(0)
    await runDeferred()
    expect(spies.nvrFindMany).not.toHaveBeenCalled()
    expect(spies.reRegisterStreams).not.toHaveBeenCalled()
    expect(spies.publishStream).not.toHaveBeenCalled()
    await expectAuthAndRevocationIntact(server)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('STREAM_AUTO_REGISTER_ENABLED=false sólo apaga el re-registro diferido', async () => {
    process.env.STREAM_AUTO_REGISTER_ENABLED = 'false'
    const server = await boot()
    expect(spies.startHealthWorker).toHaveBeenCalledWith(server, expect.objectContaining({ nvrPolling: true, streamAutoRegister: false }))
    expect(deferred.length).toBe(0)
    expect(spies.reRegisterStreams).not.toHaveBeenCalled()
    await expectAuthAndRevocationIntact(server)
  })
})

describe('arranque de server.ts — variable presente pero vacía o con espacios', { timeout: 20_000 }, () => {
  const cases: Array<[string, string]> = [
    ['STAGING_ISOLATION', ''],
    ['STAGING_ISOLATION', '   '],
    ['STAGING_ISOLATION', ' true'],
    ['STREAM_AUTO_REGISTER_ENABLED', ''],
    ['OUTBOUND_NOTIFICATIONS_ENABLED', 'false '],
  ]
  for (const [name, value] of cases) {
    it(`${name}=${JSON.stringify(value)} ⇒ aborta (exit 1) antes de conectar a PostgreSQL/Redis, escuchar o agendar nada`, async () => {
      process.env[name] = value
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { server } = await import('./server')
      booted = server
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1), { timeout: 15_000, interval: 20 })
      expect(String(errSpy.mock.calls[0]?.[1])).toContain(`${name} presente pero inválida`)
      expect(spies.prismaPluginRegistered).not.toHaveBeenCalled()
      expect(spies.redisPluginRegistered).not.toHaveBeenCalled()
      expect(spies.startHealthWorker).not.toHaveBeenCalled()
      expect(spies.startSyncWorker).not.toHaveBeenCalled()
      expect(deferred.length).toBe(0)
      expect(server.server.listening).toBe(false)
    })
  }
})
