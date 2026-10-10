// apps/api/src/playback-video/media/decode.ts
//
// Lee la franja de tiempo de TODOS los cuadros de un archivo con el ffmpeg real
// (rawvideo gris de las 24 filas superiores) y, opcionalmente, el pts de cada
// cuadro. Sirve para verificar archivos generados y MP4 exportados por la API.

import { spawn } from 'node:child_process'
import { decodeGrayStrip, STRIP_HEIGHT, STRIP_WIDTH, type DecodeResult } from './timecode'

export interface DecodedFrame { index: number; result: DecodeResult; ptsSec: number | null }

export interface FileDecodeSummary {
  frames: number
  decoded: number
  failed: number
  channels: number[]
  firstRecMs: number | null
  lastRecMs: number | null
  /** Pasos entre cuadros consecutivos que no son +1 cuadro. */
  nonUnitSteps: number
  backSteps: number
  maxStepFrames: number
}

function ffmpegRaw(ffmpegPath: string, input: string): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', input, '-fps_mode', 'passthrough',
      '-vf', `scale=${STRIP_WIDTH}:-2,crop=${STRIP_WIDTH}:${STRIP_HEIGHT}:0:0,format=gray`, '-f', 'rawvideo', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const size = STRIP_WIDTH * STRIP_HEIGHT
    let buf = Buffer.alloc(0)
    const out: Buffer[] = []
    let err = ''
    ff.stdout.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c])
      while (buf.length >= size) { out.push(buf.subarray(0, size)); buf = buf.subarray(size) }
    })
    ff.stderr.on('data', (c: Buffer) => { err += c.toString() })
    ff.on('error', reject)
    ff.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`ffmpeg (decodificación) salió ${code}: ${err.slice(-300)}`)))
  })
}

function ffprobePts(ffprobePath: string, input: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0', input],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (c: Buffer) => { out += c.toString() })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe salió ${code}`))
      resolve(out.split('\n').filter(Boolean).map((l) => {
        const [a, b] = l.split(',')
        const v = Number(a !== 'N/A' && a !== '' ? a : b)
        return Number.isFinite(v) ? v : NaN
      }))
    })
  })
}

export async function decodeFile(input: string, opts: { ffmpegPath?: string; ffprobePath?: string; withPts?: boolean } = {}): Promise<DecodedFrame[]> {
  const raws = await ffmpegRaw(opts.ffmpegPath ?? 'ffmpeg', input)
  const pts = opts.withPts ? await ffprobePts(opts.ffprobePath ?? 'ffprobe', input) : []
  return raws.map((r, index) => ({ index, result: decodeGrayStrip(r), ptsSec: Number.isFinite(pts[index]) ? pts[index] : null }))
}

export function summarizeDecoded(frames: DecodedFrame[]): FileDecodeSummary {
  const ok = frames.map((f) => f.result).filter((r): r is Extract<DecodeResult, { ok: true }> => r.ok)
  let nonUnitSteps = 0
  let backSteps = 0
  let maxStepFrames = 0
  for (let i = 1; i < ok.length; i++) {
    const d = ok[i].frame - ok[i - 1].frame
    if (d !== 1) nonUnitSteps++
    if (d <= 0) backSteps++
    maxStepFrames = Math.max(maxStepFrames, Math.abs(d))
  }
  return {
    frames: frames.length,
    decoded: ok.length,
    failed: frames.length - ok.length,
    channels: [...new Set(ok.map((r) => r.channel))].sort((a, b) => a - b),
    firstRecMs: ok[0]?.recMs ?? null,
    lastRecMs: ok.at(-1)?.recMs ?? null,
    nonUnitSteps, backSteps, maxStepFrames,
  }
}
