// A1 · F0 — pruebas de la parte PURA de revoke→kick. Sin red ni MediaMTX vivo.
import { describe, it, expect } from 'vitest'
import { connectionsToKick, performKick, noopKicker, type MediaMtxKicker } from './relay-kick'
import type { ConnectionBinding } from './contracts'

const B = (connectionId: string, grantId: string, userId: string, streamPath = 'nvr_c_sub'): ConnectionBinding =>
  ({ connectionId, grantId, userId, streamPath })

const bindings: ConnectionBinding[] = [
  B('c1', 'g1', 'userA'),
  B('c2', 'g2', 'userA'),
  B('c3', 'g3', 'userB'),
  B('c4', 'g4', 'userC'),
]

describe('connectionsToKick (pura)', () => {
  it('por USER: enumera SÓLO las conexiones de ese usuario (logout/permiso)', () => {
    expect(connectionsToKick({ kind: 'user', userId: 'userA' }, bindings).sort()).toEqual(['c1', 'c2'])
    expect(connectionsToKick({ kind: 'user', userId: 'userB' }, bindings)).toEqual(['c3'])
    expect(connectionsToKick({ kind: 'user', userId: 'nadie' }, bindings)).toEqual([])
  })
  it('por GRANTS (vista/sesión): enumera las conexiones de esos grants', () => {
    expect(connectionsToKick({ kind: 'grants', grantIds: ['g1', 'g3'] }, bindings).sort()).toEqual(['c1', 'c3'])
    expect(connectionsToKick({ kind: 'grants', grantIds: [] }, bindings)).toEqual([])
    expect(connectionsToKick({ kind: 'grants', grantIds: ['gZ'] }, bindings)).toEqual([])
  })
  it('sin duplicados aunque una conexión aparezca dos veces', () => {
    const dup = [B('c1', 'g1', 'userA'), B('c1', 'g1', 'userA')]
    expect(connectionsToKick({ kind: 'user', userId: 'userA' }, dup)).toEqual(['c1'])
  })
})

describe('performKick (kicker fake)', () => {
  it('llama kick por cada connectionId y cuenta los éxitos', async () => {
    const kicked: string[] = []
    const kicker: MediaMtxKicker = { async kick(id) { kicked.push(id) } }
    const n = await performKick(kicker, ['c1', 'c2', 'c3'])
    expect(n).toBe(3)
    expect(kicked).toEqual(['c1', 'c2', 'c3'])
  })
  it('un fallo individual no aborta el resto (best-effort)', async () => {
    const kicked: string[] = []
    const kicker: MediaMtxKicker = { async kick(id) { if (id === 'c2') throw new Error('boom'); kicked.push(id) } }
    const n = await performKick(kicker, ['c1', 'c2', 'c3'])
    expect(n).toBe(2)
    expect(kicked).toEqual(['c1', 'c3'])
  })
  it('noopKicker no lanza y no cuenta nada raro', async () => {
    expect(await performKick(noopKicker, ['c1', 'c2'])).toBe(2)
  })
})
