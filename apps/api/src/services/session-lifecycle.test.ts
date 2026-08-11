import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveSessionTtl, getSessionTtl, resetSessionTtlCache, ttlForStreamType,
  decideSessionExpiry, decideProcessTermination, orphanViewKeys,
  DEFAULT_STREAM_IDLE_TIMEOUT_SEC, DEFAULT_STREAM_HD_IDLE_TIMEOUT_SEC,
  type SessionTruth, type SessionTtl,
} from './session-lifecycle'

const T0 = 1_700_000_000_000

function session(over: Partial<SessionTruth> = {}): SessionTruth {
  return {
    key: over.key ?? `u1:cam1:${over.streamType ?? 'sub'}`,
    userId: 'u1',
    viewId: 'v1',
    cameraId: 'cam1',
    streamType: 'sub',
    streamPath: 'nvr_x_ch01_sub',
    lastClientHeartbeatMs: T0,
    generation: 1,
    ...over,
  }
}

const ttl90: SessionTtl = {
  standardTtlMs: 90_000, hdTtlMs: 90_000,
  requestedStandardSec: null, requestedHdSec: null, wasClamped: false,
}

const beats = (entries: Array<[string, number]>) => new Map<string, number>(entries)
const freshView = beats([['u1:v1', T0]])

describe('resolveSessionTtl', () => {
  afterEach(() => resetSessionTtlCache())

  it('sin configuración usa los defaults de 90 s', () => {
    const r = resolveSessionTtl({})
    expect(r.standardTtlMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_SEC * 1000)
    expect(r.hdTtlMs).toBe(DEFAULT_STREAM_HD_IDLE_TIMEOUT_SEC * 1000)
    expect(r.wasClamped).toBe(false)
  })

  it('el HD hereda el estándar cuando sólo se configura STREAM_IDLE_TIMEOUT', () => {
    const r = resolveSessionTtl({ streamIdleTimeoutSec: '300' })
    expect(r.standardTtlMs).toBe(300_000)
    expect(r.hdTtlMs).toBe(300_000)
  })

  it('el HD configurado explícitamente gana sobre el estándar', () => {
    const r = resolveSessionTtl({ streamIdleTimeoutSec: '300', streamHdIdleTimeoutSec: '120' })
    expect(r.standardTtlMs).toBe(300_000)
    expect(r.hdTtlMs).toBe(120_000)
  })

  it('rechaza cadenas numéricas parciales y cae al default', () => {
    expect(resolveSessionTtl({ streamIdleTimeoutSec: '1e5' }).standardTtlMs).toBe(90_000)
    expect(resolveSessionTtl({ streamIdleTimeoutSec: '90s' }).standardTtlMs).toBe(90_000)
    expect(resolveSessionTtl({ streamIdleTimeoutSec: '-5' }).standardTtlMs).toBe(90_000)
    expect(resolveSessionTtl({ streamIdleTimeoutSec: '' }).standardTtlMs).toBe(90_000)
  })

  it('acota valores absurdos y lo reporta con wasClamped', () => {
    const low = resolveSessionTtl({ streamIdleTimeoutSec: '1' })
    expect(low.standardTtlMs).toBe(15_000)
    expect(low.wasClamped).toBe(true)
    const high = resolveSessionTtl({ streamHdIdleTimeoutSec: '999999' })
    expect(high.hdTtlMs).toBe(3_600_000)
    expect(high.wasClamped).toBe(true)
  })

  it('getSessionTtl memoiza y registra SIEMPRE los valores efectivos', () => {
    const lines: string[] = []
    const a = getSessionTtl(l => lines.push(l))
    const b = getSessionTtl(l => lines.push(l))
    expect(a).toBe(b)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('stream_session_ttl_resolved')
    expect(lines[0]).toContain('standardTtlMs=')
    expect(lines[0]).toContain('hdTtlMs=')
  })

  it('ttlForStreamType aplica el TTL HD sólo a main_h264', () => {
    const t = resolveSessionTtl({ streamIdleTimeoutSec: '300', streamHdIdleTimeoutSec: '120' })
    expect(ttlForStreamType('sub', t)).toBe(300_000)
    expect(ttlForStreamType('main', t)).toBe(300_000)
    expect(ttlForStreamType('main_h264', t)).toBe(120_000)
  })
})

describe('decideSessionExpiry — el proceso vivo NO renueva nada', () => {
  it('(1) sesión con heartbeat de cliente vencido expira, sin importar el medio', () => {
    // El caso de las 26 h: no existe ningún parámetro por el que "FFmpeg vivo"
    // pueda entrar en esta decisión. La firma no lo admite.
    const s = session({ streamType: 'main_h264', lastClientHeartbeatMs: T0 })
    const r = decideSessionExpiry({
      sessions: [s],
      viewHeartbeats: beats([['u1:v1', T0]]),
      nowMs: T0 + 91_000,
      ttl: ttl90,
    })
    expect(r.expired).toHaveLength(1)
    expect(r.expired[0].reason).toBe('client_heartbeat_expired')
    expect(r.surviving).toHaveLength(0)
  })

  it('(2) sesión visible con heartbeat fresco permanece activa', () => {
    const r = decideSessionExpiry({
      sessions: [session({ lastClientHeartbeatMs: T0 + 80_000 })],
      viewHeartbeats: beats([['u1:v1', T0 + 80_000]]),
      nowMs: T0 + 90_000,
      ttl: ttl90,
    })
    expect(r.expired).toHaveLength(0)
    expect(r.surviving).toHaveLength(1)
  })

  it('(3) pestaña oculta MENOS de 90 s todavía puede reanudar', () => {
    const hiddenAt = T0
    const r = decideSessionExpiry({
      sessions: [session({ streamType: 'main_h264', lastClientHeartbeatMs: hiddenAt })],
      viewHeartbeats: beats([['u1:v1', hiddenAt]]),
      nowMs: hiddenAt + 89_000,
      ttl: ttl90,
    })
    expect(r.surviving).toHaveLength(1)
    expect(r.expired).toHaveLength(0)
  })

  it('(4) pestaña oculta MÁS de 90 s expira', () => {
    const hiddenAt = T0
    const r = decideSessionExpiry({
      sessions: [session({ streamType: 'main_h264', lastClientHeartbeatMs: hiddenAt })],
      viewHeartbeats: beats([['u1:v1', hiddenAt]]),
      nowMs: hiddenAt + 90_001,
      ttl: ttl90,
    })
    expect(r.expired).toHaveLength(1)
    expect(r.surviving).toHaveLength(0)
  })

  it('el borde exacto (edad == TTL) NO expira: sólo lo estrictamente mayor', () => {
    const r = decideSessionExpiry({
      sessions: [session()],
      viewHeartbeats: beats([['u1:v1', T0]]),
      nowMs: T0 + 90_000,
      ttl: ttl90,
    })
    expect(r.surviving).toHaveLength(1)
  })

  it('un view sin heartbeat registrado expira la sesión (pestaña que nunca latió)', () => {
    const r = decideSessionExpiry({
      sessions: [session({ lastClientHeartbeatMs: T0 })],
      viewHeartbeats: beats([]),
      nowMs: T0 + 1_000,
      ttl: ttl90,
    })
    expect(r.expired[0].reason).toBe('view_heartbeat_missing')
  })

  it('view vencido expira aunque la sesión tenga su propio heartbeat fresco', () => {
    const r = decideSessionExpiry({
      sessions: [session({ lastClientHeartbeatMs: T0 + 100_000 })],
      viewHeartbeats: beats([['u1:v1', T0]]),
      nowMs: T0 + 100_000,
      ttl: ttl90,
    })
    expect(r.expired[0].reason).toBe('view_heartbeat_expired')
  })

  it('el TTL HD se aplica por tipo: sub sobrevive y main_h264 expira', () => {
    const ttlSplit: SessionTtl = {
      standardTtlMs: 300_000, hdTtlMs: 90_000,
      requestedStandardSec: 300, requestedHdSec: 90, wasClamped: false,
    }
    const r = decideSessionExpiry({
      sessions: [
        session({ key: 'k-sub', streamType: 'sub', lastClientHeartbeatMs: T0 }),
        session({ key: 'k-hd', streamType: 'main_h264', streamPath: 'p_hd', lastClientHeartbeatMs: T0 }),
      ],
      viewHeartbeats: beats([['u1:v1', T0 + 100_000]]),
      nowMs: T0 + 100_000,
      ttl: ttlSplit,
    })
    expect(r.expired.map(e => e.session.key)).toEqual(['k-hd'])
    expect(r.surviving.map(s => s.key)).toEqual(['k-sub'])
  })
})

describe('decideProcessTermination — procesos compartidos', () => {
  it('(7) dos viewers comparten proceso; vencer uno NO mata el proceso', () => {
    const a = session({ key: 'a', userId: 'u1', streamType: 'main_h264', streamPath: 'p1' })
    const b = session({ key: 'b', userId: 'u2', streamType: 'main_h264', streamPath: 'p1' })
    const d = decideProcessTermination([a], [b])
    expect(d.terminate).toEqual([])
    expect(d.keepAlive).toEqual([{ streamPath: 'p1', remainingViewers: 1 }])
  })

  it('(8) al vencer el ÚLTIMO viewer el proceso termina', () => {
    const b = session({ key: 'b', userId: 'u2', streamType: 'main_h264', streamPath: 'p1' })
    const d = decideProcessTermination([b], [])
    expect(d.terminate).toEqual(['p1'])
    expect(d.keepAlive).toEqual([])
  })

  it('no termina procesos por sesiones sub/main (no poseen FFmpeg propio)', () => {
    const s = session({ streamType: 'sub', streamPath: 'p_sub' })
    const m = session({ key: 'm', streamType: 'main', streamPath: 'p_main' })
    expect(decideProcessTermination([s, m], []).terminate).toEqual([])
  })

  it('un sub sobreviviente sobre el mismo path NO mantiene vivo el FFmpeg HD', () => {
    // Sólo cuentan como dueños las sesiones main_h264: un sub no sostiene la
    // transcodificación, y contarlo dejaría FFmpeg vivo sin espectador HD.
    const hd = session({ key: 'hd', streamType: 'main_h264', streamPath: 'p1' })
    const sub = session({ key: 'sub', streamType: 'sub', streamPath: 'p1' })
    expect(decideProcessTermination([hd], [sub]).terminate).toEqual(['p1'])
  })

  it('deduplica: dos sesiones vencidas del mismo path producen UNA terminación', () => {
    const a = session({ key: 'a', userId: 'u1', streamType: 'main_h264', streamPath: 'p1' })
    const b = session({ key: 'b', userId: 'u2', streamType: 'main_h264', streamPath: 'p1' })
    const d = decideProcessTermination([a, b], [])
    expect(d.terminate).toEqual(['p1'])
  })

  it('(9) es idempotente: repetir la decisión sobre lo ya cerrado no agrega nada', () => {
    const a = session({ key: 'a', streamType: 'main_h264', streamPath: 'p1' })
    const first = decideProcessTermination([a], [])
    const second = decideProcessTermination([], [])
    expect(first.terminate).toEqual(['p1'])
    expect(second.terminate).toEqual([])
  })

  it('paths distintos se deciden por separado', () => {
    const a = session({ key: 'a', streamType: 'main_h264', streamPath: 'p1' })
    const b = session({ key: 'b', streamType: 'main_h264', streamPath: 'p2' })
    const keep = session({ key: 'c', userId: 'u9', streamType: 'main_h264', streamPath: 'p2' })
    const d = decideProcessTermination([a, b], [keep])
    expect(d.terminate).toEqual(['p1'])
    expect(d.keepAlive).toEqual([{ streamPath: 'p2', remainingViewers: 1 }])
  })
})

describe('orphanViewKeys — índices auxiliares', () => {
  it('(10) un view sin sesiones y con heartbeat vencido es huérfano', () => {
    const keys = orphanViewKeys({
      knownViewKeys: ['u1:v1'],
      surviving: [],
      viewHeartbeats: beats([['u1:v1', T0]]),
      nowMs: T0 + 91_000,
      ttl: ttl90,
    })
    expect(keys).toEqual(['u1:v1'])
  })

  it('un view con sesiones vivas NO es huérfano', () => {
    const keys = orphanViewKeys({
      knownViewKeys: ['u1:v1'],
      surviving: [session()],
      viewHeartbeats: beats([['u1:v1', T0]]),
      nowMs: T0 + 91_000,
      ttl: ttl90,
    })
    expect(keys).toEqual([])
  })

  it('una grilla recién montada sin cámaras aún NO se poda', () => {
    const keys = orphanViewKeys({
      knownViewKeys: ['u1:v1'],
      surviving: [],
      viewHeartbeats: freshView,
      nowMs: T0 + 5_000,
      ttl: ttl90,
    })
    expect(keys).toEqual([])
  })

  it('un view sin heartbeat alguno es huérfano', () => {
    const keys = orphanViewKeys({
      knownViewKeys: ['u1:vghost'],
      surviving: [],
      viewHeartbeats: beats([]),
      nowMs: T0,
      ttl: ttl90,
    })
    expect(keys).toEqual(['u1:vghost'])
  })
})

describe('(12) el caso de 26 horas ya no puede reproducirse', () => {
  it('una sesión HD de 26 h sin heartbeat de cliente expira y su proceso termina', () => {
    // Datos del incidente real: iniciada 2026-08-10T12:38:14.898Z, "latiendo"
    // todavía 2026-08-11T14:22:00.832Z porque el limpiador la renovaba al ver
    // FFmpeg vivo. Acá el heartbeat de cliente es el del arranque y nada lo
    // renueva: la única entrada posible es actividad explícita de cliente.
    const startedAt = Date.parse('2026-08-10T12:38:14.898Z')
    const observedAt = Date.parse('2026-08-11T14:22:00.832Z')
    expect(observedAt - startedAt).toBeGreaterThan(25 * 3600 * 1000)

    const zombie = session({
      key: 'zombie', streamType: 'main_h264', streamPath: 'nvr_x_ch09_main_h264',
      lastClientHeartbeatMs: startedAt,
    })
    const decision = decideSessionExpiry({
      sessions: [zombie],
      viewHeartbeats: beats([['u1:v1', startedAt]]),
      nowMs: observedAt,
      ttl: ttl90,
    })
    expect(decision.expired).toHaveLength(1)
    expect(decision.expired[0].reason).toBe('client_heartbeat_expired')
    expect(decision.expired[0].clientHeartbeatAgeMs).toBeGreaterThan(25 * 3600 * 1000)

    const term = decideProcessTermination(decision.expired.map(e => e.session), decision.surviving)
    expect(term.terminate).toEqual(['nvr_x_ch09_main_h264'])
  })
})
