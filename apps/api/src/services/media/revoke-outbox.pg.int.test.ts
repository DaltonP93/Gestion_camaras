// apps/api/src/services/media/revoke-outbox.pg.int.test.ts
//
// C23·H2·P2 — INTEGRACIÓN de `PrismaMediaRevokeOutbox` contra PostgreSQL REAL y
// EFÍMERO (`DATABASE_URL_TEST`; en CI el `services: postgres`). Valida lo que la
// impl en memoria NO puede: la atomicidad `FOR UPDATE SKIP LOCKED` del `drain`
// entre transacciones concurrentes — dos "workers" toman filas DISTINTAS a la vez
// y ninguna fila se procesa dos veces. Reemplaza el viejo NOT_VALIDATED de PG.
//
// Nunca apunta a una base remota/producción (ver pg-real-harness.ts).

import { describe, it, expect } from 'vitest'
import { PrismaMediaRevokeOutbox } from './revoke-outbox'
import { withEphemeralOutboxDb, assertPgRequiredOrSkip } from './pg-real-harness'

const HAVE_PG = assertPgRequiredOrSkip()

describe.skipIf(!HAVE_PG)('PrismaMediaRevokeOutbox · Postgres REAL', () => {
  it('enqueue / hasPending / pendingUserIds reflejan la deuda real', async () => {
    await withEphemeralOutboxDb(async ({ adapter }) => {
      const outbox = new PrismaMediaRevokeOutbox(adapter)
      expect(await outbox.hasPending('u1')).toBe(false)
      await outbox.enqueue('u1')
      await outbox.enqueue('u1') // dos intenciones para el mismo usuario
      await outbox.enqueue('u2')
      expect(await outbox.hasPending('u1')).toBe(true)
      expect((await outbox.pendingUserIds()).sort()).toEqual(['u1', 'u2'])
    })
  })

  it('drain aplica y marca appliedAt; un segundo drain no reaplica', async () => {
    await withEphemeralOutboxDb(async ({ adapter }) => {
      const outbox = new PrismaMediaRevokeOutbox(adapter)
      await outbox.enqueue('u1')
      await outbox.enqueue('u2')
      const applied: string[] = []
      expect(await outbox.drain(async (u) => { applied.push(u); return true })).toBe(2)
      expect(applied.sort()).toEqual(['u1', 'u2'])
      expect(await outbox.pendingUserIds()).toEqual([])
      // Nada pendiente ⇒ segundo drenaje no vuelve a aplicar.
      expect(await outbox.drain(async () => { throw new Error('no debe llamarse') })).toBe(0)
    })
  })

  it('apply fallido deja la fila pendiente e incrementa attempts; el reintento aplica', async () => {
    await withEphemeralOutboxDb(async ({ adapter, prisma }) => {
      const outbox = new PrismaMediaRevokeOutbox(adapter)
      await outbox.enqueue('u1')
      expect(await outbox.drain(async () => false)).toBe(0)   // backend caído ⇒ no aplica
      expect(await outbox.hasPending('u1')).toBe(true)
      const [{ attempts }] = await prisma.$queryRaw<{ attempts: number }[]>`SELECT "attempts" FROM "media_revoke_outbox" WHERE "userId" = 'u1'`
      expect(Number(attempts)).toBeGreaterThanOrEqual(1)
      expect(await outbox.drain(async () => true)).toBe(1)    // reintento ⇒ aplica
      expect(await outbox.hasPending('u1')).toBe(false)
    })
  })

  it('SKIP LOCKED: dos drenajes CONCURRENTES toman filas distintas ⇒ cada fila una sola vez', async () => {
    await withEphemeralOutboxDb(async ({ adapter }) => {
      const outbox = new PrismaMediaRevokeOutbox(adapter)
      await outbox.enqueue('u1')
      await outbox.enqueue('u2')

      // Barrera: ambos `apply` deben estar EN VUELO a la vez. Si el drain B se
      // bloqueara en el SELECT (FOR UPDATE sin SKIP LOCKED) esperando el lock de A,
      // nunca habría 2 en vuelo ⇒ maxInFlight quedaría en 1 y el test falla.
      let inFlight = 0, maxInFlight = 0, applies = 0, arrived = 0
      let release!: () => void
      const gate = new Promise<void>((res) => { release = res })
      const failSafe = setTimeout(() => release(), 8000) // no colgar la suite si algo sale mal

      const apply = async (): Promise<boolean> => {
        applies++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
        arrived++; if (arrived >= 2) release()
        await gate
        inFlight--
        return true
      }

      const [a, b] = await Promise.all([outbox.drain(apply), outbox.drain(apply)])
      clearTimeout(failSafe)

      expect(a + b).toBe(2)          // dos filas aplicadas en total
      expect(applies).toBe(2)        // cada fila aplicada EXACTAMENTE una vez (sin doble proceso)
      expect(maxInFlight).toBe(2)    // ambas tomadas concurrentemente ⇒ SKIP LOCKED real
      expect(await outbox.pendingUserIds()).toEqual([])
    })
  }, 20_000)
})
