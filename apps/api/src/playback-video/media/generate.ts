// apps/api/src/playback-video/media/generate.ts
//
// Generador de "grabaciones" sintéticas para el NVR simulado. Cada cuadro lleva el
// instante de grabación que representa (franja de `timecode.ts`) y, para mirarlo a
// ojo, un texto "CH1 2026-10-01 10:00:07 f8".
//
// Los segmentos se generan AL CORRER las pruebas en un directorio temporal y se
// borran al final: nada de video se versiona (invariante 6 del proyecto).
//
// Se parece a un NVR en lo que importa para el reproductor: H.264 sin cuadros B,
// GOP fijo (2 s por defecto), 25 fps. Los huecos son AUSENCIA de segmentos; los
// cortes y fallas de entrega se configuran por pista en el manifiesto (ver
// nvr-sim/producer.mjs).
//
// Uso manual (para mirar los archivos):  npx tsx src/playback-video/media/generate.ts <dir>

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EPOCH_BASE_S, STRIP_CHECKSUM_BASE, STRIP_FPS, STRIP_WEIGHTS } from './timecode'

/** Comportamiento de entrega de una pista del NVR simulado (lo aplica nvr-sim/producer.mjs). */
export interface SimBehavior {
  /** Ritmo de entrega relativo a tiempo real (1 = como el RTSP de playback del NVR). */
  readrate?: number
  /** Ráfaga inicial antes de imponer el ritmo (s). ffmpeg 6.1 usa 0,5 por defecto. */
  initialBurstSec?: number
  /** Huecos dentro de la ventana pedida: 'skip' = sigue con el siguiente segmento; 'end' = termina. */
  gapPolicy?: 'skip' | 'end'
  /** Espera antes del primer byte (ms). */
  startDelayMs?: number
  /** Acepta la conexión y no entrega nada (cámara bloqueada). */
  noData?: boolean
  /** Deja de entregar a los N s SIN cerrar (corte a mitad). */
  cutAfterSec?: number
  /** Cierra la entrega a los N s (fin de stream prematuro). */
  closeAfterSec?: number
  /** Responde como el RTSP del NVR con ese error (texto que reconoce classifyRtspError). */
  rtspError?: 401 | 404 | 453
  /**
   * Emula el `-timeout` de E/S de RTSP que pide la API (60 s): si el NVR queda mudo
   * más que eso, se cierra la conexión. Por defecto activo; `false` lo desactiva
   * (NVR que sigue respondiendo keepalive sin entregar video; hipótesis a medir en M).
   */
  ioTimeout?: boolean
}

export interface SegmentSpec {
  channel: number
  /** Pista ISAPI; por defecto la principal (canal*100+1). */
  track?: number
  /** Inicio en hora de pared del NVR, con la convención del código (componentes UTC, sufijo Z). */
  start: string
  durationSec: number
}

export interface ManifestSegment { start: string; end: string; file: string; fps: number; gop: number }

export interface SimManifest {
  nvrHost: string
  defaults: SimBehavior
  /** 'vp9' sólo para el Chromium de Playwright, que no decodifica H.264 (desvío documentado). */
  browserCodec?: 'vp9' | null
  tracks: Record<string, ManifestSegment[]>
  behaviors: Record<string, SimBehavior>
}

export interface GenerateOptions {
  fps?: number
  /** Tamaño del GOP en cuadros (50 = 2 s a 25 fps, típico de un NVR). */
  gop?: number
  width?: number
  height?: number
  concurrency?: number
  ffmpegPath?: string
}

/** IP ficticia RFC1918 del NVR simulado: la guarda SSRF rechaza loopback y TEST-NET. */
export const SIM_NVR_HOST = '10.255.0.10'

/**
 * Grabaciones del escenario por defecto (hora de pared del NVR, 2026-10-01):
 *  - canal 1: A 10:00:00–10:00:20, B 10:00:20–10:00:40 (contiguo), hueco real de
 *    6 s, C 10:00:46–10:01:06;
 *  - canales 2 y 4: un bloque 10:00:00–10:01:00; canal 3: 10:00:00–10:02:00 (más
 *    largo que corte + timeout RTSP de 60 s, para que en la grilla lo que termine la
 *    sesión cortada sea el timeout y no el fin del bloque). Sus fallas se fijan por
 *    escenario con `behaviors`.
 */
export const DEFAULT_SEGMENTS: SegmentSpec[] = [
  { channel: 1, start: '2026-10-01T10:00:00Z', durationSec: 20 },
  { channel: 1, start: '2026-10-01T10:00:20Z', durationSec: 20 },
  { channel: 1, start: '2026-10-01T10:00:46Z', durationSec: 20 },
  { channel: 2, start: '2026-10-01T10:00:00Z', durationSec: 60 },
  { channel: 3, start: '2026-10-01T10:00:00Z', durationSec: 120 },
  { channel: 4, start: '2026-10-01T10:00:00Z', durationSec: 60 },
]

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
]

/** Expresión `geq` de la franja (misma codificación y checksum que DECODER_JS). */
function stripExpression(firstFrame: number, channel: number): string {
  const F = `(${firstFrame}+N)`
  // Checksum por pesos (timecode.ts): la parte del canal es constante por segmento;
  // la del cuadro, un término por bit. `if` de geq es perezoso: sólo se evalúa en
  // los bloques del checksum.
  let chPart = STRIP_CHECKSUM_BASE
  for (let b = 0; b < 4; b++) chPart += ((channel >> b) & 1) * STRIP_WEIGHTS[24 + b]
  const fTerms = Array.from({ length: 24 }, (_, b) => `mod(floor(${F}/${2 ** b})\\,2)*${STRIP_WEIGHTS[b]}`).join('+')
  const CS = `mod(${chPart}+${fTerms}\\,256)`
  return `if(lt(X\\,16)\\,255\\,if(lt(X\\,32)\\,0\\,` +
    `if(lt(X\\,416)\\,255*mod(floor(${F}/pow(2\\,floor(X/16)-2))\\,2)\\,` +
    `if(lt(X\\,480)\\,255*mod(floor(${channel}/pow(2\\,floor(X/16)-26))\\,2)\\,` +
    `if(lt(X\\,608)\\,255*mod(floor(${CS}/pow(2\\,floor(X/16)-30))\\,2)\\,` +
    `if(lt(X\\,624)\\,255\\,0))))))`
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (c: Buffer) => { err += c.toString() })
    p.on('error', reject)
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} salió ${code}: ${err.slice(-400)}`)))
  })
}

/** Genera UN segmento: testsrc2 + franja + texto, H.264 sin cuadros B y GOP fijo. */
export async function generateSegment(
  file: string, channel: number, startEpochS: number, durationSec: number, opts: GenerateOptions = {},
): Promise<void> {
  const fps = opts.fps ?? STRIP_FPS
  const gop = opts.gop ?? fps * 2
  const w = opts.width ?? 640
  const h = opts.height ?? 360
  const firstFrame = (startEpochS - EPOCH_BASE_S) * fps
  if (!Number.isInteger(firstFrame) || firstFrame < 0 || firstFrame + durationSec * fps >= 2 ** 24) {
    throw new Error(`generador: inicio fuera del rango de la franja (${startEpochS})`)
  }
  const font = FONT_CANDIDATES.find((f) => fs.existsSync(f))
  // Texto legible (opcional: si no hay fuente, sólo la franja, que es lo que se mide).
  const label = font
    ? `,drawtext=fontfile=${font}:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:x=10:y=40:` +
      `text='CH${channel} %{pts\\:gmtime\\:${startEpochS}\\:%Y-%m-%d %H\\\\\\:%M\\\\\\:%S} f%{eif\\:mod(n\\,${fps})\\:d}'`
    : ''
  await run(opts.ffmpegPath ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=${fps}:d=${durationSec}`,
    '-f', 'lavfi', '-i', `color=c=black:s=640x24:r=${fps}:d=${durationSec},format=yuv420p,geq=lum='${stripExpression(firstFrame, channel)}':cb=128:cr=128`,
    '-filter_complex', `[0:v][1:v]overlay=0:0${label}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-movflags', '+faststart', file,
  ])
}

/** Genera todos los segmentos y devuelve el manifiesto (sin comportamientos). */
export async function generateRecordings(
  outDir: string, segments: SegmentSpec[] = DEFAULT_SEGMENTS, opts: GenerateOptions = {},
): Promise<SimManifest> {
  fs.mkdirSync(outDir, { recursive: true })
  const fps = opts.fps ?? STRIP_FPS
  const gop = opts.gop ?? fps * 2
  const manifest: SimManifest = { nvrHost: SIM_NVR_HOST, defaults: { readrate: 1, gapPolicy: 'skip', initialBurstSec: 0.5 }, tracks: {}, behaviors: {} }
  const jobs = segments.map((s, i) => {
    const track = String(s.track ?? s.channel * 100 + 1)
    const startMs = Date.parse(s.start)
    if (!Number.isFinite(startMs) || startMs % 1000 !== 0) throw new Error(`generador: inicio inválido ${s.start}`)
    const file = path.join(outDir, `ch${s.channel}_t${track}_${i}.mp4`)
    const seg: ManifestSegment = {
      start: new Date(startMs).toISOString().replace('.000Z', 'Z'),
      end: new Date(startMs + s.durationSec * 1000).toISOString().replace('.000Z', 'Z'),
      file, fps, gop,
    }
    ;(manifest.tracks[track] ??= []).push(seg)
    return () => generateSegment(file, s.channel, startMs / 1000, s.durationSec, opts)
  })
  const limit = Math.max(1, opts.concurrency ?? 4)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]()
  }))
  for (const list of Object.values(manifest.tracks)) list.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  return manifest
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  const out = process.argv[2]
  if (!out) {
    console.error('uso: npx tsx src/playback-video/media/generate.ts <directorio-de-salida>')
    process.exit(2)
  }
  generateRecordings(path.resolve(out)).then((m) => {
    fs.writeFileSync(path.join(path.resolve(out), 'manifest.json'), JSON.stringify(m, null, 1))
    console.log(`generados ${Object.values(m.tracks).flat().length} segmentos en ${out}`)
  }).catch((e) => { console.error(e); process.exit(1) })
}
