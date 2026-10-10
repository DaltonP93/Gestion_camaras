// apps/api/src/security-joint/infra-doubles.ts
//
// Dobles de la infraestructura EXTERNA para la suite conjunta de seguridad
// (#182 + #186 + #189 + #190). No es una prueba: lo importan las fábricas de
// `vi.mock` de cada `*.joint.test.ts` y las propias pruebas para leer el registro.
//
// Se simula SÓLO lo que tocaría infraestructura real:
//   - MediaMTX (alta/baja de paths, consultas de estado) y el FFmpeg de
//     transcodificación en vivo (`services/stream`);
//   - el NVR: llamadas ISAPI (`services/hikvision`) y sondas RTSP
//     (`services/rtsp-probe`);
//   - procesos hijos (`child_process.spawn/exec*`): FFmpeg/ffprobe de grabaciones;
//   - jobs en segundo plano (healthWorker, syncWorker) y el re-registro de streams.
// El descifrado de credenciales NVR NO se reemplaza: se ENVUELVE (la función real
// descifra) para poder afirmar "no se descifró".
//
// Todo queda en un registro en memoria (`infra`) para afirmar, por ejemplo, "no se
// publicó ningún path", "no se lanzó FFmpeg" o "el NVR se consultó con el canal 1".
// El registro guarda host/path de las URL RTSP, NUNCA usuario ni contraseña.
// Sin dependencia de vitest: este archivo también lo compila `tsc` (no es *.test.ts).

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'

export type InfraKind =
  | 'mediamtx.publish' | 'mediamtx.publishTranscoded' | 'mediamtx.remove' | 'mediamtx.removeTranscoded'
  | 'mediamtx.query'
  | 'ffmpeg.transcode.spawn' | 'ffmpeg.transcode.stop'
  | 'nvr.isapi' | 'rtsp.probe'
  | 'proc.spawn' | 'proc.exec'
  | 'credentials.decrypt'
  | 'jobs.healthWorker' | 'jobs.syncWorker' | 'streams.reregister'

export interface InfraCall {
  kind: InfraKind
  detail: Record<string, unknown>
  seq: number
}

/** Toda interacción con MediaMTX, FFmpeg, el NVR, procesos hijos o el secreto del NVR. */
export const EXTERNAL_EFFECT_KINDS: ReadonlySet<InfraKind> = new Set<InfraKind>([
  'mediamtx.publish', 'mediamtx.publishTranscoded', 'mediamtx.remove', 'mediamtx.removeTranscoded', 'mediamtx.query',
  'ffmpeg.transcode.spawn', 'ffmpeg.transcode.stop',
  'nvr.isapi', 'rtsp.probe', 'proc.spawn', 'proc.exec',
  'credentials.decrypt',
])

/** Comportamiento del FFmpeg simulado de grabaciones. */
export type FfmpegMode =
  /** VOD: escribe bytes SINTÉTICOS (no es video) en el archivo de salida y sale 0. */
  | 'vod-ok'
  /** Cualquier uso: imprime el error típico de apertura RTSP (404) y sale 1. */
  | 'fail-404'

/** Host/path/query de una URL RTSP, sin userinfo (no se registran credenciales). */
export interface RtspTarget { host: string; port: string; pathname: string; search: string; hadUserinfo: boolean }

export function parseRtspTarget(raw: unknown): RtspTarget | null {
  if (typeof raw !== 'string' || !raw.startsWith('rtsp://')) return null
  try {
    const u = new URL(raw)
    return { host: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hadUserinfo: !!(u.username || u.password) }
  } catch {
    return null
  }
}

class InfraRecorder {
  readonly calls: InfraCall[] = []
  /** FFmpeg de transcodificación en vivo "vivos", por streamPath. */
  readonly transcodeAlive = new Set<string>()
  ffmpegMode: FfmpegMode = 'vod-ok'
  /** Nombres de archivo devueltos por la búsqueda ISAPI simulada, por canal. */
  recordingName = (channel: number): string => `00010000027${String(channel).padStart(2, '0')}00`
  private seq = 0
  private pid = 70000

  record(kind: InfraKind, detail: Record<string, unknown> = {}): void {
    this.calls.push({ kind, detail, seq: ++this.seq })
  }
  /** Marca de posición: para afirmar "nada desde aquí". */
  mark(): number { return this.seq }
  of(kind: InfraKind, since = 0): InfraCall[] {
    return this.calls.filter(c => c.kind === kind && c.seq > since)
  }
  /** Efectos sobre infraestructura/secretos desde la marca (ver EXTERNAL_EFFECT_KINDS). */
  externalEffectsSince(since: number): InfraCall[] {
    return this.calls.filter(c => c.seq > since && EXTERNAL_EFFECT_KINDS.has(c.kind))
  }
  /** Destinos RTSP (host+path) de los FFmpeg/ffprobe/sondas lanzados desde la marca. */
  rtspTargetsSince(since: number): RtspTarget[] {
    const out: RtspTarget[] = []
    for (const c of this.calls) {
      if (c.seq <= since) continue
      const t = c.detail.rtsp as RtspTarget | undefined
      if (t && (c.kind === 'proc.spawn' || c.kind === 'rtsp.probe')) out.push(t)
    }
    return out
  }
  nextPid(): number { return ++this.pid }
}

export const infra = new InfraRecorder()

// ─── services/stream (MediaMTX + FFmpeg de transcodificación en vivo) ─────────
// Se conservan REALES las funciones puras (getStreamPath, getTranscodedStreamPath,
// getHlsUrl, getWebRtcUrl, sanitizeRtsp): el path que devuelve el heartbeat es el
// mismo que luego autoriza /internal/hls-auth.
export function streamModuleDouble<T extends Record<string, unknown>>(real: T): T {
  const pathOf = (nvr: any, cam: any, type: string) =>
    `nvr_${nvr?.id}_ch${String(cam?.channel).padStart(2, '0')}_${type}`
  return {
    ...real,
    publishStream: async (nvr: any, cam: any, type: 'sub' | 'main' = 'sub') => {
      infra.record('mediamtx.publish', { cameraId: cam?.id, streamPath: pathOf(nvr, cam, type) })
      return true
    },
    publishTranscodedStream: async (nvr: any, cam: any) => {
      infra.record('mediamtx.publishTranscoded', { cameraId: cam?.id, streamPath: pathOf(nvr, cam, 'main_h264') })
      return true
    },
    removeStream: async (...args: any[]) => {
      infra.record('mediamtx.remove', { args: args.map(a => (typeof a === 'object' && a ? a.id ?? '[obj]' : a)) })
      return true
    },
    removeTranscodedPath: async (...args: any[]) => {
      infra.record('mediamtx.removeTranscoded', { args: args.map(a => (typeof a === 'object' && a ? a.id ?? '[obj]' : a)) })
      return true
    },
    getStreamStatus: async (streamPath: string) => {
      infra.record('mediamtx.query', { fn: 'getStreamStatus', streamPath })
      return { active: true, routeExists: true, readers: 1, bytesReceived: 1 }
    },
    getStreamDetails: async (streamPath: string) => {
      infra.record('mediamtx.query', { fn: 'getStreamDetails', streamPath })
      return { active: true, routeExists: true, sourceType: 'rtspSession', readers: 1, bytesReceived: 1 }
    },
    listRegisteredConfigPaths: async () => null,
    listActiveStreams: async () => [],
    getMediaMtxRuntimePaths: async () => null,
    probeHlsManifest: async () => ({ ok: true, status: 200, elapsedMs: 1 }),
    publishAllStreams: async () => undefined,
    clearRegisteredPath: () => undefined,
    markAnalyticsConsumer: async () => undefined,
    clearAnalyticsConsumer: async () => undefined,
    hasActiveConsumers: async () => false,
    waitForHlsReady: async () => ({ ready: true, lastStatus: 200, elapsedMs: 1, processExited: false, manifestVisible: true }),
    isTranscodingEnabled: () => true,
    getFfmpegCapabilities: () => ({ available: true, encoders: ['libx264'] }),
    getRtspTimeoutOption: () => 'timeout',
    spawnTranscodeProcess: (_nvr: any, cam: any, streamPath: string) => {
      infra.record('ffmpeg.transcode.spawn', { cameraId: cam?.id, streamPath })
      infra.transcodeAlive.add(streamPath)
      const proc = new EventEmitter() as any
      proc.pid = infra.nextPid()
      return proc
    },
    spawnTranscodeFromRtsp: () => {
      infra.record('ffmpeg.transcode.spawn', { fn: 'spawnTranscodeFromRtsp' })
      return null
    },
    isTranscodeProcessAlive: (streamPath: string) => infra.transcodeAlive.has(streamPath),
    stopTranscodeProcess: (streamPath: string) => {
      infra.record('ffmpeg.transcode.stop', { streamPath })
      return infra.transcodeAlive.delete(streamPath)
    },
    getTranscodeStderr: () => '',
    getTranscodeRawStderr: () => '',
    getTranscodeRtspMasked: () => 'rtsp://[CREDENCIALES-OCULTAS]@host/path',
    getActiveTranscodesList: () => [...infra.transcodeAlive].map(streamPath => ({
      streamPath, pid: undefined, alive: true, stderrBytes: 0,
    })),
  } as T
}

// ─── services/hikvision (ISAPI del NVR) ───────────────────────────────────────
// Toda función con red se registra. La búsqueda, el calendario y la hora devuelven
// datos de fixture; el resto lanza (ninguna ruta de la suite debería llegar ahí).
// Las funciones puras de construcción de URL se conservan reales.
const HIK_PURE = new Set(['buildRtspUrl', 'buildRtspUrlMasked'])

export function hikvisionModuleDouble<T extends Record<string, unknown>>(real: T): T {
  const out: Record<string, unknown> = { ...real }
  for (const [name, value] of Object.entries(real)) {
    if (typeof value !== 'function' || HIK_PURE.has(name)) continue
    out[name] = async (...args: any[]) => {
      const nvr = args[0] as { id?: string; ipAddress?: string } | undefined
      infra.record('nvr.isapi', {
        fn: name, nvrId: nvr?.id, nvrHost: nvr?.ipAddress,
        channel: typeof args[1] === 'number' ? args[1] : undefined,
      })
      if (name === 'searchRecordings') {
        const channel = args[1] as number
        const start = (args[2] as Date) ?? new Date('2026-10-01T10:00:00Z')
        const end = (args[3] as Date) ?? new Date('2026-10-01T10:05:00Z')
        const ts = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
        return [{
          id: `rec-${channel}`, channel, type: 'CMR', size: 1,
          startTime: start.toISOString(), endTime: end.toISOString(),
          playbackURI: `/Streaming/tracks/${channel}01/?starttime=${ts(start)}&endtime=${ts(end)}&name=${infra.recordingName(channel)}&size=1048576`,
        }]
      }
      if (name === 'getRecordingDailyDistribution') return [1, 2, 3]
      if (name === 'getNvrSystemTime') return null
      throw new Error(`NVR simulado: ${name} no está disponible en la suite (sin red)`)
    }
  }
  return out as T
}

// ─── services/rtsp-probe (ffprobe contra el NVR) ──────────────────────────────
export function rtspProbeModuleDouble<T extends Record<string, unknown>>(real: T): T {
  return {
    ...real,
    probeRtspStream: async (url: string) => {
      infra.record('rtsp.probe', { rtsp: parseRtspTarget(url) })
      return { ok: true, codec: 'h264', latencyMs: 1 }
    },
    probeBothStreams: async () => {
      infra.record('rtsp.probe', { fn: 'probeBothStreams' })
      return { main: { ok: false, error: 'simulado', latencyMs: 1 }, sub: { ok: false, error: 'simulado', latencyMs: 1 } }
    },
  } as T
}

// ─── services/credentials (envoltura: descifra con la función REAL) ──────────
export function credentialsModuleDouble<T extends Record<string, unknown>>(real: T): T {
  const decrypt = real.decryptNvrPassword as (enc: string) => string
  const decryptOrNull = real.decryptNvrPasswordOrNull as (enc: string) => string | null
  return {
    ...real,
    decryptNvrPassword: (enc: string) => { infra.record('credentials.decrypt', { fn: 'decryptNvrPassword' }); return decrypt(enc) },
    decryptNvrPasswordOrNull: (enc: string) => { infra.record('credentials.decrypt', { fn: 'decryptNvrPasswordOrNull' }); return decryptOrNull(enc) },
  } as T
}

// ─── child_process (FFmpeg/ffprobe de grabaciones) ────────────────────────────
// `execFileSync`/`spawnSync` quedan REALES: el harness los usa para `prisma db push`.
function fakeChild(cmd: string, args: string[]): any {
  const child = new EventEmitter() as any
  const fd3 = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = null
  child.stdio = [null, child.stdout, child.stderr, fd3]
  child.pid = infra.nextPid()
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  const finish = (code: number | null, signal: string | null) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.exitCode = code
    child.signalCode = signal
    for (const s of [child.stdout, child.stderr, fd3]) { try { s.end() } catch { /* noop */ } }
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
  }
  child.kill = (sig: string = 'SIGTERM') => { child.killed = true; setImmediate(() => finish(null, sig)); return true }

  const input = args[args.indexOf('-i') + 1] ?? ''
  const output = args[args.length - 1]
  setImmediate(() => {
    if (cmd === 'ffmpeg' && infra.ffmpegMode === 'vod-ok' && args.includes('-y') && typeof output === 'string' && output.endsWith('.mp4')) {
      // Bytes SINTÉTICOS (no es video): sólo para que el servidor tenga qué servir.
      try { fs.writeFileSync(output, Buffer.alloc(64 * 1024, 0x5a)) } catch { /* noop */ }
      child.stderr.write('frame=25\nfps=25.0\nout_time_ms=1000000\nspeed=1.0x\nprogress=continue\n')
      child.stderr.write('frame=50\nfps=25.0\nout_time_ms=2000000\nspeed=1.0x\nprogress=end\n')
      finish(0, null)
      return
    }
    // Error típico de FFmpeg al abrir la entrada (incluye la URL tal como la recibió).
    child.stderr.write(`${input}: Server returned 404 Not Found\n`)
    finish(1, null)
  })
  return child
}

export function childProcessModuleDouble<T extends Record<string, unknown>>(real: T): T {
  const spawn = (cmd: string, args: string[] = []) => {
    const input = Array.isArray(args) ? args[args.indexOf('-i') + 1] : undefined
    infra.record('proc.spawn', { cmd, rtsp: parseRtspTarget(input) })
    return fakeChild(cmd, Array.isArray(args) ? args : [])
  }
  const execFile = (cmd: string, ...rest: any[]) => {
    infra.record('proc.exec', { cmd })
    const cb = rest.find(a => typeof a === 'function')
    if (cb) setImmediate(() => cb(new Error(`proceso simulado: ${cmd} no disponible`), '', ''))
    return new EventEmitter()
  }
  const execSync = (cmd: string) => {
    infra.record('proc.exec', { cmd: String(cmd).split(' ')[0] })
    throw new Error('proceso simulado: execSync no disponible en la suite')
  }
  const exec = (cmd: string, ...rest: any[]) => execFile(String(cmd).split(' ')[0], ...rest)
  const mod = { ...real, spawn, execFile, execSync, exec }
  return { ...mod, default: mod } as unknown as T
}

// ─── Jobs y re-registro (no deben contactar NVR/MediaMTX) ─────────────────────
export function healthWorkerDouble() {
  return { startHealthWorker: (..._args: unknown[]) => { infra.record('jobs.healthWorker') } }
}
export function syncWorkerDouble() {
  return { startSyncWorker: (..._args: unknown[]) => { infra.record('jobs.syncWorker') } }
}
export function reregisterDouble() {
  return {
    reRegisterStreams: async (..._args: unknown[]) => {
      infra.record('streams.reregister')
      return { total: 0, published: 0, failed: 0, skipped: 0 }
    },
  }
}
