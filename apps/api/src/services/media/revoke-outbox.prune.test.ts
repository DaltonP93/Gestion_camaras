// C23·H2 (P3) — Higiene del outbox: `pruneApplied` borra SÓLO tombstones YA
// APLICADOS y antiguos; NUNCA una intención pendiente. Unidad sobre la impl en
// memoria (sin infraestructura); el camino Postgres real se cubre en
// revoke-outbox.pg.int.test.ts.
import { describe, it, expect } from 'vitest'
import { InMemoryMediaRevokeOutbox } from './revoke-outbox'

describe('InMemoryMediaRevokeOutbox.pruneApplied', () => {
  it('conserva pendientes y aplicados recientes; borra aplicados más viejos que la retención', async () => {
    const o = new InMemoryMediaRevokeOutbox()
    await o.enqueue('u1')
    await o.enqueue('u2')
    expect(await o.drain(async () => true)).toBe(2)  // u1, u2 aplicados (appliedAt = ahora)
    await o.enqueue('u3')                            // pendiente

    // Retención amplia ⇒ los aplicados son recientes ⇒ no se borra nada.
    expect(await o.pruneApplied(60_000)).toBe(0)
    expect(await o.hasPending('u3')).toBe(true)

    // Retención 0 ⇒ borra los 2 aplicados; el pendiente sobrevive (jamás se borra).
    expect(await o.pruneApplied(0)).toBe(2)
    expect(await o.hasPending('u3')).toBe(true)
    expect(await o.pendingUserIds()).toEqual(['u3'])

    // Idempotente: sin aplicados restantes, un segundo prune no borra nada.
    expect(await o.pruneApplied(0)).toBe(0)
  })

  it('nunca borra una intención pendiente aunque la retención sea 0', async () => {
    const o = new InMemoryMediaRevokeOutbox()
    await o.enqueue('victim')                        // pendiente, sin aplicar
    expect(await o.pruneApplied(0)).toBe(0)          // no hay aplicados que borrar
    expect(await o.hasPending('victim')).toBe(true)  // la deuda pendiente sigue intacta
  })
})
