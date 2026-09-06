// apps/api/src/services/media/redis-real-harness.ts
//
// Helper de INTEGRACIÓN con Redis REAL (no es un test; el include de vitest es
// *.test.ts). Valida la ATOMICIDAD de EVAL y la expiración por RELOJ DE REDIS que
// el fake no puede probar.
//
// DOS MODOS de obtención del servidor:
//   1. `REDIS_TEST_URL` (CI): se conecta a un Redis REAL provisto por el entorno
//      (p. ej. el `services: redis` del job). Se aísla con un índice de DB
//      aleatorio + FLUSHDB, y `stop()` limpia esa DB. NO se lanza ningún proceso.
//   2. binario local (dev): lanza un `redis-server` efímero (puerto alto, sin
//      persistencia) y lo termina en `stop()`.
//
// DETECCIÓN SÍNCRONA Y FIABLE (`redisServerAvailable`): usa `spawnSync`, no
// `spawn`. `spawn` NO lanza en ausencia del binario — emite un evento `error`
// (ENOENT) asíncrono no capturado que hacía que la detección devolviera `true`
// erróneamente (y podía tumbar el runner). `spawnSync` devuelve `error`/`status`
// de inmediato, así que la ausencia se detecta sin eventos colgados.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import Redis from 'ioredis'
import type { RedisGrantClient } from './grant-store'
import { assertDisposableLocalHost } from './test-host-guard'

export interface EphemeralRedis {
  client: RedisGrantClient
  raw: Redis
  port: number
  stop: () => Promise<void>
}

const TEST_URL = process.env.REDIS_TEST_URL

/** ¿Hay un Redis REAL disponible para las suites de integración?
 *  - CI: `REDIS_TEST_URL` presente.
 *  - dev: binario `redis-server` detectable de forma SÍNCRONA (spawnSync). */
export function redisServerAvailable(): boolean {
  if (TEST_URL) return true
  try {
    const r = spawnSync('redis-server', ['--version'], { stdio: 'ignore' })
    return r.status === 0 && !r.error
  } catch {
    return false
  }
}

/** Redis obligatorio en CI: si el entorno lo exige (`REQUIRE_REAL_REDIS=1`) y no
 *  hay servidor, se LANZA para que la suite FALLE en vez de omitirse en silencio. */
export function assertRedisRequiredOrSkip(): boolean {
  const have = redisServerAvailable()
  if (!have && process.env.REQUIRE_REAL_REDIS === '1') {
    throw new Error('REQUIRE_REAL_REDIS=1 pero no hay Redis real (ni REDIS_TEST_URL ni binario redis-server). CI no puede omitir esta suite.')
  }
  return have
}

async function ping(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const probe = new Redis({ host, port, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    try {
      await probe.connect()
      const pong = await probe.ping()
      probe.disconnect()
      if (pong === 'PONG') return
    } catch {
      probe.disconnect()
      if (Date.now() > deadline) throw new Error('redis no respondió a tiempo')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

/** Cierra un cliente ioredis esperando el cierre REAL (quit; fallback disconnect). */
async function closeClient(raw: Redis): Promise<void> {
  try { await raw.quit() } catch { try { raw.disconnect() } catch { /* noop */ } }
}

/** Termina un proceso hijo esperando su `exit` real (SIGTERM y backstop SIGKILL). */
function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    proc.once('exit', finish)
    try { proc.kill('SIGTERM') } catch { /* noop */ }
    setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* noop */ }; finish() }, 2000)
  })
}

/** Levanta (o conecta) un Redis efímero y devuelve un cliente listo para usar. */
export async function startEphemeralRedis(): Promise<EphemeralRedis> {
  // ── Modo CI: conectar al Redis provisto (REDIS_TEST_URL), aislado por DB ──
  if (TEST_URL) {
    // Guard: sólo destinos descartables locales/CI (loopback), ANTES de conectar.
    assertDisposableLocalHost(TEST_URL, 'REDIS_TEST_URL')
    // Aislamiento DETERMINISTA por worker de vitest (no aleatorio): un worker corre
    // sus archivos EN SERIE, así que su DB no colisiona con otro worker. Evita la
    // colisión posible de elegir 1 de 16 al azar entre suites paralelas.
    const workerRaw = Number(process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? '0')
    const db = ((Number.isFinite(workerRaw) ? workerRaw : 0) % 16 + 16) % 16
    const raw = new Redis(TEST_URL, { db, maxRetriesPerRequest: 3 })
    await raw.flushdb() // arranca limpio en ESTA DB dedicada del worker
    const stop = async (): Promise<void> => {
      try { await raw.flushdb() } catch { /* noop */ }
      await closeClient(raw)
    }
    return { client: raw as unknown as RedisGrantClient, raw, port: 0, stop }
  }

  // ── Modo dev: lanzar un redis-server efímero local ──
  if (!redisServerAvailable()) throw new Error('redis-server no disponible (ni REDIS_TEST_URL)')
  const port = 40000 + Math.floor(Math.random() * 20000)
  const proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' })
  // ENOENT u otro fallo de arranque llega como evento `error`: capturarlo evita un
  // 'error' no manejado que tumbaría el proceso; `ping` vencerá y rechazará.
  let spawnError: Error | null = null
  proc.once('error', (e) => { spawnError = e as Error })
  try {
    await ping(port, '127.0.0.1', 5000)
  } catch (e) {
    await stopProcess(proc)
    throw spawnError ?? (e as Error)
  }
  const raw = new Redis({ port, host: '127.0.0.1', maxRetriesPerRequest: 3 })
  const stop = async (): Promise<void> => {
    await closeClient(raw)
    await stopProcess(proc)
  }
  return { client: raw as unknown as RedisGrantClient, raw, port, stop }
}
