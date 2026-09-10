// apps/api/src/services/media/grant-store.lua.test.ts
//
// Track 3 — Validación de la RUTA LUA REAL de validateAndClaim. Ejecuta el script
// EXACTO (LUA_VALIDATE_AND_CLAIM, el mismo string que Redis corre con EVAL) sobre
// una VM Lua (wasmoon) con `redis`/`cjson`/KEYS/ARGV inyectados, y cruza su
// resultado contra `validateAndClaimReducer` (la lógica en TS) para cada motivo.
// Esto cierra el hueco "Lua NO VALIDADA": no reimplementa la lógica en JS, corre
// el Lua real.
//
// ALCANCE (honesto): valida la LÓGICA del script (control de flujo, cjson,
// comparaciones, EXISTS/SET). NO valida la atomicidad/linealizabilidad de EVAL en
// un Redis real (eso lo garantiza Redis, no nuestro código) — eso sigue requiriendo
// un servidor Redis, ausente en este entorno.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { LuaFactory } from 'wasmoon'
import {
  validateAndClaimReducer,
  LUA_VALIDATE_AND_CLAIM,
  type ClaimState,
} from './grant-store'
import type { StoredMediaGrant, ValidateAndClaimInput, GrantScopeQuery } from './contracts'

const HASH = 'sha256-hash-esperado'
const CLAIM_TTL = 5000

function baseGrant(over: Partial<StoredMediaGrant> = {}): StoredMediaGrant {
  return {
    grantId: 'g1', secretHash: HASH, userId: 'u1', viewId: 'v1', cameraId: 'cam1',
    streamPath: 'nvr_x_sub', codec: 'h264', transport: 'rtsps', action: 'read',
    effectiveType: 'sub', device: 'win', mediaInstanceId: 'mi-1', authorizationEpoch: 0,
    issuedAt: 0, expiresAt: 10_000, revokedAt: null, ...over,
  }
}
function scope(over: Partial<GrantScopeQuery> = {}): GrantScopeQuery {
  return { userId: 'u1', cameraId: 'cam1', streamPath: 'nvr_x_sub', transport: 'rtsps', action: 'read', ...over }
}
function input(over: Partial<ValidateAndClaimInput> = {}): ValidateAndClaimInput {
  return { grantId: 'g1', presentedSecretHash: HASH, scope: scope(), nowMs: 1000, ...over }
}
function stateFor(over: Partial<ClaimState> = {}): ClaimState {
  return { grant: baseGrant(), userEpoch: 0, currentInstance: 'mi-1', alreadyClaimed: false, ...over }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lua: any

async function runLua(state: ClaimState, inp: ValidateAndClaimInput): Promise<{ ok: boolean; reason?: string }> {
  const kG = 'K_G', kE = 'K_E', kI = 'K_I', kC = 'K_C'
  const store = new Map<string, string>()
  if (state.grant) store.set(kG, JSON.stringify(state.grant))
  store.set(kE, String(state.userEpoch))
  if (state.currentInstance !== null && state.currentInstance !== undefined) store.set(kI, state.currentInstance)
  if (state.alreadyClaimed) store.set(kC, '1')

  // redis.call con semántica de Redis: GET de clave ausente devuelve `false` (no nil).
  // TIME es el reloj autoritativo que ahora usa el script (no un Date.now() de Node):
  // se deriva de inp.nowMs para conservar la paridad con el reducer (que usa nowMs).
  lua.global.set('redis', {
    call: (cmd: string, ...args: unknown[]) => {
      const c = String(cmd).toUpperCase()
      if (c === 'TIME') return [Math.floor(inp.nowMs / 1000), (inp.nowMs % 1000) * 1000]
      const key = String(args[0])
      if (c === 'GET') return store.has(key) ? store.get(key) : false
      if (c === 'EXISTS') return store.has(key) ? 1 : 0
      if (c === 'SET') { store.set(key, String(args[1])); return 'OK' }
      throw new Error('cmd redis inesperado: ' + c)
    },
  })
  // cjson real mapea JSON null → cjson.null (sentinela), NO a nil. Se replica con
  // un reviver: además evita pasar `null` JS a wasmoon (que rompe su marshalling).
  const CJSON_NULL = '__CJSON_NULL_SENTINEL__'
  lua.global.set('cjson', {
    encode: (t: unknown) => JSON.stringify(t),
    decode: (s: string) => JSON.parse(s, (_k, v) => (v === null ? CJSON_NULL : v)),
    null: CJSON_NULL,
  })
  // KEYS/ARGV 1-indexados construidos en el preámbulo desde escalares (sin ambigüedad 0/1).
  lua.global.set('k1', kG); lua.global.set('k2', kE); lua.global.set('k3', kI); lua.global.set('k4', kC)
  const s = inp.scope
  lua.global.set('a1', s.userId); lua.global.set('a2', s.cameraId); lua.global.set('a3', s.streamPath)
  lua.global.set('a4', s.transport); lua.global.set('a5', s.action); lua.global.set('a6', inp.presentedSecretHash)
  lua.global.set('a7', String(inp.nowMs)); lua.global.set('a8', String(CLAIM_TTL))

  const preamble = 'local KEYS = { k1, k2, k3, k4 }\nlocal ARGV = { a1, a2, a3, a4, a5, a6, a7, a8 }\n'
  const raw = await lua.doString(preamble + LUA_VALIDATE_AND_CLAIM)
  return JSON.parse(String(raw)) as { ok: boolean; reason?: string }
}

interface Case { name: string; state: ClaimState; input: ValidateAndClaimInput; expected: string | 'OK' }
const CASES: Case[] = [
  { name: 'happy (ok)',        state: stateFor(),                              input: input(),                              expected: 'OK' },
  { name: 'NOT_FOUND',         state: stateFor({ grant: null }),               input: input(),                              expected: 'NOT_FOUND' },
  { name: 'REVOKED',           state: stateFor({ grant: baseGrant({ revokedAt: 500 }) }), input: input(),                    expected: 'REVOKED' },
  { name: 'EXPIRED',           state: stateFor(),                              input: input({ nowMs: 20_000 }),             expected: 'EXPIRED' },
  { name: 'SCOPE_MISMATCH',    state: stateFor(),                              input: input({ scope: scope({ cameraId: 'otra' }) }), expected: 'SCOPE_MISMATCH' },
  { name: 'EPOCH_MISMATCH',    state: stateFor({ userEpoch: 1 }),              input: input(),                              expected: 'EPOCH_MISMATCH' },
  { name: 'INSTANCE_REQUIRED', state: stateFor({ currentInstance: null }),     input: input(),                              expected: 'INSTANCE_REQUIRED' },
  { name: 'INSTANCE_MISMATCH', state: stateFor({ currentInstance: 'mi-2' }),   input: input(),                              expected: 'INSTANCE_MISMATCH' },
  { name: 'SECRET_MISMATCH',   state: stateFor(),                              input: input({ presentedSecretHash: 'wrong' }), expected: 'SECRET_MISMATCH' },
  { name: 'REPLAYED',          state: stateFor({ alreadyClaimed: true }),      input: input(),                              expected: 'REPLAYED' },
  // Orden: revocado Y vencido ⇒ REVOKED (revocación se chequea primero, igual que el reducer).
  { name: 'orden REVOKED>EXPIRED', state: stateFor({ grant: baseGrant({ revokedAt: 500 }) }), input: input({ nowMs: 20_000 }), expected: 'REVOKED' },
]

describe('LUA_VALIDATE_AND_CLAIM real (wasmoon) ↔ validateAndClaimReducer', () => {
  beforeAll(async () => { lua = await new LuaFactory().createEngine({ enableProxy: false }) })
  afterAll(() => { try { lua?.global?.close?.() } catch { /* noop */ } })

  for (const c of CASES) {
    it(`${c.name}: Lua real == reducer == esperado`, async () => {
      const red = validateAndClaimReducer(c.state, c.input).result
      const redReason = red.ok ? 'OK' : red.reason
      const luaRes = await runLua(c.state, c.input)
      const luaReason = luaRes.ok ? 'OK' : luaRes.reason
      // El Lua real coincide con lo esperado…
      expect(luaReason).toBe(c.expected)
      // …y con el reducer (paridad TS↔Lua).
      expect(luaReason).toBe(redReason)
    })
  }
})
