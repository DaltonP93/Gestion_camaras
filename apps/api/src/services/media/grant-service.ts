// apps/api/src/services/media/grant-service.ts
//
// Servicio de grants SINGLETON + readiness UNIFICADA (C22.2). La revocación
// server-side NO se traga: distingue applied/pending/failed y reintenta.

import type { FastifyInstance } from 'fastify'
import { MediaGrantManager } from './media-grants'
import { createGrantStore, type RedisGrantClient } from './grant-store'
import { NativeRelayReadiness } from './native-readiness'
import { SingleActiveSessionPolicy } from './session-policy'
import { connectionsToKick, performKick, noopKicker, type MediaMtxKicker } from './relay-kick'
import { InMemoryMediaRevokeOutbox, PrismaMediaRevokeOutbox, type MediaRevokeOutboxRepo, type MediaRevokeOutboxTxClient, type PrismaOutboxClient } from './revoke-outbox'

let singleton: MediaGrantManager | null = null
let readiness: NativeRelayReadiness | null = null
let sessionPolicy: SingleActiveSessionPolicy | null = null
// A1 · F0 — kicker inyectable. Por defecto inerte (no hay MediaMTX vivo en F0);
// el cableado real de la API de runtime de MediaMTX es F1/F2 (infra, NO hecho).
let mediaKicker: MediaMtxKicker = noopKicker
export function setMediaKicker(k: MediaMtxKicker): void { mediaKicker = k }

const relayEnabled = (): boolean => process.env.NATIVE_MEDIA_RELAY_ENABLED === 'true'

/**
 * A1 · F0 — revoke→kick por USUARIO (logout / cambio de permisos). Con la flag
 * OFF es un no-op ESTRICTO: no enumera bindings ni toca el kicker ⇒ comportamiento
 * idéntico a hoy. Con la flag ON: enumera las conexiones vivas del usuario y las
 * expulsa best-effort. Devuelve cuántas se expulsaron (0 con flag OFF).
 */
export async function kickConnectionsForUser(server: FastifyInstance, userId: string): Promise<number> {
  if (!relayEnabled()) return 0
  try {
    const bindings = await getMediaGrantManager(server).listConnectionsForUser(userId)
    const ids = connectionsToKick({ kind: 'user', userId }, bindings)
    return await performKick(mediaKicker, ids)
  } catch { return 0 }
}

/**
 * A1 · F0 — revoke→kick por GRANTS (revocación por vista/sesión). No-op con flag OFF.
 */
export async function kickConnectionsForGrants(server: FastifyInstance, grantIds: string[]): Promise<number> {
  if (!relayEnabled() || grantIds.length === 0) return 0
  try {
    const mgr = getMediaGrantManager(server)
    const all: Awaited<ReturnType<typeof mgr.listConnectionsForGrant>> = []
    for (const gid of grantIds) all.push(...await mgr.listConnectionsForGrant(gid))
    const ids = connectionsToKick({ kind: 'grants', grantIds }, all)
    return await performKick(mediaKicker, ids)
  } catch { return 0 }
}
// C23·H2·P2 — OUTBOX DURABLE de revocación. Sustituye al Set en-proceso como
// ÚNICA fuente: la intención de revocar se persiste en Postgres (sobrevive a un
// reinicio del API durante una caída de Redis). Con Postgres disponible se usa la
// impl Prisma; si no (tests sin DB, o server sin prisma) se degrada a una impl en
// memoria — la interfaz durable es la misma. `outboxOverride` permite inyectar una
// impl durable en pruebas (simular reinicio: recrear singletons, misma outbox).
let outboxOverride: MediaRevokeOutboxRepo | null = null
let activeOutbox: MediaRevokeOutboxRepo | null = null

export function setMediaRevokeOutboxForTest(repo: MediaRevokeOutboxRepo | null): void {
  outboxOverride = repo
  activeOutbox = null
}

/** ¿Estamos en un runtime de test (vitest)? Sólo entonces se tolera el outbox en
 *  memoria SIN inyección explícita; en producción la ausencia del delegate durable
 *  es un FAIL-CLOSED (ver abajo). */
function isTestRuntime(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
}

/**
 * Outbox durable de revocación. C23·H2·P1 — FAIL-CLOSED: en producción la intención
 * de revocar DEBE persistir en Postgres; si falta el delegate Prisma
 * (`mediaRevokeOutbox` + `$transaction`) NO degradamos a memoria en silencio (eso
 * perdería la durabilidad y volvería fail-OPEN la revocación). La impl en memoria
 * sólo se usa por INYECCIÓN EXPLÍCITA de test (`setMediaRevokeOutboxForTest`) o, como
 * conveniencia, bajo runtime de test (vitest) cuando no hay ni inyección ni delegate.
 */
export function getMediaRevokeOutbox(server: FastifyInstance): MediaRevokeOutboxRepo {
  if (activeOutbox) return activeOutbox
  // 1) Inyección EXPLÍCITA de test: la vía canónica a una impl no-Postgres.
  if (outboxOverride) { activeOutbox = outboxOverride; return activeOutbox }
  // 2) Producción: EXIGE el delegate durable de Postgres.
  const prisma = (server as any).prisma
  if (prisma && prisma.mediaRevokeOutbox && typeof prisma.$transaction === 'function') {
    activeOutbox = new PrismaMediaRevokeOutbox(prisma as PrismaOutboxClient)
    return activeOutbox
  }
  // 3) Sólo en runtime de test sin inyección ni delegate: memoria (no exige Postgres
  //    a cada unit test). NUNCA en producción.
  if (isTestRuntime()) { activeOutbox = new InMemoryMediaRevokeOutbox(); return activeOutbox }
  // 4) Producción sin outbox durable ⇒ FAIL-CLOSED (no se degrada en silencio).
  throw new Error('C23·H2·P1: outbox de revocación de medios no disponible (falta el delegate Prisma `mediaRevokeOutbox` o `$transaction`). Fail-closed: no se emiten/validan grants sin durabilidad de la intención de revocación.')
}

/**
 * FAIL-CLOSED en el ARRANQUE: fuerza la resolución del outbox durable para que un
 * despliegue sin el delegate Prisma ABORTE el arranque en vez de diferir el fallo al
 * primer logout / cambio de permisos. Idempotente (cachea el singleton).
 */
export function assertRevokeOutboxAvailable(server: FastifyInstance): void {
  getMediaRevokeOutbox(server)
}

export function getMediaGrantManager(server: FastifyInstance): MediaGrantManager {
  if (singleton) return singleton
  const redis = ((server as any).redis ?? null) as RedisGrantClient | null
  singleton = new MediaGrantManager({
    store: createGrantStore(redis),
    // Fail-closed del relay: mientras exista deuda de revocación DURABLE sin aplicar
    // para el usuario, no se emiten ni validan grants de sesión de relay.
    hasRevokeDebt: (userId) => getMediaRevokeOutbox(server).hasPending(userId),
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
    {
      // A1·F0: al revocar la sesión previa, además expulsa sus conexiones vivas
      // (flag ON). Con la flag OFF grantIds=[] ⇒ kick no-op ⇒ idéntico a hoy.
      revokeBySession: async (sid, uid) => {
        const grantIds = relayEnabled() ? await mgr.listGrantIdsForSession(sid) : []
        const n = await mgr.revokeBySession(sid, uid)
        if (grantIds.length) await kickConnectionsForGrants(server, grantIds)
        return n
      },
    },
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
  const outbox = getMediaRevokeOutbox(server)
  // 1) Registrar DURABLEMENTE la intención ANTES/independiente de tocar Redis. Si
  //    la durabilidad falla (Postgres caído), no podemos garantizar la revocación:
  //    'failed' (el llamador deja constancia y NO declara éxito).
  try {
    await outbox.enqueue(userId)
  } catch {
    server.log.warn(`media_grant revoke_enqueue_failed userId=${userId.slice(0, 8)} — outbox durable no disponible`)
    return 'failed'
  }
  // 2) Intención durable OK: drenar (epoch) y devolver el estado real.
  return drainRevokeAndStatus(server, userId, outbox)
}

/**
 * C23·H2·P1 — Revocación de grants de medios ATÓMICA con la mutación de sesión /
 * permisos del caller. La mutación (`mutate(tx)`) y la INTENCIÓN de revocar
 * (fila del outbox durable) se confirman en la MISMA transacción PostgreSQL:
 *
 *   - Si `mutate` o el INSERT del outbox fallan ⇒ ROLLBACK total: ni la sesión se
 *     cierra, ni los permisos cambian, ni queda intención a medias. La excepción
 *     PROPAGA para que la ruta responda no-2xx (JAMÁS "Sesión cerrada" /
 *     "Permisos actualizados").
 *   - Si el commit tiene éxito ⇒ la intención ya es DURABLE. Se intenta drenar el
 *     epoch (best-effort). Si Redis está caído, devuelve 'pending' y el plano falla
 *     cerrado hasta el drenaje (los grants viejos no re-validan). Nunca 'failed'
 *     tras un commit exitoso (la durabilidad ya está garantizada).
 *
 * Exige `prisma.$transaction` real (fail-closed si no está): la atomicidad no puede
 * emularse sin transacción.
 */
export async function revokeUserMediaGrantsAtomic(
  server: FastifyInstance,
  userId: string,
  mutate: (tx: MediaRevokeOutboxTxClient) => Promise<void>,
): Promise<RevokeStatus> {
  const outbox = getMediaRevokeOutbox(server) // fail-closed si falta el delegate durable
  const prisma = (server as any).prisma
  if (!prisma || typeof prisma.$transaction !== 'function') {
    throw new Error('C23·H2·P1: revokeUserMediaGrantsAtomic requiere prisma.$transaction (fail-closed): la mutación y la intención de revocar deben confirmarse atómicas.')
  }
  // FASE A — mutación + intención de revocar en UNA sola transacción PG.
  await prisma.$transaction(async (tx: MediaRevokeOutboxTxClient) => {
    await mutate(tx)
    await outbox.enqueueInTx(tx, userId)
  })
  // FASE B — commit OK ⇒ intención durable. Drenaje best-effort (fail-closed hasta él).
  return drainRevokeAndStatus(server, userId, outbox)
}

/** Fase común post-intención-durable: drena el epoch y computa el estado real
 *  ('applied' | 'pending'). Expulsa conexiones de relay vivas tras aplicar. */
async function drainRevokeAndStatus(server: FastifyInstance, userId: string, outbox: MediaRevokeOutboxRepo): Promise<RevokeStatus> {
  const mgr = getMediaGrantManager(server)
  await outbox.drain((uid) => mgr.revokeAllForUser(uid).then((o) => o.status === 'applied'))
  if (await outbox.hasPending(userId)) {
    server.log.warn(`media_grant revoke_pending userId=${userId.slice(0, 8)} — backend caido, se reintentara`)
    return 'pending'
  }
  // A1·F0: tras la revocación durable, expulsa conexiones de relay vivas del
  // usuario (SOLO con la flag ON; OFF ⇒ no-op ⇒ idéntico a hoy).
  await kickConnectionsForUser(server, userId)
  return 'applied'
}

/** Reintenta (drena) el outbox durable de revocaciones (llamar al recuperar Redis). */
export async function retryPendingUserRevokes(server: FastifyInstance): Promise<number> {
  const outbox = getMediaRevokeOutbox(server)
  // Inerte si no hay nada pendiente: no construye el manager ni toca Redis (con las
  // flags OFF y sin outage previo, el barrido/reconexión no hace nada).
  if ((await outbox.pendingUserIds()).length === 0) return 0
  const mgr = getMediaGrantManager(server)
  return outbox.drain((uid) => mgr.revokeAllForUser(uid).then((o) => o.status === 'applied'))
}

export function __pendingUserRevokeCount(): number {
  const o = activeOutbox ?? outboxOverride
  return o instanceof InMemoryMediaRevokeOutbox ? o.pendingCountSync() : 0
}

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
  outboxOverride = null
  activeOutbox = null
  mediaKicker = noopKicker
}
