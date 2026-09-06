// apps/api/src/services/media/redis-real-harness.ts
//
// Helper de INTEGRACIÓN con Redis REAL (no es un test; el include de vitest es
// *.test.ts). Levanta un `redis-server` efímero (puerto alto aleatorio, sin
// persistencia) y devuelve un cliente ioredis tipado como RedisGrantClient, más
// un `stop()` que cierra cliente y proceso. Se usa para validar la ATOMICIDAD de
// EVAL y la expiración por RELOJ DE REDIS que el fake no puede probar.
//
// Si no hay binario `redis-server` disponible, `startEphemeralRedis` rechaza; el
// llamador puede marcar la suite como skip. En este entorno redis-server existe.

import { spawn, type ChildProcess } from 'node:child_process'
import Redis from 'ioredis'
import type { RedisGrantClient } from './grant-store'

export interface EphemeralRedis {
  client: RedisGrantClient
  raw: Redis
  port: number
  stop: () => Promise<void>
}

/** ¿Está el binario redis-server disponible? (para skipIf en las suites). */
export function redisServerAvailable(): boolean {
  try {
    const r = spawn('redis-server', ['--version'], { stdio: 'ignore' })
    r.kill('SIGKILL')
    return true
  } catch { return false }
}

async function ping(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  // Reintenta conectar+PING hasta que el server acepte o venza el plazo.
  for (;;) {
    const probe = new Redis({ port, lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null })
    try {
      await probe.connect()
      const pong = await probe.ping()
      probe.disconnect()
      if (pong === 'PONG') return
    } catch {
      probe.disconnect()
      if (Date.now() > deadline) throw new Error('redis-server no respondió a tiempo')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

/** Levanta un redis-server efímero y devuelve un cliente listo para usar. */
export async function startEphemeralRedis(): Promise<EphemeralRedis> {
  const port = 40000 + Math.floor(Math.random() * 20000)
  let proc: ChildProcess
  try {
    proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' })
  } catch (e) {
    throw new Error('no se pudo lanzar redis-server: ' + String(e))
  }
  await ping(port, 5000)
  const raw = new Redis({ port, maxRetriesPerRequest: 3 })
  const stop = async (): Promise<void> => {
    try { raw.disconnect() } catch { /* noop */ }
    try { proc.kill('SIGKILL') } catch { /* noop */ }
  }
  return { client: raw as unknown as RedisGrantClient, raw, port, stop }
}
