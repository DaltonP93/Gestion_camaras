// X1 exportación MP4 y Range · S8 revocación (logout y permiso) — web REAL + API REAL
// + FFmpeg real detrás del NVR simulado. Ver ../README.md.
//
// S8 tiene PRIORIDAD ALTA (pedido del dueño): hoy los medios se autentican sólo con
// tokens en la URL (stream 30 min, archivo 30 min, descarga 24 h) y ninguna de esas
// rutas vuelve a mirar la sesión ni los permisos. Acá se MIDE qué sobrevive a una
// revocación; el comportamiento correcto queda como defecto opt-in.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { decodeFile, summarizeDecoded } from '../media/decode'
import { httpProbe, type ProbeResult } from '../lib/http-probe'
import { defectMessage, RUN_KNOWN_DEFECTS, ScenarioReport } from '../lib/report'
import { iso, sleep } from '../lib/scenario-utils'
import { jointInfraAvailable } from '../../security-joint/harness'
import { assertIsolation, startVideoEnv, type VideoEnv } from '../lib/video-env'
import type { VideoPage } from '../lib/browser-page'

const FILE = 'exportacion-revocacion'
const SUP = 'sup_export'
const AUD = 'aud_revoca'
const reports: Record<string, ScenarioReport> = {}

/** Pedido JSON desde la página (cookies y Origin del navegador real). */
async function pageFetch(p: VideoPage, method: string, url: string, body?: unknown): Promise<number> {
  return p.page.evaluate(async (a: { method: string; url: string; body?: unknown }) => {
    const r = await (globalThis as any).fetch(a.url, {
      method: a.method, credentials: 'include',
      headers: a.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
    })
    return r.status as number
  }, { method, url, body })
}

/** Pedido JSON desde la página; devuelve estado y cuerpo. */
async function pageJson(p: VideoPage, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  return p.page.evaluate(async (a: { method: string; url: string; body?: unknown }) => {
    const r = await (globalThis as any).fetch(a.url, {
      method: a.method, credentials: 'include',
      headers: a.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
    })
    let json: unknown = null
    try { json = await r.json() } catch { /* sin JSON */ }
    return { status: r.status as number, json }
  }, { method, url, body })
}

/** Exportación por la API (mismo endpoint que "Generar MP4…") de una ventana corta; espera 'ready'. */
async function exportViaApi(p: VideoPage, cameraId: string, startTime: string, endTime: string): Promise<{ fileUrl?: string; downloadUrl?: string; status: number }> {
  const start = await pageJson(p, 'POST', '/api/recordings/playback', { cameraId, startTime, endTime, canPlayHevcMp4: false, forceTranscode: false })
  if (start.status >= 300) return { status: start.status }
  const sid = start.json.sessionId as string
  for (let i = 0; i < 90; i++) {
    const st = await pageJson(p, 'GET', `/api/recordings/playback/${sid}/status`)
    if (st.json?.status === 'ready') {
      return { status: 200, fileUrl: new URL(st.json.url, p.baseUrl).toString(), downloadUrl: new URL(st.json.downloadUrl, p.baseUrl).toString() }
    }
    if (st.json?.status === 'error') return { status: 500 }
    await sleep(1_000)
  }
  return { status: 504 }
}

/** Genera el MP4 del bloque activo por la UI ("Generar MP4…") y espera el enlace. */
async function exportActive(p: VideoPage): Promise<number> {
  const t = Date.now()
  await p.page.getByRole('button', { name: /Generar MP4/ }).click()
  await p.page.getByRole('link', { name: /Descargar MP4/ }).waitFor({ timeout: 90_000 })
  return Date.now() - t
}

const short = (r: ProbeResult) => ({ status: r.status, bytes: r.bytes, ...(r.error ? { error: r.error } : {}) })

describe.skipIf(!jointInfraAvailable())('video real · exportación y revocación', () => {
  let env: VideoEnv

  beforeAll(async () => {
    env = await startVideoEnv({ label: FILE, maxConcurrentPlaybackSessions: 4 })
    await env.createUser(SUP, 'SUPERVISOR')
  })

  afterAll(async () => {
    const net = await env?.stop()
    // Aislamiento: Node (net-redirect y centinela) y navegador (netlog). Ver video-env.ts.
    if (net) assertIsolation(FILE, net)
  })

  // ── X1 · Exportación MP4 y Range ─────────────────────────────────────────
  it('X1 · "Generar MP4…": relevo durante la exportación; contenido, tiempos y Range del archivo', async () => {
    const rep = reports.X1 = new ScenarioReport(FILE, 'X1-exportacion', inject('videoRun').reportDir, env.describe())
    const segs = env.segments(1)
    const p = await env.openPage(SUP)
    const apiFrom = env.api.length
    const tmp = path.join(inject('videoRun').runDir, `export-${Date.now()}.mp4`)
    try {
      await p.deepLink(env.cams[1], '2026-10-01T10:00:00.000Z')
      await p.waitForFrame(() => true, 40_000, 'primer cuadro')

      // (a) "Generar MP4…" mientras reproduce: el relevo al bloque siguiente ocurre
      // antes de que termine la exportación (que entrega a 1× como el NVR).
      const link = p.page.getByRole('link', { name: /Descargar MP4/ })
      const t0 = Date.now()
      const vodBefore = env.apiNow().vodSessions
      await p.page.getByRole('button', { name: /Generar MP4/ }).click()
      const outcome = await Promise.race([
        link.waitFor({ timeout: 60_000 }).then(() => 'listo' as const),
        p.waitFor(() => p.previews.some((r) => r.wall > t0 && !!r.continuityOf), 60_000, 'relevo de bloque').then(() => 'relevo' as const),
      ]).catch(() => 'timeout' as const)
      await sleep(3_000)
      const whilePlaying = {
        resultado: outcome, enlaceVisible: await link.isVisible(),
        indicadorGenerando: await p.page.getByText(/Generando MP4|MP4 \d+%/).first().isVisible().catch(() => false),
        sesionesVodServidor: env.apiNow().vodSessions - vodBefore,
      }
      rep.metric('exportarMientrasReproduce', whilePlaying)
      rep.defect('D-X1-0', '"Generar MP4…" sobrevive al relevo automático de bloque', 'el enlace "Descargar MP4" aparece aunque la reproducción pase al bloque siguiente',
        whilePlaying, whilePlaying.enlaceVisible)

      // (b) en pausa (el bloque activo no cambia) la exportación termina.
      await p.page.click('button[title="Pausar"]')
      await sleep(500)
      const genMs = await exportActive(p)
      const fileUrl = p.rawVod.fileUrl
      const downloadUrl = p.rawVod.downloadUrl
      const winStart = p.rawVod.startTime ? Date.parse(p.rawVod.startTime) : NaN
      const winEnd = p.rawVod.endTime ? Date.parse(p.rawVod.endTime) : NaN
      rep.invariant('I-X1-1', 'en pausa, "Generar MP4…" del bloque activo queda lista', '≤ 90 s, con URL de archivo y de descarga',
        { genMs, ventana: `${iso(winStart)}→${iso(winEnd)}`, archivo: !!fileUrl, descarga: !!downloadUrl }, !!fileUrl && !!downloadUrl)
      if (!fileUrl || !downloadUrl) return

      const full = await httpProbe(downloadUrl, { toFile: tmp })
      const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0
      const frames = await decodeFile(tmp, { ffmpegPath: inject('videoRun').realFfmpeg, ffprobePath: inject('videoRun').realFfprobe, withPts: true })
      const sum = summarizeDecoded(frames)
      const ok = frames.filter((f) => f.result.ok)
      const outside = ok.filter((f) => f.result.ok && !segs.some((s) => f.result.ok && f.result.recMs >= s.startMs && f.result.recMs < s.endMs)).length
      // Línea de tiempo del MP4 vs instante grabado: (pts − pts₀) debe seguir a
      // (grabación − grabación₀). Un corrimiento CONSTANTE no importa; se mide la
      // amplitud del desvío acumulado (máx − mín) a lo largo del archivo.
      let devMin = Infinity
      let devMax = -Infinity
      let firstDev: { cuadro: number; ptsMs: number; grabacionMs: number } | null = null
      let firstFramesWithin50ms = 0
      const o0 = ok[0]
      if (o0 && o0.result.ok && o0.ptsSec !== null) {
        for (const f of ok) {
          if (!f.result.ok || f.ptsSec === null) continue
          const ptsMs = (f.ptsSec - (o0.ptsSec as number)) * 1000
          const recMs = f.result.recMs - o0.result.recMs
          const dev = ptsMs - recMs
          devMin = Math.min(devMin, dev)
          devMax = Math.max(devMax, dev)
          if (!firstDev && Math.abs(dev) > 100) firstDev = { cuadro: f.index, ptsMs: Math.round(ptsMs), grabacionMs: recMs }
          if (ptsMs <= 50) firstFramesWithin50ms++
        }
      }
      const maxPtsDev = Number.isFinite(devMax) ? devMax - devMin : 0
      const vod = {
        bytes: size, estadoDescarga: full.status, cuadros: sum.frames, decodificados: sum.decoded, canales: sum.channels,
        primero: iso(sum.firstRecMs), ultimo: iso(sum.lastRecMs), pasosNoUnitarios: sum.nonUnitSteps, retrocesos: sum.backSteps,
        fueraDeLoGrabado: outside, amplitudDesvioPtsMs: Math.round(maxPtsDev), primerDesvio: firstDev, cuadrosEnLos50msIniciales: firstFramesWithin50ms,
      }
      rep.metric('mp4', vod)
      rep.invariant('I-X1-2', 'el MP4 contiene sólo cuadros del canal 1 y de lo grabado (nada fabricado)', 'canales = [1], 0 fuera de lo grabado, 0 ilegibles',
        vod, sum.decoded > 0 && sum.failed === 0 && sum.channels.length === 1 && sum.channels[0] === 1 && outside === 0)
      rep.invariant('I-X1-3', 'el MP4 cubre la ventana pedida sin saltos ni retrocesos', 'primero ≤ inicio + 1 GOP, último ≥ fin − 1 s, pasos de 1 cuadro',
        { ventana: `${iso(winStart)}→${iso(winEnd)}`, primero: vod.primero, ultimo: vod.ultimo, pasosNoUnitarios: sum.nonUnitSteps, retrocesos: sum.backSteps },
        sum.firstRecMs !== null && sum.firstRecMs <= winStart + 2_000 && sum.lastRecMs !== null && sum.lastRecMs >= winEnd - 1_000 && sum.nonUnitSteps === 0)
      rep.defect('D-X1-a', 'la línea de tiempo del MP4 exportado es la de grabación (no la de llegada)', 'amplitud de (pts − grabación) ≤ 100 ms en todo el archivo',
        { amplitudMs: vod.amplitudDesvioPtsMs, primerDesvio: firstDev, cuadrosEnLos50msIniciales: firstFramesWithin50ms }, maxPtsDev <= 100)

      // Range sobre /playback/:id/file.mp4 (token del archivo).
      const whole = fs.readFileSync(tmp)
      const r0 = await httpProbe(fileUrl, { range: 'bytes=0-' })
      const rMid = await httpProbe(fileUrl, { range: 'bytes=100-199', keepBody: true })
      const rSuffix = await httpProbe(fileUrl, { range: 'bytes=-1000', keepBody: true })
      const rBeyond = await httpProbe(fileUrl, { range: `bytes=0-${size + 1000}` })
      const range = {
        'bytes=0-': { status: r0.status, contentRange: r0.headers['content-range'], bytes: r0.bytes },
        'bytes=100-199': { status: rMid.status, contentRange: rMid.headers['content-range'], igualAlArchivo: !!rMid.body && rMid.body.equals(whole.subarray(100, 200)) },
        'bytes=-1000': { status: rSuffix.status, contentRange: rSuffix.headers['content-range'], ultimos1000: !!rSuffix.body && rSuffix.body.equals(whole.subarray(size - 1000)) },
        [`bytes=0-${size + 1000}`]: { status: rBeyond.status, contentRange: rBeyond.headers['content-range'] },
      }
      rep.metric('range', range)
      rep.invariant('I-X1-4', 'Range básico: bytes=0- y bytes=100-199', '206 con el contenido exacto', { r0: range['bytes=0-'], mid: range['bytes=100-199'] },
        r0.status === 206 && r0.bytes === size && rMid.status === 206 && range['bytes=100-199'].igualAlArchivo)
      rep.invariant('I-X1-5', 'descarga (token de 24 h) = archivo servido', 'mismos bytes', { descarga: size, archivo: r0.bytes }, full.status === 200 && size > 0 && r0.bytes === size)
      rep.defect('D-X1-b', 'Range de sufijo (bytes=-N) devuelve los últimos N bytes (RFC 9110 §14.1.2)', '206 con los últimos 1000 bytes', range['bytes=-1000'],
        rSuffix.status === 206 && range['bytes=-1000'].ultimos1000)
      rep.defect('D-X1-c', 'Range con fin más allá del tamaño se recorta (RFC 9110 §14.1.2)', '206 con Content-Range hasta size−1', range[`bytes=0-${size + 1000}`],
        rBeyond.status === 206 && rBeyond.headers['content-range'] === `bytes 0-${size - 1}/${size}`)
    } finally {
      fs.rmSync(tmp, { force: true })
      await p.close()
      await env.waitAllReleased(15_000)
      rep.write({ pagina: p.dump(), api: env.api.slice(apiFrom).filter((_, i) => i % 4 === 0), sim: env.simEvents() })
    }
  })

  it.runIf(RUN_KNOWN_DEFECTS).each(['D-X1-0', 'D-X1-a', 'D-X1-b', 'D-X1-c'])('DEFECTO conocido %s (opt-in)', (id) => {
    const c = reports.X1?.get(id)
    expect(c?.ok, defectMessage(c, id)).toBe(true)
  })

  // ── S8 · Revocación ──────────────────────────────────────────────────────
  it('S8 · revocación: quitar canPlayback y logout a mitad de la reproducción (prioridad alta)', async () => {
    const rep = reports.S8 = new ScenarioReport(FILE, 'S8-revocacion', inject('videoRun').reportDir, env.describe())
    const aud = await env.createUser(AUD, 'AUDITOR')
    // Cámara 4: un bloque de 60 s, así la revocación cae a mitad de bloque (sin relevo
    // que la confunda con el fin natural de la sesión).
    await env.joint.grant(aud.id, env.nvrId, env.cams[4], { canView: true, canPlayback: true })
    const p = await env.openPage(AUD)
    const apiFrom = env.api.length
    /** Lo que sigue funcionando N s después de un evento de revocación. */
    const survive = async (label: string, revoke: () => Promise<unknown>, vod: { fileUrl?: string; downloadUrl?: string }) => {
      await p.drain()
      const pv = [...p.previews].reverse().find((r) => r.sessionId && p.rawStreamUrl.has(r.sessionId))
      const streamUrl = pv?.sessionId ? p.rawStreamUrl.get(pv.sessionId) : undefined
      const before = env.procs().consumers
      const tRev = Date.now()
      const revokeResult = await revoke()
      await sleep(10_000)
      await p.drain()
      const framesAfter = p.frames.filter((f) => f.wall > tRev && f.recMs !== null)
      const stillAlive = env.procs().consumers.filter((pid) => before.includes(pid))
      const newStart = await pageFetch(p, 'POST', '/api/recordings/preview/start', {
        cameraId: env.cams[4], slotIndex: 0, startTime: '2026-10-01T10:00:30.000Z', endTime: '2026-10-01T10:00:40.000Z',
      }).catch(() => -1)
      const file = vod.fileUrl ? await httpProbe(vod.fileUrl, { range: 'bytes=0-99' }) : null
      const dl = vod.downloadUrl ? await httpProbe(vod.downloadUrl, { readMs: 500 }) : null
      // Último: el GET del stream con el token hace "takeover" (abre otra sesión RTSP).
      const stream = streamUrl ? await httpProbe(streamUrl, { readMs: 3_000 }) : null
      await sleep(500)
      const out = {
        evento: label, resultadoDelEvento: revokeResult,
        cuadrosEnElNavegadorTras10s: framesAfter.length, ultimoCuadroAlosMs: framesAfter.length ? framesAfter.at(-1)!.wall - tRev : null,
        ffmpegVivoTras10s: stillAlive.length, ffmpegAntes: before.length,
        nuevoPreviewStart: newStart,
        streamConToken: stream && short(stream), archivoConToken: file && short(file), descargaConToken: dl && short(dl),
      }
      rep.metric(label, out)
      return out
    }
    try {
      // RBAC: sin permiso sobre la cámara 2 no se abre preview (antes de reproducir nada).
      const denied = await pageFetch(p, 'POST', '/api/recordings/preview/start', {
        cameraId: env.cams[2], slotIndex: 0, startTime: '2026-10-01T10:00:00.000Z', endTime: '2026-10-01T10:00:20.000Z',
      })
      rep.invariant('I-S8-1', 'RBAC: un AUDITOR sin canPlayback sobre la cámara 2 no puede abrir preview', '403', denied, denied === 403)

      // Reproducción + exportación del bloque A con permiso.
      await p.deepLink(env.cams[4], '2026-10-01T10:00:00.000Z')
      await p.waitForFrame((f) => f.ch === 4, 40_000, 'cuadros del canal 4')
      const vod = await exportViaApi(p, env.cams[4], '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:05.000Z')
      rep.metric('exportacionPrevia', { status: vod.status, archivo: !!vod.fileUrl, descarga: !!vod.downloadUrl })
      await p.waitForFrame(() => true, 10_000, 'sigue reproduciendo', Date.now())

      // (a) quitar canPlayback a mitad de la reproducción.
      const perm = await survive('revocarPermiso', async () =>
        (await env.joint.prisma.userPermission.updateMany({ where: { userId: aud.id }, data: { canPlayback: false } })).count, vod)
      rep.invariant('I-S8-2', 'tras quitar canPlayback no se abren sesiones nuevas', 'POST /preview/start = 403', perm.nuevoPreviewStart, perm.nuevoPreviewStart === 403)
      rep.defect('D-S8-a', 'quitar canPlayback corta la reproducción en curso (FFmpeg termina)', 'FFmpeg de la sesión terminado a los 10 s',
        { ffmpegVivoTras10s: perm.ffmpegVivoTras10s, cuadrosTras10s: perm.cuadrosEnElNavegadorTras10s }, perm.ffmpegAntes > 0 && perm.ffmpegVivoTras10s === 0)
      rep.defect('D-S8-b', 'tras quitar canPlayback las URL de medios con token dejan de servir', 'stream, archivo y descarga ≠ 2xx',
        { stream: perm.streamConToken, archivo: perm.archivoConToken, descarga: perm.descargaConToken },
        [perm.streamConToken, perm.archivoConToken, perm.descargaConToken].every((r) => r !== null && (r.status === null || r.status >= 400)))
      await env.waitAllReleased(15_000)

      // (b) logout con el permiso restituido y una reproducción nueva.
      await env.joint.prisma.userPermission.updateMany({ where: { userId: aud.id }, data: { canPlayback: true } })
      await p.deepLink(env.cams[4], '2026-10-01T10:00:20.000Z')
      await p.waitForFrame((f) => f.ch === 4, 40_000, 'cuadros del canal 4 (antes del logout)', Date.now())
      await sleep(2_000)
      const out = await survive('logout', async () => pageFetch(p, 'POST', '/api/auth/logout', {}), vod)
      rep.invariant('I-S8-3', 'logout responde 2xx y no se abren sesiones nuevas', 'logout 2xx; POST /preview/start = 401', { logout: out.resultadoDelEvento, previewStart: out.nuevoPreviewStart },
        typeof out.resultadoDelEvento === 'number' && out.resultadoDelEvento < 300 && out.nuevoPreviewStart === 401)
      rep.defect('D-S8-c', 'logout corta la reproducción en curso (FFmpeg termina)', 'FFmpeg de la sesión terminado a los 10 s',
        { ffmpegVivoTras10s: out.ffmpegVivoTras10s, cuadrosTras10s: out.cuadrosEnElNavegadorTras10s }, out.ffmpegAntes > 0 && out.ffmpegVivoTras10s === 0)
      rep.defect('D-S8-d', 'tras logout las URL de medios con token dejan de servir', 'stream, archivo y descarga ≠ 2xx',
        { stream: out.streamConToken, archivo: out.archivoConToken, descarga: out.descargaConToken },
        [out.streamConToken, out.archivoConToken, out.descargaConToken].every((r) => r !== null && (r.status === null || r.status >= 400)))
      rep.note('Prioridad ALTA (pedido del dueño): los tokens de medios en la URL no se validan contra la sesión ni el permiso vigentes.')
    } finally {
      await p.close()
      await env.waitAllReleased(15_000)
      rep.write({ pagina: p.dump(), api: env.api.slice(apiFrom).filter((_, i) => i % 4 === 0), sim: env.simEvents() })
    }
  })

  it.runIf(RUN_KNOWN_DEFECTS).each(['D-S8-a', 'D-S8-b', 'D-S8-c', 'D-S8-d'])('DEFECTO conocido %s (opt-in, prioridad alta)', (id) => {
    const c = reports.S8?.get(id)
    expect(c?.ok, defectMessage(c, id)).toBe(true)
  })
})
