// apps/api/src/services/media/session-policy.test.ts
//
// N2d — sesión única por usuario. Verifica que deshabilitada es no-op, que
// habilitada revoca la sesión previa (no la nueva), que re-registrar la misma no
// revoca, forget limpia, y que los usuarios son independientes.

import { describe, it, expect, vi } from 'vitest'
import { SingleActiveSessionPolicy, type SessionRevoker } from './session-policy'

function revoker(): SessionRevoker & { calls: Array<[string, string | undefined]> } {
  const calls: Array<[string, string | undefined]> = []
  return { calls, async revokeBySession(sid, uid) { calls.push([sid, uid]); return 1 } }
}

describe('SingleActiveSessionPolicy', () => {
  it('deshabilitada: no revoca ni registra (no-op)', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, false)
    expect(await p.register('u1', 's1')).toEqual({ revokedPrior: 0 })
    expect(await p.register('u1', 's2')).toEqual({ revokedPrior: 0 })
    expect(r.calls).toEqual([])
    expect(p.activeSession('u1')).toBeNull()
  })

  it('habilitada: la sesión nueva revoca la previa (no la nueva)', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, true)
    expect(await p.register('u1', 's1')).toEqual({ revokedPrior: 0 })
    expect(p.activeSession('u1')).toBe('s1')
    const out = await p.register('u1', 's2')
    expect(out).toEqual({ revokedPrior: 1 })
    expect(r.calls).toEqual([['s1', 'u1']])     // revocó la previa s1, con owner u1
    expect(p.activeSession('u1')).toBe('s2')
  })

  it('re-registrar la MISMA sesión no revoca', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, true)
    await p.register('u1', 's1')
    const out = await p.register('u1', 's1')
    expect(out).toEqual({ revokedPrior: 0 })
    expect(r.calls).toEqual([])
  })

  it('forget limpia sólo si coincide la sesión activa', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, true)
    await p.register('u1', 's1')
    p.forget('u1', 'otra')                       // no coincide ⇒ no toca
    expect(p.activeSession('u1')).toBe('s1')
    p.forget('u1', 's1')
    expect(p.activeSession('u1')).toBeNull()
  })

  it('forget: no-op cuando está deshabilitada (mapa siempre vacío)', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, false)
    // register es no-op con la flag OFF ⇒ nada que olvidar; no debe lanzar.
    p.forget('u1', 's1')
    expect(p.activeSession('u1')).toBeNull()
  })

  it('forgetUser: limpia CUALQUIER sesión activa del usuario (logout)', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, true)
    await p.register('u1', 's1')
    expect(p.activeSession('u1')).toBe('s1')
    expect(p.forgetUser('u1')).toBe(true)         // había mapeo ⇒ true
    expect(p.activeSession('u1')).toBeNull()
    expect(p.forgetUser('u1')).toBe(false)        // ya limpio ⇒ false
    expect(r.calls).toEqual([])                   // forgetUser NO revoca grants
  })

  it('forgetUser: no cruza usuarios', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, true)
    await p.register('u1', 's1')
    await p.register('u2', 's2')
    p.forgetUser('u1')
    expect(p.activeSession('u1')).toBeNull()
    expect(p.activeSession('u2')).toBe('s2')      // u2 intacto
  })

  it('forgetUser: no-op (false) cuando está deshabilitada', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, false)
    await p.register('u1', 's1')                  // no-op con flag OFF
    expect(p.forgetUser('u1')).toBe(false)
  })

  it('usuarios independientes', async () => {
    const r = revoker()
    const p = new SingleActiveSessionPolicy(r, true)
    await p.register('u1', 's1')
    await p.register('u2', 's1')                  // mismo sessionId, otro usuario
    expect(r.calls).toEqual([])                   // no cruza usuarios
    expect(p.activeSession('u1')).toBe('s1')
    expect(p.activeSession('u2')).toBe('s1')
  })
})
