// S1 continuidad · S2 seek · S4 velocidades — 1×1, canal 1, web REAL + API REAL +
// FFmpeg real detrás del NVR simulado. Ver ../README.md.
//
// Grabaciones del canal 1: A 10:00:00–:20, B :20–:40 (contiguo), hueco real de 6 s,
// C :46–10:01:06. GOP 2 s, 25 fps.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { decodeFile, summarizeDecoded } from '../media/decode'
import { SIM_BIN } from '../lib/run-config'
import { clockErrors, clockStats, isRecorded, rateWindow } from '../lib/metrics'
import { defectMessage, RUN_KNOWN_DEFECTS, ScenarioReport } from '../lib/report'
import { compactBorder, compactSession, DAY_YEAR, iso, maxOf, sessionsOf, sleep, T } from '../lib/scenario-utils'
import { jointInfraAvailable } from '../../security-joint/harness'
import { assertIsolation, startVideoEnv, type VideoEnv } from '../lib/video-env'

const FILE = 'reproduccion'
const GOP_MS = 2_000
const USER = 'sup_video'
const reports: Record<string, ScenarioReport> = {}

describe.skipIf(!jointInfraAvailable())('video real · reproducción 1×1 (canal 1)', () => {
  let env: VideoEnv

  beforeAll(async () => {
    env = await startVideoEnv({ label: FILE })
    await env.createUser(USER, 'SUPERVISOR')
  })

  afterAll(async () => {
    const net = await env?.stop()
    // Aislamiento: Node (net-redirect y centinela) y navegador (netlog). Ver video-env.ts.
    if (net) assertIsolation(FILE, net)
  })

  it('S1 · continuidad entre bloques: contiguo A→B y hueco real de 6 s B→C (deep link 10:00:02)', async () => {
    const rep = reports.S1 = new ScenarioReport(FILE, 'S1-continuidad', inject('videoRun').reportDir, env.describe())
    const segs = env.segments(1)
    const p = await env.openPage(USER)
    const apiFrom = env.api.length
    try {
      await p.deepLink(env.cams[1], '2026-10-01T10:00:02.000Z')
      await p.waitForFrame(() => true, 40_000, 'primer cuadro')
      // Fidelidad del entorno: el CSS de producción (Tailwind) está aplicado.
      const display = await p.page.evaluate(() => {
        const w = globalThis as any
        const g = w.document.querySelector('div.grid')
        return g ? w.getComputedStyle(g).display as string : null
      })
      rep.invariant('I-ENV-1', 'la web servida es la de producción con su CSS (grilla con display:grid)', 'display = grid', display, display === 'grid')
      // Hasta el final del último bloque (o lo que muestre el reproductor).
      await p.waitFor(() => (p.lastFrame()?.recMs ?? 0) >= T('10:01:04') || p.badge(0).badge === 'Sin grabación', 150_000, 'fin del bloque C')
      await p.waitFor(() => p.badge(0).badge === 'Sin grabación' || p.badge(0).badge === 'Error', 30_000, 'fin del rango').catch(() => undefined)
      const rel = await env.waitAllReleased(15_000)

      const { sessions, borders } = sessionsOf(p, 0, segs)
      const frames = p.frames.filter((f) => f.slot === 0)
      const decoded = frames.filter((f) => f.recMs !== null)
      const wrongCh = decoded.filter((f) => f.ch !== 1).length
      const outside = decoded.filter((f) => !isRecorded(f.recMs as number, segs)).length
      const back = sessions.reduce((a, s) => a + s.backSteps, 0) + borders.filter((b) => b.recJumpMs < 0).length
      const blocksSeen = ['10:00:00', '10:00:20', '10:00:46'].map((s, i) => {
        const a = T(s); const b = [T('10:00:20'), T('10:00:40'), T('10:01:06')][i]
        return decoded.some((f) => (f.recMs as number) >= a && (f.recMs as number) < b)
      })
      const api = env.api.slice(apiFrom)
      const maxConsumers = Math.max(0, ...api.map((a) => a.consumers.length))
      const maxLeases = Math.max(0, ...api.map((a) => a.active))
      const previewsCam1 = p.previews.filter((r) => r.cameraId === env.cams[1])
      const perBlock = [T('10:00:00'), T('10:00:20'), T('10:00:46')].map((a, i) => {
        const b = [T('10:00:20'), T('10:00:40'), T('10:01:06')][i]
        return previewsCam1.filter((r) => Date.parse(r.startTime) >= a && Date.parse(r.startTime) < b).length
      })
      const clock = clockStats(clockErrors(decoded, DAY_YEAR))

      rep.metric('sesiones', sessions.map(compactSession))
      rep.metric('bordes', borders.map(compactBorder))
      rep.metric('reloj', clock)
      rep.metric('previewsPorBloque', perBlock)
      rep.metric('maxFfmpeg', maxConsumers)
      rep.metric('maxLeases', maxLeases)
      rep.metric('liberacionAlFinalMs', rel.ms)
      rep.metric('cuadrosMuestreados', frames.length)

      rep.invariant('I-S1-1', 'todos los cuadros son de la cámara de la celda (canal 1)', '0 cuadros de otro canal', { cuadros: decoded.length, otroCanal: wrongCh }, decoded.length > 0 && wrongCh === 0)
      rep.invariant('I-S1-2', 'ningún cuadro fuera de lo grabado (nada fabricado)', '0 cuadros fuera de los segmentos', { fuera: outside }, outside === 0)
      rep.invariant('I-S1-3', 'el instante mostrado nunca retrocede (sesiones y bordes)', '0 retrocesos', { retrocesos: back }, back === 0)
      rep.invariant('I-S1-4', 'continúa sola por los tres bloques (contiguo y con hueco), sin clic', 'se ven cuadros de A, B y C', { A: blocksSeen[0], B: blocksSeen[1], C: blocksSeen[2] }, blocksSeen.every(Boolean))
      rep.invariant('I-S1-5', 'decodificación de la franja en el navegador', '≤ 1 % de cuadros ilegibles', { muestras: frames.length, ilegibles: frames.length - decoded.length }, frames.length > 0 && (frames.length - decoded.length) / frames.length <= 0.01)
      rep.invariant('I-S1-6', 'una sola sesión de preview por bloque (sin arranques duplicados)', '1 por bloque', perBlock, perBlock.every((n) => n === 1))
      rep.invariant('I-S1-7', 'en el relevo nunca hay más de 2 FFmpeg ni más de 2 leases', '≤ 2', { maxFfmpeg: maxConsumers, maxLeases }, maxConsumers <= 2 && maxLeases <= 2)
      const leaseUnder = api.filter((a) => a.active < a.consumers.length).length
      rep.invariant('I-S1-9', 'ningún lease se libera antes de que su FFmpeg termine (S1.5)', 'leases ≥ FFmpeg vivos en cada muestra (cada 250 ms)', { muestras: api.length, violaciones: leaseUnder }, api.length > 0 && leaseUnder === 0)
      rep.invariant('I-S1-8', 'al terminar el rango se liberan FFmpeg y leases sin acción del usuario', '0 en ≤ 15 s', { ms: rel.ms, consumidores: rel.after.consumers.length, leases: rel.after.active }, rel.ms !== null)

      const heads = sessions.map((s) => s.headLossMs)
      const internalBorders = borders.filter((b) => b.realGapMs === 0)
      const tails = sessions.slice(0, -1).map((s) => s.tailLossMs)
      rep.defect('D-S1-a', 'cada sesión empieza en el instante pedido (no se pierde el primer GOP)', 'primer cuadro − inicio pedido ≤ 500 ms', heads, (maxOf(heads) ?? Infinity) <= 500)
      rep.defect('D-S1-b', 'pausa visible entre grabaciones consecutivas (borde contiguo)', 'imagen congelada ≤ 1000 ms', internalBorders.map((b) => b.frozenMs), internalBorders.length > 0 && internalBorders.every((b) => b.frozenMs <= 1_000))
      rep.defect('D-S1-c', 'no se saltea video grabado en los bordes (contiguo y con hueco)', 'video perdido ≤ 500 ms además del hueco real', borders.map((b) => ({ perdidoMs: b.lostMs, huecoRealMs: b.realGapMs })), borders.length > 0 && borders.every((b) => b.lostMs <= 500))
      rep.defect('D-S1-d', 'el relevo no corta el bloque antes de su final (timer de continuidad)', 'último cuadro ≥ fin del bloque − 500 ms', tails, tails.length > 0 && tails.every((t) => t !== null && t <= 500))
      rep.defect('D-S1-e', 'el reloj de la UI coincide con el cuadro mostrado', 'p95 |reloj − cuadro| ≤ 1500 ms (resolución 1 s)', clock, clock.p95Abs !== null && clock.p95Abs <= 1_500)
      // Trinquetes: el valor de HOY más un margen. Sin esto, cualquier empeoramiento
      // de un defecto conocido pasaba en verde (medido con mutaciones: timer de
      // continuidad 6 s antes, reloj +1 h, inicio +10 s).
      rep.ratchet('R-S1-a', 'D-S1-a', 'el inicio de cada sesión no se atrasa más', 'primer cuadro − inicio pedido ≤ 2500 ms (hoy +2000 ms)', heads,
        heads.length > 0 && heads.every((h) => h !== null && h <= 2_500))
      rep.ratchet('R-S1-b', 'D-S1-b', 'la pausa en el borde contiguo no crece', 'imagen congelada ≤ 8000 ms (hoy 5,0–5,1 s)', internalBorders.map((b) => b.frozenMs),
        internalBorders.length > 0 && internalBorders.every((b) => b.frozenMs <= 8_000))
      rep.ratchet('R-S1-c', 'D-S1-c', 'el video perdido por borde no crece', '≤ 5000 ms por borde además del hueco real (hoy 3,8–4,2 s)', borders.map((b) => b.lostMs),
        borders.length >= 2 && borders.every((b) => b.lostMs <= 5_000))
      rep.ratchet('R-S1-d', 'D-S1-d', 'el relevo no corta el bloque más temprano', 'último cuadro ≥ fin del bloque − 3000 ms (hoy 1,8–2,2 s antes)', tails,
        tails.length > 0 && tails.every((t) => t !== null && t <= 3_000))
      rep.ratchet('R-S1-e', 'D-S1-e', 'el reloj de la UI no se aleja más del cuadro (es la hora que el operador toma como evidencia)', 'p95 |reloj − cuadro| ≤ 5000 ms (hoy 3,5–3,7 s)', clock,
        clock.p95Abs !== null && clock.p95Abs <= 5_000)
      rep.note(`Bordes: ${borders.map((b) => `${iso(b.lastRecMs)}→${iso(b.firstRecMs)} (hueco real ${b.realGapMs} ms, congelado ${b.frozenMs} ms)`).join('; ')}`)
    } finally {
      await p.close()
      rep.write({ pagina: p.dump(), api: env.api.slice(apiFrom).filter((_, i) => i % 4 === 0), sim: env.simEvents() })
    }
  })

  it.runIf(RUN_KNOWN_DEFECTS).each(['D-S1-a', 'D-S1-b', 'D-S1-c', 'D-S1-d', 'D-S1-e'])('DEFECTO conocido %s (opt-in)', (id) => {
    const c = reports.S1?.get(id)
    expect(c?.ok, defectMessage(c, id)).toBe(true)
  })

  // ── S0 · Comando H.264 real (sin navegador) ──────────────────────────────
  // El Chromium de Playwright no decodifica H.264: el shim pasa la SALIDA a VP9 para
  // el navegador. Acá se re-ejecuta, sin ese desvío, el comando EXACTO que armó la
  // API en S1 (capturado por el shim) y se lee la franja de cada cuadro de su salida.
  it('S0 · el comando H.264 real de la API conserva cada cuadro y su instante (sin desvío VP9)', async () => {
    const run = inject('videoRun')
    const rep = reports.S0 = new ScenarioReport(FILE, 'S0-comando-h264', run.reportDir, env.describe())
    const ev = env.simEvents().find((e) => e.ev === 'api_args' && e.track === '101' && Array.isArray(e.args) && (e.args as string[]).includes('libx264'))
    expect(ev, 'S1 debe haber capturado un comando de preview').toBeDefined()
    const args = [...(ev!.args as string[])]
    const url = new URL(args[args.indexOf('-i') + 1])
    const reqStart = Date.parse(String(url.searchParams.get('starttime')).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))
    const reqEnd = Date.parse(String(url.searchParams.get('endtime')).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'))
    const prog = args.indexOf('-progress')
    if (prog >= 0) args.splice(prog, 2)
    const out = path.join(run.runDir, `h264-${Date.now()}.mp4`)
    args[args.lastIndexOf('pipe:1')] = out
    const manifest = env.manifestCopy()
    manifest.browserCodec = null
    manifest.behaviors = {}
    const mpath = path.join(run.runDir, 'manifest-h264.json')
    fs.writeFileSync(mpath, JSON.stringify(manifest))
    try {
      const t0 = Date.now()
      const code = await new Promise<number | null>((resolve) => {
        const ff = spawn(path.join(SIM_BIN, 'ffmpeg'), ['-y', ...args], {
          stdio: ['ignore', 'ignore', 'ignore'],
          env: { ...process.env, VC_SIM_MANIFEST: mpath, VC_SIM_LOG: path.join(run.runDir, 'sim-h264.jsonl') },
        })
        const timer = setTimeout(() => ff.kill('SIGKILL'), 90_000)
        ff.on('close', (c) => { clearTimeout(timer); resolve(c) })
      })
      const probe = await new Promise<string>((resolve) => {
        const pr = spawn(run.realFfprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,width,height', '-of', 'csv=p=0', out])
        let o = ''
        pr.stdout.on('data', (c: Buffer) => { o += c.toString() })
        pr.on('close', () => resolve(o.trim()))
      })
      const sum = summarizeDecoded(await decodeFile(out, { ffmpegPath: run.realFfmpeg, ffprobePath: run.realFfprobe }))
      const res = {
        salida: code, ms: Date.now() - t0, stream: probe, cuadros: sum.frames, decodificados: sum.decoded, canales: sum.channels,
        pedido: `${iso(reqStart)}→${iso(reqEnd)}`, primero: iso(sum.firstRecMs), ultimo: iso(sum.lastRecMs),
        perdidaInicioMs: sum.firstRecMs !== null ? sum.firstRecMs - reqStart : null, pasosNoUnitarios: sum.nonUnitSteps, retrocesos: sum.backSteps,
      }
      rep.metric('h264', res)
      rep.invariant('I-S0-1', 'la salida del comando real es H.264 baseline (lo que recibiría Chrome)', 'h264,Constrained Baseline', probe, /^h264,(Constrained )?Baseline/.test(probe))
      rep.invariant('I-S0-2', 'cada cuadro de la salida conserva su instante y su canal', '0 ilegibles, canal 1, pasos de 1 cuadro', res,
        code === 0 && sum.decoded > 0 && sum.failed === 0 && sum.channels.join() === '1' && sum.nonUnitSteps === 0 && sum.backSteps === 0)
      rep.invariant('I-S0-3', 'la salida termina en el fin pedido', 'último ≥ fin − 1 s', res.ultimo, sum.lastRecMs !== null && sum.lastRecMs >= reqEnd - 1_000)
      rep.defect('D-S0-a', 'el comando real empieza en el instante pedido (mismo defecto que D-S1-a, sin navegador)', 'primer cuadro − inicio ≤ 500 ms', res.perdidaInicioMs,
        res.perdidaInicioMs !== null && res.perdidaInicioMs <= 500)
      rep.ratchet('R-S0-a', 'D-S0-a', 'el comando real no pierde más del principio', 'primer cuadro − inicio ≤ 2500 ms (hoy +2000 ms)', res.perdidaInicioMs,
        res.perdidaInicioMs !== null && res.perdidaInicioMs <= 2_500)
    } finally {
      fs.rmSync(out, { force: true })
      rep.write()
    }
  })

  // ── S2 · Seek ────────────────────────────────────────────────────────────
  it('S2 · seek: botones ±10 s, clic en la línea de tiempo y 5 seeks encadenados', async () => {
    const rep = reports.S2 = new ScenarioReport(FILE, 'S2-seek', inject('videoRun').reportDir, env.describe())
    const segs = env.segments(1)
    const p = await env.openPage(USER)
    const apiFrom = env.api.length
    // Rango del deep link: t − 2 min → t + 10 min, truncado al minuto.
    const RANGE = { start: T('09:58:00'), end: T('10:10:00') }
    const ffmpegOpens = (from: number, to = Infinity) => env.simEvents().filter((e) => e.ev === 'rtsp_open' && !e.probe && e.t >= from && e.t <= to).length
    try {
      await p.deepLink(env.cams[1], '2026-10-01T10:00:00.000Z')
      await p.waitForFrame(() => true, 40_000, 'primer cuadro')
      await sleep(2_000)

      // (b) clic en la línea de tiempo (fuera de lo cargado) con el FFmpeg del
      // bloque A todavía entregando: sesión nueva en el punto pedido.
      await p.drain()
      const oldPids = env.procs().consumers
      const tClick = await p.clickTimeline(T('10:00:30'), RANGE.start, RANGE.end)
      await p.waitFor(() => p.previews.some((r) => r.wall >= tClick && r.sessionId), 15_000, 'preview del seek')
      const pv = p.previews.filter((r) => r.wall >= tClick).at(-1)!
      const rel = await env.waitReleased(oldPids, 10_000)
      const first = await p.waitForFrame((f) => f.sid === pv.sessionId, 25_000, 'primer cuadro tras el seek', tClick).catch(() => null)
      await sleep(2_000)
      const settled = env.apiNow()
      const req = Date.parse(pv.startTime)
      const err = first ? (first.recMs as number) - req : null
      const seekB = {
        pedido: iso(req), primerCuadro: iso(first?.recMs), errorMs: err, ttffMs: first ? first.wall - tClick : null,
        ffmpegAnteriores: oldPids.length, liberaAnteriorMs: rel.ms, ffmpegTrasAsentar: settled.consumers.length, leasesTrasAsentar: settled.active,
      }
      rep.metric('lineaDeTiempo', seekB)
      rep.invariant('I-S2-1', 'clic en la línea de tiempo: el primer cuadro es el punto pedido o el keyframe siguiente', '−100 ms ≤ error ≤ 1 GOP + 500 ms', seekB, err !== null && err >= -100 && err <= GOP_MS + 500)
      rep.invariant('I-S2-2', 'tiempo hasta el primer cuadro tras el seek', '≤ 15 s', seekB.ttffMs, seekB.ttffMs !== null && seekB.ttffMs <= 15_000)
      rep.invariant('I-S2-3', 'el FFmpeg de la sesión anterior (aún entregando) termina tras el seek', '≤ 5 s', { ms: rel.ms, pids: oldPids.length }, oldPids.length > 0 && rel.ms !== null && rel.ms <= 5_000)
      rep.invariant('I-S2-4', 'tras el seek queda una sola sesión contra el NVR', '1 FFmpeg y 1 lease', { ffmpeg: settled.consumers.length, leases: settled.active }, settled.consumers.length === 1 && settled.active === 1)

      // (c) 5 seeks encadenados en ~1 s: sólo el último publica video (invariante 4).
      await p.drain()
      const before = env.procs().consumers
      const targets = ['10:00:05', '10:00:12', '10:00:25', '10:00:33', '10:00:47'].map(T)
      const tChain = Date.now()
      for (const t of targets) { await p.clickTimeline(t, RANGE.start, RANGE.end); await sleep(200) }
      const tLast = Date.now()
      await p.waitFor(() => p.previews.filter((r) => r.wall >= tChain && r.sessionId).length >= targets.length, 15_000, 'arranques de los 5 seeks').catch(() => undefined)
      const chainPvs = p.previews.filter((r) => r.wall >= tChain)
      const lastPv = chainPvs.at(-1)
      const lastFirst = lastPv ? await p.waitForFrame((f) => f.sid === lastPv.sessionId, 25_000, 'primer cuadro del último seek', tChain).catch(() => null) : null
      await sleep(4_000)
      await p.drain()
      const staleSids = new Set(chainPvs.slice(0, -1).map((r) => r.sessionId).filter(Boolean))
      const staleFrames = p.frames.filter((f) => f.slot === 0 && f.wall > tLast + 300 && f.sid && f.sid !== lastPv?.sessionId)
      const staleRel = await env.waitReleased(before, 5_000)
      const end = env.apiNow()
      const errC = lastFirst && lastPv ? (lastFirst.recMs as number) - Date.parse(lastPv.startTime) : null
      const chain = {
        arranques: chainPvs.length, sesionesDescartadas: staleSids.size, ffmpegLanzados: ffmpegOpens(tChain, tLast + 15_000),
        deletes: p.net.filter((n) => n.kind === 'delete' && n.wall >= tChain).length,
        cuadrosDeSesionesViejas: staleFrames.length, ultimoPedido: iso(lastPv ? Date.parse(lastPv.startTime) : null),
        primerCuadro: iso(lastFirst?.recMs), errorMs: errC, ffmpegAlFinal: end.consumers.length, leasesAlFinal: end.active,
        anterioresLiberadosMs: staleRel.ms,
      }
      rep.metric('seeksEncadenados', chain)
      rep.invariant('I-S2-5', 'seeks encadenados: ninguna sesión vieja publica video después del último clic', '0 cuadros de sesiones viejas', chain.cuadrosDeSesionesViejas, staleFrames.length === 0)
      rep.invariant('I-S2-6', 'seeks encadenados: al final una sola sesión, en el último punto pedido', '1 FFmpeg, 1 lease, error en [−100, GOP+500] ms', chain,
        end.consumers.length === 1 && end.active === 1 && errC !== null && errC >= -100 && errC <= GOP_MS + 500 && lastPv !== undefined && Math.abs(Date.parse(lastPv.startTime) - targets.at(-1)!) <= 2_000)
      rep.invariant('I-S2-7', 'seeks encadenados: las sesiones reemplazadas no dejan FFmpeg', 'liberados ≤ 5 s', staleRel.ms, staleRel.ms !== null)
      rep.defect('D-S2-e', 'seeks encadenados: los puntos intermedios no abren sesiones contra el NVR', '≤ 2 FFmpeg lanzados para 5 seeks en ~1 s',
        { ffmpegLanzados: chain.ffmpegLanzados, arranques: chain.arranques }, chain.ffmpegLanzados <= 2)
      rep.ratchet('R-S2-e', 'D-S2-e', 'seeks encadenados: no más de una sesión NVR por clic', '≤ 5 FFmpeg lanzados para 5 seeks (hoy 4–5)',
        { ffmpegLanzados: chain.ffmpegLanzados, arranques: chain.arranques }, chain.ffmpegLanzados <= targets.length)

      // (a) botones ±10 s sobre el bloque C (sesión del último seek: ct = 0 ≈ 10:00:48,
      // termina en ct ≈ 18 s; el FFmpeg entrega a 1×). Primero −10 s y después +10 s:
      // si el −10 s funcionara, el destino del +10 s quedaría dentro de lo ya descargado
      // (S2.1: sólo currentTime, ninguna petición nueva).
      //  - El −10 s se hace con ct ≥ 13 s: el destino queda ≥ 3 s DESPUÉS del inicio de
      //    la sesión. Con ct ≈ 11 s (versión anterior) el destino quedaba a 1,2 s del
      //    inicio y "volver al inicio de la sesión" (lo que hace hoy el reproductor:
      //    ct → 0) pasaba como "retroceder 10 s" con la tolerancia de ±1,5 s. No se usa
      //    ct ≥ 15 s: si algún día el −10 s funciona, el +10 s siguiente (≈ 2,5 s
      //    después) caería pasado el fin del bloque y D-S2-a no se podría cumplir.
      //  - Criterio del −10 s: ±0,5 s del destino en ≤ 2,5 s, currentTime = antes − 10 s
      //    ± 0,5 s (misma sesión, S2.1) y nada mostrado por debajo del destino − 0,5 s.
      //  - Mecanismo medido (`medioAntes`): el stream fMP4 progresivo tiene `seekable`
      //    = [0, 0], así que todo cambio de currentTime cae en 0 (inicio de la sesión).
      //  - Las consecuencias de un clic pueden llegar DESPUÉS de su ventana (medido: con
      //    ct ≈ 13 s el navegador vuelve a pedir el stream desde el byte 0, la API corta
      //    el FFmpeg y responde 409, y la UI abre otra sesión contra el NVR ~3 s después).
      //    Por eso, tras cada clic se espera a que la reproducción se asiente (2 s de
      //    cuadros sin pedidos nuevos, máx. 20 s) y todo lo ocurrido hasta el clic
      //    siguiente (o hasta asentarse) se atribuye a ese clic.
      const mediaState = async () => p.page.evaluate(() => {
        const v = (globalThis as any).document.querySelector('video')
        if (!v) return null
        const r = (x: any) => Array.from({ length: x.length }, (_, i) => `${x.start(i).toFixed(2)}–${x.end(i).toFixed(2)}`)
        return { ct: Number(v.currentTime.toFixed(3)), duracion: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : String(v.duration), seekable: r(v.seekable), buffered: r(v.buffered) }
      }).catch(() => null)
      const lastActivity = () => Math.max(0, ...p.net.filter((n) => n.kind === 'stream_get' || n.kind === 'delete').map((n) => n.wall), ...p.previews.map((r) => r.wall))
      const settle = async (since: number) => {
        let ok = true
        await p.waitFor(() => {
          const now = Date.now()
          const lf = p.lastFrame(0)
          return now - since >= 1_000 && now - lastActivity() >= 2_000 && lf !== undefined && lf.wall > since && now - lf.wall <= 500 &&
            p.frames.some((f) => f.slot === 0 && f.sid === lf.sid && f.recMs !== null && f.wall > since && f.wall <= now - 2_000)
        }, 20_000, 'reproducción asentada tras el botón').catch(() => { ok = false })
        return { ok, at: Date.now() }
      }
      const press = async (title: 'Avanzar 10 s' | 'Retroceder 10 s', observeMs: number) => {
        await p.drain()
        const before = p.lastFrame(0)
        const media = await mediaState()
        const t = Date.now()
        await p.page.click(`button[title="${title}"]`)
        await sleep(observeMs)
        return { t, before, media }
      }
      const analyze = (c: Awaited<ReturnType<typeof press>>, delta: number, tolMs: number, reachMs: number, to: number, settled: boolean) => {
        const { t, before } = c
        const sessionStart = before ? p.frames.find((f) => f.slot === 0 && f.sid === before.sid && f.recMs !== null)?.recMs ?? null : null
        const after = p.frames.filter((f) => f.slot === 0 && f.wall > t && f.wall <= to && f.recMs !== null)
        const base = before?.recMs ?? NaN
        const target = base + delta
        const reached = after.find((f) => f.wall <= t + reachMs && Math.abs((f.recMs as number) - target) <= tolMs)
        const ctExpected = before ? before.ct + delta / 1000 : null
        const minRec = after.length ? Math.min(...after.map((f) => f.recMs as number)) : null
        const clock = clockStats(clockErrors(after.filter((f) => f.wall <= t + 6_000), DAY_YEAR))
        // Imagen congelada: del clic al primer cuadro, entre cuadros y del último al final.
        let frozen = after.length ? after[0].wall - t : to - t
        for (let i = 1; i < after.length; i++) frozen = Math.max(frozen, after[i].wall - after[i - 1].wall)
        if (after.length) frozen = Math.max(frozen, to - after[after.length - 1].wall)
        const away = after.find((f) => Math.abs((f.recMs as number) - base) > 1_000)
        return {
          antes: iso(base), ctAntes: before?.ct ?? null, medioAntes: c.media, inicioDeLaSesion: iso(sessionStart),
          objetivo: iso(target), objetivoDesdeElInicioMs: sessionStart !== null ? target - sessionStart : null, toleranciaMs: tolMs,
          alcanzaObjetivoEnMs: reached ? reached.wall - t : null, ctAlAlcanzar: reached?.ct ?? null, ctEsperado: ctExpected,
          ctOk: !!reached && ctExpected !== null && Math.abs(reached.ct - ctExpected) <= 0.5,
          primeroTrasClic: iso(after[0]?.recMs), ctTrasClic: after[0]?.ct ?? null,
          // Primer cuadro que se aleja del punto de partida (> 1 s): adónde fue de verdad.
          destinoReal: iso(away?.recMs), ctDestinoReal: away?.ct ?? null, mismaSesion: away ? away.sid === before?.sid : null,
          minimoMostrado: iso(minRec), bajoElObjetivoMs: minRec !== null ? Math.max(0, target - minRec) : null,
          retrocesoBajoElPuntoDePartidaMs: delta > 0 && minRec !== null ? Math.max(0, base - minRec) : null,
          observadoMs: to - t, asentada: settled, congeladoMaxMs: frozen,
          getsDelStream: p.net.filter((n) => n.kind === 'stream_get' && n.wall > t && n.wall <= to).map((n) => n.range ?? '-'),
          respuestasDelStream: p.net.filter((n) => n.kind === 'stream_resp' && n.wall > t && n.wall <= to).map((n) => n.status),
          previewsNuevos: p.previews.filter((r) => r.wall > t && r.wall <= to).length,
          ffmpegNuevos: ffmpegOpens(t, to), reloj: clock,
        }
      }
      const cSid = lastPv?.sessionId
      await p.waitForFrame((f) => f.sid === cSid && f.ct >= 13, 30_000, 'ct ≥ 13 s en la sesión del bloque C', tLast).catch(() => undefined)
      const cMinus = await press('Retroceder 10 s', 2_500)
      const sMinus = await settle(cMinus.t)
      const cPlus = await press('Avanzar 10 s', 6_000)
      const sPlus = await settle(cPlus.t)
      await p.drain()
      const minus = analyze(cMinus, -10_000, 500, 2_500, cPlus.t, sMinus.ok)
      const plus = analyze(cPlus, 10_000, 1_500, 3_000, sPlus.at, sPlus.ok)
      rep.metric('botonMenos10', minus)
      rep.metric('botonMas10', plus)
      rep.invariant('I-S2-11', 'la medición del −10 s distingue "retroceder 10 s" de "volver al inicio de la sesión"', 'ct antes ≥ 12,5 s (destino ≥ 2,5 s después del inicio)',
        { ctAntes: minus.ctAntes, objetivoDesdeElInicioMs: minus.objetivoDesdeElInicioMs }, minus.ctAntes !== null && minus.ctAntes >= 12.5)
      rep.invariant('I-S2-12', 'tras cada botón ±10 s la celda vuelve a reproducir sola (no queda congelada ni en error)', 'cuadros nuevos y sin pedidos durante 2 s en ≤ 20 s',
        { menos10: { asentada: minus.asentada, congeladoMaxMs: minus.congeladoMaxMs }, mas10: { asentada: plus.asentada, congeladoMaxMs: plus.congeladoMaxMs } }, minus.asentada && plus.asentada)
      rep.defect('D-S2-a', '"Avanzar 10 s" muestra el instante +10 s sin retroceder', '±1,5 s del objetivo en ≤ 3 s y sin retroceso', plus,
        plus.alcanzaObjetivoEnMs !== null && (plus.retrocesoBajoElPuntoDePartidaMs ?? 0) === 0)
      rep.defect('D-S2-b', '"Retroceder 10 s" (dentro de lo descargado) muestra el instante −10 s (S2.1: sólo currentTime)',
        '±0,5 s del objetivo en ≤ 2,5 s; currentTime = antes − 10 s ± 0,5 s; nada mostrado por debajo del objetivo − 0,5 s', minus,
        minus.alcanzaObjetivoEnMs !== null && minus.ctOk && minus.bajoElObjetivoMs !== null && minus.bajoElObjetivoMs <= 500)
      rep.defect('D-S2-c', 'el reloj de la UI acompaña los botones ±10 s', 'p95 |reloj − cuadro| ≤ 1500 ms en los 6 s siguientes',
        { menos10: minus.reloj, mas10: plus.reloj }, [plus.reloj, minus.reloj].every((c) => c.p95Abs !== null && c.p95Abs <= 1_500))
      // Antes era la invariante I-S2-10: se cumplía sólo con el −10 s a 1,2 s del inicio
      // de la sesión (el principio del stream seguía en la caché del navegador).
      const perClick = { menos10: { gets: minus.getsDelStream, respuestas: minus.respuestasDelStream, previews: minus.previewsNuevos, ffmpeg: minus.ffmpegNuevos },
        mas10: { gets: plus.getsDelStream, respuestas: plus.respuestasDelStream, previews: plus.previewsNuevos, ffmpeg: plus.ffmpegNuevos } }
      rep.defect('D-S2-d', 'los botones ±10 s no vuelven a pedir el stream ni abren otra sesión contra el NVR (S2.1)', '0 GET nuevos del stream y 0 FFmpeg nuevos por clic',
        perClick, [minus, plus].every((x) => x.getsDelStream.length === 0 && x.ffmpegNuevos === 0))
      rep.ratchet('R-S2-d', 'D-S2-d', 'los botones ±10 s abren como mucho una sesión NVR por clic y la imagen no queda congelada más que hoy',
        '≤ 1 FFmpeg nuevo y ≤ 2 GET del stream por clic; congelado ≤ 12 s (hoy −10 s: 1 FFmpeg, 2 GET —409 y 200—, 7,7–7,8 s)',
        { ...perClick, congeladoMaxMs: { menos10: minus.congeladoMaxMs, mas10: plus.congeladoMaxMs } },
        [minus, plus].every((x) => x.ffmpegNuevos <= 1 && x.getsDelStream.length <= 2 && x.congeladoMaxMs <= 12_000))

      const decoded = p.frames.filter((f) => f.slot === 0 && f.recMs !== null)
      const wrong = decoded.filter((f) => f.ch !== 1 || !isRecorded(f.recMs as number, segs)).length
      rep.invariant('I-S2-8', 'todos los cuadros son del canal 1 y de lo grabado', '0 cuadros ajenos', { cuadros: decoded.length, ajenos: wrong }, decoded.length > 0 && wrong === 0)
    } finally {
      await p.close()
      await env.waitAllReleased(10_000)
      rep.write({ pagina: p.dump(), api: env.api.slice(apiFrom).filter((_, i) => i % 4 === 0), sim: env.simEvents() })
    }
  })

  it.runIf(RUN_KNOWN_DEFECTS).each(['D-S0-a'])('DEFECTO conocido %s (opt-in)', (id) => {
    const c = reports.S0?.get(id)
    expect(c?.ok, defectMessage(c, id)).toBe(true)
  })

  it.runIf(RUN_KNOWN_DEFECTS).each(['D-S2-a', 'D-S2-b', 'D-S2-c', 'D-S2-d', 'D-S2-e'])('DEFECTO conocido %s (opt-in)', (id) => {
    const c = reports.S2?.get(id)
    expect(c?.ok, defectMessage(c, id)).toBe(true)
  })

  // ── S4 · Velocidades ─────────────────────────────────────────────────────
  it('S4 · velocidades 1× → 2× → 4× → 1/2× (la fuente entrega a 1×)', async () => {
    const rep = reports.S4 = new ScenarioReport(FILE, 'S4-velocidades', inject('videoRun').reportDir, env.describe())
    const segs = env.segments(1)
    const p = await env.openPage(USER)
    const apiFrom = env.api.length
    try {
      await p.deepLink(env.cams[1], '2026-10-01T10:00:00.000Z')
      const f0 = await p.waitForFrame(() => true, 40_000, 'primer cuadro')
      const windows: Array<{ label: string; rate: number; from: number; to: number }> = []
      const t1 = Date.now()
      await sleep(4_000)
      windows.push({ label: '1×', rate: 1, from: Math.max(f0.wall, t1), to: Date.now() })
      for (const [label, rate, ms] of [['2×', 2, 10_000], ['4×', 4, 12_000], ['1/2×', 0.5, 8_000]] as const) {
        const t = Date.now()
        await p.page.click(`button[title="Velocidad ${label}"]`)
        await sleep(ms)
        windows.push({ label, rate, from: t + 500, to: Date.now() })
      }
      await p.drain()
      const res = windows.map((w) => ({ ...w, ...rateWindow(p.frames, 0, w.from, w.to, w.rate, segs, DAY_YEAR) }))
      const rates = Object.fromEntries(res.map((r) => [r.label, {
        tasaEfectiva: r.effectiveRate, cuadros: r.frames, salteadoMs: r.skippedMs, retrocesos: r.backSteps,
        congeladoMaxMs: r.maxFreezeMs, reloj: r.clock,
        relojAlEntrarMs: clockStats(clockErrors(p.frames.filter((f) => f.slot === 0 && f.wall >= r.from && f.wall <= r.from + 1_000), DAY_YEAR)).p50,
        relojAlSalirMs: clockStats(clockErrors(p.frames.filter((f) => f.slot === 0 && f.wall >= r.to - 1_000 && f.wall <= r.to), DAY_YEAR)).p50,
        playbackRateDelVideo: [...new Set(p.frames.filter((f) => f.slot === 0 && f.wall >= r.from && f.wall <= r.to).map((f) => f.rate))],
      }]))
      rep.metric('velocidades', rates)
      const { sessions } = sessionsOf(p, 0, segs)
      rep.metric('sesiones', sessions.map(compactSession))
      const decoded = p.frames.filter((f) => f.slot === 0 && f.recMs !== null)
      const wrong = decoded.filter((f) => f.ch !== 1 || !isRecorded(f.recMs as number, segs)).length
      const back = sessions.reduce((a, s) => a + s.backSteps, 0)
      const [r1, r2, r4, rHalf] = res
      rep.invariant('I-S4-1', 'todos los cuadros son del canal 1 y de lo grabado', '0 cuadros ajenos', { cuadros: decoded.length, ajenos: wrong }, decoded.length > 0 && wrong === 0)
      rep.invariant('I-S4-2', 'a ninguna velocidad el instante mostrado retrocede dentro de una sesión', '0 retrocesos', back, back === 0)
      rep.invariant('I-S4-3', 'el <video> toma la velocidad elegida', 'playbackRate = nominal en cada ventana',
        res.map((r) => ({ v: r.label, rates: rates[r.label].playbackRateDelVideo })),
        res.every((r) => rates[r.label].playbackRateDelVideo.length > 0 && rates[r.label].playbackRateDelVideo.every((x) => Math.abs(x - r.rate) < 1e-6)))
      rep.invariant('I-S4-4', 'a 1× y 1/2× la tasa efectiva es la nominal (la fuente alcanza)', '1×: 0,9–1,1 · 1/2×: 0,4–0,6',
        { '1×': r1.effectiveRate, '1/2×': rHalf.effectiveRate },
        r1.effectiveRate !== null && r1.effectiveRate >= 0.9 && r1.effectiveRate <= 1.1 && rHalf.effectiveRate !== null && rHalf.effectiveRate >= 0.4 && rHalf.effectiveRate <= 0.6)
      rep.defect('D-S4-a', 'a 2× y 4× no se saltea video grabado (la fuente entrega a 1×)', 'salteado ≤ 1000 ms por ventana',
        { '2×': r2.skippedMs, '4×': r4.skippedMs }, r2.skippedMs <= 1_000 && r4.skippedMs <= 1_000)
      rep.defect('D-S4-b', 'el reloj de la UI coincide con el cuadro a toda velocidad', 'p95 |reloj − cuadro| ≤ 1500 ms en cada ventana',
        Object.fromEntries(res.map((r) => [r.label, r.clock.p95Abs])), res.every((r) => r.clock.p95Abs !== null && r.clock.p95Abs <= 1_500))
      rep.ratchet('R-S4-a', 'D-S4-a', 'el video salteado a 2× y 4× no crece', '2×: ≤ 1000 ms en 10 s (hoy 0) · 4×: ≤ 20000 ms en 12 s (hoy 16,7–17,5 s)',
        { '2×': r2.skippedMs, '4×': r4.skippedMs }, r2.skippedMs <= 1_000 && r4.skippedMs <= 20_000)
      rep.ratchet('R-S4-b', 'D-S4-b', 'a 1× el reloj de la UI no se aleja más del cuadro', 'p95 |reloj − cuadro| ≤ 5000 ms a 1× (hoy 3,4–3,7 s)',
        r1.clock, r1.clock.p95Abs !== null && r1.clock.p95Abs <= 5_000)
      rep.note(`Tasa efectiva (grabación mostrada / pared): ${res.map((r) => `${r.label}=${r.effectiveRate}`).join(', ')}`)

      // Salir de Grabaciones a mitad de reproducción → todo liberado.
      await p.drain()
      const tLeave = Date.now()
      await p.page.goto(`${env.baseUrl}/`)
      const rel = await env.waitAllReleased(10_000)
      rep.invariant('I-S4-5', 'al salir de Grabaciones se liberan FFmpeg y leases', '0 en ≤ 5 s', { ms: rel.ms, desde: tLeave }, rel.ms !== null && rel.ms <= 5_000)
    } finally {
      await p.close()
      await env.waitAllReleased(10_000)
      rep.write({ pagina: p.dump(), api: env.api.slice(apiFrom).filter((_, i) => i % 4 === 0), sim: env.simEvents() })
    }
  })

  it.runIf(RUN_KNOWN_DEFECTS).each(['D-S4-a', 'D-S4-b'])('DEFECTO conocido %s (opt-in)', (id) => {
    const c = reports.S4?.get(id)
    expect(c?.ok, defectMessage(c, id)).toBe(true)
  })
})
