// Actor vigente (política §7.2): contrato de loadCurrentActor y de la revalidación
// de medios de grabación. La integración con el server.ts real, PG y Redis está en
// security-joint/revocation-effective.joint.test.ts; aquí, la forma de la consulta
// y las reglas de rol con un Prisma de juguete.
import { describe, it, expect } from 'vitest'
import { loadCurrentActor, checkRecordingMediaAccess, actorCanPlaybackCamera } from './current-actor'

function fakePrisma(opts: {
  user?: { role: string; username: string } | null
  perm?: boolean
  down?: boolean
} = {}) {
  const calls: Array<{ model: string; args: any }> = []
  return {
    calls,
    user: {
      findFirst: async (args: any) => {
        calls.push({ model: 'user', args })
        if (opts.down) throw Object.assign(new Error('base caída'), { code: 'P1001' })
        return opts.user ?? null
      },
    },
    userPermission: {
      findFirst: async (args: any) => {
        calls.push({ model: 'userPermission', args })
        return opts.perm ? { id: 'p1' } : null
      },
    },
  }
}

describe('loadCurrentActor', () => {
  it('sin `sid` (access previo al cambio, tokens 2fa/enroll/step-up/refresh) ⇒ NO_SESSION_CLAIM sin consultar la base', async () => {
    const prisma = fakePrisma({ user: { role: 'ADMIN', username: 'a' } })
    for (const claims of [{ sub: 'u1' }, { sub: 'u1', sid: '' }, { sub: 'u1', sid: 42 }, { sid: 's1' }, { sub: '', sid: 's1' }, null, undefined]) {
      expect(await loadCurrentActor(prisma, claims as any)).toEqual({ ok: false, reason: 'NO_SESSION_CLAIM' })
    }
    expect(await loadCurrentActor(prisma, { sub: 'u1', sid: 'x'.repeat(65) })).toEqual({ ok: false, reason: 'NO_SESSION_CLAIM' })
    expect(prisma.calls).toEqual([])
  })

  it('UNA consulta: usuario por id, activo, con la sesión viva (por id, no vencida) del MISMO usuario', async () => {
    const now = new Date('2026-10-09T12:00:00Z')
    const prisma = fakePrisma({ user: { role: 'AUDITOR', username: 'carla' } })
    const r = await loadCurrentActor(prisma, { sub: 'u1', sid: 's1', role: 'ADMIN', username: 'viejo' } as any, now)
    // El rol y el username salen de la BASE, no de los claims.
    expect(r).toEqual({ ok: true, actor: { userId: 'u1', sid: 's1', role: 'AUDITOR', username: 'carla' } })
    expect(prisma.calls).toHaveLength(1)
    expect(prisma.calls[0].args).toEqual({
      where: { id: 'u1', active: true, sessions: { some: { id: 's1', expiresAt: { gt: now } } } },
      select: { role: true, username: true },
    })
  })

  it('usuario borrado/inactivo o sesión cerrada/vencida ⇒ NOT_CURRENT; base caída ⇒ lanza (el llamador decide fail-closed)', async () => {
    expect(await loadCurrentActor(fakePrisma({ user: null }), { sub: 'u1', sid: 's1' })).toEqual({ ok: false, reason: 'NOT_CURRENT' })
    await expect(loadCurrentActor(fakePrisma({ down: true }), { sub: 'u1', sid: 's1' })).rejects.toThrow()
  })
})

describe('actorCanPlaybackCamera — mismas reglas de rol que el alta de la reproducción', () => {
  const actor = (role: string) => ({ userId: 'u1', sid: 's1', role, username: 'x' })
  it('ADMIN y SUPERVISOR sí, sin consultar permisos', async () => {
    for (const role of ['ADMIN', 'SUPERVISOR']) {
      const prisma = fakePrisma()
      expect(await actorCanPlaybackCamera(prisma, actor(role), 'c1')).toBe(true)
      expect(prisma.calls).toEqual([])
    }
  })
  it('AUDITOR sólo con canPlayback sobre ESA cámara; OPERATOR nunca', async () => {
    const withPerm = fakePrisma({ perm: true })
    expect(await actorCanPlaybackCamera(withPerm, actor('AUDITOR'), 'c1')).toBe(true)
    expect(withPerm.calls[0].args.where).toEqual({ userId: 'u1', cameraId: 'c1', canPlayback: true })
    expect(await actorCanPlaybackCamera(fakePrisma({ perm: false }), actor('AUDITOR'), 'c1')).toBe(false)
    const op = fakePrisma({ perm: true })
    expect(await actorCanPlaybackCamera(op, actor('OPERATOR'), 'c1')).toBe(false)
    expect(op.calls).toEqual([])
  })
})

describe('checkRecordingMediaAccess', () => {
  it('token sin ligadura (emitido antes del cambio) ⇒ UNBOUND, sin consultar', async () => {
    const prisma = fakePrisma({ user: { role: 'ADMIN', username: 'a' } })
    for (const b of [{}, { userId: 'u1' }, { userId: 'u1', sid: 's1' }, { userId: 'u1', cameraId: 'c1' }, { sid: 's1', cameraId: 'c1' }]) {
      expect(await checkRecordingMediaAccess(prisma, b)).toEqual({ ok: false, reason: 'UNBOUND' })
    }
    expect(prisma.calls).toEqual([])
  })
  it('titular no vigente ⇒ ACTOR_REVOKED; sin permiso actual ⇒ PLAYBACK_REVOKED; vigente con permiso ⇒ ok', async () => {
    const binding = { userId: 'u1', sid: 's1', cameraId: 'c1' }
    expect(await checkRecordingMediaAccess(fakePrisma({ user: null }), binding)).toEqual({ ok: false, reason: 'ACTOR_REVOKED' })
    expect(await checkRecordingMediaAccess(fakePrisma({ user: { role: 'AUDITOR', username: 'x' }, perm: false }), binding)).toEqual({ ok: false, reason: 'PLAYBACK_REVOKED' })
    expect(await checkRecordingMediaAccess(fakePrisma({ user: { role: 'OPERATOR', username: 'x' }, perm: true }), binding)).toEqual({ ok: false, reason: 'PLAYBACK_REVOKED' })
    expect(await checkRecordingMediaAccess(fakePrisma({ user: { role: 'AUDITOR', username: 'x' }, perm: true }), binding)).toEqual({ ok: true })
    expect(await checkRecordingMediaAccess(fakePrisma({ user: { role: 'SUPERVISOR', username: 'x' } }), binding)).toEqual({ ok: true })
  })
})
