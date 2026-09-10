// apps/api/src/services/media/redis-real-harness.int.test.ts
//
// C23·H2·P2 — El aislamiento entre corridas del harness es por NAMESPACE ÚNICO
// (keyPrefix), no por índice de DB. Esta suite demuestra, contra el Redis COMPARTIDO
// de CI (REDIS_TEST_URL), que:
//   1. >15 corridas concurrentes NO colisionan (el viejo pool (INCR%15)+1 reusaba una
//      DB activa en la asignación 16).
//   2. Parar una corrida borra SÓLO sus claves (SCAN+UNLINK), sin borrado cruzado
//      (el viejo FLUSHDB sobre una DB compartida sí borraba datos vecinos).
//
// Sólo aplica al modo de instancia COMPARTIDA (REDIS_TEST_URL). En dev (binario
// local) cada corrida es su propio `redis-server`, trivialmente aislado ⇒ se omite.
import { describe, it, expect, afterEach } from 'vitest'
import { startEphemeralRedis, type EphemeralRedis } from './redis-real-harness'

const SHARED = !!process.env.REDIS_TEST_URL

describe.skipIf(!SHARED)('redis-real-harness · aislamiento por namespace (Redis compartido)', () => {
  let live: EphemeralRedis[] = []
  afterEach(async () => { await Promise.all(live.map((e) => e.stop().catch(() => {}))); live = [] })

  it('>15 corridas concurrentes: namespaces disjuntos, sin colisión ni borrado cruzado', async () => {
    const N = 20  // > 15: el punto exacto donde el pool circular de DB reusaba una activa
    const envs = await Promise.all(Array.from({ length: N }, () => startEphemeralRedis()))
    live = [...envs]

    // Cada corrida escribe una marca ÚNICA en SU namespace (misma key lógica 'mark').
    await Promise.all(envs.map((e, i) => e.raw.set('mark', String(i))))

    // Ninguna ve la marca de otra: cada cliente lee SU propio valor (namespaces disjuntos).
    const seen = await Promise.all(envs.map((e) => e.raw.get('mark')))
    expect(seen.map((v) => Number(v)).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i))

    // Parar la PRIMERA mitad borra sólo SUS claves; la otra mitad sobrevive intacta.
    const firstHalf = envs.slice(0, N / 2)
    const secondHalf = envs.slice(N / 2)
    await Promise.all(firstHalf.map((e) => e.stop()))
    live = [...secondHalf]  // ya no re-parar la primera mitad en afterEach

    const survivors = await Promise.all(secondHalf.map((e) => e.raw.get('mark')))
    expect(survivors.every((v) => v !== null)).toBe(true)  // sin borrado cruzado
  })
})
