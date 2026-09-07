// apps/api/src/services/media/grant-store.ts
//
// Almacén de grants con TRANSICIÓN ATÓMICA ÚNICA (C22.2). Corrige las carreras
// TOCTOU de C22.1: consume ya no hace get→validate→claim como pasos separados.
//
//   - `validateAndClaim`: relee grant + epoch de usuario + instancia de fuente +
//     estado de uso y, en la MISMA operación linealizable, valida y marca el uso.
//     Memoria: método síncrono (atómico en el event loop de un solo hilo). Redis:
//     script Lua vía EVAL (una sola operación linealizable en el servidor).
//   - Revocación durable por EPOCH de autorización por usuario (logout/permisos
//     lo incrementan). Un grant con epoch viejo no valida aunque su índice se
//     haya escrito tarde. `bumpUserEpoch` FALLA si el backend está caído (no se
//     traga una revocación de seguridad).
//   - Registro de INSTANCIA de fuente real por path (sub/main/main_h264):
//     `registerSource`/`retireSource` la crean/rotan/eliminan junto al lifecycle
//     de MediaMTX. `issue` NO inventa una instancia: si no hay fuente vigente,
//     se niega. Recrear la fuente rota la generación e invalida grants viejos.
//
// TIEMPO AUTORITATIVO (C23·H2·P1): del lado Redis el tiempo NO se captura en Node
// antes del EVAL. Los scripts leen `redis.call('TIME')` en el MISMO punto de
// linealización y comparan expiración / fijan el TTL del claim contra ese reloj.
// La EMISIÓN también fija `issuedAt`/`expiresAt` con Redis-time dentro del script
// ISSUE_GRANT, de modo que emisión, validación y TTL del claim viven en un dominio
// temporal COHERENTE (todo Redis-time). Node ya no aporta el instante de decisión.
// `MemoryGrantStore` conserva su reloj inyectable para las pruebas unitarias.
//
// El backend Redis se ejecuta contra Redis real. La LÓGICA del script Lua real
// (LUA_VALIDATE_AND_CLAIM) se valida en una VM Lua (grant-store.lua.test.ts, wasmoon)
// cruzando su resultado contra validateAndClaimReducer, y la ATOMICIDAD +
// expiración por reloj de Redis se validan contra un `redis-server` REAL efímero
// en grant-store.redis.int.test.ts.

import type { StoredMediaGrant, GrantRejectReason, GrantScopeQuery, ConnectionBinding } from './contracts'

export type IndexKind = 'user' | 'view' | 'session'

export interface ClaimResult {
  ok: boolean
  reason?: GrantRejectReason
  grant?: StoredMediaGrant
}

export interface ValidateAndClaimInput {
  grantId: string
  presentedSecretHash: string
  scope: GrantScopeQuery
  nowMs: number
}

// ─── reducer PURO de la transición (misma lógica en memoria y en Lua) ──
export interface ClaimState {
  grant: StoredMediaGrant | null
  userEpoch: number
  currentInstance: string | null
  alreadyClaimed: boolean
}

/** Decisión atómica pura. `claim=true` ⇒ el llamador debe marcar el uso. */
export function validateAndClaimReducer(state: ClaimState, input: ValidateAndClaimInput): { result: ClaimResult; claim: boolean } {
  const g = state.grant
  if (!g) return { result: { ok: false, reason: 'NOT_FOUND' }, claim: false }
  if (g.revokedAt !== null) return { result: { ok: false, reason: 'REVOKED' }, claim: false }
  if (input.nowMs >= g.expiresAt) return { result: { ok: false, reason: 'EXPIRED' }, claim: false }
  const s = input.scope
  if (g.userId !== s.userId || g.cameraId !== s.cameraId || g.streamPath !== s.streamPath || g.transport !== s.transport || g.action !== s.action) {
    return { result: { ok: false, reason: 'SCOPE_MISMATCH' }, claim: false }
  }
  if (g.authorizationEpoch !== state.userEpoch) return { result: { ok: false, reason: 'EPOCH_MISMATCH' }, claim: false }
  if (state.currentInstance === null || state.currentInstance === undefined) return { result: { ok: false, reason: 'INSTANCE_REQUIRED' }, claim: false }
  if (g.mediaInstanceId !== state.currentInstance) return { result: { ok: false, reason: 'INSTANCE_MISMATCH' }, claim: false }
  if (g.secretHash !== input.presentedSecretHash) return { result: { ok: false, reason: 'SECRET_MISMATCH' }, claim: false }
  if (state.alreadyClaimed) return { result: { ok: false, reason: 'REPLAYED' }, claim: false }
  return { result: { ok: true, grant: g }, claim: true }
}

// A1 · F0 — Re-validación NO destructiva de un grant de SESIÓN de relay. Aplica
// EXACTAMENTE las mismas verificaciones que `validateAndClaimReducer`
// (REVOKED/EXPIRED/SCOPE/EPOCH/INSTANCE/SECRET) en el MISMO orden, pero SIN claim
// y SIN REPLAYED: una conexión de medios es larga y MediaMTX re-consulta el hook
// varias veces durante su vida; re-validar repetidamente debe seguir dando OK
// mientras el grant siga vigente. Nunca marca uso ⇒ nunca devuelve REPLAYED.
export interface SessionState {
  grant: StoredMediaGrant | null
  userEpoch: number
  currentInstance: string | null
}
export function validateSessionReducer(state: SessionState, input: ValidateAndClaimInput): { result: ClaimResult } {
  const g = state.grant
  if (!g) return { result: { ok: false, reason: 'NOT_FOUND' } }
  if (g.revokedAt !== null) return { result: { ok: false, reason: 'REVOKED' } }
  if (input.nowMs >= g.expiresAt) return { result: { ok: false, reason: 'EXPIRED' } }
  const s = input.scope
  if (g.userId !== s.userId || g.cameraId !== s.cameraId || g.streamPath !== s.streamPath || g.transport !== s.transport || g.action !== s.action) {
    return { result: { ok: false, reason: 'SCOPE_MISMATCH' } }
  }
  if (g.authorizationEpoch !== state.userEpoch) return { result: { ok: false, reason: 'EPOCH_MISMATCH' } }
  if (state.currentInstance === null || state.currentInstance === undefined) return { result: { ok: false, reason: 'INSTANCE_REQUIRED' } }
  if (g.mediaInstanceId !== state.currentInstance) return { result: { ok: false, reason: 'INSTANCE_MISMATCH' } }
  if (g.secretHash !== input.presentedSecretHash) return { result: { ok: false, reason: 'SECRET_MISMATCH' } }
  return { result: { ok: true, grant: g } }
}

export interface IssueIndices { viewId: string; sessionId?: string }

export interface GrantStore {
  /** true si el backend es atómico ENTRE PROCESOS (Redis). Memoria = false. */
  readonly crossProcessAtomic: boolean
  /** ¿El backend está operativo? (para readiness / fail-closed). */
  healthy(): Promise<boolean>

  /** Emite grant + índices de forma atómica. */
  issueGrant(grant: StoredMediaGrant, indices: IssueIndices, ttlMs: number): Promise<void>
  getGrant(grantId: string): Promise<StoredMediaGrant | null>

  /** Transición atómica única: valida y reclama el uso. */
  validateAndClaim(input: ValidateAndClaimInput): Promise<ClaimResult>

  /**
   * A1 · F0 — Valida un grant de SESIÓN de relay SIN consumirlo (no destructiva,
   * atómica, fail-closed). Relee grant+epoch+instancia y aplica el reducer de
   * sesión. Puede llamarse muchas veces durante la vida de la conexión.
   */
  validateSession(input: ValidateAndClaimInput): Promise<ClaimResult>

  /** A1 · F0 — Mapa conexión↔grant de sesiones de relay vivas (con TTL). */
  bindConnection(connectionId: string, grantId: string, userId: string, streamPath: string, ttlMs: number): Promise<void>
  unbindConnection(connectionId: string): Promise<void>
  listConnectionsForUser(userId: string): Promise<ConnectionBinding[]>
  listConnectionsForGrant(grantId: string): Promise<ConnectionBinding[]>

  /** Epoch de autorización por usuario (revocación durable). `bump` lanza si falla. */
  getUserEpoch(userId: string): Promise<number>
  bumpUserEpoch(userId: string): Promise<number>

  /** Revocación best-effort por índice (vista/sesión/grant). No es el epoch. */
  listIndex(kind: IndexKind, key: string): Promise<string[]>
  markRevoked(grantId: string, at: number, ttlMs: number): Promise<void>

  /** Instancia de fuente real por path. `issue` sólo la LEE (no mintea). */
  currentInstance(streamPath: string): Promise<string | null>
  /** El lifecycle real (MediaMTX source add) la crea/rota. Devuelve la nueva. */
  registerSource(streamPath: string, ttlMs: number): Promise<string>
  /**
   * Extiende el TTL de la instancia SIN rotarla (keepalive del reconcile). Rotar
   * en cada tick invalidaría grants vivos (INSTANCE_MISMATCH); `refresh` sólo
   * prolonga la vigencia de la MISMA instancia.
   */
  refreshSource(streamPath: string, ttlMs: number): Promise<void>
  /** El lifecycle real (source remove) la elimina. */
  retireSource(streamPath: string): Promise<void>
}

// ─── memoria (atómica dentro de un proceso) ─────────────────────────
export class MemoryGrantStore implements GrantStore {
  readonly crossProcessAtomic = false
  private grants = new Map<string, { g: StoredMediaGrant; exp: number }>()
  private claims = new Set<string>()
  private idx: Record<IndexKind, Map<string, Set<string>>> = { user: new Map(), view: new Map(), session: new Map() }
  private userEpochs = new Map<string, number>()
  private instances = new Map<string, string>()
  private instanceCounter = 0
  private up = true
  // A1 · F0 — bindings conexión↔grant (con expiración por TTL).
  private conns = new Map<string, { b: ConnectionBinding; exp: number }>()

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Para pruebas: simular backend caído. */
  setHealthy(v: boolean): void { this.up = v }
  async healthy(): Promise<boolean> { return this.up }

  private live(grantId: string): StoredMediaGrant | null {
    const e = this.grants.get(grantId)
    if (!e) return null
    if (this.clock() > e.exp) { this.grants.delete(grantId); return null }
    return e.g
  }

  async issueGrant(grant: StoredMediaGrant, indices: IssueIndices, ttlMs: number): Promise<void> {
    if (!this.up) throw new Error('grant store unavailable')
    // Atómico: sin await entre estas escrituras.
    this.grants.set(grant.grantId, { g: grant, exp: this.clock() + ttlMs })
    this.addIdx('user', grant.userId, grant.grantId)
    this.addIdx('view', indices.viewId, grant.grantId)
    if (indices.sessionId) this.addIdx('session', indices.sessionId, grant.grantId)
  }
  private addIdx(kind: IndexKind, key: string, grantId: string): void {
    let s = this.idx[kind].get(key)
    if (!s) { s = new Set(); this.idx[kind].set(key, s) }
    s.add(grantId)
  }

  async getGrant(grantId: string): Promise<StoredMediaGrant | null> { return this.live(grantId) }

  // Atómico: lee estado y marca el uso sin await intermedio.
  async validateAndClaim(input: ValidateAndClaimInput): Promise<ClaimResult> {
    if (!this.up) return { ok: false, reason: 'BACKEND_UNAVAILABLE' }
    const grant = this.live(input.grantId)
    const state: ClaimState = {
      grant,
      userEpoch: grant ? (this.userEpochs.get(grant.userId) ?? 0) : 0,
      currentInstance: grant ? (this.instances.get(grant.streamPath) ?? null) : null,
      alreadyClaimed: this.claims.has(input.grantId),
    }
    const { result, claim } = validateAndClaimReducer(state, input)
    if (claim) this.claims.add(input.grantId)
    return result
  }

  // A1 · F0 — no destructiva: relee estado y valida sin marcar uso.
  async validateSession(input: ValidateAndClaimInput): Promise<ClaimResult> {
    if (!this.up) return { ok: false, reason: 'BACKEND_UNAVAILABLE' }
    const grant = this.live(input.grantId)
    const state: SessionState = {
      grant,
      userEpoch: grant ? (this.userEpochs.get(grant.userId) ?? 0) : 0,
      currentInstance: grant ? (this.instances.get(grant.streamPath) ?? null) : null,
    }
    return validateSessionReducer(state, input).result
  }

  private liveConn(connectionId: string): ConnectionBinding | null {
    const e = this.conns.get(connectionId)
    if (!e) return null
    if (this.clock() > e.exp) { this.conns.delete(connectionId); return null }
    return e.b
  }
  async bindConnection(connectionId: string, grantId: string, userId: string, streamPath: string, ttlMs: number): Promise<void> {
    if (!this.up) throw new Error('grant store unavailable')
    this.conns.set(connectionId, { b: { connectionId, grantId, userId, streamPath }, exp: this.clock() + Math.max(1, ttlMs) })
  }
  async unbindConnection(connectionId: string): Promise<void> { this.conns.delete(connectionId) }
  async listConnectionsForUser(userId: string): Promise<ConnectionBinding[]> {
    const out: ConnectionBinding[] = []
    for (const id of [...this.conns.keys()]) { const b = this.liveConn(id); if (b && b.userId === userId) out.push(b) }
    return out
  }
  async listConnectionsForGrant(grantId: string): Promise<ConnectionBinding[]> {
    const out: ConnectionBinding[] = []
    for (const id of [...this.conns.keys()]) { const b = this.liveConn(id); if (b && b.grantId === grantId) out.push(b) }
    return out
  }

  async getUserEpoch(userId: string): Promise<number> {
    if (!this.up) throw new Error('grant store unavailable')
    return this.userEpochs.get(userId) ?? 0
  }
  async bumpUserEpoch(userId: string): Promise<number> {
    if (!this.up) throw new Error('grant store unavailable')
    const next = (this.userEpochs.get(userId) ?? 0) + 1
    this.userEpochs.set(userId, next)
    return next
  }

  async listIndex(kind: IndexKind, key: string): Promise<string[]> { return [...(this.idx[kind].get(key) ?? [])] }
  async markRevoked(grantId: string, at: number, ttlMs: number): Promise<void> {
    const g = this.live(grantId)
    if (g) this.grants.set(grantId, { g: { ...g, revokedAt: at }, exp: this.clock() + ttlMs })
  }

  async currentInstance(streamPath: string): Promise<string | null> { return this.instances.get(streamPath) ?? null }
  async registerSource(streamPath: string): Promise<string> {
    if (!this.up) throw new Error('grant store unavailable')
    const token = `mi-${++this.instanceCounter}`
    this.instances.set(streamPath, token)
    return token
  }
  // Memoria: el Map no tiene TTL, así que refrescar es un no-op (la instancia
  // persiste hasta retireSource/rotación). No rota el token: eso es lo esencial.
  async refreshSource(): Promise<void> { /* no-op: sin expiración en memoria */ }
  async retireSource(streamPath: string): Promise<void> { this.instances.delete(streamPath) }
}

// ─── Redis (atómico entre procesos, vía Lua) ────────────────────────
export interface RedisGrantClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', ttl: number, nx?: 'NX'): Promise<unknown>
  del(key: string): Promise<unknown>
  sadd(key: string, member: string): Promise<unknown>
  srem(key: string, member: string): Promise<unknown>
  smembers(key: string): Promise<string[]>
  pexpire(key: string, ttlMs: number): Promise<unknown>
  incr(key: string): Promise<number>
  ping(): Promise<unknown>
  /** EVAL de un script Lua. En producción es ioredis real; en tests, un fake equivalente. */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

const P = 'vc:mg:'
export const gk = (id: string) => `${P}grant:${id}`
export const ck = (id: string) => `${P}claim:${id}`
export const ik = (kind: IndexKind, key: string) => `${P}idx:${kind}:${key}`
export const ekk = (userId: string) => `${P}epoch:user:${userId}`
export const instk = (path: string) => `${P}inst:${path}`
const INSTANCE_COUNTER = `${P}instctr`
// Gracia de retención de la clave del grant más allá de su expiración lógica: la
// clave sobrevive lo suficiente para que un grant recién vencido devuelva EXPIRED
// (por el reloj de Redis) en vez de NOT_FOUND (desalojo del PX). Ver LUA_ISSUE_GRANT.
export const GRANT_KEY_GRACE_MS = 10_000
// A1 · F0 — claves del mapa conexión↔grant.
export const connk = (connectionId: string) => `${P}conn:${connectionId}`
export const connUserk = (userId: string) => `${P}idx:connuser:${userId}`
export const connGrantk = (grantId: string) => `${P}idx:conngrant:${grantId}`

// Script Lua de validateAndClaim (linealizable en el servidor Redis). Relee el
// grant, el epoch del usuario, la instancia de la fuente y el estado de uso, y
// marca el uso en la misma operación. El instante de decisión se obtiene DENTRO
// del script con `redis.call('TIME')` (reloj autoritativo de Redis), nunca de un
// `Date.now()` capturado en Node: así la expiración se juzga y el TTL del claim se
// fija en el mismo punto de linealización, sin ventana Node→EVAL ni deriva de
// reloj entre el API y Redis. Marcado con VALIDATE_AND_CLAIM para el fake.
//   ARGV[1..5]=scope(userId,cameraId,streamPath,transport,action) ARGV[6]=secretHash
export const LUA_VALIDATE_AND_CLAIM = `-- VALIDATE_AND_CLAIM
local g = redis.call('GET', KEYS[1])
if not g then return cjson.encode({ok=false, reason='NOT_FOUND'}) end
local grant = cjson.decode(g)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if grant.revokedAt ~= nil and grant.revokedAt ~= cjson.null then return cjson.encode({ok=false, reason='REVOKED'}) end
if now >= grant.expiresAt then return cjson.encode({ok=false, reason='EXPIRED'}) end
if grant.userId ~= ARGV[1] or grant.cameraId ~= ARGV[2] or grant.streamPath ~= ARGV[3] or grant.transport ~= ARGV[4] or grant.action ~= ARGV[5] then return cjson.encode({ok=false, reason='SCOPE_MISMATCH'}) end
local epoch = tonumber(redis.call('GET', KEYS[2]) or '0')
if grant.authorizationEpoch ~= epoch then return cjson.encode({ok=false, reason='EPOCH_MISMATCH'}) end
local inst = redis.call('GET', KEYS[3])
if not inst then return cjson.encode({ok=false, reason='INSTANCE_REQUIRED'}) end
if grant.mediaInstanceId ~= inst then return cjson.encode({ok=false, reason='INSTANCE_MISMATCH'}) end
if grant.secretHash ~= ARGV[6] then return cjson.encode({ok=false, reason='SECRET_MISMATCH'}) end
if redis.call('EXISTS', KEYS[4]) == 1 then return cjson.encode({ok=false, reason='REPLAYED'}) end
local claimTtl = grant.expiresAt - now
if claimTtl < 1 then claimTtl = 1 end
redis.call('SET', KEYS[4], '1', 'PX', claimTtl)
return cjson.encode({ok=true})`

// B2 — Script Lua de emisión ATÓMICA (linealizable en el servidor Redis). Antes
// eran `await` secuenciales: un crash entre el SET del grant y los SADD de índices
// dejaba un grant sin índice (o un índice sin grant), y la revocación por-índice
// (revokeByView/revokeBySession) podía no encontrarlo. EVAL agrupa todas las
// escrituras en una sola operación indivisible. Marcado ISSUE_GRANT para el fake.
//
// TIEMPO COHERENTE (C23·H2·P1): `issuedAt`/`expiresAt` se FIJAN aquí con el reloj
// de Redis (`redis.call('TIME')`), no con el `Date.now()` de Node que trae el JSON.
// Así la expiración que juzga VALIDATE_AND_CLAIM (también Redis-time) vive en el
// mismo dominio temporal que la emisión. La clave del grant sobrevive `keyPx`
// (= ttl lógico + gracia) para que un grant recién vencido devuelva EXPIRED por el
// reloj de Redis (no NOT_FOUND por desalojo del PX) en el punto de validación.
//   KEYS[1]=grant  KEYS[2]=idx:user  KEYS[3]=idx:view  KEYS[4]=idx:session
//   ARGV[1]=grantJSON ARGV[2]=ttlLogicoMs ARGV[3]=grantId(member)
//   ARGV[4]=hasSession('1'|'') ARGV[5]=userIdxExpireMs ARGV[6]=keyPxMs
export const LUA_ISSUE_GRANT = `-- ISSUE_GRANT
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[2])
local keyPx = tonumber(ARGV[6])
local grant = cjson.decode(ARGV[1])
grant.issuedAt = now
grant.expiresAt = now + ttl
redis.call('SET', KEYS[1], cjson.encode(grant), 'PX', keyPx)
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('SADD', KEYS[3], ARGV[3])
if ARGV[4] ~= '' then redis.call('SADD', KEYS[4], ARGV[3]) end
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[5]))
return 1`

// A1 · F0 — Script Lua de validación de SESIÓN (NO destructivo, linealizable).
// Idéntico a LUA_VALIDATE_AND_CLAIM salvo que NO comprueba ni marca el uso: no
// hay REPLAYED y no escribe el claim. Puede re-ejecutarse durante toda la vida de
// la conexión. Marcado VALIDATE_SESSION para el fake.
export const LUA_VALIDATE_SESSION = `-- VALIDATE_SESSION
local g = redis.call('GET', KEYS[1])
if not g then return cjson.encode({ok=false, reason='NOT_FOUND'}) end
local grant = cjson.decode(g)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if grant.revokedAt ~= nil and grant.revokedAt ~= cjson.null then return cjson.encode({ok=false, reason='REVOKED'}) end
if now >= grant.expiresAt then return cjson.encode({ok=false, reason='EXPIRED'}) end
if grant.userId ~= ARGV[1] or grant.cameraId ~= ARGV[2] or grant.streamPath ~= ARGV[3] or grant.transport ~= ARGV[4] or grant.action ~= ARGV[5] then return cjson.encode({ok=false, reason='SCOPE_MISMATCH'}) end
local epoch = tonumber(redis.call('GET', KEYS[2]) or '0')
if grant.authorizationEpoch ~= epoch then return cjson.encode({ok=false, reason='EPOCH_MISMATCH'}) end
local inst = redis.call('GET', KEYS[3])
if not inst then return cjson.encode({ok=false, reason='INSTANCE_REQUIRED'}) end
if grant.mediaInstanceId ~= inst then return cjson.encode({ok=false, reason='INSTANCE_MISMATCH'}) end
if grant.secretHash ~= ARGV[6] then return cjson.encode({ok=false, reason='SECRET_MISMATCH'}) end
return cjson.encode({ok=true})`

// A1 · F0 — bind atómico conexión↔grant + índices inversos (BIND_CONNECTION).
//   KEYS[1]=conn  KEYS[2]=idx:connuser  KEYS[3]=idx:conngrant
//   ARGV[1]=bindingJSON ARGV[2]=ttlMs ARGV[3]=connectionId(member)
export const LUA_BIND_CONNECTION = `-- BIND_CONNECTION
redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('SADD', KEYS[3], ARGV[3])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]))
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[2]))
return 1`

export class RedisGrantStore implements GrantStore {
  readonly crossProcessAtomic = true
  constructor(private readonly redis: RedisGrantClient) {}

  async healthy(): Promise<boolean> {
    try { await this.redis.ping(); return true } catch { return false }
  }

  async issueGrant(grant: StoredMediaGrant, indices: IssueIndices, ttlMs: number): Promise<void> {
    // Escrituras AGRUPADAS en una sola operación linealizable (EVAL): un crash no
    // puede dejar un grant sin índice. El epoch ya fue capturado en el grant.
    // `issuedAt`/`expiresAt` los FIJA el script con el reloj de Redis (Redis-time
    // coherente); el TTL de la CLAVE es el ttl lógico + gracia para que EXPIRED sea
    // observable por el reloj de Redis y no lo enmascare el desalojo del PX.
    const ttl = Math.max(1, Math.floor(ttlMs))
    const keyPx = ttl + GRANT_KEY_GRACE_MS
    const userExpire = Math.max(keyPx, 60_000)
    await this.redis.eval(
      LUA_ISSUE_GRANT, 4,
      gk(grant.grantId), ik('user', grant.userId), ik('view', indices.viewId), ik('session', indices.sessionId ?? '_'),
      JSON.stringify(grant), String(ttl), grant.grantId, indices.sessionId ? '1' : '', String(userExpire), String(keyPx),
    )
  }

  async getGrant(grantId: string): Promise<StoredMediaGrant | null> {
    const raw = await this.redis.get(gk(grantId))
    return raw ? (JSON.parse(raw) as StoredMediaGrant) : null
  }

  async validateAndClaim(input: ValidateAndClaimInput): Promise<ClaimResult> {
    try {
      const grant = await this.getGrant(input.grantId)
      const epochKey = grant ? ekk(grant.userId) : ekk('_')
      const instKey = grant ? instk(grant.streamPath) : instk('_')
      const raw = await this.redis.eval(
        LUA_VALIDATE_AND_CLAIM, 4,
        gk(input.grantId), epochKey, instKey, ck(input.grantId),
        input.scope.userId, input.scope.cameraId, input.scope.streamPath, input.scope.transport, input.scope.action,
        input.presentedSecretHash,
      )
      const parsed = JSON.parse(String(raw)) as { ok: boolean; reason?: GrantRejectReason }
      return parsed.ok ? { ok: true, grant: grant! } : { ok: false, reason: parsed.reason }
    } catch {
      return { ok: false, reason: 'BACKEND_UNAVAILABLE' }
    }
  }

  // A1 · F0 — no destructiva: EVAL del script de sesión (sin claim). Fail-closed.
  async validateSession(input: ValidateAndClaimInput): Promise<ClaimResult> {
    try {
      const grant = await this.getGrant(input.grantId)
      const epochKey = grant ? ekk(grant.userId) : ekk('_')
      const instKey = grant ? instk(grant.streamPath) : instk('_')
      const raw = await this.redis.eval(
        LUA_VALIDATE_SESSION, 3,
        gk(input.grantId), epochKey, instKey,
        input.scope.userId, input.scope.cameraId, input.scope.streamPath, input.scope.transport, input.scope.action,
        input.presentedSecretHash,
      )
      const parsed = JSON.parse(String(raw)) as { ok: boolean; reason?: GrantRejectReason }
      return parsed.ok ? { ok: true, grant: grant! } : { ok: false, reason: parsed.reason }
    } catch {
      return { ok: false, reason: 'BACKEND_UNAVAILABLE' }
    }
  }

  async bindConnection(connectionId: string, grantId: string, userId: string, streamPath: string, ttlMs: number): Promise<void> {
    const px = Math.max(1, ttlMs)
    const binding: ConnectionBinding = { connectionId, grantId, userId, streamPath }
    await this.redis.eval(
      LUA_BIND_CONNECTION, 3,
      connk(connectionId), connUserk(userId), connGrantk(grantId),
      JSON.stringify(binding), String(px), connectionId,
    )
  }
  async unbindConnection(connectionId: string): Promise<void> {
    const raw = await this.redis.get(connk(connectionId))
    if (raw) {
      const b = JSON.parse(raw) as ConnectionBinding
      await this.redis.srem(connUserk(b.userId), connectionId)
      await this.redis.srem(connGrantk(b.grantId), connectionId)
    }
    await this.redis.del(connk(connectionId))
  }
  private async resolveConns(ids: string[]): Promise<ConnectionBinding[]> {
    const out: ConnectionBinding[] = []
    for (const id of ids) {
      const raw = await this.redis.get(connk(id))
      if (raw) out.push(JSON.parse(raw) as ConnectionBinding)
    }
    return out
  }
  async listConnectionsForUser(userId: string): Promise<ConnectionBinding[]> {
    return this.resolveConns((await this.redis.smembers(connUserk(userId))) ?? [])
  }
  async listConnectionsForGrant(grantId: string): Promise<ConnectionBinding[]> {
    return this.resolveConns((await this.redis.smembers(connGrantk(grantId))) ?? [])
  }

  async getUserEpoch(userId: string): Promise<number> {
    const v = await this.redis.get(ekk(userId))
    return v ? parseInt(v, 10) : 0
  }
  async bumpUserEpoch(userId: string): Promise<number> {
    // INCR es atómico y durable; si Redis está caído, LANZA (no se traga).
    return this.redis.incr(ekk(userId))
  }

  async listIndex(kind: IndexKind, key: string): Promise<string[]> { return (await this.redis.smembers(ik(kind, key))) ?? [] }
  async markRevoked(grantId: string, at: number, ttlMs: number): Promise<void> {
    const g = await this.getGrant(grantId)
    if (g) await this.redis.set(gk(grantId), JSON.stringify({ ...g, revokedAt: at }), 'PX', Math.max(1, ttlMs))
  }

  async currentInstance(streamPath: string): Promise<string | null> { return this.redis.get(instk(streamPath)) }
  async registerSource(streamPath: string, ttlMs: number): Promise<string> {
    const token = `mi-${await this.redis.incr(INSTANCE_COUNTER)}`
    await this.redis.set(instk(streamPath), token, 'PX', Math.max(ttlMs, 60_000))
    return token
  }
  // PEXPIRE extiende el TTL de la MISMA instancia (no cambia el token). Si el
  // path ya no existe (vencido/retirado), PEXPIRE es no-op — el reconcile lo
  // re-registrará en la próxima pasada.
  async refreshSource(streamPath: string, ttlMs: number): Promise<void> { await this.redis.pexpire(instk(streamPath), Math.max(ttlMs, 60_000)) }
  async retireSource(streamPath: string): Promise<void> { await this.redis.del(instk(streamPath)) }
}

export function createGrantStore(redis: RedisGrantClient | null | undefined): GrantStore {
  return redis ? new RedisGrantStore(redis) : new MemoryGrantStore()
}
