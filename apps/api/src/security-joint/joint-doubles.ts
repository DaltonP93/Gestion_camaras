// apps/api/src/security-joint/joint-doubles.ts
//
// Dobles ADICIONALES de la suite conjunta extendida (#187, #191, #192, #193). No es
// una prueba: lo importan las fábricas de `vi.mock` de staging/nvr-audio/branding/
// profile-diag y las propias pruebas para leer el registro.
//
// harness.ts e infra-doubles.ts quedan CONGELADOS byte a byte (otros PRs llevan
// copias idénticas): lo nuevo vive acá y COMPONE esos dobles sin modificarlos
// (mismo registro `infra` para lo que ya existía; `joint` para lo nuevo).
//
// Qué agrega:
//   - ISAPI de configuración de canal EN MEMORIA (cliente HTTP de
//     services/nvr-config/hikvision): `axios.create` hacia un NVR de TEST-NET-1
//     devuelve un cliente simulado que exige Digest con las credenciales que el
//     NVR "conoce" (las ficticias de la suite) y guarda/sirve el XML del canal. El
//     guard SSRF real se conserva para todo host que NO sea TEST-NET-1.
//   - Salidas externas (SMTP por nodemailer, HTTP por axios fuera de loopback):
//     se registran y fallan sin red.
//   - node-cron: los jobs se CAPTURAN (no corren solos) para ejecutarlos a mano.
//   - ffprobe con el error REAL de Node (`Command failed: ffprobe … rtsp://usuario:
//     clave@ip…`) para que services/rtsp-probe y la redacción de #193 corran reales.
//   - MediaMTX con un `sourceMasked` en formato legado (`rtsp://usuario:***@ip…`).
//   - services/hikvision con lecturas REALES puntuales (p. ej. fetchChannelVideoConfig)
//     que, con axios doblado, van al ISAPI simulado con Digest: sin red y sin fixture.
//
// El registro guarda host/path/método; NUNCA usuario ni contraseña.
// Sin dependencia de vitest: este archivo también lo compila `tsc` (no es *.test.ts).
// El estado vive en globalThis para sobrevivir a `vi.resetModules()` (staging
// arranca más de un server.ts en el mismo archivo).

import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import util from 'node:util'
import {
  infra, parseRtspTarget, childProcessModuleDouble, streamModuleDouble, hikvisionModuleDouble,
} from './infra-doubles'

// ─── Registro propio ──────────────────────────────────────────────────────────

export type JointKind =
  | 'isapi.http'          // petición al ISAPI simulado (nvr-config)
  | 'outbound.smtp'       // nodemailer.createTransport / sendMail
  | 'outbound.http'       // axios hacia un host que no es loopback ni el NVR simulado
  | 'cron.schedule'       // job agendado por node-cron (capturado)

export interface JointCall { kind: JointKind; detail: Record<string, unknown>; seq: number }

export interface CapturedCronJob { expr: string; fn: () => unknown }

interface IsapiState {
  /** XML por `${host}:${port}${path}`. */
  docs: Map<string, string>
  /** Credenciales que acepta el NVR simulado (Digest). null ⇒ no exige auth. */
  accept: { username: string; password: string } | null
  nonces: Set<string>
}

class JointRecorder {
  readonly calls: JointCall[] = []
  readonly cron: CapturedCronJob[] = []
  readonly isapi: IsapiState = { docs: new Map(), accept: null, nonces: new Set() }
  /** Fuente "enmascarada" que devuelve getStreamDetails (formato legado). */
  legacySource: ((streamPath: string) => string | undefined) | null = null
  private seq = 0

  record(kind: JointKind, detail: Record<string, unknown> = {}): void {
    this.calls.push({ kind, detail, seq: ++this.seq })
  }
  mark(): number { return this.seq }
  of(kind: JointKind, since = 0): JointCall[] {
    return this.calls.filter(c => c.kind === kind && c.seq > since)
  }
  /** Peticiones al ISAPI simulado desde la marca (opcionalmente sólo un método). */
  isapiCalls(since = 0, method?: string): Array<{ method: string; host: string; path: string; authorized: boolean; body?: string }> {
    return this.of('isapi.http', since)
      .map(c => c.detail as { method: string; host: string; path: string; authorized: boolean; body?: string })
      .filter(d => !method || d.method === method)
  }
}

const REGISTRY_KEY = '__visioncoreJointDoubles__'
const g = globalThis as unknown as Record<string, JointRecorder | undefined>
export const joint: JointRecorder = g[REGISTRY_KEY] ?? (g[REGISTRY_KEY] = new JointRecorder())

// ─── Hosts ────────────────────────────────────────────────────────────────────

/** NVR simulado: SÓLO TEST-NET-1 (RFC 5737), nunca una LAN real. */
export function isSimulatedNvrHost(host: string): boolean {
  return /^192\.0\.2\.\d{1,3}$/.test(host)
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

function urlParts(raw: unknown, base?: string): { host: string; port: string; path: string } | null {
  try {
    const u = new URL(String(raw ?? ''), base)
    return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80'), path: u.pathname + u.search }
  } catch {
    return null
  }
}

// ─── services/net/nvr-host-guard: TEST-NET-1 simulado, el resto REAL ──────────

export function nvrHostGuardDouble<T extends Record<string, unknown>>(real: T): T {
  const realAssert = real.assertSafeNvrHostForUrl as (h: string) => string
  return {
    ...real,
    assertSafeNvrHostForUrl: (h: string) => (isSimulatedNvrHost(String(h)) ? String(h) : realAssert(h)),
  } as T
}

// ─── ISAPI simulado (cliente axios de nvr-config) ─────────────────────────────

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

function parseDigest(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[m[1]] = m[2] ?? m[3] ?? ''
  return out
}

/** ¿El Authorization Digest corresponde a las credenciales que acepta el NVR simulado? */
function digestOk(header: unknown, method: string, path: string): boolean {
  const acc = joint.isapi.accept
  if (!acc) return true
  if (typeof header !== 'string' || !/^Digest\s/i.test(header)) return false
  const d = parseDigest(header)
  if (d.username !== acc.username || !joint.isapi.nonces.has(d.nonce) || d.uri !== path) return false
  const ha1 = md5(`${acc.username}:${d.realm}:${acc.password}`)
  const ha2 = md5(`${method}:${d.uri}`)
  const expected = d.qop ? md5(`${ha1}:${d.nonce}:${d.nc}:${d.cnonce}:${d.qop}:${ha2}`) : md5(`${ha1}:${d.nonce}:${ha2}`)
  return d.response === expected
}

function httpError(status: number, config: any, headers: Record<string, string> = {}): Error {
  const err = new Error(`Request failed with status code ${status}`) as any
  err.response = { status, statusText: status === 401 ? 'Unauthorized' : 'Not Found', headers, data: '', config }
  err.config = config
  err.isAxiosError = true
  return err
}

function simIsapiClient(baseURL: string) {
  const base = urlParts(baseURL)!
  let onRejected: ((e: any) => any) | undefined
  const client: any = {
    defaults: { baseURL, headers: {} },
    interceptors: {
      request: { use: () => 0, eject: () => undefined },
      response: { use: (_ok: unknown, bad?: (e: any) => any) => { onRejected = bad; return 0 }, eject: () => undefined },
    },
    async request(config: any) {
      const method = String(config?.method ?? 'get').toUpperCase()
      const target = urlParts(config?.url ?? '/', `http://${base.host}:${base.port}`)!
      const headers = (config.headers ??= {})
      const authorized = digestOk(headers.Authorization ?? headers.authorization, method, target.path)
      const detail: Record<string, unknown> = { method, host: base.host, path: target.path, authorized }
      if (method === 'PUT' && authorized) detail.body = String(config.data ?? '')
      joint.record('isapi.http', detail)
      if (!authorized) {
        const nonce = randomBytes(8).toString('hex')
        joint.isapi.nonces.add(nonce)
        const err = httpError(401, config, { 'www-authenticate': `Digest realm="NVR-SIMULADO", nonce="${nonce}", qop="auth"` })
        if (onRejected) return onRejected(err)
        throw err
      }
      const key = `${base.host}:${base.port}${target.path}`
      if (method === 'GET') {
        const xml = joint.isapi.docs.get(key)
        if (xml === undefined) {
          const err = httpError(404, config)
          if (onRejected) return onRejected(err)
          throw err
        }
        return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/xml' }, data: xml, config }
      }
      if (method === 'PUT') {
        joint.isapi.docs.set(key, String(config.data ?? ''))
        return { status: 200, statusText: 'OK', headers: {}, data: '<ResponseStatus><statusCode>1</statusCode></ResponseStatus>', config }
      }
      const err = httpError(404, config)
      if (onRejected) return onRejected(err)
      throw err
    },
    get(url: string, cfg: any = {}) { return client.request({ ...cfg, headers: { ...(cfg.headers ?? {}) }, method: 'get', url }) },
    put(url: string, data?: unknown, cfg: any = {}) { return client.request({ ...cfg, headers: { ...(cfg.headers ?? {}) }, method: 'put', url, data }) },
    post(url: string, data?: unknown, cfg: any = {}) { return client.request({ ...cfg, headers: { ...(cfg.headers ?? {}) }, method: 'post', url, data }) },
  }
  return client
}

/** Clave del documento del ISAPI simulado para un NVR (host:puerto) y path. */
export function isapiDocKey(host: string, path: string, port = 80): string {
  return `${host}:${port}${path}`
}

function outboundRejection(method: string, host: string): Promise<never> {
  joint.record('outbound.http', { method, host })
  const err = new Error('suite conjunta: salida HTTP no loopback bloqueada (sin red)') as any
  err.code = 'ECONNREFUSED'
  return Promise.reject(err)
}

/**
 * axios: `create()` hacia un NVR de TEST-NET-1 ⇒ ISAPI simulado; hacia loopback ⇒
 * axios real; cualquier otro host ⇒ cliente que registra y rechaza. Las llamadas
 * directas (`axios.post(url)` de webhooks) fuera de loopback se registran y rechazan.
 */
export function axiosModuleDouble<T extends Record<string, unknown>>(real: T): T {
  const realDefault = ((real as any).default ?? real) as any
  const create = (cfg: any = {}) => {
    const p = urlParts(cfg?.baseURL ?? '')
    if (p && isSimulatedNvrHost(p.host)) return simIsapiClient(String(cfg.baseURL))
    if (p && !isLoopback(p.host)) {
      const blocked: any = {
        defaults: { baseURL: cfg.baseURL, headers: {} },
        interceptors: { request: { use: () => 0, eject: () => undefined }, response: { use: () => 0, eject: () => undefined } },
        request: (c: any) => outboundRejection(String(c?.method ?? 'get').toUpperCase(), p.host),
      }
      for (const m of ['get', 'delete', 'head', 'post', 'put', 'patch']) blocked[m] = () => outboundRejection(m.toUpperCase(), p.host)
      return blocked
    }
    return realDefault.create(cfg)
  }
  const direct = (method: string) => (url: unknown, ...rest: unknown[]) => {
    const p = urlParts(url)
    if (p && !isLoopback(p.host)) return outboundRejection(method.toUpperCase(), p.host)
    return realDefault[method](url, ...rest)
  }
  const proxy = new Proxy(realDefault, {
    get(target, prop, receiver) {
      if (prop === 'create') return create
      if (typeof prop === 'string' && ['get', 'delete', 'head', 'post', 'put', 'patch'].includes(prop)) return direct(prop)
      if (prop === 'request') {
        return (c: any) => {
          const p = urlParts(c?.url, c?.baseURL)
          return p && !isLoopback(p.host) ? outboundRejection(String(c?.method ?? 'get').toUpperCase(), p.host) : realDefault.request(c)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
    apply(_target, _this, args: any[]) {
      const c = typeof args[0] === 'string' ? { ...(args[1] ?? {}), url: args[0] } : args[0]
      const p = urlParts(c?.url, c?.baseURL)
      return p && !isLoopback(p.host) ? outboundRejection(String(c?.method ?? 'get').toUpperCase(), p.host) : realDefault(...args)
    },
  })
  return { ...(real as any), default: proxy, create } as T
}

// ─── nodemailer: SMTP simulado (registra y falla sin red) ─────────────────────

export function nodemailerDouble() {
  const createTransport = (opts: any = {}) => {
    joint.record('outbound.smtp', { op: 'createTransport', host: opts?.host, port: opts?.port })
    const fail = async () => {
      joint.record('outbound.smtp', { op: 'sendMail', host: opts?.host })
      const err = new Error('SMTP simulado: sin red') as any
      err.code = 'ECONNECTION'
      throw err
    }
    return { sendMail: fail, verify: fail, close: () => undefined }
  }
  const mod = { createTransport }
  return { ...mod, default: mod }
}

// ─── node-cron: jobs capturados (se ejecutan a mano) ──────────────────────────

export function nodeCronDouble() {
  const schedule = (expr: string, fn: () => unknown) => {
    joint.cron.push({ expr, fn })
    joint.record('cron.schedule', { expr })
    return { stop: () => undefined, start: () => undefined }
  }
  const mod = { schedule, validate: () => true }
  return { ...mod, default: mod }
}

/** Vacía los jobs capturados (antes de cada arranque de server.ts). */
export function resetCapturedCron(): void { joint.cron.length = 0 }

// ─── child_process con el error REAL de ffprobe ───────────────────────────────
// spawn/exec* = los de infra-doubles (FFmpeg simulado). execFile de ffprobe falla
// como lo hace Node: `Command failed: ffprobe <args>` con la URL RTSP TAL CUAL se
// pasó (usuario y clave del NVR incluidos). services/rtsp-probe corre real encima.

function ffprobeFailure(cmd: string, argv: string[]): Error {
  const err = new Error(`Command failed: ${cmd} ${argv.join(' ')}\n`) as any
  err.code = 1
  err.killed = false
  err.signal = null
  err.cmd = `${cmd} ${argv.join(' ')}`
  err.stdout = ''
  err.stderr = ''
  return err
}

export function childProcessFfprobeDouble<T extends Record<string, unknown>>(real: T): T {
  const base = childProcessModuleDouble(real) as any
  const record = (cmd: string, argv: string[]) => {
    const url = argv.find(a => typeof a === 'string' && a.startsWith('rtsp://'))
    infra.record('proc.exec', { cmd, rtsp: parseRtspTarget(url) })
    // Una sonda RTSP es contacto con el NVR: también se registra como tal.
    if (url) infra.record('rtsp.probe', { rtsp: parseRtspTarget(url), via: 'ffprobe' })
  }
  const execFile = (cmd: string, ...rest: any[]) => {
    const argv: string[] = Array.isArray(rest[0]) ? rest[0] : []
    record(cmd, argv)
    const cb = rest.find(a => typeof a === 'function')
    const err = ffprobeFailure(cmd, argv)
    if (cb) setImmediate(() => cb(err, '', ''))
    return new EventEmitter()
  }
  ;(execFile as any)[util.promisify.custom] = (cmd: string, args: string[] = []) => {
    record(cmd, Array.isArray(args) ? args : [])
    const err = ffprobeFailure(cmd, Array.isArray(args) ? args : [])
    return new Promise((_resolve, reject) => setImmediate(() => reject(err)))
  }
  const mod = { ...base, execFile }
  return { ...mod, default: mod } as unknown as T
}

// ─── services/stream: getStreamDetails con fuente en formato LEGADO ───────────

export function streamLegacySourceDouble<T extends Record<string, unknown>>(real: T): T {
  const base = streamModuleDouble(real) as any
  return {
    ...base,
    getStreamDetails: async (streamPath: string) => {
      infra.record('mediamtx.query', { fn: 'getStreamDetails', streamPath })
      return {
        active: true, routeExists: true, sourceType: 'rtspSource', readers: 1, bytesReceived: 1,
        sourceMasked: joint.legacySource?.(streamPath),
      }
    },
  } as T
}

// ─── services/hikvision con fixtures puntuales ────────────────────────────────
// Igual que hikvisionModuleDouble (registra todo y lanza en lo no soportado), pero
// algunas funciones devuelven datos de fixture (sin red) para rutas que los leen.

const HIK_FIXTURES: Record<string, (...args: any[]) => unknown> = {
  // Lista ISAPI de cámaras IP del NVR: sólo canal/nombre/estado (sin credenciales).
  getIpCameraList: () => [{ channel: 1, name: 'Cam 1', status: 'online', protocol: 'HIKVISION' }],
}

export function hikvisionWithFixturesDouble<T extends Record<string, unknown>>(real: T): T {
  const base = hikvisionModuleDouble(real) as Record<string, unknown>
  const out: Record<string, unknown> = { ...base }
  for (const [name, fixture] of Object.entries(HIK_FIXTURES)) {
    if (typeof real[name] !== 'function') continue
    out[name] = async (...args: any[]) => {
      const nvr = args[0] as { id?: string; ipAddress?: string } | undefined
      infra.record('nvr.isapi', { fn: name, nvrId: nvr?.id, nvrHost: nvr?.ipAddress, channel: typeof args[1] === 'number' ? args[1] : undefined })
      return fixture(...args)
    }
  }
  return out as T
}

// ─── services/hikvision con lecturas REALES puntuales ─────────────────────────
// Igual que hikvisionModuleDouble (registra todo y lanza en lo no soportado), salvo
// las funciones nombradas, que corren REALES: su createHikClient usa `axios.create`,
// así que con axiosModuleDouble + nvrHostGuardDouble llegan al ISAPI simulado de
// TEST-NET-1 (Digest con las credenciales descifradas, XML de `joint.isapi.docs`).
// Para rutas que leen el canal ANTES de escribirlo (backup previo de PUT
// /api/nvrs/:id/video-audio/:ch): sin esto, el doble lanza y la ruta guarda '{}'.

export function hikvisionRealReadsDouble<T extends Record<string, unknown>>(real: T, names: string[]): T {
  const base = hikvisionModuleDouble(real) as Record<string, unknown>
  const out: Record<string, unknown> = { ...base }
  for (const name of names) {
    const fn = real[name]
    if (typeof fn !== 'function') throw new Error(`hikvisionRealReadsDouble: services/hikvision no exporta ${name}`)
    out[name] = async (...args: any[]) => {
      const nvr = args[0] as { id?: string; ipAddress?: string } | undefined
      if (!nvr?.ipAddress || !isSimulatedNvrHost(nvr.ipAddress)) {
        throw new Error(`NVR simulado: ${name} real sólo contra TEST-NET-1 (recibió otro host)`)
      }
      infra.record('nvr.isapi', { fn: name, nvrId: nvr.id, nvrHost: nvr.ipAddress, channel: typeof args[1] === 'number' ? args[1] : undefined, real: true })
      return (fn as (...a: any[]) => unknown)(...args)
    }
  }
  return out as T
}
