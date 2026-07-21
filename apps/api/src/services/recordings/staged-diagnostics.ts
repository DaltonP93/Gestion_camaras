// Diagnóstico POR ETAPAS de una estrategia de reproducción RTSP. Ejecuta FFmpeg/
// ffprobe instrumentados para localizar el punto EXACTO donde se detiene el flujo
// (RTSP abierto, streams detectados, paquete de video, frame decodificado, frame
// codificado, primer byte muxeado). Sanitiza todo: nunca registra ni retorna
// credenciales — sólo opera sobre stderr/-progress y devuelve URLs enmascaradas.
//
// Los PARSERS viven en ffmpeg-progress.ts (puros y testeados). Aquí sólo se
// spawnea y se orquesta; no puede unit-testearse sin un NVR real (por diseño: la
// validación final es contra el NVR, no en CI).

import { spawn } from 'child_process'
import { parseFfprobeJson, parseStreamInfoFromStderr, parseFfmpegProgress } from './ffmpeg-progress'
import { maskUrlCredentials } from './rtsp-url'

export type RtspTransport = 'tcp' | 'udp'

// Recorta stderr a HEAD (primeras N líneas: incluye la línea "Stream #0:0 Video"
// que hoy se pierde con sólo el tail) + TAIL (últimas N: el error final).
function headTail(lines: string[], head = 12, tail = 12): string {
  if (lines.length <= head + tail) return lines.join('\n')
  return [...lines.slice(0, head), `… (${lines.length - head - tail} líneas omitidas) …`, ...lines.slice(-tail)].join('\n')
}

interface RawRunResult {
  stderrLines: string[]
  progressText: string
  firstStdoutByteMs: number | null
  bytes: number
  inputOpenedMs: number | null
  firstFrameMs: number | null       // primer frame reportado por -progress
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
}

// Corre UN FFmpeg con -progress en un fd dedicado (pipe:3) y captura marcas de
// tiempo por etapa. SIEMPRE mata el proceso al terminar (no deja FFmpeg huérfano).
function runFfmpeg(fullArgs: string[], timeoutMs: number): Promise<RawRunResult> {
  return new Promise(resolve => {
    const started = Date.now()
    const stderrLines: string[] = []
    let progressText = ''
    let firstStdoutByteMs: number | null = null
    let bytes = 0
    let inputOpenedMs: number | null = null
    let firstFrameMs: number | null = null
    let settled = false
    let timedOut = false
    let exitCode: number | null = null
    let signal: string | null = null

    // fd extra (3) para -progress, separado del stderr humano.
    const proc = spawn('ffmpeg', fullArgs, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGKILL') } catch {}
      resolve({
        stderrLines, progressText, firstStdoutByteMs, bytes,
        inputOpenedMs, firstFrameMs, exitCode, signal, timedOut,
        elapsedMs: Date.now() - started,
      })
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (firstStdoutByteMs == null) firstStdoutByteMs = Date.now() - started
      bytes += chunk.length
    })
    proc.stderr?.on('data', (c: Buffer) => {
      for (const raw of c.toString().split('\n')) {
        const line = maskUrlCredentials(raw.trim())
        if (!line) continue
        stderrLines.push(line)
        if (stderrLines.length > 400) stderrLines.shift()
        if (inputOpenedMs == null && /Input #\d+|Stream #\d+:\d+/.test(line)) inputOpenedMs = Date.now() - started
      }
    })
    // fd 3 = -progress (key=value). frame>=1 marca el primer frame por el pipeline.
    const progressPipe = (proc.stdio as any)[3]
    progressPipe?.on('data', (c: Buffer) => {
      progressText += c.toString()
      if (firstFrameMs == null) {
        const snap = parseFfmpegProgress(progressText)
        if (snap.frame != null && snap.frame >= 1) firstFrameMs = Date.now() - started
      }
    })

    proc.on('exit', (code, sig) => { exitCode = code; signal = sig ?? null })
    proc.on('close', () => finish())
    proc.on('error', () => finish())
    const timer = setTimeout(() => { timedOut = true; finish() }, timeoutMs)
  })
}

function transportArgs(url: string, transport: RtspTransport): string[] {
  return ['-rtsp_transport', transport, '-fflags', '+genpts+discardcorrupt', '-i', url]
}

export interface StageProbeResult {
  stage: 'rtsp_sdp'
  transport: RtspTransport
  rtspOpened: boolean
  streamsDetected: number
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
  fps: number | null
  elapsedMs: number
  timedOut: boolean
  stderrSample: string
}

// Etapa 1 — RTSP/SDP: ffprobe hasta detectar streams. Prueba que el RTSP abre y
// qué descubre, sin depender de que salga un solo byte muxeado.
export async function stageProbe(url: string, transport: RtspTransport, timeoutMs: number): Promise<StageProbeResult> {
  const started = Date.now()
  const args = ['-rtsp_transport', transport, '-i', url,
    '-show_streams', '-show_format', '-of', 'json', '-loglevel', 'error']
  const out: string[] = []
  const errLines: string[] = []
  const r = await new Promise<{ json: string; timedOut: boolean }>(resolve => {
    let done = false, timedOut = false
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout?.on('data', (c: Buffer) => out.push(c.toString()))
    proc.stderr?.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) { const s = maskUrlCredentials(l.trim()); if (s) errLines.push(s) } })
    const fin = () => { if (done) return; done = true; clearTimeout(t); try { proc.kill('SIGKILL') } catch {}; resolve({ json: out.join(''), timedOut }) }
    proc.on('close', fin); proc.on('error', fin)
    const t = setTimeout(() => { timedOut = true; fin() }, timeoutMs)
  })
  const parsed = parseFfprobeJson(r.json)
  const fromErr = parseStreamInfoFromStderr(errLines.join('\n'))
  return {
    stage: 'rtsp_sdp', transport,
    rtspOpened: !!parsed || fromErr.inputOpened,
    streamsDetected: parsed?.streamsDetected ?? 0,
    videoCodec: parsed?.videoCodec ?? fromErr.videoCodec,
    audioCodec: parsed?.audioCodec ?? fromErr.audioCodec,
    width: parsed?.width ?? fromErr.width,
    height: parsed?.height ?? fromErr.height,
    fps: parsed?.fps ?? fromErr.fps,
    elapsedMs: Date.now() - started,
    timedOut: r.timedOut,
    stderrSample: headTail(errLines).slice(0, 800),
  }
}

export interface StageRunResult {
  stage: string
  transport: RtspTransport
  inputOpened: boolean
  videoCodec: string | null
  audioCodec: string | null
  firstDecodedFrameMs: number | null
  firstEncodedFrameMs: number | null
  firstMuxedByteMs: number | null
  bytes: number
  frames: number | null
  outTimeMs: number | null
  totalSize: number | null
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  elapsedMs: number
  stderrSample: string     // HEAD+TAIL sanitizado (no sólo tail)
}

// Etapa DECODE — video-only, decodifica a null. firstEncodedFrame no aplica.
export async function stageDecode(url: string, transport: RtspTransport, timeoutMs: number): Promise<StageRunResult> {
  const args = [...transportArgs(url, transport), '-an', '-map', '0:v:0', '-f', 'null',
    '-progress', 'pipe:3', '-loglevel', 'info', '-']
  const r = await runFfmpeg(args, timeoutMs)
  const info = parseStreamInfoFromStderr(r.stderrLines.join('\n'))
  const snap = parseFfmpegProgress(r.progressText)
  return {
    stage: 'decode', transport,
    inputOpened: info.inputOpened || r.inputOpenedMs != null,
    videoCodec: info.videoCodec, audioCodec: info.audioCodec,
    firstDecodedFrameMs: r.firstFrameMs, firstEncodedFrameMs: null, firstMuxedByteMs: null,
    bytes: r.bytes, frames: snap.frame, outTimeMs: snap.outTimeMs, totalSize: snap.totalSize,
    exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, elapsedMs: r.elapsedMs,
    stderrSample: headTail(r.stderrLines).slice(0, 1200),
  }
}

// Etapa ENCODE+MUX — transcode libx264 → fMP4 a pipe (lo que hace el preview real).
// videoOnly descarta el audio (para aislar si el AAC/G.711 o la sync A/V bloquean).
// fragArgs permite probar variantes de fragmentación fMP4 (TASK 7).
export async function stageEncodeMux(url: string, transport: RtspTransport, timeoutMs: number, opts?: {
  videoOnly?: boolean; fragArgs?: string[]; label?: string
}): Promise<StageRunResult> {
  const audio = opts?.videoOnly ? ['-an'] : ['-map', '0:a?', '-c:a', 'aac', '-b:a', '64k', '-ac', '1']
  const frag = opts?.fragArgs ?? ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']
  const args = [
    ...transportArgs(url, transport),
    '-map', '0:v:0', ...audio,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    ...frag, '-f', 'mp4',
    '-progress', 'pipe:3', '-loglevel', 'info', 'pipe:1',
  ]
  const r = await runFfmpeg(args, timeoutMs)
  const info = parseStreamInfoFromStderr(r.stderrLines.join('\n'))
  const snap = parseFfmpegProgress(r.progressText)
  return {
    stage: opts?.label ?? (opts?.videoOnly ? 'video_only_h264' : 'encode_mux_fmp4'), transport,
    inputOpened: info.inputOpened || r.inputOpenedMs != null,
    videoCodec: info.videoCodec, audioCodec: info.audioCodec,
    firstDecodedFrameMs: r.firstFrameMs,       // con transcode, el 1er frame implica decode+encode
    firstEncodedFrameMs: r.firstFrameMs,
    firstMuxedByteMs: r.firstStdoutByteMs,
    bytes: r.bytes, frames: snap.frame, outTimeMs: snap.outTimeMs, totalSize: snap.totalSize,
    exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, elapsedMs: r.elapsedMs,
    stderrSample: headTail(r.stderrLines).slice(0, 1200),
  }
}
