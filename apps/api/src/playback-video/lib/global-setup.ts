// apps/api/src/playback-video/lib/global-setup.ts
//
// Preparación de UNA corrida de la suite de video (vitest globalSetup):
//   0. barre directorios `vcv-*` de corridas ABORTADAS (SIGKILL, timeout externo,
//      reinicio): el borrado normal es el del teardown, que en esos casos no corre;
//   1. directorio temporal CORTO bajo os.tmpdir() (los sockets UNIX del simulador
//      no admiten rutas largas);
//   2. genera las grabaciones sintéticas (nada se versiona; se borran al final) y
//      decodifica un segmento para comprobar que generador y decodificador coinciden;
//   3. compila la web REAL con su vite.config.ts (bundle de producción, sin el
//      doble montaje de StrictMode del modo dev) salvo VIDEO_WEB_MODE=dev;
//   4. al terminar: RESUMEN.md, verificación de huérfanos y borrado de los medios.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TestProject } from 'vitest/node'
import { decodeFile, summarizeDecoded } from '../media/decode'
import { generateRecordings, DEFAULT_SEGMENTS } from '../media/generate'
import { listSimProcs, pidsMentioning, totalSimProcs } from './procs'
import { writeSummary } from './report'
import { API_ROOT, SIM_BIN, WEB_ROOT, type VideoRun } from './run-config'
import { importFromWeb, webPostcss } from './web'

/** Primer ejecutable `name` del PATH que NO sea el shim del simulador. */
function resolveReal(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === SIM_BIN) continue
    const p = path.join(dir, name)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* siguiente */ }
  }
  throw new Error(`suite de video: no se encontró ${name} en el PATH (instalar ffmpeg; en CI: apt-get install ffmpeg)`)
}

/** Prefijo de los directorios de corrida bajo os.tmpdir(). */
const RUN_PREFIX = 'vcv-'
/** Sin escrituras durante este lapso y sin procesos que lo usen ⇒ corrida abortada. */
const STALE_MS = 30 * 60_000

/** Última escritura en el directorio o en sus hijos directos (logs del simulador, manifiestos, medios). */
function lastActivityMs(dir: string): number {
  let last = fs.statSync(dir).mtimeMs
  for (const e of fs.readdirSync(dir)) {
    try { last = Math.max(last, fs.statSync(path.join(dir, e)).mtimeMs) } catch { /* se borró mientras tanto */ }
  }
  return last
}

/**
 * Borra los `vcv-*` de corridas abortadas: más de STALE_MS sin escrituras, sin
 * procesos del NVR simulado (`listSimProcs(dir/s)`) y sin ningún proceso que lo
 * mencione (navegador con su netlog, FFmpeg, productor). Una corrida viva escribe
 * su log del simulador y sus manifiestos todo el tiempo y tiene esos procesos.
 */
function sweepAbortedRuns(): string[] {
  const swept: string[] = []
  const tmp = os.tmpdir()
  let entries: string[] = []
  try { entries = fs.readdirSync(tmp).filter((e) => e.startsWith(RUN_PREFIX)) } catch { return swept }
  for (const e of entries) {
    const dir = path.join(tmp, e)
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue
      if (Date.now() - lastActivityMs(dir) < STALE_MS) continue
      if (totalSimProcs(listSimProcs(path.join(dir, 's'))) > 0 || pidsMentioning(dir).length > 0) continue
      fs.rmSync(dir, { recursive: true, force: true })
      swept.push(e)
    } catch { /* de otro usuario o en uso: se deja */ }
  }
  return swept
}

export default async function setup(project: TestProject) {
  const swept = sweepAbortedRuns()
  const realFfmpeg = resolveReal('ffmpeg')
  const realFfprobe = resolveReal('ffprobe')
  const version = execFileSync(realFfmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_PREFIX))
  const simWorkRoot = path.join(runDir, 's')
  const mediaDir = path.join(runDir, 'media')
  fs.mkdirSync(simWorkRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportDir = process.env.VIDEO_REPORT_DIR
    ? path.resolve(process.env.VIDEO_REPORT_DIR, stamp)
    : path.join(API_ROOT, '.video-reports', stamp)
  fs.mkdirSync(reportDir, { recursive: true })

  const t0 = Date.now()
  const manifest = await generateRecordings(mediaDir, DEFAULT_SEGMENTS, { ffmpegPath: realFfmpeg, concurrency: 4 })
  const genMs = Date.now() - t0
  // Generador (expresión geq) y decodificador (DECODER_JS) deben coincidir cuadro por
  // cuadro: si no, todo lo demás mediría basura. Un segmento alcanza (~1 s).
  const firstSeg = manifest.tracks['101'][0]
  const check = summarizeDecoded(await decodeFile(firstSeg.file, { ffmpegPath: realFfmpeg }))
  if (check.frames === 0 || check.failed > 0 || check.nonUnitSteps > 0 || check.firstRecMs !== Date.parse(firstSeg.start)) {
    fs.rmSync(runDir, { recursive: true, force: true })
    throw new Error(`suite de video: la franja generada no se decodifica bien (${JSON.stringify(check)})`)
  }

  const webMode = process.env.VIDEO_WEB_MODE === 'dev' ? 'dev' : 'build'
  const viteCacheDir = path.join(runDir, 'vite-cache')
  let webDist: string | null = null
  let buildMs = 0
  if (webMode === 'build') {
    const t1 = Date.now()
    webDist = path.join(runDir, 'web')
    const vite = await importFromWeb('vite')
    await vite.build({
      root: WEB_ROOT, configFile: path.join(WEB_ROOT, 'vite.config.ts'), logLevel: 'error', cacheDir: viteCacheDir,
      css: { postcss: await webPostcss() },
      build: { outDir: webDist, emptyOutDir: true, sourcemap: false, reportCompressedSize: false, chunkSizeWarningLimit: 100_000 },
    })
    buildMs = Date.now() - t1
  }

  const run: VideoRun = {
    runDir, simWorkRoot, reportDir, manifest, webMode, webDist, viteCacheDir, realFfmpeg, realFfprobe,
    startedAt: new Date().toISOString(),
  }
  project.provide('videoRun', run)
  fs.writeFileSync(path.join(reportDir, 'preparacion.txt'),
    `ffmpeg: ${version}\nmedios: ${Object.values(manifest.tracks).flat().length} segmentos en ${genMs} ms` +
    ` (control de franja: ${check.decoded}/${check.frames} cuadros)\nweb: ${webMode}${webMode === 'build' ? ` (${buildMs} ms)` : ''}\n` +
    `corridas abortadas barridas: ${swept.length ? swept.join(', ') : 'ninguna'}\n`)

  return async () => {
    // Huérfanos del simulador: ninguno debe quedar vivo al terminar la corrida.
    const left = listSimProcs(simWorkRoot)
    const orphans = totalSimProcs(left)
    if (orphans > 0) {
      for (const pid of [...left.consumers, ...left.feeders, ...left.producers]) { try { process.kill(pid, 'SIGKILL') } catch { /* ya salió */ } }
    }
    writeSummary(reportDir, {
      inicio: run.startedAt, fin: new Date().toISOString(), ffmpeg: version, web: webMode,
      'navegador/códec': process.env.VIDEO_BROWSER === 'chrome' ? 'Google Chrome (H.264)' : 'Chromium de Playwright (ver cada escenario)',
      'huérfanos al final': orphans,
      'defectos ejecutados como pruebas': process.env.RUN_KNOWN_DEFECTS === '1',
    })
    // Nunca se conservan videos ni imágenes: se borra todo el directorio temporal.
    fs.rmSync(runDir, { recursive: true, force: true })
    if (orphans > 0) throw new Error(`suite de video: quedaron ${orphans} procesos del NVR simulado vivos al terminar (se mataron)`)
  }
}
