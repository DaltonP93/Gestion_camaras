// apps/api/src/services/media/redis-real-harness.ts
//
// Helper de INTEGRACIÓN con Redis REAL (no es un test; el include de vitest es
// *.test.ts). Valida la ATOMICIDAD de EVAL y la expiración por RELOJ DE REDIS que
// el fake no puede probar.
//
// DOS MODOS de obtención del servidor:
//   1. `REDIS_TEST_URL` (CI): se conecta a un Redis REAL provisto por el entorno
//      (p. ej. el `services: redis` del job). El índice de DB se asigna de forma
//      ATÓMICA y DETERMINISTA (contador en la DB 0 ⇒ 1..15 distintos por suite, sin
//      colisión entre procesos), y `stop()` limpia esa DB. El FLUSHDB exige la señal
//      explícita `REDIS_TEST_DISPOSABLE=1` (loopback solo no autoriza destructivo).
//      NO se lanza ningún proceso.
//   2. binario local (dev): lanza un `redis-server` efímero PROPIO (puerto alto, sin
//      persistencia) y lo termina en `stop()`. Al ser instancia propia por corrida,
//      no requiere la señal de desechabilidad.
//
// DETECCIÓN SÍNCRONA Y FIABLE (`redisServerAvailable`): usa `spawnSync`, no
// `spawn`. `spawn` NO lanza en ausencia del binario — emite un evento `error`
// (ENOENT) asíncrono no capturado que hacía que la detección devolviera `true`
// erróneamente (y podía tumbar el runner). `spawnSync` devuelve `error`/`status`
// de inmediato, así que la ausencia se detecta sin eventos colgados.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import Redis from 'ioredis'
import type { RedisGrantClient } from './grant-store'
import { assertDestructiveTestAllowed } from './test-host-guard'

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
    // Guard: loopback + señal EXPLÍCITA de instancia descartable, ANTES de FLUSHDB.
    // (loopback por sí solo no prueba que sea desechable.)
    assertDestructiveTestAllowed(TEST_URL, 'REDIS_TEST_URL', 'REDIS_TEST_DISPOSABLE')
    // Aislamiento por ASIGNACIÓN ATÓMICA de DB (no worker%16, que colisiona entre
    // procesos separados o cuando el id supera 16). Un contador en la DB 0 reparte
    // índices distintos 1..15 a suites concurrentes (la DB 0 se reserva para el
    // contador y NO se limpia). Determinista y sin colisión hasta 15 concurrentes.
    const alloc = new Redis(TEST_URL, { db: 0, maxRetriesPerRequest: 3 })
    let db: number
    try {
      const n = await alloc.incr('__vc_test_db_alloc__')
      db = (Number(n) % 15) + 1 // 1..15
    } finally {
      await closeClient(alloc)
    }
    const raw = new Redis(TEST_URL, { db, maxRetriesPerRequest: 3 })
    await raw.flushdb() // arranca limpio en ESTA DB dedicada (1..15), nunca la 0
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
