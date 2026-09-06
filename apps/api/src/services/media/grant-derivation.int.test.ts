// apps/api/src/services/media/grant-derivation.int.test.ts
//
// C23·H2·P3 — INTEGRACIÓN (Redis REAL): la readiness POR PATH que comparten
// /client-capabilities y /media-grant refleja el ciclo real de la fuente
// (ready/notReady/recreated), es COHERENTE entre dos workers sobre el MISMO Redis
// y sobrevive a un "reinicio" del API (nuevo store sobre el mismo Redis). Además:
//   - Un `ready` DUPLICADO (poll repetido) NO rota la instancia (invariante N1):
//     un grant emitido antes sigue validando (no INSTANCE_MISMATCH).
//   - Un ciclo notReady→ready (recreación) SÍ rota la instancia: el grant viejo da
//     INSTANCE_MISMATCH. La generación se identifica por mediaInstanceId, no por el
//     streamPath (que es reutilizable).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RedisGrantStore } from './grant-store'
import { SourceLifecycleController } from './source-lifecycle'
import { deriveMediaRequest, type DeriveDeps } from './grant-derivation'
import { MediaGrantManager } from './media-grants'
import { startEphemeralRedis, redisServerAvailable, type EphemeralRedis } from './redis-real-harness'

const HAVE_REDIS = redisServerAvailable()

const CAM = { id: 'cam-1', channel: 9, mainCodec: 'HEVC', subCodec: 'H264', nvr: { id: 'nvr1' } }
const STREAM = `nvr_${CAM.nvr.id}_ch${String(CAM.channel).padStart(2, '0')}_main`

const prismaStub = {
  camera: { findUnique: async () => CAM },
  userPermission: { findFirst: async () => null },
} as unknown as DeriveDeps['prisma']

const deriveWith = (store: RedisGrantStore) =>
  deriveMediaRequest({ prisma: prismaStub, role: 'ADMIN', userId: 'u', currentInstance: (p) => store.currentInstance(p) }, 'cam-1')

const scope = { userId: 'u', cameraId: 'cam-1', streamPath: STREAM, transport: 'rtsps' as const, action: 'read' as const }

describe.skipIf(!HAVE_REDIS)('readiness por path · Redis REAL (lifecycle + 2 workers + restart)', () => {
  let env: EphemeralRedis
  beforeAll(async () => { env = await startEphemeralRedis() })
  afterAll(async () => { await env?.stop() })

  it('ready/notReady/recreated se refleja en hasInstance (misma verificación que la emisión)', async () => {
    const store = new RedisGrantStore(env.client)
    const ctrl = new SourceLifecycleController(store)

    // Sin fuente ⇒ no hay instancia ⇒ hasInstance false.
    let d = await deriveWith(store)
    expect(d.ok && d.derived.hasInstance).toBe(false)

    // ready ⇒ hasInstance true.
    await ctrl.onReady(STREAM)
    d = await deriveWith(store)
    expect(d.ok && d.derived.hasInstance).toBe(true)

    // notReady ⇒ vuelve a false.
    await ctrl.onNotReady(STREAM)
    d = await deriveWith(store)
    expect(d.ok && d.derived.hasInstance).toBe(false)
  })

  it('ready DUPLICADO no rota (N1): grant previo sigue validando; recreación ⇒ INSTANCE_MISMATCH', async () => {
    const store = new RedisGrantStore(env.client)
    const ctrl = new SourceLifecycleController(store)
    const mgr = new MediaGrantManager({ store })

    await ctrl.onReady(STREAM)
    const inst1 = await store.currentInstance(STREAM)
    const r = await mgr.issue({ userId: 'u', viewId: 'v', cameraId: 'cam-1', streamPath: STREAM, effectiveType: 'main', codec: 'hevc', transport: 'rtsps', device: 'win', ttlMs: 30_000 })
    if (!r.ok) throw new Error('issue: ' + r.code)

    // ready DUPLICADO (poll repetido): keepalive, NO rota la instancia.
    await ctrl.onReady(STREAM)
    expect(await store.currentInstance(STREAM)).toBe(inst1)
    // El grant previo sigue siendo válido (validación no destructiva).
    const vs = await mgr.validateSession({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)
    expect(vs.ok).toBe(true)

    // Recreación (notReady→ready): rota la instancia ⇒ el grant viejo da INSTANCE_MISMATCH.
    await ctrl.onNotReady(STREAM)
    await ctrl.onReady(STREAM)
    const inst2 = await store.currentInstance(STREAM)
    expect(inst2).not.toBe(inst1)
    const claim = await mgr.consume({ grantId: r.issued.grantId, secret: r.issued.secret }, scope)
    expect(claim.reason).toBe('INSTANCE_MISMATCH')
  })

  it('dos workers sobre el MISMO Redis ven la misma readiness; sobrevive al "reinicio"', async () => {
    const workerA = new RedisGrantStore(env.client)
    const ctrlA = new SourceLifecycleController(workerA)
    await ctrlA.onReady('nvr_nvr1_ch11_main')

    // Worker B (otro proceso, mismo Redis) ve la instancia registrada por A.
    const workerB = new RedisGrantStore(env.client)
    const dB = await deriveMediaRequest({ prisma: { camera: { findUnique: async () => ({ ...CAM, channel: 11 }) }, userPermission: { findFirst: async () => null } } as any, role: 'ADMIN', userId: 'u', currentInstance: (p) => workerB.currentInstance(p) }, 'cam-1')
    expect(dB.ok && dB.derived.hasInstance).toBe(true)

    // "Reinicio del API": store nuevo sobre el MISMO Redis ⇒ la instancia persiste.
    const afterRestart = new RedisGrantStore(env.client)
    expect(await afterRestart.currentInstance('nvr_nvr1_ch11_main')).not.toBeNull()
  })
})
