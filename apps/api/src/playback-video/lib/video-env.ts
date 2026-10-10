// apps/api/src/playback-video/lib/video-env.ts
//
// Entorno de UN archivo de escenarios: web REAL (bundle de producción servido por
// `vite preview`, o `vite` dev con VIDEO_WEB_MODE=dev) + navegador (playwright-core)
// contra el `server.ts` REAL del harness conjunto (PostgreSQL/Redis efímeros), con
// el NVR simulado: ISAPI HTTP en loopback para el cliente hikvision REAL y el shim
// de ffmpeg/ffprobe primero en el PATH del proceso (la API lanza FFmpeg por nombre).
//
// Aislamiento: sólo loopback, en los DOS procesos que hablan con la red.
//   - Node (API, cliente ISAPI, sondas): la única "IP del NVR" es RFC1918 ficticia y
//     se redirige al ISAPI simulado; cualquier otro destino o puerto loopback no
//     listado se bloquea y queda registrado (net-redirect + centinela del harness).
//   - Navegador: `--host-resolver-rules` hace que NINGÚN nombre ni IP literal fuera
//     de 127.0.0.1 resuelva (la web real pide Google Fonts; Chromium además usa DoH
//     y servicios de fondo como la hora de red). Los pedidos de las páginas que
//     intentan salir se registran (`browserAttempts`) y el netlog del navegador
//     (`--log-net-log`, en el directorio temporal de la corrida) prueba al cerrar
//     que no hubo NINGÚN socket fuera de loopback, incluido el servicio de red.
//     La tipografía Inter cae a la fuente de reemplazo: no cambia ninguna medición
//     (los clics en la línea de tiempo se calculan con su caja real).
// Credenciales ficticias.

import fs from 'node:fs'
import path from 'node:path'
import { expect, inject } from 'vitest'
import {
  JOINT_PASSWORD, NVR_FAKE_PASS, NVR_FAKE_USER, startJointServer, type JointEnv,
} from '../../security-joint/harness'
import type { SimBehavior, SimManifest } from '../media/generate'
import { startIsapiSim, type IsapiSim } from '../nvr-sim/isapi-sim'
import { installNetRedirect, type NetRedirect } from '../nvr-sim/net-redirect'
import { samplerScript, VideoPage } from './browser-page'
import { readNetlog, type BrowserNet } from './netlog'
import type { Segment } from './metrics'
import { listSimProcs, totalSimProcs, type SimProcs } from './procs'
import { SIM_BIN, WEB_ROOT, type VideoRun } from './run-config'
import { sanitize, ScenarioReport } from './report'
import { importFromWeb, playwrightDisableFeatures, webPostcss } from './web'

export { JOINT_PASSWORD }

export interface ApiSample {
  wall: number
  previewSessions: number
  vodSessions: number
  active: number
  queued: number
  consumers: number[]
  producers: number[]
  feeders: number[]
}

export interface SimEvent { t: number; pid: number; ev: string; track?: string; [k: string]: unknown }

/** Lo que vio cada capa de red de la corrida (ver `assertIsolation`). */
export interface IsolationResult {
  /** Conexiones de Node bloqueadas por net-redirect (destino o puerto no listado). */
  blocked: string[]
  redirected: number
  isapiCalls: number
  /** Conexiones NO loopback de Node bloqueadas por el centinela del harness. */
  harnessBlocked: string[]
  /** Sockets del navegador según su netlog (null si no hubo navegador). */
  browser: BrowserNet | null
  /** URLs (sin query) que las páginas intentaron fuera de loopback (bloqueadas). */
  browserAttempts: string[]
}

export interface VideoEnvOptions {
  label: string
  behaviors?: Record<string, SimBehavior>
  maxConcurrentPlaybackSessions?: number
  /** Variables extra de la API (sólo esta corrida). */
  apiEnv?: Record<string, string>
}

/**
 * Reglas del resolvedor del navegador: todo nombre (y toda IP literal) fuera de
 * 127.0.0.1 da ERR_NAME_NOT_RESOLVED sin consultar DNS ni DoH. Medido con un netns
 * con ruta por defecto a un TUN que registra cada paquete: sin la regla, la carga
 * de la web emite consultas DNS a los servidores del sistema por las fuentes de
 * Google; con la regla, 0 paquetes fuera de loopback.
 */
export const BROWSER_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'

const isLoopbackUrl = (u: string) => /^(https?|wss?):\/\/(127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u) || /^(data|blob|about|chrome|devtools):/.test(u)

const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']

/** Puerto de una URL de servicio (PG/Redis) para la lista de loopback permitidos. */
function portOf(url: string | undefined, fallback: number): number {
  try { return Number(new URL(url ?? '').port) || fallback } catch { return fallback }
}

export class VideoEnv {
  joint!: JointEnv
  isapi!: IsapiSim
  netRedirect!: NetRedirect
  browser: any
  server: any
  baseUrl = ''
  codec: 'h264' | 'vp9' = 'h264'
  browserVersion = ''
  nvrId = ''
  cams: Record<number, string> = {}
  readonly api: ApiSample[] = []
  readonly run: VideoRun
  private manifest: SimManifest
  private manifestPath = ''
  private simLog = ''
  private savedEnv: Record<string, string | undefined> = {}
  private poller: NodeJS.Timeout | null = null
  private recordingsMod: any = null
  readonly pages: VideoPage[] = []
  /** Pedidos de las páginas a destinos fuera de loopback (bloqueados por el resolvedor). */
  readonly browserAttempts: string[] = []
  private netlogPath = ''

  constructor(readonly opts: VideoEnvOptions) {
    this.run = inject('videoRun')
    this.manifest = JSON.parse(JSON.stringify(this.run.manifest))
    this.manifest.behaviors = { ...(opts.behaviors ?? {}) }
  }

  /** Segmentos grabados de un canal (pista principal), para las métricas. */
  segments(channel: number): Segment[] {
    return (this.manifest.tracks[String(channel * 100 + 1)] ?? []).map((s) => ({ startMs: Date.parse(s.start), endMs: Date.parse(s.end) }))
  }

  /** Copia del manifiesto actual (para re-ejecutar comandos fuera del navegador). */
  manifestCopy(): SimManifest { return JSON.parse(JSON.stringify(this.manifest)) }

  /** Cambia los comportamientos del NVR simulado (los lee cada FFmpeg nuevo). */
  setBehaviors(b: Record<string, SimBehavior>): void {
    this.manifest.behaviors = { ...b }
    this.writeManifest()
  }

  private writeManifest(): void {
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 1))
  }

  async start(): Promise<void> {
    const r = this.run
    const label = this.opts.label.replace(/[^a-z0-9]/gi, '').toLowerCase()
    this.manifestPath = path.join(r.runDir, `manifest-${label}.json`)
    this.simLog = path.join(r.runDir, `sim-${label}.jsonl`)

    // ── Navegador primero: define si hace falta el desvío VP9 ──
    const pw = await importFromWeb('playwright-core')
    // VIDEO_HEADED=1 (bajo xvfb-run): sólo para mirar la corrida; no cambia lo que se mide.
    const headed = process.env.VIDEO_HEADED === '1'
    this.netlogPath = path.join(r.runDir, `netlog-${label}.json`)
    const channel = process.env.VIDEO_BROWSER === 'chrome' ? 'chrome' : undefined
    // DoH apagado: con un resolvedor del sistema "conocido" (p. ej. el de los runners
    // de GitHub) Chromium/Chrome suben solos a DNS-over-HTTPS y se conectan al
    // servidor DoH por IP literal, que `--host-resolver-rules` no cubre (CI de #199:
    // 2001:4860:4860::8888:443 por TCP y QUIC). Se suma a la lista de Playwright sin
    // pisarla; QUIC fuera por la misma razón (la web real va por HTTP/1.1 a loopback).
    const features = playwrightDisableFeatures(['DnsOverHttpsUpgrade'], channel)
    const launch: Record<string, unknown> = {
      headless: !headed,
      ignoreDefaultArgs: [features.defaultArg],
      args: [
        '--no-proxy-server', '--autoplay-policy=no-user-gesture-required',
        `--host-resolver-rules=${BROWSER_RESOLVER_RULES}`, `--log-net-log=${this.netlogPath}`,
        features.merged, '--disable-quic',
      ],
    }
    if (channel) launch.channel = channel
    else {
      // Chromium COMPLETO (headless nuevo) en todos lados: el preinstalado del
      // entorno o, en CI, el que instala `playwright install chromium` (canal
      // 'chromium'; sin canal, Playwright usaría el headless-shell, otro binario).
      const exe = process.env.PW_CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)
      if (exe) launch.executablePath = exe
      else launch.channel = 'chromium'
    }
    this.browser = await pw.chromium.launch(launch)
    this.browserVersion = this.browser.version()
    const probe = await this.browser.newPage()
    const h264 = await probe.evaluate(() => (globalThis as any).document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01F"'))
    await probe.close()
    if (!h264) {
      if (process.env.VIDEO_REQUIRE_H264 === '1') throw new Error('suite de video: el navegador no decodifica H.264 y VIDEO_REQUIRE_H264=1 (usar VIDEO_BROWSER=chrome)')
      this.codec = 'vp9'
      this.manifest.browserCodec = 'vp9'
    }
    this.writeManifest()

    // ── Entorno del proceso (la API hereda PATH y variables del simulador) ──
    for (const k of [...PROXY_VARS, 'PATH', 'FFPROBE_PATH', 'VC_SIM_MANIFEST', 'VC_SIM_LOG', 'VC_SIM_WORK_ROOT', 'VC_SIM_REAL_FFMPEG', 'VC_SIM_REAL_FFPROBE']) {
      this.savedEnv[k] = process.env[k]
    }
    for (const k of PROXY_VARS) delete process.env[k]
    process.env.NO_PROXY = '*'
    process.env.PATH = `${SIM_BIN}${path.delimiter}${process.env.PATH ?? ''}`
    process.env.FFPROBE_PATH = path.join(SIM_BIN, 'ffprobe')
    process.env.VC_SIM_MANIFEST = this.manifestPath
    process.env.VC_SIM_LOG = this.simLog
    process.env.VC_SIM_WORK_ROOT = r.simWorkRoot
    process.env.VC_SIM_REAL_FFMPEG = r.realFfmpeg
    process.env.VC_SIM_REAL_FFPROBE = r.realFfprobe

    this.isapi = await startIsapiSim({
      manifest: () => this.manifest, user: NVR_FAKE_USER, pass: NVR_FAKE_PASS, pageSize: 2,
      localTime: '2026-10-01T10:30:00+00:00', timeZone: 'CST+0:00:00',
    })
    this.joint = await startJointServer({
      label: `video${label}`.slice(0, 12),
      env: {
        RECORDINGS_PREVIEW_FIRST_BYTE_TIMEOUT_MS: process.env.VIDEO_FIRST_BYTE_TIMEOUT_MS ?? '8000',
        ...(this.opts.apiEnv ?? {}),
      },
    })
    this.netRedirect = installNetRedirect(this.manifest.nvrHost, this.isapi.port, [
      this.joint.port,
      portOf(process.env.DATABASE_URL_TEST, 5432),
      portOf(process.env.REDIS_TEST_URL, 6379),
    ])

    // ── Siembra: NVR simulado, cámaras 1–4 y usuarios ──
    const nvr = await this.joint.createNvr('NVR simulado', this.manifest.nvrHost)
    this.nvrId = nvr.id
    await this.joint.prisma.nVR.update({ where: { id: nvr.id }, data: { maxConcurrentPlaybackSessions: this.opts.maxConcurrentPlaybackSessions ?? 4 } })
    for (const ch of [1, 2, 3, 4]) this.cams[ch] = (await this.joint.createCamera(nvr.id, ch)).id

    // ── Web REAL ──
    const vite = await importFromWeb('vite')
    const target = `http://127.0.0.1:${this.joint.port}`
    // vite (http-proxy) NO propaga al backend el aborto de un cliente cuya respuesta
    // todavía no empezó (medido: el backend veía el `close` recién al responder, 4,18 s
    // después). nginx sí lo propaga por defecto (proxy_ignore_client_abort off): este
    // hook sólo iguala ese comportamiento en la prueba.
    const configure = (proxy: any) => proxy.on('proxyReq', (proxyReq: any, _req: any, res: any) => {
      res.on('close', () => { if (!res.writableEnded) proxyReq.destroy() })
    })
    // El cierre de pestañas corta el WebSocket de alertas: vite lo registra como
    // error ("ws proxy socket error"). Es ruido esperado de la prueba.
    const base = vite.createLogger('error')
    const customLogger = { ...base, error: (msg: string, o?: unknown) => { if (/ws proxy (socket )?error/.test(String(msg))) return; base.error(msg, o) } }
    const proxy = {
      '/api': { target, configure },
      '/ws': { target: `ws://127.0.0.1:${this.joint.port}`, ws: true },
    }
    if (r.webMode === 'build' && r.webDist) {
      this.server = await vite.preview({
        root: WEB_ROOT, configFile: false, logLevel: 'error', customLogger, build: { outDir: r.webDist },
        preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy },
      })
    } else {
      const react = (await importFromWeb('@vitejs/plugin-react')).default
      this.server = await vite.createServer({
        configFile: false, root: WEB_ROOT, cacheDir: r.viteCacheDir, logLevel: 'error', customLogger,
        css: { postcss: await webPostcss() },
        plugins: [react()], resolve: { alias: { '@': path.join(WEB_ROOT, 'src') } },
        server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, proxy },
      })
      await this.server.listen()
    }
    const webPort = this.server.httpServer.address().port
    this.baseUrl = `http://127.0.0.1:${webPort}`
    this.netRedirect.allow(webPort)

    this.recordingsMod = await import('../../routes/recordings')
    this.poller = setInterval(() => this.sampleApi(), 250)
  }

  async createUser(username: string, role: 'SUPERVISOR' | 'AUDITOR' | 'ADMIN'): Promise<{ id: string; username: string }> {
    return this.joint.createUser(username, role)
  }

  /** Estado de la API (mismo módulo que usa server.ts) y procesos del simulador. */
  apiNow(): ApiSample {
    // Procesos ANTES que los leases: un FFmpeg visible ya tenía su lease tomado
    // (se toma antes del spawn y se suelta después de la salida real).
    const p = listSimProcs(this.run.simWorkRoot)
    const m = this.recordingsMod
    const metrics = m.getRecordingsMetrics()
    return {
      wall: Date.now(), previewSessions: metrics.previewSessions, vodSessions: metrics.vodSessions,
      active: m.admission.activeCount(this.nvrId), queued: m.admission.queuedCount(this.nvrId),
      consumers: p.consumers, producers: p.producers, feeders: p.feeders,
    }
  }

  private sampleApi(): void {
    try { this.api.push(this.apiNow()) } catch { /* el módulo puede no estar listo */ }
  }

  procs(): SimProcs { return listSimProcs(this.run.simWorkRoot) }

  /** Espera a que no quede vivo ningún PID de la lista y (opcional) a que los leases bajen a `leases`. */
  async waitReleased(pids: number[], timeoutMs: number, leases?: number): Promise<{ ms: number | null; after: ApiSample }> {
    const t0 = Date.now()
    for (;;) {
      const now = this.apiNow()
      const alive = [...now.consumers, ...now.producers, ...now.feeders]
      const pidsGone = pids.every((p) => !alive.includes(p))
      const leasesOk = leases === undefined || now.active <= leases
      if (pidsGone && leasesOk) return { ms: Date.now() - t0, after: now }
      if (Date.now() - t0 > timeoutMs) return { ms: null, after: now }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** Espera a que el simulador quede en cero (sin FFmpeg, productores ni leases). */
  async waitAllReleased(timeoutMs: number): Promise<{ ms: number | null; after: ApiSample }> {
    const t0 = Date.now()
    for (;;) {
      const now = this.apiNow()
      if (totalSimProcs(now) === 0 && now.active === 0 && now.queued === 0) return { ms: Date.now() - t0, after: now }
      if (Date.now() - t0 > timeoutMs) return { ms: null, after: now }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  simEvents(): SimEvent[] {
    if (!fs.existsSync(this.simLog)) return []
    return fs.readFileSync(this.simLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SimEvent)
  }

  /** Abre una pestaña nueva (contexto propio, zona horaria UTC) con el muestreador y hace login por la UI. */
  async openPage(username: string, opts: { context?: any } = {}): Promise<VideoPage> {
    const context = opts.context ?? await this.browser.newContext({ timezoneId: 'UTC', viewport: { width: 1400, height: 900 }, locale: 'es-AR' })
    if (!opts.context) {
      await context.addInitScript(samplerScript())
      // Registro PASIVO (sin interceptar: `context.route` pasaría cada pedido del
      // stream y de la API por Node y sumaría latencia a lo que se mide). El bloqueo
      // es el del resolvedor; el netlog verifica los sockets al cerrar.
      context.on('request', (req: any) => {
        const u = String(req.url())
        if (!isLoopbackUrl(u) && this.browserAttempts.length < 200) this.browserAttempts.push(sanitize(u.replace(/[?#].*$/, '')))
      })
    }
    const page = await context.newPage()
    const vp = new VideoPage(context, page, this.baseUrl)
    this.pages.push(vp)
    if (!opts.context) await vp.login(username, JOINT_PASSWORD)
    return vp
  }

  /** Contexto para el reporte. */
  describe(): Record<string, unknown> {
    return {
      browser: `${process.env.VIDEO_BROWSER === 'chrome' ? 'Google Chrome' : 'Chromium (Playwright)'} ${this.browserVersion}`,
      codecEnNavegador: this.codec === 'vp9' ? 'VP9/Opus (desvío: el navegador no decodifica H.264)' : 'H.264 (comando real de la API)',
      web: this.run.webMode, firstByteTimeoutMs: process.env.VIDEO_FIRST_BYTE_TIMEOUT_MS ?? '8000',
      maxConcurrentPlaybackSessions: this.opts.maxConcurrentPlaybackSessions ?? 4,
      behaviors: this.manifest.behaviors,
    }
  }

  async stop(): Promise<IsolationResult> {
    if (this.poller) clearInterval(this.poller)
    for (const p of this.pages) p.stopDraining()
    await this.browser?.close().catch(() => undefined)
    // El netlog queda completo al cerrar el navegador; se lee y se borra enseguida.
    const browserNet = this.browser ? readNetlog(this.netlogPath) : null
    fs.rmSync(this.netlogPath, { force: true })
    // Tras cerrar el navegador, todo FFmpeg debe terminar (cliente desconectado).
    await this.waitAllReleased(15_000).catch(() => undefined)
    const server = this.server
    if (server) {
      if (typeof server.close === 'function') await server.close().catch(() => undefined)
      else await new Promise((r) => server.httpServer.close(r))
    }
    const out: IsolationResult = {
      blocked: [...(this.netRedirect?.blocked ?? [])], redirected: this.netRedirect?.redirected ?? 0,
      isapiCalls: this.isapi?.calls.length ?? 0, harnessBlocked: [...(this.joint?.blockedConnections ?? [])],
      browser: browserNet, browserAttempts: [...new Set(this.browserAttempts)],
    }
    this.netRedirect?.uninstall()
    try { await this.joint?.stop() } finally {
      await this.isapi?.close()
      for (const [k, v] of Object.entries(this.savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
    return out
  }
}

/**
 * Aislamiento de un archivo de escenarios (afterAll): registra el reporte
 * `<archivo>--aislamiento.json` y afirma las cuatro capas. Node: ni la suite ni el
 * centinela del harness bloquearon nada (nadie intentó salir). Navegador: el netlog
 * se leyó y vio tráfico loopback (no es una prueba vacía) y NINGÚN socket fuera de
 * loopback. Los intentos bloqueados por el resolvedor (Google Fonts de la web,
 * servicios de fondo del navegador) se informan, no fallan: no salieron.
 */
export function assertIsolation(file: string, net: IsolationResult): void {
  const rep = new ScenarioReport(file, 'aislamiento', inject('videoRun').reportDir, {})
  const b = net.browser
  rep.record('I-NET-1', 'Node: ninguna conexión fuera de la lista (API, ISAPI simulado, PostgreSQL, Redis, web)', '0 bloqueadas por la suite', net.blocked, net.blocked.length === 0)
  rep.record('I-NET-2', 'Node: ninguna conexión fuera de loopback', '0 bloqueadas por el centinela del harness', net.harnessBlocked, net.harnessBlocked.length === 0)
  rep.record('I-NET-3', 'navegador: el netlog se leyó y registró los sockets de la corrida', 'legible, con eventos y sockets loopback',
    b && { ok: b.ok, error: b.error, eventos: b.events, bytes: b.bytes, socketsLoopback: b.loopbackSockets }, !!b && b.ok && b.loopbackSockets > 0)
  rep.record('I-NET-4', 'navegador: ningún socket fuera de loopback (páginas, DoH, servicios de fondo)', '0 sockets no loopback en el netlog',
    b?.nonLoopback ?? null, !!b && b.ok && b.nonLoopback.length === 0)
  rep.record('I-NET-5', 'navegador: sin DNS-over-HTTPS (el DoH va por IP literal, fuera de la regla del resolvedor)', '0 consultas DOH_URL_REQUEST en el netlog',
    b?.dohRequests ?? null, !!b && b.ok && b.dohRequests === 0)
  rep.metric('intentosBloqueadosPaginas', net.browserAttempts)
  rep.metric('intentosBloqueadosNetlog', b?.attemptedOrigins ?? [])
  rep.metric('redirigidasAlIsapiSimulado', net.redirected)
  rep.metric('llamadasIsapi', net.isapiCalls)
  rep.write()
  expect(net.blocked, 'I-NET-1 conexiones bloqueadas por la suite').toEqual([])
  expect(net.harnessBlocked, 'I-NET-2 conexiones NO loopback bloqueadas por el centinela').toEqual([])
  expect(b, 'I-NET-3 netlog del navegador').not.toBeNull()
  expect({ ok: b?.ok, error: b?.error, conTraficoLoopback: (b?.loopbackSockets ?? 0) > 0 }, 'I-NET-3 netlog del navegador').toEqual({ ok: true, error: undefined, conTraficoLoopback: true })
  expect(b?.nonLoopback, 'I-NET-4 sockets del navegador fuera de loopback').toEqual([])
  expect(b?.dohRequests, 'I-NET-5 consultas DNS-over-HTTPS del navegador').toBe(0)
}

export async function startVideoEnv(opts: VideoEnvOptions): Promise<VideoEnv> {
  const env = new VideoEnv(opts)
  try {
    await env.start()
  } catch (e) {
    await env.stop().catch(() => undefined)
    throw e
  }
  return env
}
