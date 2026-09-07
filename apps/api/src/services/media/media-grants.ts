// apps/api/src/services/media/media-grants.ts
//
// Plano de autorización de medios (C22, endurecido C22.1 y C22.2).
//
//   - `consume` usa la transición ATÓMICA ÚNICA del store (`validateAndClaim`):
//     revoke/expiración/epoch/instancia/uso se comprueban y el uso se marca en el
//     mismo punto de linealización (sin ventanas TOCTOU).
//   - `issue` captura el EPOCH de autorización del usuario y EXIGE una instancia
//     de fuente real vigente (no inventa una por el string del path); si no hay,
//     se niega con NO_MEDIA_INSTANCE.
//   - `revokeAllForUser` incrementa el epoch de forma DURABLE (fail-closed: si el
//     backend está caído, propaga el error; nunca declara revocación exitosa).
//
// El grant nunca contiene contraseñas de NVR ni URIs RTSP.

import crypto from 'node:crypto'
import type { GrantStore } from './grant-store'
import {
  MEDIA_GRANT_CONTRACT_VERSION,
  type IssuedMediaGrant,
  type StoredMediaGrant,
  type GrantScopeQuery,
  type GrantValidation,
  type GrantAuditRecord,
  type MediaCodec,
  type MediaTransport,
  type ConnectionBinding,
} from './contracts'

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8'); const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export interface GrantClock { now(): number }
export interface GrantRandom { secret(): string; id(): string }
export const systemClock: GrantClock = { now: () => Date.now() }
export const systemRandom: GrantRandom = {
  secret: () => crypto.randomBytes(32).toString('hex'),
  id: () => `mg_${crypto.randomBytes(12).toString('hex')}`,
}

export interface MintGrantParams {
  userId: string
  viewId: string
  cameraId: string
  streamPath: string
  effectiveType: 'sub' | 'main'
  codec: MediaCodec
  transport: MediaTransport
  device: string
  sessionId?: string
  ttlMs: number
}

export interface BuildGrantInternal extends MintGrantParams {
  mediaInstanceId: string
  authorizationEpoch: number
}

export function buildGrant(params: BuildGrantInternal, clock: GrantClock, random: GrantRandom): { issued: IssuedMediaGrant; stored: StoredMediaGrant } {
  const now = clock.now()
  const grantId = random.id()
  const secret = random.secret()
  const ttlMs = Math.max(1, Math.floor(params.ttlMs))
  const expiresAt = now + ttlMs
  const stored: StoredMediaGrant = {
    grantId,
    secretHash: sha256Hex(secret),
    userId: params.userId,
    viewId: params.viewId,
    cameraId: params.cameraId,
    streamPath: params.streamPath,
    codec: params.codec,
    transport: params.transport,
    action: 'read',
    effectiveType: params.effectiveType,
    device: params.device.slice(0, 120),
    mediaInstanceId: params.mediaInstanceId,
    authorizationEpoch: params.authorizationEpoch,
    issuedAt: now,
    expiresAt,
    // Construcción existente ⇒ SIEMPRE handshake (uso único). A1·F0 no cambia esto.
    kind: 'handshake',
    revokedAt: null,
  }
  const issued: IssuedMediaGrant = {
    grantId, secret, transport: params.transport, codec: params.codec,
    streamPath: params.streamPath, action: 'read', expiresAt,
    contractVersion: MEDIA_GRANT_CONTRACT_VERSION,
  }
  return { issued, stored }
}

export interface GrantPresentation { grantId: string; secret: string }

// ─── manager ────────────────────────────────────────────────────────
export type GrantAuditSink = (record: GrantAuditRecord) => void
const noopAudit: GrantAuditSink = () => {}

export interface MediaGrantManagerDeps {
  store: GrantStore
  clock?: GrantClock
  random?: GrantRandom
  audit?: GrantAuditSink
  /**
   * C23·H2·P2 — Predicado de deuda de revocación DURABLE por usuario. Si está
   * presente y resuelve true, el relay FALLA CERRADO: no se emiten ni validan
   * grants de SESIÓN de relay para ese usuario (issueSession/validateSession).
   * Ausente ⇒ los caminos de relay no consultan deuda (comportamiento previo).
   */
  hasRevokeDebt?: (userId: string) => Promise<boolean>
}

export type IssueResult =
  | { ok: true; issued: IssuedMediaGrant }
  | { ok: false; code: 'NO_MEDIA_INSTANCE' | 'BACKEND_UNAVAILABLE' | 'REVOKE_PENDING' }

export type RevokeAllOutcome = { status: 'applied'; epoch: number } | { status: 'failed' }

export class MediaGrantManager {
  private readonly store: GrantStore
  private readonly clock: GrantClock
  private readonly random: GrantRandom
  private readonly audit: GrantAuditSink
  private readonly hasRevokeDebt?: (userId: string) => Promise<boolean>

  constructor(deps: MediaGrantManagerDeps) {
    this.store = deps.store
    this.clock = deps.clock ?? systemClock
    this.random = deps.random ?? systemRandom
    this.audit = deps.audit ?? noopAudit
    this.hasRevokeDebt = deps.hasRevokeDebt
  }

  /**
   * C23·H2·P2 — Fail-closed del relay: ¿el usuario tiene deuda de revocación
   * DURABLE sin aplicar? Ante un error consultando la deuda, DENIEGA (cerrado).
   */
  private async revokeDebtBlocks(userId: string): Promise<boolean> {
    if (!this.hasRevokeDebt) return false
    try { return await this.hasRevokeDebt(userId) } catch { return true }
  }

  get crossProcessAtomic(): boolean { return this.store.crossProcessAtomic }
  healthy(): Promise<boolean> { return this.store.healthy() }

  async issue(params: MintGrantParams): Promise<IssueResult> {
    // Fail-closed (C23·H2·P2): las rutas activas usan issue()/consume(), no sólo
    // issueSession/validateSession. Con deuda de revocación DURABLE pendiente para
    // el usuario, NO se emite ningún grant — aunque el drenaje del epoch aún no
    // haya corrido (Redis pudo estar caído al hacer logout/quitar permisos).
    if (await this.revokeDebtBlocks(params.userId)) return { ok: false, code: 'REVOKE_PENDING' }
    // EXIGE una instancia de fuente real vigente: no se inventa por el path.
    let instance: string | null
    let epoch: number
    try {
      instance = await this.store.currentInstance(params.streamPath)
      if (instance === null) return { ok: false, code: 'NO_MEDIA_INSTANCE' }
      epoch = await this.store.getUserEpoch(params.userId)
    } catch { return { ok: false, code: 'BACKEND_UNAVAILABLE' } }

    const { issued, stored } = buildGrant({ ...params, mediaInstanceId: instance, authorizationEpoch: epoch }, this.clock, this.random)
    try {
      await this.store.issueGrant(stored, { viewId: params.viewId, sessionId: params.sessionId }, Math.max(1, Math.floor(params.ttlMs)))
    } catch { return { ok: false, code: 'BACKEND_UNAVAILABLE' } }
    this.audit({ event: 'grant_issued', grantId: stored.grantId, userId: stored.userId, cameraId: stored.cameraId, transport: stored.transport, at: stored.issuedAt })
    return { ok: true, issued }
  }

  /**
   * A1 · F0 — Emite un grant de SESIÓN de relay (`kind:'relay_session'`, long-lived).
   * Idénticas invariantes que `issue` (exige instancia real, captura epoch), pero
   * el grant NO es de uso único: lo re-valida `validateSession` sin consumirse.
   */
  async issueSession(params: MintGrantParams): Promise<IssueResult> {
    // Fail-closed: con deuda de revocación durable pendiente para el usuario, no
    // se emite grant de sesión de relay (aunque el drenaje aún no haya corrido).
    if (await this.revokeDebtBlocks(params.userId)) return { ok: false, code: 'REVOKE_PENDING' }
    let instance: string | null
    let epoch: number
    try {
      instance = await this.store.currentInstance(params.streamPath)
      if (instance === null) return { ok: false, code: 'NO_MEDIA_INSTANCE' }
      epoch = await this.store.getUserEpoch(params.userId)
    } catch { return { ok: false, code: 'BACKEND_UNAVAILABLE' } }

    const built = buildGrant({ ...params, mediaInstanceId: instance, authorizationEpoch: epoch }, this.clock, this.random)
    const stored: StoredMediaGrant = { ...built.stored, kind: 'relay_session' }
    try {
      await this.store.issueGrant(stored, { viewId: params.viewId, sessionId: params.sessionId }, Math.max(1, Math.floor(params.ttlMs)))
    } catch { return { ok: false, code: 'BACKEND_UNAVAILABLE' } }
    this.audit({ event: 'grant_issued', grantId: stored.grantId, userId: stored.userId, cameraId: stored.cameraId, transport: stored.transport, at: stored.issuedAt })
    return { ok: true, issued: built.issued }
  }

  /**
   * A1 · F0 — Re-valida un grant de sesión SIN consumirlo (no destructiva). Se
   * llama en cada callback de auth del relay durante la vida de la conexión.
   */
  async validateSession(presented: GrantPresentation, scope: GrantScopeQuery): Promise<GrantValidation> {
    const now = this.clock.now()
    // Fail-closed: si hay deuda de revocación durable pendiente para el usuario del
    // scope, se DENIEGA la validación de sesión aunque el epoch de Redis todavía no
    // se haya bumpeado (Redis pudo haberse caído; el drenaje aún no aplicó).
    if (await this.revokeDebtBlocks(scope.userId)) {
      this.audit({ event: 'grant_rejected', grantId: presented.grantId, userId: scope.userId, cameraId: scope.cameraId, transport: scope.transport, reason: 'REVOKE_PENDING', at: now })
      return { ok: false, reason: 'REVOKE_PENDING' }
    }
    const result = await this.store.validateSession({
      grantId: presented.grantId,
      presentedSecretHash: sha256Hex(presented.secret),
      scope, nowMs: now,
    })
    this.audit({
      event: result.ok ? 'grant_used' : (result.reason === 'EXPIRED' ? 'grant_expired' : 'grant_rejected'),
      grantId: presented.grantId, userId: scope.userId, cameraId: scope.cameraId, transport: scope.transport,
      reason: result.ok ? undefined : result.reason, at: now,
    })
    return result
  }

  /** A1 · F0 — mapa conexión↔grant (passthrough al store). */
  bindConnection(connectionId: string, grantId: string, userId: string, streamPath: string, ttlMs: number): Promise<void> {
    return this.store.bindConnection(connectionId, grantId, userId, streamPath, ttlMs)
  }
  unbindConnection(connectionId: string): Promise<void> { return this.store.unbindConnection(connectionId) }
  listConnectionsForUser(userId: string): Promise<ConnectionBinding[]> { return this.store.listConnectionsForUser(userId) }
  listConnectionsForGrant(grantId: string): Promise<ConnectionBinding[]> { return this.store.listConnectionsForGrant(grantId) }

  /** Consume atómicamente (una sola transición linealizable). */
  async consume(presented: GrantPresentation, scope: GrantScopeQuery): Promise<GrantValidation> {
    const now = this.clock.now()
    // Fail-closed (C23·H2·P2): consume() es el camino activo de consumo de grants.
    // Con deuda de revocación durable pendiente para el usuario del scope, se
    // DENIEGA antes de reclamar (aunque el epoch de Redis todavía no se bumpeó).
    if (await this.revokeDebtBlocks(scope.userId)) {
      this.audit({ event: 'grant_rejected', grantId: presented.grantId, userId: scope.userId, cameraId: scope.cameraId, transport: scope.transport, reason: 'REVOKE_PENDING', at: now })
      return { ok: false, reason: 'REVOKE_PENDING' }
    }
    const result = await this.store.validateAndClaim({
      grantId: presented.grantId,
      presentedSecretHash: sha256Hex(presented.secret),
      scope, nowMs: now,
    })
    this.audit({
      event: result.ok ? 'grant_used' : (result.reason === 'EXPIRED' ? 'grant_expired' : 'grant_rejected'),
      grantId: presented.grantId, userId: scope.userId, cameraId: scope.cameraId, transport: scope.transport,
      reason: result.ok ? undefined : result.reason, at: now,
    })
    return result
  }

  /** Revoca un grant por id (best-effort, marca revokedAt). Owner check. */
  async revoke(grantId: string, byUserId?: string): Promise<boolean> {
    const stored = await this.store.getGrant(grantId)
    if (!stored) return false
    if (byUserId !== undefined && stored.userId !== byUserId) return false
    if (stored.revokedAt !== null) return false
    const now = this.clock.now()
    await this.store.markRevoked(grantId, now, Math.max(1, stored.expiresAt - now))
    this.audit({ event: 'grant_revoked', grantId, userId: stored.userId, cameraId: stored.cameraId, transport: stored.transport, at: now })
    return true
  }

  /**
   * Revocación DURABLE de todos los grants de un usuario (logout / permisos):
   * incrementa el epoch. FAIL-CLOSED: si el backend falla, devuelve 'failed'
   * (el llamador debe encolar retry y NO declarar revocación completa).
   */
  async revokeAllForUser(userId: string): Promise<RevokeAllOutcome> {
    try {
      const epoch = await this.store.bumpUserEpoch(userId)
      // Best-effort: además marca revokedAt en los grants del índice (acelera el
      // rechazo y facilita auditoría). El epoch ya es la verdad durable.
      try {
        const ids = await this.store.listIndex('user', userId)
        for (const id of ids) await this.revoke(id, userId)
      } catch { /* el epoch ya invalidó; esto es sólo cosmético */ }
      return { status: 'applied', epoch }
    } catch {
      return { status: 'failed' }
    }
  }

  private async revokeIndex(kind: 'view' | 'session', key: string, byUserId?: string): Promise<number> {
    const ids = await this.store.listIndex(kind, key)
    let n = 0
    for (const id of ids) { if (await this.revoke(id, byUserId)) n++ }
    return n
  }
  revokeByView(viewId: string, byUserId?: string): Promise<number> { return this.revokeIndex('view', viewId, byUserId) }
  revokeBySession(sessionId: string, byUserId?: string): Promise<number> { return this.revokeIndex('session', sessionId, byUserId) }

  /** A1·F0 — grantIds de un índice (para calcular el kick de conexiones vivas). */
  listGrantIdsForView(viewId: string): Promise<string[]> { return this.store.listIndex('view', viewId) }
  listGrantIdsForSession(sessionId: string): Promise<string[]> { return this.store.listIndex('session', sessionId) }

  async peek(grantId: string): Promise<StoredMediaGrant | null> { return this.store.getGrant(grantId) }

  // Lifecycle de fuente real (lo llamaría MediaMTX source add/remove en N1). En
  // C22.2 se usa desde pruebas y quedaría cableado al lifecycle real más adelante.
  registerSource(streamPath: string, ttlMs = 60_000): Promise<string> { return this.store.registerSource(streamPath, ttlMs) }
  refreshSource(streamPath: string, ttlMs = 90_000): Promise<void> { return this.store.refreshSource(streamPath, ttlMs) }
  retireSource(streamPath: string): Promise<void> { return this.store.retireSource(streamPath) }
  currentInstance(streamPath: string): Promise<string | null> { return this.store.currentInstance(streamPath) }
}

// ─── política de emisión (pura) ─────────────────────────────────────
export interface GrantIssuancePolicyInput {
  playbackEnabled: boolean
  relayReady: boolean
  transport: MediaTransport
  hasCameraAccess: boolean
}
export interface GrantIssuanceDecision { allow: boolean; httpStatus: number; code: string }

export function decideGrantIssuance(i: GrantIssuancePolicyInput): GrantIssuanceDecision {
  if (!i.playbackEnabled) return { allow: false, httpStatus: 404, code: 'NATIVE_PLAYBACK_DISABLED' }
  if (i.transport === 'rtsps' || i.transport === 'whep') {
    // relayReady unifica flag+secreto+atomicidad+salud+transporte (NativeRelayReadiness).
    if (!i.relayReady) return { allow: false, httpStatus: 503, code: 'NATIVE_RELAY_NOT_READY' }
    if (!i.hasCameraAccess) return { allow: false, httpStatus: 403, code: 'CAMERA_ACCESS_DENIED' }
    return { allow: true, httpStatus: 200, code: 'OK' }
  }
  return { allow: false, httpStatus: 400, code: 'TRANSPORT_NOT_SUPPORTED_HERE' }
}
