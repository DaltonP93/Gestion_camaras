// apps/api/src/services/media/grant-service.ts
//
// Servicio de grants SINGLETON + readiness UNIFICADA (C22.2). La revocación
// server-side NO se traga: distingue applied/pending/failed y reintenta.

import type { FastifyInstance } from 'fastify'
import { MediaGrantManager } from './media-grants'
import { createGrantStore, type RedisGrantClient } from './grant-store'
import { NativeRelayReadiness } from './native-readiness'
import { SingleActiveSessionPolicy } from './session-policy'

let singleton: MediaGrantManager | null = null
let readiness: NativeRelayReadiness | null = null
let sessionPolicy: SingleActiveSessionPolicy | null = null
// Outbox en-proceso de revocaciones (epoch bump) que fallaron por backend caído.
// Durante el outage el plano falla cerrado (readiness+validateAndClaim), así que
// ningún grant es aceptable; al recuperar Redis se drena esta cola.
const pendingUserRevokes = new Set<string>()

export function getMediaGrantManager(server: FastifyInstance): MediaGrantManager {
  if (singleton) return singleton
  const redis = ((server as any).redis ?? null) as RedisGrantClient | null
  singleton = new MediaGrantManager({
    store: createGrantStore(redis),
    audit: (r) => server.log.info(
      `media_grant event=${r.event} grantId=${r.grantId} cam=${r.cameraId.slice(0, 8)} ` +
      `transport=${r.transport}${r.reason ? ` reason=${r.reason}` : ''}`,
    ),
  })
  return singleton
}

export function getNativeReadiness(server: FastifyInstance): NativeRelayReadiness {
  if (readiness) return readiness
  const mgr = getMediaGrantManager(server)
  readiness = new NativeRelayReadiness({
    playbackEnabled: process.env.NATIVE_PLAYBACK_ENABLED === 'true',
    relayEnabled: process.env.NATIVE_MEDIA_RELAY_ENABLED === 'true',
    secretPresent: (process.env.MEDIA_RELAY_SECRET || '') !== '',
    storeAtomic: mgr.crossProcessAtomic,
    checkHealth: () => mgr.healthy(),
  })
  return readiness
}

/**
 * N2d — Política de sesión única por usuario (multi-dispositivo). Singleton
 * gobernado por SINGLE_ACTIVE_MEDIA_SESSION (OFF por defecto: register es no-op).
 */
export function getSessionPolicy(server: FastifyInstance): SingleActiveSessionPolicy {
  if (sessionPolicy) return sessionPolicy
  const mgr = getMediaGrantManager(server)
  sessionPolicy = new SingleActiveSessionPolicy(
    { revokeBySession: (sid, uid) => mgr.revokeBySession(sid, uid) },
    process.env.SINGLE_ACTIVE_MEDIA_SESSION === 'true',
  )
  return sessionPolicy
}

export type RevokeStatus = 'applied' | 'pending' | 'failed'

/**
 * Revoca los grants de medios de un usuario ante logout / cambio de permisos.
 * DEVUELVE el estado real: 'applied' (epoch incrementado durablemente), 'pending'
 * (backend caído; encolado para retry — el plano falla cerrado mientras tanto).
 * No declara éxito si la revocación no se aplicó.
 */
export async function revokeUserMediaGrants(server: FastifyInstance, userId: string): Promise<RevokeStatus> {
  const outcome = await getMediaGrantManager(server).revokeAllForUser(userId)
  if (outcome.status === 'applied') { pendingUserRevokes.delete(userId); return 'applied' }
  pendingUserRevokes.add(userId)
  server.log.warn(`media_grant revoke_pending userId=${userId.slice(0, 8)} — backend caido, se reintentara`)
  return 'pending'
}

/** Reintenta las revocaciones pendientes (llamar al recuperar Redis). */
export async function retryPendingUserRevokes(server: FastifyInstance): Promise<number> {
  const mgr = getMediaGrantManager(server)
  let ok = 0
  for (const uid of [...pendingUserRevokes]) {
    const o = await mgr.revokeAllForUser(uid)
    if (o.status === 'applied') { pendingUserRevokes.delete(uid); ok++ }
  }
  return ok
}

export function __pendingUserRevokeCount(): number { return pendingUserRevokes.size }

/** Sólo para pruebas: reconstruye singletons y limpia el outbox. */
export function __resetMediaGrantManagerForTest(): void {
  singleton = null
  readiness = null
  sessionPolicy = null
  pendingUserRevokes.clear()
}
