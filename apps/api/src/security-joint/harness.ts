// apps/api/src/security-joint/harness.ts
//
// Harness de la SUITE CONJUNTA de seguridad (#182 + #186 + #189 + #190). No es una
// prueba (el include de vitest es *.test.ts); lo usan los `*.joint.test.ts`.
//
// QUÉ ES REAL
//   - `server.ts` tal cual: se importa el módulo y su `main()` registra helmet,
//     CORS, rate-limit (store Redis), CSRF, cookies, JWT con `trusted` (#190),
//     todas las rutas, el WebSocket y ESCUCHA en 127.0.0.1 con puerto efímero.
//   - PostgreSQL efímero: un SCHEMA único `joint_<rand>` con el schema Prisma
//     versionado aplicado con `prisma db push --skip-generate` (binario local), y
//     DROP SCHEMA … CASCADE al terminar.
//   - Redis efímero: el de REDIS_TEST_URL con un `keyPrefix` único por corrida
//     (sesiones de WS, tickets, rate-limit, grants, tokens de descarga). Al final
//     se borran SÓLO las claves de ese prefijo; nunca FLUSHDB. Así ningún contador
//     de rate-limit de una corrida previa influye en ésta.
//   - Usuarios con hash bcrypt real, NVR con la contraseña cifrada por la función
//     real, permisos reales, MFA con el secreto guardado como lo guarda el código
//     (`generateTotpSecret`, base32 en claro) y TOTP generado con otplib.
//   - Tokens SIEMPRE emitidos por las rutas reales (login, 2fa/verify, refresh,
//     step-up, enrolamiento). El navegador simulado mantiene un tarro de cookies
//     (Set-Cookie → Cookie, respetando Path y borrado) y manda las cabeceras que
//     manda apps/web (Origin en mutaciones same-origin, JSON, sin Authorization).
//
// QUÉ SE SIMULA (ver infra-doubles.ts): MediaMTX, FFmpeg, sondas RTSP, ISAPI del
// NVR, jobs en segundo plano y el re-registro diferido de streams. Un centinela de
// red bloquea y registra cualquier conexión saliente que no sea loopback. Con
// `nativeRelay` (flags del plano de medios SÓLO en esa corrida) el expulsor de
// conexiones de MediaMTX es un espía en memoria (`kicked`); el auth-hook, los grants
// y el outbox de revocación son los reales, sobre el Redis/PG efímeros.
//
// GUARDAS: igual que `pg-real-harness.ts`/`redis-real-harness.ts`. Con
// REQUIRE_REAL_PG=1 / REQUIRE_REAL_REDIS=1 y sin servicio, la suite FALLA (no se
// omite). Las operaciones destructivas exigen loopback + PG_TEST_DISPOSABLE=1 /
// REDIS_TEST_DISPOSABLE=1. Ningún mensaje incluye hosts ni credenciales.

import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import Redis from 'ioredis'
import WebSocket from 'ws'
import { generate as generateOtp } from 'otplib'
import { PrismaClient, type Role } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { assertDestructiveTestAllowed } from '../services/media/test-host-guard'
import { encryptNvrPassword } from '../services/credentials'
import { generateTotpSecret } from '../services/totp'

// ─── Constantes de la suite (ficticias) ───────────────────────────────────────
/** Host público simulado. nginx reenvía `Host $host` y el navegador manda este Origin. */
export const JOINT_HOST = 'vms.example.test'
export const JOINT_ORIGIN = `https://${JOINT_HOST}`
/** Contraseña de TODOS los usuarios sembrados (ficticia). */
export const JOINT_PASSWORD = 'Clave-de-prueba-conjunta-2026!'
/** Credenciales del NVR simulado (ficticias; se guardan cifradas con la función real). */
export const NVR_FAKE_USER = 'usuario-falso'
export const NVR_FAKE_PASS = 'clave-falsa-nvr'
/** IP de nginx en la red interna (bridge de docker) — origen de /internal/hls-auth. */
export const NGINX_INTERNAL_IP = '127.0.0.1'

const API_ROOT = path.resolve(__dirname, '../..')
const SCHEMA_PRISMA = path.resolve(API_ROOT, '../../prisma/schema.prisma')
const PRISMA_BIN = path.resolve(API_ROOT, 'node_modules/.bin/prisma')
const REREGISTER_DELAY_MS = 5000

// ─── Disponibilidad de infraestructura ────────────────────────────────────────

/**
 * ¿Hay PostgreSQL y Redis reales para la suite? Si el entorno los EXIGE
 * (REQUIRE_REAL_PG=1 / REQUIRE_REAL_REDIS=1) y faltan, LANZA: la suite falla en
 * vez de omitirse en silencio (mismo contrato que pg-real-harness).
 */
export function jointInfraAvailable(): boolean {
  const havePg = !!process.env.DATABASE_URL_TEST
  const haveRedis = !!process.env.REDIS_TEST_URL
  if (!havePg && process.env.REQUIRE_REAL_PG === '1') {
    throw new Error('REQUIRE_REAL_PG=1 pero no hay DATABASE_URL_TEST (Postgres efímero real). La suite conjunta no puede omitirse.')
  }
  if (!haveRedis && process.env.REQUIRE_REAL_REDIS === '1') {
    throw new Error('REQUIRE_REAL_REDIS=1 pero no hay REDIS_TEST_URL (Redis efímero real). La suite conjunta no puede omitirse.')
  }
  return havePg && haveRedis
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

export async function waitFor<T>(
  probe: () => T | Promise<T>, what: string, timeoutMs = 10_000, intervalMs = 25,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v) return v as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`)
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

/** Claims de un JWT SIN verificar firma (sólo para inspección en las pruebas). */
export function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

/**
 * Firma HS256 a mano con el secreto EFÍMERO de la suite. Sólo para tokens que las
 * rutas reales no emiten por diseño (forma previa a #190, step-up vencido).
 */
export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(payload)
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/** TOTP actual para un secreto base32 (otplib, compatible con la verificación real). */
export async function totpNow(secret: string): Promise<string> {
  return generateOtp({ secret })
}

// ─── Cookies (Set-Cookie → tarro → Cookie) ────────────────────────────────────

export interface SetCookie {
  name: string
  value: string
  path?: string
  httpOnly: boolean
  secure: boolean
  sameSite?: string
  maxAge?: number
  expires?: Date
  raw: string
}

export function parseSetCookie(raw: string): SetCookie {
  const [pair, ...attrs] = raw.split(';').map(s => s.trim())
  const eq = pair.indexOf('=')
  const out: SetCookie = {
    name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)),
    httpOnly: false, secure: false, raw,
  }
  for (const a of attrs) {
    const [k, ...v] = a.split('=')
    const key = k.toLowerCase()
    const val = v.join('=')
    if (key === 'path') out.path = val
    else if (key === 'httponly') out.httpOnly = true
    else if (key === 'secure') out.secure = true
    else if (key === 'samesite') out.sameSite = val
    else if (key === 'max-age') out.maxAge = Number(val)
    else if (key === 'expires') out.expires = new Date(val)
  }
  return out
}

/** RFC 6265 §5.1.4: ¿el Path de la cookie cubre la ruta pedida? */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

export interface JointResponse {
  status: number
  headers: Record<string, string | string[] | number | undefined>
  text: string
  setCookies: SetCookie[]
  json<T = any>(): T
}

function setCookieHeaders(headers: JointResponse['headers']): string[] {
  const v = headers['set-cookie']
  if (!v) return []
  return Array.isArray(v) ? v.map(String) : [String(v)]
}

// ─── Centinela de red: sólo loopback ──────────────────────────────────────────

function isLoopbackHost(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host) || host === '::ffff:127.0.0.1'
}

interface NetSentinel { blocked: string[]; uninstall(): void }

/**
 * Bloquea (y registra) cualquier conexión TCP saliente que no sea loopback: si un
 * doble faltara, ninguna llamada alcanzaría un NVR, MediaMTX ni servidor real.
 * Se registra sólo el host (nunca credenciales).
 */
function installNetSentinel(): NetSentinel {
  const proto = net.Socket.prototype as any
  const realConnect = proto.connect
  const blocked: string[] = []
  proto.connect = function patchedConnect(this: net.Socket, ...args: any[]) {
    let opts: any = args[0]
    if (Array.isArray(opts)) opts = opts[0]
    let host: string | undefined
    let ipcPath: string | undefined
    if (opts && typeof opts === 'object') { host = opts.host; ipcPath = opts.path }
    else if (typeof opts === 'number' || (typeof opts === 'string' && /^\d+$/.test(opts))) host = typeof args[1] === 'string' ? args[1] : undefined
    else if (typeof opts === 'string') ipcPath = opts
    if (!ipcPath && !isLoopbackHost(host ?? 'localhost')) {
      blocked.push(String(host))
      const err = new Error('suite conjunta: conexión de red NO loopback bloqueada')
      process.nextTick(() => this.destroy(err))
      return this
    }
    return realConnect.apply(this, args)
  }
  return { blocked, uninstall: () => { proto.connect = realConnect } }
}

// ─── Entorno conjunto ─────────────────────────────────────────────────────────

export interface JointOptions {
  /** Etiqueta corta del archivo de pruebas (sólo para nombres de recursos). */
  label: string
  /** Flags opcionales: sólo para la corrida de la suite. */
  nativePlayback?: boolean
  /**
   * Plano de medios nativo COMPLETO sólo en esta corrida (NATIVE_PLAYBACK_ENABLED +
   * NATIVE_MEDIA_RELAY_ENABLED + MEDIA_RELAY_SECRET efímero). El kicker de MediaMTX
   * se reemplaza por un espía en memoria (`kicked`): no hay MediaMTX real.
   */
  nativeRelay?: boolean
  /** Variables extra (p. ej. NODE_ENV, JWT_SECRET) aplicadas DESPUÉS de los defaults; se restauran en stop(). */
  env?: Record<string, string>
}

export interface JointEnv {
  server: FastifyInstance
  port: number
  /** Cliente Prisma sobre el schema efímero (siembra y verificaciones). */
  prisma: PrismaClient
  schema: string
  redisPrefix: string
  jwtSecret: string
  tmpDir: string
  cacheDir: string
  /** Re-registros diferidos capturados durante el arranque (no se ejecutan). */
  deferredReregister: number
  /** Conexiones salientes bloqueadas por el centinela. */
  blockedConnections: string[]
  /** Secreto efímero del relay (sólo con `nativeRelay`). */
  relaySecret?: string
  /** connectionIds que el revoke→kick intentó expulsar (espía del kicker; sólo con `nativeRelay`). */
  kicked: string[]
  browser(name: string): SimBrowser
  /** Claves Redis (de ESTE prefijo) que matchean un patrón relativo. */
  redisKeys(pattern: string): Promise<string[]>
  /** Petición HTTP REAL por el socket TCP de 127.0.0.1:<port>. */
  tcp(method: string, url: string, headers?: Record<string, string>, body?: unknown): Promise<JointResponse>
  /** nginx: auth_request a /internal/hls-auth con la URI del request padre. */
  hlsAuth(uri: string, from?: HlsAuthFrom): Promise<JointResponse>
  /**
   * MediaMTX → auth-hook (/internal/mediamtx/auth) con el grant que presenta el
   * lector (RTSP user/password), como lo haría `authHTTPAddress`. Sólo con `nativeRelay`.
   */
  mediamtxAuth(grant: { grantId: string; secret: string }, streamPath: string, connectionId: string, remoteAddress?: string): Promise<JointResponse>
  openWs(ticket: string | undefined): Promise<WsHandle>
  // Siembra
  createNvr(name: string, ip: string): Promise<{ id: string; name: string }>
  createCamera(nvrId: string, channel: number, codecs?: { main?: string; sub?: string }): Promise<{ id: string; channel: number }>
  createUser(username: string, role: Role, extra?: Record<string, unknown>): Promise<{ id: string; username: string }>
  createMfaUser(username: string, role: Role): Promise<{ id: string; username: string; secret: string }>
  grant(userId: string, nvrId: string, cameraId: string | null, perms: Record<string, boolean>): Promise<void>
  setSecurity(data: Record<string, unknown>): Promise<void>
  stop(): Promise<void>
}

export interface HlsAuthFrom {
  /** Navegador cuyo tarro aporta la cookie (como la reenvía nginx). */
  browser?: SimBrowser
  /** Valor crudo de la cookie access_token (si no se usa el tarro). */
  cookie?: string
  bearer?: string
  /** IP del par TCP (nginx interno por defecto). */
  remoteAddress?: string
  method?: 'GET' | 'HEAD'
}

export interface WsHandle {
  ws: WebSocket
  /** Resuelve con el código de cierre. */
  closed: Promise<number>
  messages: string[]
  /** true si llegó a abrirse. */
  opened: Promise<boolean>
}

type EnvSnapshot = Record<string, string | undefined>

const MANAGED_ENV = [
  'JWT_SECRET', 'NVR_CREDENTIAL_KEY', 'API_HOST', 'API_PORT', 'UPLOADS_DIR', 'DATABASE_URL', 'REDIS_URL',
  'RECORDINGS_CACHE_DIR', 'VOD_TEMP_DIR', 'NATIVE_PLAYBACK_ENABLED',
  // Se borran para que la corrida sea determinista (defaults del código):
  'CORS_ORIGINS', 'COOKIE_SECURE', 'JWT_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN',
  'NATIVE_MEDIA_RELAY_ENABLED', 'NATIVE_SOURCE_LIFECYCLE_ENABLED', 'MEDIA_RELAY_SECRET',
  'AI_EVENTS_ENABLED', 'ONVIF_ENABLED', 'HIK_CONNECT_ENABLED', 'SINGLE_ACTIVE_MEDIA_SESSION',
  'RECORDINGS_PREVIEW_PROBE', 'RECORDINGS_FORCE_TRANSCODE', 'RECORDINGS_PROGRESSIVE_MP4',
  'RECORDINGS_TRANSCODE_CRF', 'RECORDINGS_TRANSCODE_MAXRATE', 'RECORDINGS_TRANSCODE_MAX_WIDTH',
  'RECORDINGS_TRANSCODE_FPS', 'RECORDINGS_TRANSCODE_PRESET', 'RECORDINGS_TRANSCODE_BUFSIZE',
]

/** Todas las claves que matchean el glob `match` (SCAN completo, no bloqueante). */
async function scanMatch(admin: Redis, match: string): Promise<string[]> {
  const out: string[] = []
  let cursor = '0'
  do {
    const [next, keys] = await admin.scan(cursor, 'MATCH', match, 'COUNT', 500)
    cursor = next
    out.push(...keys)
  } while (cursor !== '0')
  return out
}
const scanPrefix = (admin: Redis, prefix: string) => scanMatch(admin, `${prefix}*`)

/** Borra SÓLO las claves de este prefijo (nunca FLUSHDB). */
async function deleteRedisPrefix(admin: Redis, prefix: string): Promise<void> {
  const keys = await scanPrefix(admin, prefix)
  for (let i = 0; i < keys.length; i += 500) await admin.unlink(...keys.slice(i, i + 500))
}

/**
 * Prepara PG/Redis efímeros, arranca el `server.ts` REAL y devuelve el entorno.
 * Llamar en `beforeAll` y `stop()` en `afterAll`.
 */
export async function startJointServer(opts: JointOptions): Promise<JointEnv> {
  const pgBase = process.env.DATABASE_URL_TEST
  const redisBase = process.env.REDIS_TEST_URL
  if (!pgBase || !redisBase) throw new Error('suite conjunta: faltan DATABASE_URL_TEST / REDIS_TEST_URL')
  // Guardas ANTES de conectar o escribir: loopback + señal explícita de desechable.
  assertDestructiveTestAllowed(pgBase, 'DATABASE_URL_TEST', 'PG_TEST_DISPOSABLE')
  assertDestructiveTestAllowed(redisBase, 'REDIS_TEST_URL', 'REDIS_TEST_DISPOSABLE')

  const rand = `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  const schema = `joint_${opts.label.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)}_${rand}`
  const redisPrefix = `vc_joint:${opts.label}:${process.pid.toString(36)}:${rand}:`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-joint-'))
  const cacheDir = path.join(tmpDir, 'cache')
  for (const d of ['uploads', 'cache', 'vod']) fs.mkdirSync(path.join(tmpDir, d), { recursive: true })

  // ── PostgreSQL: schema único + schema Prisma real ──
  const scoped = new URL(pgBase)
  scoped.searchParams.set('schema', schema)
  const scopedUrl = scoped.toString()
  const boot = new PrismaClient({ datasources: { db: { url: pgBase } } })
  try { await boot.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`) } finally { await boot.$disconnect() }
  const dropSchema = async () => {
    const c = new PrismaClient({ datasources: { db: { url: pgBase } } })
    try { await c.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally { await c.$disconnect() }
  }
  try {
    execFileSync(PRISMA_BIN, ['db', 'push', '--skip-generate', '--schema', SCHEMA_PRISMA], {
      cwd: API_ROOT,
      // CHECKPOINT_DISABLE: sin telemetría del CLI (nada de red salvo loopback).
      env: { ...process.env, DATABASE_URL: scopedUrl, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    })
  } catch (err) {
    await dropSchema().catch(() => undefined)
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '').split('\n').filter(l => !/postgres(ql)?:\/\//i.test(l)).slice(-5).join(' | ')
    throw new Error(`suite conjunta: prisma db push falló (${stderr})`)
  }
  const prisma = new PrismaClient({ datasources: { db: { url: scopedUrl } } })

  // ── Redis: prefijo único por corrida ──
  const redisUrl = new URL(redisBase)
  redisUrl.searchParams.set('keyPrefix', redisPrefix)
  const redisAdmin = new Redis(redisBase, { maxRetriesPerRequest: 2 })

  // ── Entorno del proceso (se restaura en stop) ──
  const saved: EnvSnapshot = Object.fromEntries(MANAGED_ENV.map(k => [k, process.env[k]]))
  for (const k of MANAGED_ENV) delete process.env[k]
  const jwtSecret = `joint-jwt-${randomBytes(32).toString('hex')}`
  process.env.JWT_SECRET = jwtSecret
  process.env.NVR_CREDENTIAL_KEY = `joint-nvr-${randomBytes(24).toString('hex')}`
  process.env.API_HOST = '127.0.0.1'
  process.env.API_PORT = '0'
  process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads')
  process.env.DATABASE_URL = scopedUrl
  process.env.REDIS_URL = redisUrl.toString()
  process.env.RECORDINGS_CACHE_DIR = cacheDir
  process.env.VOD_TEMP_DIR = path.join(tmpDir, 'vod')
  if (opts.nativePlayback || opts.nativeRelay) process.env.NATIVE_PLAYBACK_ENABLED = 'true'
  let relaySecret: string | undefined
  if (opts.nativeRelay) {
    relaySecret = `joint-relay-${randomBytes(24).toString('hex')}`
    process.env.NATIVE_MEDIA_RELAY_ENABLED = 'true'
    process.env.MEDIA_RELAY_SECRET = relaySecret
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!(k in saved)) saved[k] = process.env[k]
    process.env[k] = v
  }

  // ── process.exit espiado, señales y re-registro diferido capturados ──
  const realExit = process.exit
  const exitCalls: Array<number | string | null | undefined> = []
  process.exit = ((code?: number | string | null) => { exitCalls.push(code) }) as typeof process.exit
  const signalsBefore = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') }
  const realSetTimeout = globalThis.setTimeout
  let deferredReregister = 0
  globalThis.setTimeout = ((fn: (...a: unknown[]) => unknown, ms?: number, ...rest: unknown[]) => {
    if (ms === REREGISTER_DELAY_MS && /reRegisterStreams/.test(String(fn))) {
      deferredReregister++
      const fake = { ref() { return fake }, unref() { return fake }, hasRef: () => false, refresh() { return fake }, [Symbol.toPrimitive]: () => 0 }
      return fake as unknown as NodeJS.Timeout
    }
    return realSetTimeout(fn, ms, ...rest)
  }) as typeof setTimeout

  const sentinel = installNetSentinel()
  let server: FastifyInstance | undefined
  try {
    const mod = await import('../server')
    server = mod.server
    // Logs del servidor silenciados (JOINT_LOG_LEVEL=info para depurar).
    server.log.level = process.env.JOINT_LOG_LEVEL || 'silent'
    const booting = server
    await waitFor(() => {
      if (exitCalls.length > 0) throw new Error(`server.ts abortó el arranque (process.exit(${String(exitCalls[0])}))`)
      return booting.server.listening && process.listeners('SIGTERM').length > signalsBefore.SIGTERM.length
    }, 'arranque de server.ts', 30_000)
  } catch (err) {
    globalThis.setTimeout = realSetTimeout
    try { await server?.close() } catch { /* noop */ }
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      for (const l of process.listeners(sig)) {
        if (!signalsBefore[sig].includes(l)) process.removeListener(sig, l as (...a: unknown[]) => void)
      }
    }
    process.exit = realExit
    sentinel.uninstall()
    await prisma.$disconnect().catch(() => undefined)
    await dropSchema().catch(() => undefined)
    await deleteRedisPrefix(redisAdmin, redisPrefix).catch(() => undefined)
    redisAdmin.disconnect()
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    throw err
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  const app: FastifyInstance = server
  // Kicker de MediaMTX: espía en memoria (sin MediaMTX real). Inerte sin la flag.
  const kicked: string[] = []
  if (opts.nativeRelay) {
    const gs = await import('../services/media/grant-service')
    gs.setMediaKicker({ kick: async (connectionId: string) => { kicked.push(connectionId) } })
  }
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const pwHash = await bcrypt.hash(JOINT_PASSWORD, 4)
  let ipSeq = 10

  const env: JointEnv = {
    server: app, port, prisma, schema, redisPrefix, jwtSecret: process.env.JWT_SECRET!, tmpDir, cacheDir, deferredReregister,
    blockedConnections: sentinel.blocked, relaySecret, kicked,

    browser(name: string) {
      ipSeq += 1
      // Cada navegador simulado tiene su propia IP pública (TEST-NET-2, luego TEST-NET-3).
      const ip = ipSeq < 250 ? `198.51.100.${ipSeq}` : `203.0.113.${10 + ((ipSeq - 250) % 240)}`
      return new SimBrowser(env, name, ip)
    },

    async redisKeys(pattern: string) {
      return (await scanMatch(redisAdmin, `${redisPrefix}${pattern}`)).map(k => k.slice(redisPrefix.length))
    },

    tcp(method, url, headers = {}, body) {
      return new Promise<JointResponse>((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
        const req = http.request({
          host: '127.0.0.1', port, method, path: url,
          headers: {
            host: JOINT_HOST, ...headers,
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          },
        }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            const hdrs = res.headers as JointResponse['headers']
            resolve({ status: res.statusCode ?? 0, headers: hdrs, text, setCookies: setCookieHeaders(hdrs).map(parseSetCookie), json: () => JSON.parse(text) })
          })
        })
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
      })
    },

    async hlsAuth(uri, from = {}) {
      const headers: Record<string, string> = { host: JOINT_HOST, 'x-original-uri': uri }
      const cookie = from.browser ? from.browser.cookieHeaderFor(uri) : (from.cookie ? `access_token=${from.cookie}` : undefined)
      if (cookie) headers.cookie = cookie
      if (from.bearer) headers.authorization = `Bearer ${from.bearer}`
      const res = await app.inject({
        method: from.method ?? 'GET', url: '/internal/hls-auth', headers,
        remoteAddress: from.remoteAddress ?? NGINX_INTERNAL_IP,
      })
      return wrapInject(res)
    },

    async mediamtxAuth(grant, streamPath, connectionId, remoteAddress = NGINX_INTERNAL_IP) {
      const res = await app.inject({
        method: 'POST', url: '/internal/mediamtx/auth', remoteAddress,
        headers: { 'x-media-relay-secret': relaySecret ?? '' },
        payload: { user: grant.grantId, password: grant.secret, action: 'read', path: streamPath, protocol: 'rtsps', id: connectionId },
      })
      return wrapInject(res)
    },

    openWs(ticket) {
      const q = ticket === undefined ? '' : `?ticket=${encodeURIComponent(ticket)}`
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/alerts${q}`, { headers: { host: JOINT_HOST, origin: JOINT_ORIGIN } })
      const messages: string[] = []
      ws.on('message', (d: WebSocket.RawData) => messages.push(d.toString()))
      ws.on('error', () => undefined)
      const opened = new Promise<boolean>((resolve) => {
        ws.once('open', () => resolve(true))
        ws.once('close', () => resolve(false))
      })
      const closed = new Promise<number>((resolve) => ws.once('close', (code: number) => resolve(code)))
      return Promise.resolve({ ws, closed, messages, opened })
    },

    async createNvr(name, ip) {
      const nvr = await prisma.nVR.create({ data: {
        name, model: 'DS-SIMULADO', ipAddress: ip, username: NVR_FAKE_USER,
        password: encryptNvrPassword(NVR_FAKE_PASS), online: true, active: true,
      } })
      return { id: nvr.id, name: nvr.name }
    },

    async createCamera(nvrId, channel, codecs = {}) {
      const cam = await prisma.camera.create({ data: {
        nvrId, channel, name: `Cam ${channel}`, mainCodec: codecs.main ?? 'h264', subCodec: codecs.sub ?? 'h264',
        rtspSubOk: true, rtspMainOk: true, streamHealthStatus: 'HEALTHY', online: true, active: true,
        ipAddress: `198.51.100.${200 + channel}`, rtspUrl: `rtsp://198.51.100.${200 + channel}:554/Streaming/Channels/101`,
      } })
      return { id: cam.id, channel: cam.channel }
    },

    async createUser(username, role, extra = {}) {
      const u = await prisma.user.create({ data: {
        username, email: `${username}@example.test`, fullName: username, passwordHash: pwHash, role, ...extra,
      } })
      return { id: u.id, username: u.username }
    },

    async createMfaUser(username, role) {
      // Igual que GET /2fa/setup + /2fa/enable: secreto base32 de generateTotpSecret().
      const secret = generateTotpSecret()
      const u = await env.createUser(username, role, { twoFactorEnabled: true, twoFactorSecret: secret })
      return { ...u, secret }
    },

    async grant(userId, nvrId, cameraId, perms) {
      await prisma.userPermission.create({ data: { userId, nvrId, cameraId, ...perms } })
    },

    async setSecurity(data) {
      await prisma.securitySettings.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', ...data },
        update: data,
      })
    },

    async stop() {
      const problems: string[] = []
      try { await app.close() } catch (e) { problems.push(`close: ${(e as Error).message}`) }
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        for (const l of process.listeners(sig)) {
          if (!signalsBefore[sig].includes(l)) process.removeListener(sig, l as (...a: unknown[]) => void)
        }
      }
      process.exit = realExit
      sentinel.uninstall()
      try { await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } catch (e) { problems.push(`drop: ${(e as Error).message}`) }
      await prisma.$disconnect().catch(() => undefined)
      try { await deleteRedisPrefix(redisAdmin, redisPrefix) } catch (e) { problems.push(`redis: ${(e as Error).message}`) }
      // Verificación: ni schema ni claves colgando.
      const check = new PrismaClient({ datasources: { db: { url: pgBase } } })
      try {
        const rows = await check.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM information_schema.schemata WHERE schema_name = ${schema}`
        if (Number(rows[0]?.n ?? 0) !== 0) problems.push('quedó el schema efímero')
      } finally { await check.$disconnect() }
      const leftover = await scanPrefix(redisAdmin, redisPrefix)
      if (leftover.length > 0) problems.push(`quedaron ${leftover.length} claves Redis del prefijo`)
      redisAdmin.disconnect()
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* noop */ }
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
      if (exitCalls.length > 0) problems.push(`server.ts llamó process.exit(${String(exitCalls[0])})`)
      if (problems.length > 0) throw new Error(`suite conjunta — limpieza incompleta: ${problems.join('; ')}`)
    },
  }
  return env
}

function wrapInject(res: { statusCode: number; headers: Record<string, any>; body: string }): JointResponse {
  const headers = res.headers as JointResponse['headers']
  return {
    status: res.statusCode, headers, text: res.body,
    setCookies: setCookieHeaders(headers).map(parseSetCookie),
    json: () => JSON.parse(res.body),
  }
}

// ─── Navegador simulado ───────────────────────────────────────────────────────

interface StoredCookie { name: string; value: string; path: string; httpOnly: boolean; sameSite?: string; secure: boolean }

export interface BrowserRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  /** Origin a enviar: por defecto el propio en mutaciones (como un fetch same-origin); null = ninguno. */
  origin?: string | null
}

/**
 * Navegador same-origin: tarro de cookies que respeta Path y el borrado por
 * Expires/Max-Age; en POST/PUT/PATCH/DELETE agrega `Origin` (lo hace el navegador
 * en todo fetch/XHR same-origin con método no seguro); cuerpo JSON como apps/web;
 * NUNCA `Authorization` (el web autentica sólo por cookie HttpOnly).
 */
export class SimBrowser {
  private readonly jar = new Map<string, StoredCookie>()
  constructor(private readonly env: JointEnv, readonly name: string, readonly ip: string) {}

  /** Cabecera Cookie que el navegador enviaría a `url` (respeta Path). */
  cookieHeaderFor(url: string): string | undefined {
    const reqPath = url.split('?')[0]
    const parts: string[] = []
    const sorted = [...this.jar.values()].sort((a, b) => b.path.length - a.path.length)
    for (const c of sorted) if (pathMatches(c.path, reqPath)) parts.push(`${c.name}=${c.value}`)
    return parts.length > 0 ? parts.join('; ') : undefined
  }

  /** Valor de una cookie del tarro (sólo para las pruebas: JS de la página NO puede leer HttpOnly). */
  cookie(name: string, cookiePath = '/'): string | undefined {
    for (const c of this.jar.values()) if (c.name === name && (c.path === cookiePath || cookiePath === '*')) return c.value
    return undefined
  }

  get accessToken(): string | undefined { return this.cookie('access_token', '/') }
  get refreshToken(): string | undefined { return this.cookie('refresh_token', '/api/auth') }

  /** Planta una cookie a mano (p. ej. un token intermedio en access_token). */
  plantCookie(name: string, value: string, cookiePath = '/'): void {
    this.jar.set(`${name}\u0000${cookiePath}`, { name, value, path: cookiePath, httpOnly: true, secure: false })
  }

  clearCookies(): void { this.jar.clear() }

  private absorb(setCookies: SetCookie[]): void {
    const now = Date.now()
    for (const c of setCookies) {
      const p = c.path ?? '/'
      const key = `${c.name}\u0000${p}`
      const expired = (c.maxAge !== undefined && c.maxAge <= 0) || (c.expires !== undefined && c.expires.getTime() <= now) || c.value === ''
      if (expired) { this.jar.delete(key); continue }
      this.jar.set(key, { name: c.name, value: c.value, path: p, httpOnly: c.httpOnly, sameSite: c.sameSite, secure: c.secure })
    }
  }

  async request(method: string, url: string, o: BrowserRequestOptions = {}): Promise<JointResponse> {
    const upper = method.toUpperCase()
    const headers: Record<string, string> = { host: JOINT_HOST, 'user-agent': `Mozilla/5.0 (X11; Linux x86_64) SimBrowser/${this.name}`, ...(o.headers ?? {}) }
    const cookie = this.cookieHeaderFor(url)
    if (cookie && headers.cookie === undefined) headers.cookie = cookie
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(upper)
    const origin = o.origin === undefined ? (mutating ? JOINT_ORIGIN : undefined) : o.origin
    if (origin) headers.origin = origin
    const res = await this.env.server.inject({
      method: upper as any, url, headers, remoteAddress: this.ip,
      ...(o.body !== undefined ? { payload: o.body as any } : {}),
    })
    const wrapped = wrapInject(res)
    this.absorb(wrapped.setCookies)
    return wrapped
  }

  get(url: string, o: BrowserRequestOptions = {}) { return this.request('GET', url, o) }
  post(url: string, body?: unknown, o: BrowserRequestOptions = {}) { return this.request('POST', url, { ...o, body }) }
  put(url: string, body?: unknown, o: BrowserRequestOptions = {}) { return this.request('PUT', url, { ...o, body }) }
  del(url: string, o: BrowserRequestOptions = {}) { return this.request('DELETE', url, o) }

  // ── Flujos de apps/web ──
  login(username: string, password = JOINT_PASSWORD, rememberMe = true) {
    return this.post('/api/auth/login', { username, password, rememberMe })
  }
  verify2fa(tempToken: string, code: string, rememberMe = true) {
    return this.post('/api/auth/2fa/verify', { tempToken, code, rememberMe })
  }
  /** Login completo (con TOTP si el usuario tiene MFA). Falla si no termina con cookies. */
  async signIn(username: string, totpSecret?: string): Promise<void> {
    const r = await this.login(username)
    if (r.status !== 200) throw new Error(`login ${username}: ${r.status}`)
    if (r.json().requiresTwoFactor) {
      if (!totpSecret) throw new Error(`login ${username}: requiere 2FA`)
      const v = await this.verify2fa(r.json().tempToken, await totpNow(totpSecret))
      if (v.status !== 200) throw new Error(`2fa ${username}: ${v.status}`)
    }
    if (!this.accessToken) throw new Error(`login ${username}: sin cookie access_token`)
  }
  heartbeat(viewId: string, visibleCameraIds: string[], o: BrowserRequestOptions = {}) {
    return this.post('/api/live-view/heartbeat', { viewId, visibleCameraIds }, o)
  }
  /** Como lib/websocket.ts: POST ws-ticket con la cookie y abre /ws/alerts?ticket=… */
  async openAlerts(): Promise<WsHandle> {
    const t = await this.post('/api/auth/ws-ticket')
    if (t.status !== 200) throw new Error(`ws-ticket ${this.name}: ${t.status}`)
    const h = await this.env.openWs(t.json().ticket)
    await h.opened
    return h
  }
}
