// apps/api/src/playback-video/nvr-sim/producer.mjs
//
// Productor del NVR simulado: escucha en un socket UNIX privado y entrega la
// ventana pedida como MPEG-TS a ritmo de tiempo real (como el RTSP de playback de
// un NVR). Fallas por pista: startDelayMs, noData (acepta y no entrega: cámara
// bloqueada), cutAfterSec (deja de entregar SIN cerrar), closeAfterSec (cierra).
//
// Timeout de E/S de RTSP: la API lanza FFmpeg con `-timeout 60000000` (60 s) y el
// shim tiene que quitarlo (no existe para una entrada mpegts). Para no perder ese
// comportamiento, cuando el "NVR" queda mudo (noData, corte, demora inicial) más que
// ese plazo, el productor cierra la conexión y FFmpeg ve el fin de la entrada.
// Diferencia conocida: con RTSP real FFmpeg ve un error ETIMEDOUT, acá un EOF (el
// código de salida puede diferir; la liberación es la misma). Hipótesis a
// calibrar en M: un NVR que deja de entregar pero sigue respondiendo los
// keepalive RTSP podría no disparar nunca ese timeout. `ioTimeout: false` en el
// comportamiento de la pista desactiva la emulación.
//
// Termina solo si muere su padre (el ffmpeg real que lanzó la API), aunque la API
// lo haya matado con SIGKILL: no deja huérfanos. Registra la salida del
// consumidor (`consumer_gone`) para medir la liberación.
//
// El PID del padre lo pasa el shim (`$$`, que pasa a ser el ffmpeg tras `exec`):
// `process.ppid` de Node es un valor fijo del arranque, y si la API mata al shim
// ANTES de que el productor arranque (p. ej. seeks encadenados), el productor nace
// ya reparentado y vigilaría al proceso init para siempre (medido: un productor
// huérfano en 1 de 3 corridas). Se lee /proc para detectar también un padre zombi
// o un reparentado posterior.
import fs from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'

const work = process.argv[2]
const P = JSON.parse(fs.readFileSync(`${work}/plan.json`, 'utf8'))
const parent = Number(process.argv[3]) || process.ppid

/** Campos de /proc/<pid>/stat después del nombre del comando (estado, ppid, …). */
function statFields(pid) {
  const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  return st.slice(st.lastIndexOf(')') + 2).split(' ')
}
function parentAlive() {
  let viaProc = true
  try {
    const [state] = statFields(parent)
    if (state === 'Z' || state === 'X') return false
  } catch (e) {
    if (e && e.code === 'ENOENT' && fs.existsSync('/proc/self/stat')) return false
    viaProc = false
  }
  if (!viaProc) { try { process.kill(parent, 0) } catch { return false } }
  // ¿Sigo siendo su hijo? (si el padre murió, el kernel me reparenta)
  try { if (Number(statFields('self')[1]) !== parent) return false } catch { /* sin /proc */ }
  return true
}
const real = process.env.VC_SIM_REAL_FFMPEG || '/usr/bin/ffmpeg'
const log = (o) => {
  if (!process.env.VC_SIM_LOG) return
  try { fs.appendFileSync(process.env.VC_SIM_LOG, JSON.stringify({ t: Date.now(), pid: parent, track: P.track, ...o }) + '\n') } catch {}
}
let child = null
let done = false
const bye = (why) => {
  if (done) return
  done = true
  try { child?.kill('SIGKILL') } catch {}
  try { fs.rmSync(work, { recursive: true, force: true }) } catch {}
  log({ ev: 'producer_exit', why })
  process.exit(0)
}
const watchParent = () => { if (!parentAlive()) { log({ ev: 'consumer_gone' }); bye('parent_gone') } }
watchParent()
setInterval(watchParent, 100)
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => bye(s))

const B = P.beh
const srv = net.createServer((sock) => {
  srv.close()
  log({ ev: 'consumer_connected' })
  sock.on('error', () => {})
  sock.on('close', () => bye('consumer_closed'))
  // Emulación del -timeout de RTSP: se arma cuando el NVR deja de entregar y se
  // desarma con el primer byte entregado.
  let silence = null
  const silent = (why) => {
    if (B.ioTimeout === false || !(P.ioTimeoutMs > 0) || silence) return
    silence = setTimeout(() => { log({ ev: 'io_timeout', why, afterMs: P.ioTimeoutMs }); sock.destroy() }, P.ioTimeoutMs)
  }
  const talking = () => { if (silence) { clearTimeout(silence); silence = null } }
  if (B.noData) { log({ ev: 'no_data' }); silent('no_data'); return }
  if (B.startDelayMs) silent('start_delay')
  setTimeout(() => {
    const list = `${work}/concat.txt`
    fs.writeFileSync(list, P.parts.map((p) =>
      `file '${p.file.replace(/'/g, "'\\''")}'\ninpoint ${p.inpoint.toFixed(3)}\noutpoint ${p.outpoint.toFixed(3)}\n`).join(''))
    child = spawn(real, [
      '-hide_banner', '-loglevel', 'error',
      '-readrate', String(B.readrate ?? 1), '-readrate_initial_burst', String(B.initialBurstSec ?? 0.5),
      '-f', 'concat', '-safe', '0', '-i', list,
      '-map', '0', '-c', 'copy', '-f', 'mpegts', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    const t0 = Date.now()
    let stopped = false
    let first = true
    child.stdout.on('data', (c) => {
      const el = (Date.now() - t0) / 1000
      if (first) { first = false; talking(); log({ ev: 'first_bytes', afterMs: Date.now() - t0 }) }
      if (B.cutAfterSec != null && el >= B.cutAfterSec) {
        if (!stopped) { stopped = true; try { child.kill('SIGSTOP') } catch {} ; log({ ev: 'cut', atSec: el }); silent('cut') }
        return
      }
      if (B.closeAfterSec != null && el >= B.closeAfterSec) { log({ ev: 'close', atSec: el }); sock.end(); return }
      if (!sock.write(c)) { child.stdout.pause(); sock.once('drain', () => child.stdout.resume()) }
    })
    child.on('close', () => { if (!stopped) { log({ ev: 'eof', afterMs: Date.now() - t0 }); sock.end() } })
  }, B.startDelayMs ?? 0)
}).listen(`${work}/nvr.sock`)
