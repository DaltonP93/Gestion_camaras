// A1 · la ruta de sesiones HLS expiradas también tiene que ser cancelable.
//
// Hallazgo bloqueante de la revisión de #156: `flushHlsExpiry` seguía llamando
// al endpoint por su cuenta —sin `AbortSignal`, sin releer la visibilidad tras
// el `await`— y su `catch` programaba un `loadStream` con `setTimeout` aunque la
// pestaña ya estuviera oculta. La garantía documentada no era cierta.
//
// Los casos A, B, C, E y F del encargo se prueban acá, sobre la función pura,
// con todos los efectos inyectados: si alguno se ejecuta cuando no debe, la
// prueba lo ve.
import { describe, it, expect, beforeEach } from 'vitest'
import { reconcileHlsExpiry, type HlsExpiryDeps } from './hlsExpiryReconcile'
import type { HeartbeatOutcome } from './heartbeatScheduler'

interface Resp { startedIds: string[] }

/** Banco de pruebas: registra cada efecto y permite forzar cada desenlace. */
function makeDeps(over: Partial<HlsExpiryDeps<Resp>> = {}) {
  const efectos: string[] = []
  const oculta = { valor: false }
  let outcome: HeartbeatOutcome<Resp> = { status: 'ok', result: { startedIds: [] } }
  /** Se ejecuta DENTRO del heartbeat, para modelar lo que pasa mientras viaja. */
  let duranteElEnvio: (() => void) | null = null

  const deps: HlsExpiryDeps<Resp> = {
    isHidden: () => oculta.valor,
    now: () => 1_000_000,
    lastRestartAt: {},
    runHeartbeat: async () => {
      efectos.push('heartbeat')
      duranteElEnvio?.()
      return outcome
    },
    applyHeartbeat: (r) => { efectos.push(`applyHeartbeat:${r.startedIds.join('|')}`) },
    bumpPlayerKeys: (ids) => { efectos.push(`bump:${ids.join('|')}`) },
    clearLoading: (ids) => { efectos.push(`clearLoading:${ids.join('|')}`) },
    scheduleReload: (ids) => { efectos.push(`scheduleReload:${ids.join('|')}`) },
    startedIdsOf: (r) => r.startedIds,
    isAuthError: (e: any) => e?.response?.status === 401,
    ...over,
  }

  return {
    deps,
    efectos,
    oculta,
    setOutcome(o: HeartbeatOutcome<Resp>) { outcome = o },
    setDuranteElEnvio(fn: () => void) { duranteElEnvio = fn },
    hubo: (prefijo: string) => efectos.some(e => e.startsWith(prefijo)),
  }
}

let bench: ReturnType<typeof makeDeps>
beforeEach(() => { bench = makeDeps() })

// ─── A · se oculta mientras la solicitud viaja ───────────────────────────────

describe('(A) la pestaña se oculta antes de que responda', () => {
  it('no aplica el heartbeat, no remonta y no programa recargas', async () => {
    // El programador devuelve `aborted` porque su señal se abortó al ocultarse.
    bench.setDuranteElEnvio(() => { bench.oculta.valor = true })
    bench.setOutcome({ status: 'aborted' })

    const r = await reconcileHlsExpiry(['c1', 'c2'], ['c1', 'c2'], bench.deps)

    expect(r).toEqual({ status: 'aborted' })
    expect(bench.hubo('applyHeartbeat')).toBe(false)
    expect(bench.hubo('bump')).toBe(false)
    expect(bench.hubo('scheduleReload')).toBe(false)
  })

  it('tampoco aplica nada si la respuesta llega bien pero la pestaña ya se ocultó', async () => {
    // Peor caso: la solicitud alcanzó a completarse. La última relectura de
    // visibilidad es la que impide tocar el estado.
    bench.setDuranteElEnvio(() => { bench.oculta.valor = true })
    bench.setOutcome({ status: 'ok', result: { startedIds: ['c1'] } })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'aborted' })
    expect(bench.hubo('applyHeartbeat')).toBe(false)
    expect(bench.hubo('bump')).toBe(false)
  })

  it('si ya estaba oculta al entrar, ni siquiera consulta al backend', async () => {
    bench.oculta.valor = true

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'hidden' })
    expect(bench.efectos).toEqual([])
  })
})

// ─── B · 401, renovación del JWT y ocultación ────────────────────────────────

describe('(B) 401 con renovación de token', () => {
  it('un 401 no toca el estado de las cámaras ni programa fallback', async () => {
    bench.setOutcome({ status: 'error', error: { response: { status: 401 } } })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'auth' })
    expect(bench.hubo('applyHeartbeat')).toBe(false)
    expect(bench.hubo('scheduleReload')).toBe(false)
  })

  it('si la pestaña se oculta durante el refresh, el reintento queda abortado y no llega nada', async () => {
    // El reintento del interceptor reusa la config —y con ella la señal—, así
    // que el programador informa `aborted` en vez de un resultado.
    bench.setDuranteElEnvio(() => { bench.oculta.valor = true })
    bench.setOutcome({ status: 'aborted' })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'aborted' })
    expect(bench.efectos).toEqual(['heartbeat'])   // sólo el intento; ningún efecto
  })
})

// ─── C · falla después de ocultarse ──────────────────────────────────────────

describe('(C) falla de red después de ocultarse', () => {
  it('no programa ningún fallback ni arranque de stream', async () => {
    bench.setDuranteElEnvio(() => { bench.oculta.valor = true })
    bench.setOutcome({ status: 'error', error: { response: { status: 500 } } })

    const r = await reconcileHlsExpiry(['c1', 'c2'], ['c1', 'c2'], bench.deps)

    expect(r).toEqual({ status: 'aborted' })
    expect(bench.hubo('scheduleReload')).toBe(false)
  })

  it('estando visible, esa misma falla sí programa el fallback', async () => {
    // El contrapeso: sin él, la aserción de arriba podría pasar porque el
    // fallback no exista en ningún caso.
    bench.setOutcome({ status: 'error', error: { response: { status: 500 } } })

    const r = await reconcileHlsExpiry(['c1', 'c2'], ['c1', 'c2'], bench.deps)

    expect(r).toEqual({ status: 'failed', scheduled: ['c1', 'c2'] })
    expect(bench.efectos).toContain('scheduleReload:c1|c2')
  })
})

// ─── E · readquisición real ──────────────────────────────────────────────────

describe('(E) readquisición tras el TTL', () => {
  it('procesa startedIds y remonta sólo las que el backend NO reinició', async () => {
    bench.setOutcome({ status: 'ok', result: { startedIds: ['c1'] } })

    const r = await reconcileHlsExpiry(['c1', 'c2'], ['c1', 'c2'], bench.deps)

    expect(r).toEqual({ status: 'reconciled', remounted: ['c2'] })
    // `applyHeartbeat` ya remonta las readquiridas (c1); acá se remonta c2,
    // que seguía viva en el servidor con la cookie vencida.
    expect(bench.efectos).toEqual([
      'heartbeat',
      'applyHeartbeat:c1',
      'bump:c2',
    ])
  })

  it('con todas readquiridas no hay remontes extra', async () => {
    bench.setOutcome({ status: 'ok', result: { startedIds: ['c1', 'c2'] } })

    const r = await reconcileHlsExpiry(['c1', 'c2'], ['c1', 'c2'], bench.deps)

    expect(r).toEqual({ status: 'reconciled', remounted: [] })
    expect(bench.efectos).toEqual(['heartbeat', 'applyHeartbeat:c1|c2'])
  })

  it('un solo heartbeat por reconciliación, sin ráfagas', async () => {
    bench.setOutcome({ status: 'ok', result: { startedIds: [] } })

    await reconcileHlsExpiry(['c1', 'c2', 'c3'], ['c1', 'c2', 'c3'], bench.deps)

    expect(bench.efectos.filter(e => e === 'heartbeat')).toHaveLength(1)
  })
})

// ─── F · dos rutas intentando latir a la vez ─────────────────────────────────

describe('(F) solapamiento con otra ruta', () => {
  it('si ya hay un heartbeat en vuelo, no se solapa ni se aplica nada', async () => {
    bench.setOutcome({ status: 'busy' })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'busy' })
    expect(bench.hubo('applyHeartbeat')).toBe(false)
    expect(bench.hubo('scheduleReload')).toBe(false)
  })
})

// ─── Enfriamiento y bordes ───────────────────────────────────────────────────

describe('enfriamiento por cámara y bordes', () => {
  it('una cámara reiniciada hace poco sólo se remonta, sin tocar la red', async () => {
    bench.deps.lastRestartAt['c1'] = 1_000_000 - 5_000     // dentro de los 30 s

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'throttled', remounted: ['c1'] })
    expect(bench.hubo('heartbeat')).toBe(false)
    expect(bench.efectos).toEqual(['bump:c1', 'clearLoading:c1'])
  })

  it('la cola vacía no hace nada', async () => {
    const r = await reconcileHlsExpiry([], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'empty' })
    expect(bench.efectos).toEqual([])
  })

  it('sin cámaras visibles no se consulta al backend', async () => {
    const r = await reconcileHlsExpiry(['c1'], [], bench.deps)

    expect(r).toEqual({ status: 'no_visible' })
    expect(bench.hubo('heartbeat')).toBe(false)
  })

  it('marca el reinicio de las cámaras que sí van por heartbeat', async () => {
    await reconcileHlsExpiry(['c1', 'c2'], ['c1'], bench.deps)

    expect(bench.deps.lastRestartAt).toEqual({ c1: 1_000_000, c2: 1_000_000 })
  })
})
