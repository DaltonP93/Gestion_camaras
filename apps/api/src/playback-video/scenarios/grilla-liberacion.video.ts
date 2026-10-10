// S5/S9 grilla con cámaras bloqueadas · S7 liberación de sesiones — web REAL + API
// REAL + FFmpeg real detrás del NVR simulado. Ver ../README.md.
//
// Grilla 2×2, búsqueda 09:59–10:02 (canal 1: A, B y C; canales 2 y 4: 10:00–10:01;
// canal 3: 10:00–10:02):
//   canal 1 sano · canal 2 acepta y no entrega (bloqueada) · canal 3 se corta a los
//   8 s sin cerrar · canal 4 responde 404 RTSP (falla rápida).
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { defectMessage, RUN_KNOWN_DEFECTS, ScenarioReport } from '../lib/report'
import { iso, sleep, T } from '../lib/scenario-utils'
import { jointInfraAvailable } from '../../security-joint/harness'
import { assertIsolation, startVideoEnv, type SimEvent, type VideoEnv } from '../lib/video-env'
import type { VideoPage } from '../lib/browser-page'

const FILE = 'grilla-liberacion'
const USER = 'sup_grilla'
const reports: Record<string, ScenarioReport> = {}
const RANGE = { start: T('09:58:00'), end: T('10:10:00') }
/** `-timeout` de E/S RTSP que la API pasa a FFmpeg (recordings.ts, rtspTimeoutUs = 60 s). */
const RTSP_IO_TIMEOUT_MS = 60_000
/** Gracia SIGTERM → SIGKILL por defecto (termination-timing.ts, DEFAULT_KILL_GRACE_MS). */
const KILL_GRACE_MS = 2_000

/** Instante en que terminó el FFmpeg consumidor `pid` (lo registra su productor). */
function exitOf(events: SimEvent[], pid: number, since: number): number | null {
  const e = events.find((x) => x.pid === pid && x.t >= since && (x.ev === 'consumer_gone' || x.ev === 'producer_exit'))
  return e ? e.t : null
}

/**
 * Mecanismo (sin API ni navegador): el comando de preview de la API, con SIGTERM
 * mientras su stdout se DRENA o después de dejar de leerlo (lo que hace la API al
 * cerrar: `proc.stdout.unpipe(res)` y SIGTERM). SIGKILL a la gracia, como el registry.
 */
async function sigtermProbe(ffmpeg: string, drain: boolean): Promise<{ salidaMs: number; senal: string | null; codigo: number | null }> {
  const args = ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '30', '-maxrate', '1500k', '-bufsize', '3000k',
    '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level', '3.1', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']
  const ff = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  ff.stdout.on('data', () => undefined)
  await sleep(3_000)
  if (!drain) { ff.stdout.pause(); await sleep(300) }
  const t = Date.now()
  ff.kill('SIGTERM')
  const k = setTimeout(() => ff.kill('SIGKILL'), KILL_GRACE_MS)
  const [code, sig] = await new Promise<[number | null, string | null]>((r) => ff.on('exit', (c, s) => r([c, s])))
  clearTimeout(k)
  ff.stdout.destroy()
  return { salidaMs: Date.now() - t, senal: sig, codigo: code }
}

describe.skipIf(!jointInfraAvailable())('video real · grilla con cámaras bloqueadas y liberación de sesiones', () => {
  let env: VideoEnv

  beforeAll(async () => {
    env = await startVideoEnv({ label: FILE, maxConcurrentPlaybackSessions: 4 })
    await env.createUser(USER, 'SUPERVISOR')
  })

  afterAll(async () => {
    const net = await env?.stop()
    // Aislamiento: Node (net-redirect y centinela) y navegador (netlog). Ver video-env.ts.
    if (net) assertIsolation(FILE, net)
  })

  // ── S5/S9 · Grilla ───────────────────────────────────────────────────────
  it('S5/S9 · grilla 2×2: una cámara bloqueada, una cortada y una con error no frenan a la sana', async () => {
    env.setBehaviors({ 201: { noData: true }, 301: { cutAfterSec: 8 }, 401: { rtspError: 404 } })
    const rep = reports.S5 = new ScenarioReport(FILE, 'S5-grilla-bloqueadas', inject('videoRun').reportDir, env.describe())
    const p = await env.openPage(USER)
    const apiFrom = env.api.length
    const snapshots: Array<{ t: number; badges: Array<string | null> }> = []
    let tPlay = 0
    let tClose = 0
    try {
      await p.page.goto(`${env.baseUrl}/recordings`)
      await p.page.click('button[title="Cuatro cámaras"]')
      for (const ch of [1, 2, 3, 4]) {
        await p.page.locator('button', { hasText: `Cam ${ch}` }).locator('span[title="Incluir en la búsqueda"]').click()
      }
      const inputs = p.page.locator('input[type="datetime-local"]')
      await inputs.nth(0).fill('2026-10-01T09:59')
      await inputs.nth(1).fill('2026-10-01T10:02')
      await p.page.getByRole('button', { name: 'Buscar', exact: true }).click()
      await p.page.waitForTimeout(1_500)
      tPlay = Date.now()
      await p.page.click('button[title="Reproducir"]')
      for (let i = 0; i < 9; i++) {
        await sleep(5_000)
        await p.drain()
        snapshots.push({ t: Date.now() - tPlay, badges: [0, 1, 2, 3].map((s) => p.badge(s).badge) })
      }
      const tWindowEnd = Date.now()
      // Celda → cámara (rótulo "NVR simulado · Cam N").
      const camOfSlot = [0, 1, 2, 3].map((s) => Number(p.badge(s).text.match(/Cam (\d)/)?.[1] ?? NaN))
      const perSlot = [0, 1, 2, 3].map((s) => {
        const dec = p.frames.filter((f) => f.slot === s && f.recMs !== null)
        return {
          slot: s, camara: camOfSlot[s], cuadros: dec.length, canales: [...new Set(dec.map((f) => f.ch))],
          primero: iso(dec[0]?.recMs), ultimo: iso(dec.at(-1)?.recMs),
          ultimoCuadroHaceMs: dec.length ? tWindowEnd - (dec.at(-1) as { wall: number }).wall : null,
          grabacionMostradaMs: dec.length ? (dec.at(-1)!.recMs as number) - (dec[0].recMs as number) : 0,
          rotulos: p.badgeHistory(s).map((b) => ({ ms: b.wall - tPlay, rotulo: b.badge, detalle: b.detail.slice(0, 80) })),
        }
      })
      const api = env.api.slice(apiFrom)
      const maxLeases = Math.max(0, ...api.map((a) => a.active))
      const maxFfmpeg = Math.max(0, ...api.map((a) => a.consumers.length))
      const sim = env.simEvents().filter((e) => e.t >= tPlay)
      const opens = sim.filter((e) => e.ev === 'rtsp_open' && !e.probe)
      const tracksRequested = [...new Set(opens.map((e) => String(e.track)))].sort()
      const tracksReturned = [...env.isapi.tracksReturned].sort()
      const cut = sim.find((e) => e.ev === 'cut' && e.track === '301')
      const cutPid = cut?.pid

      // Sin tocar nada: esperar a que el -timeout de RTSP (emulado por el NVR
      // simulado) termine el FFmpeg de la celda cortada, y observar la UI después.
      const cutDeadline = (cut?.t ?? tPlay + 10_000) + RTSP_IO_TIMEOUT_MS + 10_000
      while (Date.now() < cutDeadline) {
        if (cutPid !== undefined && exitOf(env.simEvents(), cutPid, tPlay) !== null) break
        await sleep(1_000)
      }
      await sleep(4_000)
      await p.drain()
      snapshots.push({ t: Date.now() - tPlay, badges: [0, 1, 2, 3].map((s) => p.badge(s).badge) })
      const simAll = env.simEvents().filter((e) => e.t >= tPlay)
      const ioTimeout = simAll.find((e) => e.ev === 'io_timeout' && e.pid === cutPid)
      const cutExitT = cutPid !== undefined ? exitOf(simAll, cutPid, tPlay) : null
      const apiAfterCutExit = cutExitT !== null ? env.api.filter((a) => a.wall >= cutExitT && a.wall <= cutExitT + 5_000) : []
      const leaseFreed = apiAfterCutExit.some((a) => a.active === a.consumers.length && !a.consumers.includes(cutPid as number))
      const cam3Slot = camOfSlot.indexOf(3)
      const cam3Frames = p.frames.filter((f) => f.slot === cam3Slot && f.recMs !== null)
      const cam3Hist = p.badgeHistory(cam3Slot).map((b) => ({ ms: b.wall - tPlay, wall: b.wall, rotulo: b.badge, detalle: b.detail.slice(0, 80) }))
      // Imagen congelada: el mayor intervalo sin cuadro nuevo en la celda cortada (al
      // terminar por timeout FFmpeg vacía lo que tenía, así que puede haber cuadros
      // DESPUÉS del congelamiento). Se mide cuánto de ese intervalo siguió en "● Play".
      let freeze: { from: number; to: number } | null = null
      for (let i = 1; i < cam3Frames.length; i++) {
        const gap = cam3Frames[i].wall - cam3Frames[i - 1].wall
        if (!freeze || gap > freeze.to - freeze.from) freeze = { from: cam3Frames[i - 1].wall, to: cam3Frames[i].wall }
      }
      if (cam3Frames.length > 0 && (!freeze || Date.now() - (cam3Frames.at(-1) as { wall: number }).wall > freeze.to - freeze.from)) {
        freeze = { from: (cam3Frames.at(-1) as { wall: number }).wall, to: Date.now() }
      }
      const badgeAt = (w: number) => [...cam3Hist].reverse().find((h) => h.wall <= w)?.rotulo ?? null
      const firstNotPlay = freeze ? cam3Hist.find((h) => h.wall > (freeze as { from: number }).from && h.rotulo !== '● Play') : undefined
      const frozenPlayMs = freeze && badgeAt(freeze.from) === '● Play' ? Math.min(freeze.to, firstNotPlay?.wall ?? Infinity) - freeze.from : (freeze ? 0 : null)
      const lastShown = cam3Frames.at(-1)?.recMs ?? null
      const finalBadge = cam3Hist.at(-1)?.rotulo ?? null
      const cam3Retries = p.previews.filter((r) => r.cameraId === env.cams[3] && cutExitT !== null && r.wall > cutExitT).length

      // Cerrar la pestaña con todo en curso.
      await p.drain()
      tClose = Date.now()
      await p.close()
      const rel = await env.waitAllReleased(10_000)

      rep.metric('celdas', perSlot)
      rep.metric('rotulosCada5s', snapshots)
      rep.metric('maxLeases', maxLeases)
      rep.metric('maxFfmpeg', maxFfmpeg)
      rep.metric('intentosPorPista', Object.fromEntries(tracksRequested.map((t) => [t, opens.filter((e) => String(e.track) === t).length])))
      rep.metric('pistasPedidas', tracksRequested)
      rep.metric('pistasDevueltasPorLaBusqueda', tracksReturned)
      rep.metric('liberacionAlCerrarMs', rel.ms)

      const byCam = (ch: number) => perSlot.find((x) => x.camara === ch)
      const sane = byCam(1)
      const cutCell = byCam(3)
      rep.invariant('I-S5-1', 'cada celda muestra sólo su cámara', 'canales de cada celda = su cámara', perSlot.map((x) => ({ cam: x.camara, canales: x.canales })),
        perSlot.every((x) => x.canales.every((c) => c === x.camara)) && camOfSlot.every((c) => Number.isFinite(c)))
      rep.invariant('I-S5-2', 'la cámara sana sigue reproduciendo pese a las otras tres', '≥ 20 s de grabación mostrada y cuadros hasta el final de la ventana',
        sane && { mostradaMs: sane.grabacionMostradaMs, ultimoCuadroHaceMs: sane.ultimoCuadroHaceMs },
        !!sane && sane.grabacionMostradaMs >= 20_000 && sane.ultimoCuadroHaceMs !== null && sane.ultimoCuadroHaceMs <= 5_000)
      rep.invariant('I-S5-3', 'la cámara cortada mostró su video antes del corte', '≥ 1 cuadro del canal 3', cutCell?.cuadros ?? 0, (cutCell?.cuadros ?? 0) > 0)
      rep.invariant('I-S5-4', 'nunca se supera el límite de sesiones del NVR', `≤ 4 leases y ≤ 4 FFmpeg`, { maxLeases, maxFfmpeg }, maxLeases <= 4 && maxFfmpeg <= 4)
      const problemCells = [2, 4].map((ch) => byCam(ch))
      rep.invariant('I-S5-5', 'las celdas sin video (bloqueada y 404) muestran un problema, no quedan "cargando"', '"Error" o "Sin avance" al final de la ventana',
        problemCells.map((c) => ({ cam: c?.camara, final: c?.rotulos.at(-1)?.rotulo })),
        problemCells.every((c) => c !== undefined && ['Error', 'Sin avance'].includes(String(c.rotulos.at(-1)?.rotulo))))
      const leaseUnder = api.filter((a) => a.active < a.consumers.length).length
      rep.invariant('I-S5-7', 'ningún lease se libera antes de que su FFmpeg termine', 'leases ≥ FFmpeg vivos en cada muestra', { muestras: api.length, violaciones: leaseUnder }, api.length > 0 && leaseUnder === 0)
      rep.invariant('I-S5-6', 'al cerrar la pestaña se liberan todos los FFmpeg, productores y leases', '0 en ≤ 5 s', { ms: rel.ms, quedan: rel.after }, rel.ms !== null && rel.ms <= 5_000)

      const masked = problemCells.map((c) => {
        const hist = c?.rotulos ?? []
        const firstErr = hist.findIndex((h) => h.rotulo === 'Error')
        return { cam: c?.camara, errorEnMs: firstErr >= 0 ? hist[firstErr].ms : null, despues: firstErr >= 0 ? hist.slice(firstErr + 1).map((h) => `${h.rotulo}@${h.ms}`) : [] }
      })
      rep.defect('D-S5-a', 'el error de una celda no queda tapado por "Sin avance"', 'tras "Error" el rótulo sigue en "Error"', masked,
        masked.every((m) => m.errorEnMs !== null && m.despues.every((d) => d.startsWith('Error'))))
      const cutRelMs = cut && cutExitT !== null && cutExitT < tClose ? cutExitT - cut.t : null
      const cutInfo = {
        cortaEnMs: cut ? cut.t - tPlay : null, timeoutRtspEmulado: !!ioTimeout, liberadaTrasCorteMs: cutRelMs,
        leaseLiberado: leaseFreed, congeladoMs: freeze ? freeze.to - freeze.from : null, rotuloPlayCongeladoMs: frozenPlayMs,
        ultimoCuadroMostrado: iso(lastShown), rotuloFinal: finalBadge, previewsNuevosCam3TrasFin: cam3Retries,
        rotulosCam3: cam3Hist.map(({ ms, rotulo, detalle }) => ({ ms, rotulo, detalle })),
      }
      rep.metric('celdaCortada', cutInfo)
      rep.invariant('I-S5-8', 'con el NVR mudo, el -timeout de RTSP termina el FFmpeg y libera el lease sin acción del usuario (ciclo de vida explícito)',
        `FFmpeg terminado ≤ ${RTSP_IO_TIMEOUT_MS / 1000} s + 5 s después del corte, antes de cerrar la pestaña, y lease liberado`,
        { liberadaTrasCorteMs: cutRelMs, leaseLiberado: leaseFreed, timeoutRtspEmulado: !!ioTimeout },
        cutRelMs !== null && cutRelMs <= RTSP_IO_TIMEOUT_MS + 5_000 && leaseFreed)
      rep.defect('D-S5-b', 'la sesión del NVR de una celda sin datos se libera cuando la UI ya la dio por perdida (no al minuto)',
        'FFmpeg y lease liberados ≤ 30 s después del corte (umbral de "sin avance" y de sesión sin consumidor del propio producto)',
        { liberadaTrasCorteMs: cutRelMs }, cutRelMs !== null && cutRelMs <= 30_000)
      rep.defect('D-S5-d', 'una celda congelada (el origen dejó de entregar a mitad) no sigue mostrando "● Play"',
        'rótulo distinto de "● Play" ≤ 10 s después del último cuadro nuevo', { congeladoMs: cutInfo.congeladoMs, rotuloPlayCongeladoMs: frozenPlayMs, siguienteRotulo: firstNotPlay?.rotulo ?? null },
        frozenPlayMs !== null && frozenPlayMs <= 10_000)
      const blockEnd = T('10:02:00')
      rep.defect('D-S5-e', 'un fin PREMATURO del stream (a mitad del bloque) no se presenta como "Sin grabación"',
        'si el último cuadro está > 1 GOP antes del fin del bloque, el rótulo final no es "Sin grabación" (error o reintento)',
        { ultimoCuadro: iso(lastShown), finDelBloque: iso(blockEnd), rotuloFinal: finalBadge, reintentos: cam3Retries },
        lastShown === null || lastShown >= blockEnd - 2_000 || finalBadge !== 'Sin grabación')
      const blind = tracksRequested.filter((t) => !tracksReturned.includes(t))
      rep.defect('D-S5-c', 'sólo se piden pistas que la búsqueda devolvió con grabación (PLAYER_TEST_PLAN §1.1)', '0 pistas pedidas a ciegas', { aCiegas: blind }, blind.length === 0)
    } finally {
      if (!tClose) await p.close()
      await env.waitAllReleased(10_000)
      rep.write({ pagina: p.dump(), api: env.api.slice(apiFrom).filter((_, i) => i % 4 === 0), sim: env.simEvents().filter((e) => e.t >= tPlay - 1_000) })
    }
  })

  it.runIf(RUN_KNOWN_DEFECTS).each(['D-S5-a', 'D-S5-b', 'D-S5-c', 'D-S5-d', 'D-S5-e'])('DEFECTO conocido %s (opt-in)', (id) => {
    const c = reports.S5?.get(id)
    expect(c?.ok, defectMessage(c, id)).toBe(true)
  })

  // ── S7 · Liberación ──────────────────────────────────────────────────────
  it('S7 · liberación: seek, cambio de cámara, navegación SPA, navegación completa (en backpressure), cierre de pestaña', async () => {
    env.setBehaviors({})
    const rep = reports.S7 = new ScenarioReport(FILE, 'S7-liberacion', inject('videoRun').reportDir, env.describe())
    const p: VideoPage = await env.openPage(USER)
    const context = p.context
    const apiFrom = env.api.length
    const table: Record<string, unknown> = {}
    /**
     * Salida REAL de cada FFmpeg anterior, desde la acción (ms). Se calcula al final:
     * el productor registra la salida unos ms DESPUÉS de que el PID desaparece de `ps`.
     */
    const exitCases: Array<{ caso: string; pids: number[]; since: number }> = []
    const exitsMs = (pids: number[], since: number) => {
      const ev = env.simEvents()
      return pids.map((pid) => { const x = exitOf(ev, pid, since); return x === null ? null : x - since })
    }
    const playing = async (camCh: number, iso8601: string) => {
      await p.deepLink(env.cams[camCh], iso8601)
      return p.waitForFrame((f) => f.ch === camCh, 40_000, `cuadros del canal ${camCh}`, Date.now())
    }
    try {
      // (1) seek por la línea de tiempo
      await playing(1, '2026-10-01T10:00:00.000Z')
      await sleep(1_500)
      let old = env.procs().consumers
      let t = await p.clickTimeline(T('10:00:30'), RANGE.start, RANGE.end)
      let r = await env.waitReleased(old, 10_000)
      table.seek = { ffmpegAnteriores: old.length, liberadoMs: r.ms }
      exitCases.push({ caso: 'seek', pids: old, since: t })
      rep.invariant('I-S7-1', 'seek: el FFmpeg anterior termina', '≤ 5 s', table.seek, old.length > 0 && r.ms !== null && r.ms <= 5_000)
      await p.waitForFrame((f) => (f.recMs as number) >= T('10:00:29'), 25_000, 'cuadros tras el seek', t)

      // (2) cambio de cámara en la celda activa: incluir "Cam 4" en la búsqueda
      // (búsqueda incremental del mismo rango) y asignarla con un clic en el árbol.
      await p.page.locator('button', { hasText: 'Cam 4' }).locator('span[title="Incluir en la búsqueda"]').click()
      await sleep(1_500)
      await p.drain()
      old = env.procs().consumers
      t = Date.now()
      await p.page.locator('button', { hasText: 'Cam 4' }).first().click()
      r = await env.waitReleased(old, 10_000)
      const ch4 = await p.waitForFrame((f) => f.ch === 4, 30_000, 'cuadros del canal 4', t).catch(() => null)
      await sleep(2_000)
      await p.drain()
      const ch1After = ch4 ? p.frames.filter((f) => f.slot === 0 && f.wall > ch4.wall && f.ch === 1).length : null
      const now = env.apiNow()
      table.cambioDeCamara = { ffmpegAnteriores: old.length, liberadoMs: r.ms, primerCuadroCanal4Ms: ch4 ? ch4.wall - t : null, cuadrosCanal1Despues: ch1After, ffmpeg: now.consumers.length, leases: now.active }
      exitCases.push({ caso: 'cambioDeCamara', pids: old, since: t })
      rep.invariant('I-S7-2', 'cambio de cámara: el FFmpeg anterior termina y queda una sola sesión (la nueva)', '≤ 5 s; 1 FFmpeg; 0 cuadros del canal 1 después del primero del 4', table.cambioDeCamara,
        old.length > 0 && r.ms !== null && r.ms <= 5_000 && ch4 !== null && ch1After === 0 && now.consumers.length === 1 && now.active === 1)

      // (3) navegación SPA fuera de Grabaciones (NavLink al tablero)
      await p.drain()
      old = env.procs().consumers
      t = Date.now()
      await p.page.locator('a[href="/"]').first().click()
      r = await env.waitReleased(old, 10_000, 0)
      table.navegacionSpa = { ffmpegAnteriores: old.length, liberadoMs: r.ms, deleteEnviado: p.net.some((n) => n.kind === 'delete' && n.wall >= t), leases: r.after.active }
      exitCases.push({ caso: 'navegacionSpa', pids: old, since: t })
      rep.invariant('I-S7-3', 'navegación SPA: DELETE y liberación', '≤ 5 s, 0 leases', table.navegacionSpa, old.length > 0 && r.ms !== null && r.ms <= 5_000)

      // (4) navegación completa con el FFmpeg en backpressure (1/2×: el navegador lee más lento)
      await playing(1, '2026-10-01T10:00:00.000Z')
      await p.page.click('button[title="Velocidad 1/2×"]')
      await sleep(10_000)
      await p.drain()
      old = env.procs().consumers
      t = Date.now()
      await p.page.goto(`${env.baseUrl}/`)
      r = await env.waitReleased(old, 10_000, 0)
      table.navegacionCompleta = { ffmpegAnteriores: old.length, liberadoMs: r.ms, leases: r.after.active }
      exitCases.push({ caso: 'navegacionCompleta', pids: old, since: t })
      rep.invariant('I-S7-4', 'navegación completa con backpressure: FFmpeg termina (SIGKILL si ignora SIGTERM) y se libera el lease', '≤ 5 s', table.navegacionCompleta, old.length > 0 && r.ms !== null && r.ms <= 5_000)

      // (5) cierre de pestaña a mitad de bloque
      await playing(1, '2026-10-01T10:00:20.000Z')
      await sleep(2_000)
      await p.drain()
      old = env.procs().consumers
      t = Date.now()
      await p.close()
      r = await env.waitReleased(old, 10_000, 0)
      table.cierreDePestana = { ffmpegAnteriores: old.length, liberadoMs: r.ms, leases: r.after.active }
      exitCases.push({ caso: 'cierreDePestana', pids: old, since: t })
      rep.invariant('I-S7-5', 'cierre de pestaña: liberación sin DELETE (desconexión del cliente)', '≤ 5 s', table.cierreDePestana, old.length > 0 && r.ms !== null && r.ms <= 5_000)

      // (6) pestaña oculta: NO se puede producir con Playwright en este entorno
      // (medido: visibilityState sigue "visible" con bringToFront de otra pestaña,
      // window.open + Target.activateTarget, ventana minimizada por CDP, headless y
      // con ventana bajo Xvfb, con y sin los flags de backgrounding de Playwright; y
      // Page.setWebLifecycleState('frozen') no congela la página visible: sus timers
      // siguen corriendo). Queda como medición local/manual con un Chrome real.
      rep.note('Pestaña oculta: no reproducible con Playwright (ver README, "Límites"). Grabaciones no escucha visibilitychange ni pagehide; en segundo plano el efecto depende de las políticas del navegador (throttling de timers, pausa de video) — medición local/manual.')

      // (7) entradas de previewSessions que quedan sin proceso ni lease
      const zombies0 = env.apiNow()
      await sleep(10_000)
      const zombies = env.apiNow()
      table.sesionesRetenidas = { alTerminar: zombies0.previewSessions, a10s: zombies.previewSessions, leases: zombies.active, ffmpeg: zombies.consumers.length }
      rep.defect('D-S7-a', 'sin entradas de preview retenidas tras liberar (hoy se barren al vencer el TTL de 30 min)', 'previewSessions = 0 a los 10 s', table.sesionesRetenidas, zombies.previewSessions === 0)
      // (8) ¿Termina FFmpeg con SIGTERM? Al cerrar, la API hace `proc.stdout.unpipe(res)`
      // y SIGTERM: con stdout sin leer, FFmpeg queda bloqueado escribiendo su último
      // fragmento, ignora SIGTERM y lo termina el SIGKILL de la gracia (2 s). Eso
      // retiene el lease del NVR 2 s en cada seek/cambio/cierre y corta RTSP sin
      // TEARDOWN. Se mide en la suite (salidas) y se aísla el mecanismo sin la API.
      await sleep(500)
      const salidas = Object.fromEntries(exitCases.map((c) => [c.caso, exitsMs(c.pids, c.since)]))
      const allExits = Object.values(salidas).flat()
      const finite = allExits.filter((x): x is number => x !== null)
      const mech = {
        drenando: await sigtermProbe(inject('videoRun').realFfmpeg, true),
        sinDrenar: await sigtermProbe(inject('videoRun').realFfmpeg, false),
      }
      table.salidaFfmpeg = { salidasMs: salidas, graciaSigkillMs: KILL_GRACE_MS, mecanismo: mech }
      rep.invariant('I-S7-8', 'mecanismo de control: FFmpeg con stdout drenado sale con SIGTERM', '≤ 1000 ms, sin SIGKILL', mech.drenando,
        mech.drenando.senal === null && mech.drenando.salidaMs <= 1_000)
      rep.defect('D-S7-b', 'al liberar, FFmpeg termina con SIGTERM (sin esperar el SIGKILL de la gracia de 2 s)', 'cada FFmpeg anterior termina ≤ 1000 ms después de la acción',
        { salidasMs: salidas, mecanismoSinDrenar: mech.sinDrenar }, finite.length > 0 && finite.length === allExits.length && finite.every((x) => x <= 1_000))
      // Trinquete: hoy cada FFmpeg anterior sale por el SIGKILL de la gracia de 2 s
      // (2,02–2,16 s). I-S7-1…5 sólo exigen ≤ 5 s: sin esto, una gracia más larga
      // (lease del NVR retenido más tiempo en cada seek/cambio/cierre) pasaba en verde.
      rep.ratchet('R-S7-b', 'D-S7-b', 'cada FFmpeg anterior no tarda más que hoy en salir', '≤ 3000 ms después de la acción (hoy 2,0–2,2 s, SIGKILL de la gracia)',
        { salidasMs: salidas }, finite.length > 0 && finite.every((x) => x <= 3_000))
      rep.metric('liberacion', table)
      const s7api = env.api.slice(apiFrom)
      const under7 = s7api.filter((a) => a.active < a.consumers.length).length
      rep.invariant('I-S7-7', 'ningún lease se libera antes de que su FFmpeg termine (S2.5/S5.2)', 'leases ≥ FFmpeg vivos en cada muestra', { muestras: s7api.length, violaciones: under7 }, s7api.length > 0 && under7 === 0)
    } finally {
      await p.close()
      await context.close().catch(() => undefined)
      await env.waitAllReleased(10_000)
      rep.write({ pagina: p.dump(), api: env.api.slice(apiFrom).filter((_, i) => i % 4 === 0), sim: env.simEvents() })
    }
  })

  it.runIf(RUN_KNOWN_DEFECTS).each(['D-S7-a', 'D-S7-b'])('DEFECTO conocido %s (opt-in)', (id) => {
    const c = reports.S7?.get(id)
    expect(c?.ok, defectMessage(c, id)).toBe(true)
  })
})
