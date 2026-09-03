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
  // Inerte si no hay nada pendiente: no construye el singleton ni toca Redis (con
  // las flags OFF y sin outage previo, el barrido/reconexión no hace nada).
  if (pendingUserRevokes.size === 0) return 0
  const mgr = getMediaGrantManager(server)
  let ok = 0
  for (const uid of [...pendingUserRevokes]) {
    try {
      const o = await mgr.revokeAllForUser(uid)
      if (o.status === 'applied') { pendingUserRevokes.delete(uid); ok++ }
    } catch { /* backend aún caído: sigue pendiente, se reintenta en el próximo barrido */ }
  }
  return ok
}

export function __pendingUserRevokeCount(): number { return pendingUserRevokes.size }

export interface RevokeRecovery { stop(): void }

/**
 * B1 — Cablea la RECUPERACIÓN de la revocación durable a dos disparadores:
 *   1) `redis.on('ready')`: al (re)conectar Redis, drena el outbox de inmediato
 *      (cierra el hueco del outage: los grants viejos no pueden re-validar porque
 *      el epoch se incrementa en cuanto vuelve el backend).
 *   2) barrido periódico (unref'd): red de seguridad si el evento 'ready' se pierde
 *      o si la revocación falla en el primer intento. Inerte cuando no hay pendientes.
 * Idempotente y seguro con las flags OFF: sin revocaciones pendientes es un no-op.
 */
export function startRevokeRecovery(server: FastifyInstance, sweepIntervalMs = 60_000): RevokeRecovery {
  const redis = (server as any).redis as { on?: (e: string, cb: () => void) => void; off?: (e: string, cb: () => void) => void } | null
  const drain = (trigger: string): void => {
    void retryPendingUserRevokes(server)
      .then((n) => { if (n > 0) server.log.info(`media_grant revoke_drained trigger=${trigger} n=${n}`) })
      .catch(() => { /* se reintenta en el próximo disparo */ })
  }
  const onReady = (): void => drain('redis_ready')
  if (redis && typeof redis.on === 'function') redis.on('ready', onReady)
  const timer = setInterval(() => drain('sweep'), Math.max(1000, sweepIntervalMs))
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
  return {
    stop() {
      clearInterval(timer)
      if (redis && typeof redis.off === 'function') redis.off('ready', onReady)
    },
  }
}

/** Sólo para pruebas: reconstruye singletons y limpia el outbox. */
export function __resetMediaGrantManagerForTest(): void {
  singleton = null
  readiness = null
  sessionPolicy = null
  pendingUserRevokes.clear()
}
