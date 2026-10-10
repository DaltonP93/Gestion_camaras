// Pruebas unitarias del análisis puro de la suite de video (corren en `npm test`).
import { describe, it, expect } from 'vitest'
import {
  bordersBetween, clockErrors, clockStats, isRecorded, parseClock, percentile, rateWindow,
  runStats, runsForSlot, uncoveredMs, type FrameSample, type Segment,
} from './metrics'
import { DECODER_JS, decodeStrip, frameIndexFor, stripChecksum, EPOCH_BASE_S } from '../media/timecode'
import { analyzeNetlog } from './netlog'

const T0 = Date.UTC(2026, 9, 1, 10, 0, 0)
const segs: Segment[] = [
  { startMs: T0, endMs: T0 + 20_000 },
  { startMs: T0 + 20_000, endMs: T0 + 40_000 },
  { startMs: T0 + 46_000, endMs: T0 + 66_000 },
]

/** Corrida sintética: `n` cuadros desde recStart, presentados cada `dwall` ms desde wall0. */
function frames(sid: string, recStart: number, n: number, wall0: number, opts: { step?: number; dwall?: number; slot?: number; rate?: number; clockOffsetMs?: number } = {}): FrameSample[] {
  const step = opts.step ?? 40
  const dwall = opts.dwall ?? 40
  return Array.from({ length: n }, (_, i) => {
    const recMs = recStart + i * step
    const clockMs = recMs + (opts.clockOffsetMs ?? 0)
    const d = new Date(clockMs)
    const p = (x: number) => String(x).padStart(2, '0')
    return {
      wall: wall0 + i * dwall, slot: opts.slot ?? 0, ct: i * 0.04, rate: opts.rate ?? 1, sid, recMs, ch: 1,
      clock: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
    }
  })
}

describe('playback-video · métricas puras', () => {
  it('uncoveredMs / isRecorded respetan huecos y solapes', () => {
    expect(uncoveredMs(T0 + 39_000, T0 + 47_000, segs)).toBe(6_000)
    expect(uncoveredMs(T0 + 10_000, T0 + 30_000, segs)).toBe(0)
    expect(uncoveredMs(T0 + 30_000, T0 + 30_000, segs)).toBe(0)
    expect(isRecorded(T0 + 43_000, segs)).toBe(false)
    expect(isRecorded(T0 + 46_000, segs)).toBe(true)
  })

  it('percentile y parseClock', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3)
    expect(percentile([], 50)).toBeNull()
    expect(parseClock('01/10 10:00:07', 2026)).toBe(T0 + 7_000)
    expect(parseClock('--/-- --:--:--', 2026)).toBeNull()
  })

  it('runsForSlot agrupa por sesión y deduplica cuadros repetidos', () => {
    const a = frames('A', T0, 5, 1_000)
    const dup = { ...a[4], wall: a[4].wall + 40 }
    const b = frames('B', T0 + 22_000, 3, 10_000)
    const other = frames('X', T0, 3, 1_000, { slot: 1 })
    const runs = runsForSlot([...a, dup, ...b, ...other], 0)
    expect(runs.map((r) => [r.sid, r.frames.length, r.samples.length])).toEqual([['A', 5, 6], ['B', 3, 3]])
  })

  it('bordersBetween: salto de 4 s en un borde contiguo = 4 s perdidos; con hueco real se descuenta', () => {
    const a = frames('A', T0 + 2_000, 400, 0)                 // 10:00:02 → 10:00:17.96
    const b = frames('B', T0 + 22_000, 445, 16_000 + 5_170)    // empieza 10:00:22, 5,17 s después
    const c = frames('C', T0 + 48_000, 10, 40_000)             // tras hueco real 40→46
    const bs = bordersBetween([...runsForSlot([...a, ...b, ...c], 0)], segs)
    expect(bs[0]).toMatchObject({ realGapMs: 0, lostMs: 4_000 })
    expect(bs[0].frozenMs).toBe(5_170 + 40)
    expect(bs[1].realGapMs).toBe(6_000)
    expect(bs[1].lostMs).toBe(48_000 - 39_760 - 40 - 6_000)
  })

  it('runStats detecta retrocesos y saltos, y tolera el avance esperado a 4×', () => {
    const fwd = frames('A', T0, 50, 0, { step: 160, dwall: 40, rate: 4 }) // 4× sin saltos
    expect(runStats(runsForSlot(fwd, 0)[0], segs)).toMatchObject({ backSteps: 0, skippedMs: 0 })
    const back = [...frames('A', T0 + 10_000, 10, 0), ...frames('A', T0 + 6_960, 10, 400)]
    const st = runStats(runsForSlot(back, 0)[0], segs)
    expect(st.backSteps).toBe(1)
    expect(st.maxBackMs).toBe(10_360 - 6_960)
    const jump = [...frames('A', T0, 10, 0), ...frames('A', T0 + 10_000, 10, 400)]
    expect(runStats(runsForSlot(jump, 0)[0], segs).skippedMs).toBe(10_000 - 360 - 40)
  })

  it('reloj de la UI: error con cuantización de 1 s', () => {
    const ok = frames('A', T0, 100, 0)
    const st = clockStats(clockErrors(ok, 2026))
    expect(st.p95Abs).toBeLessThanOrEqual(500)
    const late = frames('A', T0, 100, 0, { clockOffsetMs: 3_000 })
    expect(clockStats(clockErrors(late, 2026)).p50).toBeGreaterThanOrEqual(2_500)
  })

  it('rateWindow: tasa efectiva, video salteado y congelamiento', () => {
    // 2× nominal pero la fuente entrega a 1×: avanza 1 s por segundo y congela.
    const s = [...frames('A', T0, 25, 0, { rate: 2 }), ...frames('A', T0 + 1_000, 25, 2_000, { rate: 2 })]
    const w = rateWindow(s, 0, 0, 3_000, 2, segs, 2026)
    expect(w.effectiveRate).toBeCloseTo(0.67, 1)
    expect(w.maxFreezeMs).toBeGreaterThanOrEqual(1_000)
    // salto de 10 s a 1×
    const j = [...frames('A', T0, 25, 0), ...frames('A', T0 + 11_000, 25, 1_000)]
    expect(rateWindow(j, 0, 0, 2_000, 1, segs, 2026).skippedMs).toBeGreaterThan(9_000)
    // A 4×: congelado de 5,8 s y después 23,5 s más adelante (con 6 s de hueco real):
    // el tiempo de pared NO justifica el salto; se perdieron ~17,4 s de grabación.
    const f4 = [...frames('B', T0 + 22_000, 10, 0, { rate: 4, step: 160 }), ...frames('C', T0 + 48_000, 10, 7_240, { rate: 4, step: 160 })]
    const w4 = rateWindow(f4, 0, 0, 9_000, 4, segs, 2026)
    expect(w4.skippedMs).toBe(48_000 - (22_000 + 9 * 160) - 6_000 - 40)
    expect(w4.maxFreezeMs).toBeGreaterThanOrEqual(5_800)
  })

  it('decodificador de la franja: mismo texto para Node y navegador, checksum y canal', () => {
    expect(DECODER_JS).toContain('function decodeStrip')
    const F = frameIndexFor(T0 + 7_320)
    expect(F).toBe((T0 / 1000 - EPOCH_BASE_S) * 25 + 183)
    const ch = 3
    const bits = (i: number): number => {
      if (i === 0 || i === 38) return 255
      if (i === 1 || i === 39) return 0
      if (i < 26) return ((F >> (i - 2)) & 1) * 255
      if (i < 30) return ((ch >> (i - 26)) & 1) * 255
      return ((stripChecksum(F, ch) >> (i - 30)) & 1) * 255
    }
    const r = decodeStrip((x) => bits(Math.floor(Math.max(0, Math.min(639, x)) / 16)), 640)
    expect(r).toEqual({ ok: true, frame: F, channel: 3, recMs: T0 + 7_320 })
    const bad = decodeStrip((x) => (Math.floor(x / 16) === 31 ? 255 - bits(31) : bits(Math.floor(Math.max(0, Math.min(639, x)) / 16))), 640)
    expect(bad).toEqual({ ok: false, reason: 'checksum' })
    expect(decodeStrip(() => 128, 640)).toEqual({ ok: false, reason: 'sin_referencias' })
  })

  it('checksum de la franja: todo error de lectura de 1 o 2 bloques (cuadro, canal o checksum) se detecta', () => {
    // Cuadros con bits altos en 1 (la fórmula anterior no veía los bits 8–23).
    for (const [F, ch] of [[frameIndexFor(T0 + 30_000), 1], [2 ** 24 - 1, 15], [0x5a5a5a, 10]] as const) {
      const block = (i: number): number => {
        if (i === 0 || i === 38) return 1
        if (i === 1 || i === 39) return 0
        if (i < 26) return Math.floor(F / 2 ** (i - 2)) % 2
        if (i < 30) return (ch >> (i - 26)) & 1
        return (stripChecksum(F, ch) >> (i - 30)) & 1
      }
      const read = (flip: Set<number>) => decodeStrip((x) => {
        const i = Math.floor(Math.max(0, Math.min(639, x)) / 16)
        return (flip.has(i) ? 1 - block(i) : block(i)) * 255
      }, 640)
      expect(read(new Set())).toMatchObject({ ok: true, frame: F, channel: ch })
      const undetected: string[] = []
      for (let a = 2; a <= 37; a++) {
        if (read(new Set([a])).ok) undetected.push(`${a}`)
        for (let b = a + 1; b <= 37; b++) if (read(new Set([a, b])).ok) undetected.push(`${a}+${b}`)
      }
      expect(undetected, `F=${F} canal=${ch}`).toEqual([])
    }
  })

  it('netlog del navegador: separa sockets loopback de los de afuera y lista los orígenes intentados', () => {
    const constants = { constants: {
      logEventTypes: { TCP_CONNECT: 48, TCP_CONNECT_ATTEMPT: 49, UDP_CONNECT: 90, UDP_BYTES_SENT: 91, SOCKET_CONNECT: 92, URL_REQUEST_START_JOB: 2 },
      logSourceType: { SOCKET: 1, UDP_SOCKET: 3, UDP_CLIENT_SOCKET: 4 },
    } }
    const ev = (type: number, params: Record<string, unknown>, source = { id: 1, type: 1 }) => `${JSON.stringify({ params, phase: 1, source, time: '1', type })},`
    const head = `${JSON.stringify(constants).slice(0, -1)},\n"events": [\n`
    const clean = head + [
      ev(2, { url: 'http://127.0.0.1:4173/recordings', method: 'GET' }),
      ev(48, { address_list: ['127.0.0.1:4173'] }),
      ev(2, { url: 'https://fonts.googleapis.com/css2?family=Inter', method: 'GET' }),
    ].join('\n') + '\n'
    expect(analyzeNetlog(clean)).toMatchObject({ ok: true, events: 3, loopbackSockets: 1, nonLoopback: [], attemptedOrigins: ['https://fonts.googleapis.com'] })
    // Archivo truncado (navegador que no cerró bien) con TCP a DoH y DNS por UDP que SÍ envió.
    const udp = { id: 5, type: 3 }
    const leak = head + [ev(49, { address: '8.8.4.4:443' }), ev(90, { address: '8.8.8.8:53' }, udp), ev(91, { byte_count: 40 }, udp), ev(48, { address_list: ['[::1]:9'] })].join('\n')
    expect(analyzeNetlog(leak)).toMatchObject({ ok: true, loopbackSockets: 1, nonLoopback: ['TCP_CONNECT_ATTEMPT 8.8.4.4:443', 'UDP_SEND 8.8.8.8:53'], udpConnectOnly: [] })
    // UDP connect() sin envío (sonda de IPv6 de Chromium, visto en el runner de CI): no
    // emite paquetes ⇒ no es tráfico, se informa aparte. Igual con SendTo sin connect sí cuenta.
    const probe = head + [
      ev(92, { address: '[2001:4860:4860::8888]:443' }, { id: 6, type: 4 }), ev(90, { address: '[2001:4860:4860::8888]:443' }, { id: 7, type: 3 }),
      ev(48, { address_list: ['127.0.0.1:4173'] }),
    ].join('\n') + '\n'
    expect(analyzeNetlog(probe)).toMatchObject({ ok: true, nonLoopback: [], udpConnectOnly: ['[2001:4860:4860::8888]:443'] })
    const sendto = head + [ev(91, { byte_count: 40, address: '198.51.100.7:53' }, { id: 8, type: 3 }), ev(48, { address_list: ['127.0.0.1:4173'] })].join('\n') + '\n'
    expect(analyzeNetlog(sendto)).toMatchObject({ ok: true, nonLoopback: ['UDP_BYTES_SENT 198.51.100.7:53'] })
    // SOCKET_CONNECT que NO es de un socket UDP cuenta como tráfico (estricto).
    const tcpSock = head + [ev(92, { address: '198.51.100.9:443' }, { id: 9, type: 1 })].join('\n') + '\n'
    expect(analyzeNetlog(tcpSock).nonLoopback).toEqual(['SOCKET_CONNECT 198.51.100.9:443'])
    expect(analyzeNetlog('')).toMatchObject({ ok: false })
    // DoH: se cuenta aunque el socket no llegue a abrirse (sin ruta a la IP del servidor).
    const doh = `${JSON.stringify({ constants: { logEventTypes: { ...constants.constants.logEventTypes, DOH_URL_REQUEST: 7 } } }).slice(0, -1)},\n"events": [\n` +
      [ev(7, { url: 'https://dns.google/dns-query?dns=AAAB' }), ev(48, { address_list: ['127.0.0.1:4173'] })].join('\n') + '\n'
    expect(analyzeNetlog(doh)).toMatchObject({ ok: true, dohRequests: 1, nonLoopback: [] })
    expect(analyzeNetlog(clean).dohRequests).toBe(0)
  })
})
