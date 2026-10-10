// apps/api/src/playback-video/lib/browser-page.ts
//
// Una pestaña de la web REAL instrumentada:
//   - muestreador inyectado (addInitScript): por cada cuadro presentado en cada
//     <video> (requestVideoFrameCallback) lee la franja de tiempo con el MISMO
//     decodificador que Node (DECODER_JS) y anota celda, sesión, currentTime,
//     velocidad y el reloj de la UI; cada 200 ms anota los cambios del rótulo de
//     cada celda y del reloj;
//   - captura de red: arranques de preview (cuerpo y respuesta), GET del stream
//     (con Range), DELETE de sesiones, playback/descarga y errores HTTP;
//   - consola `[recordings-ui]` (saneada).
// Los tokens de las URL se guardan sólo en memoria (para las pruebas de
// revocación) y se sanean en todo lo que se escribe al reporte.
//
// Selectores (no hay data-testid): ver README de la suite.

import { DECODER_JS } from '../media/timecode'
import type { FrameSample } from './metrics'
import { sanitize } from './report'

export interface StatusSample { wall: number; slot: number; text: string; detail?: string }

export interface PreviewStartRec {
  wall: number
  slotIndex: number | null
  cameraId: string
  startTime: string
  endTime: string
  continuityOf: string | null
  responseWall?: number
  status?: number
  sessionId?: string
  queued?: boolean
  error?: string
}

export interface NetEvent { wall: number; kind: 'stream_get' | 'stream_resp' | 'delete' | 'playback' | 'error'; sid?: string; range?: string | null; status?: number; detail?: string }

const BADGES = ['● Play', 'Pausado', 'Buffering…', 'Sin avance', 'Cargando…', 'Error', 'Sin grabación', 'Esperando…', 'Relevo…', 'En cola']
export function badgeOf(text: string | undefined): string | null {
  if (!text) return null
  return BADGES.find((b) => text.includes(b)) ?? null
}

/** Script del muestreador (se inyecta en cada documento de la pestaña). */
export function samplerScript(): string {
  return `${DECODER_JS}
;(() => {
  if (window.__vcVideo) return
  const st = window.__vcVideo = { frames: [], status: [], last: {}, seen: new WeakSet(), lastClock: undefined }
  const c = document.createElement('canvas'); c.width = 640; c.height = 24
  const g = c.getContext('2d', { willReadFrequently: true })
  const clockText = () => { for (const e of document.querySelectorAll('span.font-mono')) { const t = (e.textContent || '').trim(); if (/^\\d\\d\\/\\d\\d \\d\\d:\\d\\d:\\d\\d$/.test(t)) return t } return null }
  const sidOf = (v) => { const m = (v.currentSrc || v.getAttribute('src') || '').match(/\\/preview\\/([^/?#]+)\\/stream/); return m ? m[1] : '' }
  const slotOf = (v) => Array.prototype.indexOf.call(document.querySelectorAll('video'), v)
  const hook = (v) => {
    const f = () => {
      try {
        if (v.videoWidth > 0) {
          g.drawImage(v, 0, 0, v.videoWidth, Math.round(24 * v.videoWidth / 640), 0, 0, 640, 24)
          const d = g.getImageData(0, 0, 640, 24).data
          const r = decodeStrip((x, y) => { x = Math.max(0, Math.min(639, x)); y = Math.max(0, Math.min(23, y)); const i = (y * 640 + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3 }, 640)
          const du = v.duration
          st.frames.push({ wall: Date.now(), slot: slotOf(v), ct: v.currentTime, dur: Number.isNaN(du) ? null : (du === Infinity ? -1 : du), rate: v.playbackRate, sid: sidOf(v), recMs: r.ok ? r.recMs : null, ch: r.ok ? r.channel : null, clock: clockText() })
        }
      } catch (e) {}
      if (v.isConnected) v.requestVideoFrameCallback(f)
    }
    v.requestVideoFrameCallback(f)
  }
  setInterval(() => {
    document.querySelectorAll('video').forEach((v) => { if (!st.seen.has(v)) { st.seen.add(v); hook(v) } })
    document.querySelectorAll('div.grid > div.relative').forEach((cell, i) => {
      const bar = cell.querySelector('div.absolute.top-0')
      const text = bar ? (bar.textContent || '').trim() : ''
      const p = cell.querySelector('p')
      const detail = p ? (p.textContent || '').trim() : ''
      const key = text + '|' + detail
      if (st.last[i] !== key) { st.last[i] = key; st.status.push({ wall: Date.now(), slot: i, text, detail }) }
    })
    const ck = clockText()
    if (ck !== st.lastClock) { st.lastClock = ck; st.status.push({ wall: Date.now(), slot: -1, text: ck || '' }) }
  }, 200)
})()`
}

export class VideoPage {
  readonly frames: FrameSample[] = []
  readonly statuses: StatusSample[] = []
  readonly previews: PreviewStartRec[] = []
  readonly net: NetEvent[] = []
  readonly consoleLines: string[] = []
  /** sessionId → URL del stream CON token (sólo memoria; nunca al reporte). */
  readonly rawStreamUrl = new Map<string, string>()
  /** URLs de VOD CON token (sólo memoria). */
  readonly rawVod: { sessionId?: string; fileUrl?: string; downloadUrl?: string; startTime?: string; endTime?: string } = {}
  private drainTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(readonly context: any, readonly page: any, readonly baseUrl: string) {
    const pending = new Map<any, PreviewStartRec>()
    page.on('console', (m: any) => {
      const t = String(m.text())
      if (/^\[recordings-(ui|time)\]/.test(t) && this.consoleLines.length < 4000) this.consoleLines.push(`${Date.now()} ${sanitize(t)}`)
    })
    page.on('request', (r: any) => {
      const url: string = r.url()
      const method: string = r.method()
      if (method === 'POST' && /\/api\/recordings\/preview\/start$/.test(url)) {
        let body: any = {}
        try { body = JSON.parse(r.postData() ?? '{}') } catch { /* noop */ }
        const rec: PreviewStartRec = {
          wall: Date.now(), slotIndex: body.slotIndex ?? null, cameraId: body.cameraId, startTime: body.startTime,
          endTime: body.endTime, continuityOf: body.continuityOfSessionId ?? null,
        }
        this.previews.push(rec)
        pending.set(r, rec)
      } else if (method === 'POST' && /\/api\/recordings\/playback$/.test(url)) {
        try {
          const b = JSON.parse(r.postData() ?? '{}')
          this.rawVod.startTime = b.startTime
          this.rawVod.endTime = b.endTime
          this.rawVod.fileUrl = undefined
          this.rawVod.downloadUrl = undefined
        } catch { /* noop */ }
      } else if (/\/api\/recordings\/preview\/[^/]+\/stream/.test(url)) {
        this.net.push({ wall: Date.now(), kind: 'stream_get', sid: url.match(/preview\/([^/]+)\/stream/)?.[1], range: r.headers()['range'] ?? null })
      } else if (method === 'DELETE' && /\/api\/recordings\/preview\/[^/]+$/.test(url)) {
        this.net.push({ wall: Date.now(), kind: 'delete', sid: url.split('/').at(-1) })
      }
    })
    page.on('response', async (res: any) => {
      const url: string = res.url()
      const status: number = res.status()
      const req = res.request()
      const rec = pending.get(req)
      if (rec) {
        pending.delete(req)
        rec.responseWall = Date.now()
        rec.status = status
        try {
          const j = await res.json()
          rec.sessionId = j.sessionId
          rec.queued = j.status === 'queued'
          if (j.streamUrl && j.sessionId) this.rawStreamUrl.set(j.sessionId, new URL(j.streamUrl, this.baseUrl).toString())
          if (status >= 400) rec.error = String(j.message ?? '')
        } catch { /* sin cuerpo JSON */ }
        return
      }
      if (/\/api\/recordings\/preview\/[^/]+\/status$/.test(url) && status === 200) {
        try {
          const j = await res.json()
          if (j.streamUrl) this.rawStreamUrl.set(url.split('/').at(-2) as string, new URL(j.streamUrl, this.baseUrl).toString())
        } catch { /* noop */ }
      }
      if (/\/api\/recordings\/preview\/[^/]+\/stream/.test(url)) {
        this.net.push({ wall: Date.now(), kind: 'stream_resp', sid: url.match(/preview\/([^/]+)\/stream/)?.[1], status })
      }
      if (/\/api\/recordings\/playback(\/[^/]+\/status)?$/.test(url) && status < 400) {
        try {
          const j = await res.json()
          if (j.sessionId) this.rawVod.sessionId = j.sessionId
          if (j.url) this.rawVod.fileUrl = new URL(j.url, this.baseUrl).toString()
          if (j.downloadUrl) this.rawVod.downloadUrl = new URL(j.downloadUrl, this.baseUrl).toString()
          this.net.push({ wall: Date.now(), kind: 'playback', status, detail: String(j.status ?? '') })
        } catch { /* noop */ }
      }
      if (status >= 400 && !/\/api\/auth\/(me|refresh)$/.test(url)) {
        this.net.push({ wall: Date.now(), kind: 'error', status, detail: sanitize(`${req.method()} ${url.replace(/^https?:\/\/[^/]+/, '')}`) })
      }
    })
    this.drainTimer = setInterval(() => { void this.drain() }, 1000)
  }

  /** Trae las muestras acumuladas en la página. */
  async drain(): Promise<void> {
    if (this.closed) return
    try {
      const got = await this.page.evaluate(() => {
        const s = (globalThis as any).__vcVideo
        if (!s) return null
        return { frames: s.frames.splice(0), status: s.status.splice(0) }
      })
      if (got) { this.frames.push(...got.frames); this.statuses.push(...got.status) }
    } catch { /* navegación en curso o pestaña cerrada */ }
  }

  async login(username: string, password: string): Promise<void> {
    await this.page.goto(`${this.baseUrl}/login`)
    await this.page.fill('input[placeholder="tu_usuario"]', username)
    await this.page.fill('input[placeholder="••••••••"]', password)
    await this.page.click('button[type="submit"]')
    await this.page.waitForURL((u: URL) => !u.pathname.startsWith('/login'), { timeout: 20_000 })
  }

  /** Deep link de Grabaciones: busca ±(2, 10) min alrededor de `iso` y reproduce solo. */
  async deepLink(cameraId: string, iso: string): Promise<void> {
    await this.drain()
    await this.page.goto(`${this.baseUrl}/recordings?cameraId=${encodeURIComponent(cameraId)}&t=${encodeURIComponent(iso)}`)
  }

  async waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await this.drain()
      if (pred()) return
      if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms) esperando: ${what}`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /** Espera a que la celda muestre un cuadro que cumpla `pred` (con recMs). */
  async waitForFrame(pred: (f: FrameSample) => boolean, timeoutMs: number, what: string, since = 0): Promise<FrameSample> {
    let hit: FrameSample | undefined
    await this.waitFor(() => { hit = this.frames.find((f) => f.wall >= since && f.recMs !== null && pred(f)); return !!hit }, timeoutMs, what)
    return hit as FrameSample
  }

  lastFrame(slot = 0): FrameSample | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].slot === slot && this.frames[i].recMs !== null) return this.frames[i]
    return undefined
  }

  /** Último rótulo de la celda (badge) y su detalle. */
  badge(slot: number): { badge: string | null; text: string; detail: string } {
    for (let i = this.statuses.length - 1; i >= 0; i--) {
      const s = this.statuses[i]
      if (s.slot === slot) return { badge: badgeOf(s.text), text: s.text, detail: s.detail ?? '' }
    }
    return { badge: null, text: '', detail: '' }
  }

  /** Historia de rótulos de una celda (badge con su primer instante). */
  badgeHistory(slot: number): Array<{ wall: number; badge: string | null; detail: string }> {
    const out: Array<{ wall: number; badge: string | null; detail: string }> = []
    for (const s of this.statuses) {
      if (s.slot !== slot) continue
      const b = badgeOf(s.text)
      if (out.at(-1)?.badge !== b || out.at(-1)?.detail !== (s.detail ?? '')) out.push({ wall: s.wall, badge: b, detail: s.detail ?? '' })
    }
    return out
  }

  /** x en pantalla de un instante en la regla de la línea de tiempo. */
  async timelineX(targetMs: number, rangeStartMs: number, rangeEndMs: number): Promise<{ x: number; y: number }> {
    const box = await this.page.locator('div.flex.flex-shrink-0.border-b.h-6 > div').nth(1).boundingBox()
    if (!box) throw new Error('no se encontró la regla de la línea de tiempo')
    const frac = (targetMs - rangeStartMs) / (rangeEndMs - rangeStartMs)
    return { x: box.x + box.width * frac, y: box.y + box.height / 2 }
  }

  async clickTimeline(targetMs: number, rangeStartMs: number, rangeEndMs: number): Promise<number> {
    const { x, y } = await this.timelineX(targetMs, rangeStartMs, rangeEndMs)
    const t = Date.now()
    await this.page.mouse.click(x, y)
    return t
  }

  async close(): Promise<void> {
    await this.drain()
    this.closed = true
    if (this.drainTimer) clearInterval(this.drainTimer)
    await this.page.close().catch(() => undefined)
  }

  stopDraining(): void {
    this.closed = true
    if (this.drainTimer) clearInterval(this.drainTimer)
  }

  /** Datos saneados para el reporte. */
  dump(): Record<string, unknown> {
    return {
      previews: this.previews,
      net: this.net,
      statuses: this.statuses,
      consoleLines: this.consoleLines.slice(-1500),
      frames: this.frames.length,
    }
  }
}
