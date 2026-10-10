// apps/api/src/playback-video/nvr-sim/plan.mjs
//
// Traduce la invocación RTSP de la API (FFmpeg/ffprobe) a:
//  (1) los argumentos del ffmpeg real, con entrada `-f mpegts -i unix:<socket>`;
//  (2) un plan para el productor (segmentos, recortes, ritmo y fallas).
// Falla cerrado: si la URL no es la del NVR simulado, imita el error de ffmpeg y
// sale 1 (jamás se contacta otra IP). Con `--probe <url>` imprime el primer
// segmento de la ventana (para el shim de ffprobe).
//
// Hipótesis del NVR (a calibrar con las mediciones M): arranca en el keyframe
// anterior o igual a `starttime` (lo que hace `-c copy` con inpoint), entrega a
// ritmo 1×, con una ráfaga inicial corta; sin grabación en la ventana responde 404.
import fs from 'node:fs'
import path from 'node:path'

const PROBE = process.argv[2] === '--probe'
const [work, ...argv] = PROBE ? [null, '-i', process.argv[3]] : process.argv.slice(2)
const manifestPath = process.env.VC_SIM_MANIFEST
const log = (o) => {
  if (!process.env.VC_SIM_LOG) return
  try { fs.appendFileSync(process.env.VC_SIM_LOG, JSON.stringify({ t: Date.now(), pid: process.ppid, ...o }) + '\n') } catch {}
}
const fail = (msg, code = 1) => { process.stderr.write(msg + '\n'); log({ ev: 'fail', msg: msg.split('\n').at(-1), probe: PROBE }); process.exit(code) }
if (!manifestPath) fail('vc-sim: falta VC_SIM_MANIFEST (fail closed)')
const M = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const iIdx = argv.indexOf('-i')
const url = argv[iIdx + 1]
let u
try { u = new URL(url) } catch { fail(`${url}: Invalid data found when processing input`) }
// Para el log y los errores: sin credenciales.
const masked = `${u.protocol}//${u.hostname}:${u.port || 554}${u.pathname}${u.search}`
if (u.hostname !== M.nvrHost) fail(`${masked}: Connection refused`)
const m = u.pathname.match(/^\/Streaming\/tracks\/(\d+)\/?$/)
if (!m) fail(`${masked}: Server returned 404 Not Found`)
const track = m[1]
const hik = (s) => s && new Date(s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')).getTime()
const startMs = hik(u.searchParams.get('starttime'))
const endMs = hik(u.searchParams.get('endtime'))
if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) fail(`${masked}: Server returned 400 Bad Request`)
// sun_path de un socket UNIX admite ~108 bytes: con una ruta más larga el socket se
// crearía truncado en otro lugar. Fallar claro (usar VC_SIM_WORK_ROOT corto).
if (!PROBE && `${work}/nvr.sock`.length > 100) fail(`vc-sim: ruta de socket demasiado larga (${work}); usar VC_SIM_WORK_ROOT corto`)
const beh = { ...(M.defaults ?? {}), ...((M.behaviors ?? {})[track] ?? {}) }
log({ ev: 'rtsp_open', track, startMs, endMs, beh, probe: PROBE, hasName: u.searchParams.has('name') })
if (beh.rtspError === 453) fail(`[rtsp @ 0x0] method DESCRIBE failed: 453 Not Enough Bandwidth\n${masked}: Server returned 4XX Client Error, but not one of 40{0,1,3,4}`)
if (beh.rtspError === 401) fail(`[rtsp @ 0x0] method DESCRIBE failed: 401 Unauthorized\n${masked}: Server returned 401 Unauthorized (authorization failed)`)
if (beh.rtspError === 404) fail(`[rtsp @ 0x0] method DESCRIBE failed: 404 Not Found\n${masked}: Server returned 404 Not Found`)

const segs = (M.tracks?.[track] ?? []).map((s) => ({ ...s, s: Date.parse(s.start), e: Date.parse(s.end) }))
  .filter((s) => s.e > startMs && s.s < endMs).sort((a, b) => a.s - b.s)
if (segs.length === 0) fail(`[rtsp @ 0x0] method DESCRIBE failed: 404 Not Found\n${masked}: Server returned 404 Not Found`)
const abs = (f) => (path.isAbsolute(f) ? f : path.resolve(path.dirname(manifestPath), f))
if (PROBE) { process.stdout.write(abs(segs[0].file)); process.exit(0) }

const parts = []
for (const s of segs) {
  if (parts.length > 0 && beh.gapPolicy === 'end' && s.s > parts.at(-1).absEnd) break
  parts.push({
    file: abs(s.file),
    inpoint: Math.max(0, (startMs - s.s) / 1000),
    outpoint: (Math.min(endMs, s.e) - s.s) / 1000,
    absStart: Math.max(startMs, s.s),
    absEnd: Math.min(endMs, s.e),
  })
}

// Argumentos del ffmpeg real: misma salida; entrada = socket UNIX mpegts; se quitan
// SÓLO las opciones del demuxer RTSP (ffmpeg 6.1 sale con código 8 "Option … not
// found" si las recibe con una entrada mpegts).
const RTSP_ONLY = new Set(['-rtsp_transport', '-timeout', '-rw_timeout', '-stimeout', '-reorder_queue_size'])
const IO_TIMEOUT = new Set(['-timeout', '-rw_timeout', '-stimeout'])
const out = []
// Timeout de E/S del socket RTSP que pidió la API (µs). El productor lo emula: si el
// "NVR" queda mudo más que eso, cierra la conexión (ver producer.mjs).
let ioTimeoutMs = null
for (let i = 0; i < argv.length; i++) {
  if (i < iIdx && IO_TIMEOUT.has(argv[i]) && Number(argv[i + 1]) > 0) ioTimeoutMs = Math.round(Number(argv[i + 1]) / 1000)
  if (i < iIdx && RTSP_ONLY.has(argv[i])) { i++; continue }
  if (i === iIdx) { out.push('-f', 'mpegts', '-i', `unix:${work}/nvr.sock`); i++; continue }
  out.push(argv[i])
}
// Argumentos de la API tal cual (URL sin credenciales): permiten re-ejecutar el
// comando H.264 REAL fuera del navegador (ver la prueba S0).
log({ ev: 'api_args', track, args: argv.map((a, i) => (i === iIdx + 1 ? `rtsp://usuario:clave@${u.hostname}:${u.port || 554}${u.pathname}${u.search}` : a)) })
// Sólo para el Chromium de Playwright (sin H.264/AAC): re-codificar la SALIDA a
// VP9/Opus. Desvío documentado; con Google Chrome no se aplica.
if (M.browserCodec === 'vp9') {
  const cv = out.indexOf('-c:v')
  if (cv >= 0 && out[cv + 1] === 'libx264') {
    const drop = new Set(['-preset', '-tune', '-profile:v', '-level', '-crf', '-maxrate', '-bufsize', '-x264-params'])
    const rebuilt = []
    for (let i = 0; i < out.length; i++) {
      if (i === cv) { rebuilt.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '1500k'); i++; continue }
      if (drop.has(out[i])) { i++; continue }
      rebuilt.push(out[i])
    }
    out.splice(0, out.length, ...rebuilt)
  }
  const ca = out.indexOf('-c:a')
  if (ca >= 0 && out[ca + 1] === 'aac') out[ca + 1] = 'libopus'
}
fs.writeFileSync(`${work}/plan.json`, JSON.stringify({ track, startMs, endMs, parts, beh, ioTimeoutMs }))
fs.writeFileSync(`${work}/argv`, out.map((a) => a + '\0').join(''))
log({ ev: 'plan', track, startMs, endMs, parts: parts.map((p) => ({ f: path.basename(p.file), in: p.inpoint, out: p.outpoint })), vp9: M.browserCodec === 'vp9', ioTimeoutMs })
