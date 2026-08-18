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
import {
  reconcileHlsExpiry, decideExpiryRecovery, decideHiddenExpiryRemounts,
  type HlsExpiryDeps,
} from './hlsExpiryReconcile'
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

    expect(r).toEqual({ status: 'aborted', pending: ['c1', 'c2'] })
    expect(bench.hubo('bump')).toBe(false)
    expect(bench.hubo('scheduleReload')).toBe(false)
  })

  it('tampoco aplica nada si la respuesta llega bien pero la pestaña ya se ocultó', async () => {
    // Peor caso: la solicitud alcanzó a completarse. La última relectura de
    // visibilidad es la que impide tocar el estado.
    bench.setDuranteElEnvio(() => { bench.oculta.valor = true })
    bench.setOutcome({ status: 'ok', result: { startedIds: ['c1'] } })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'aborted', pending: ['c1'] })
    expect(bench.hubo('bump')).toBe(false)
  })

  it('si ya estaba oculta al entrar, ni siquiera consulta al backend', async () => {
    bench.oculta.valor = true

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'hidden', pending: ['c1'] })
    expect(bench.efectos).toEqual([])
  })
})

// ─── B · 401, renovación del JWT y ocultación ────────────────────────────────

describe('(B) 401 con renovación de token', () => {
  it('un 401 no toca el estado de las cámaras ni programa fallback', async () => {
    bench.setOutcome({ status: 'error', error: { response: { status: 401 } } })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'auth', pending: ['c1'] })
    expect(bench.hubo('scheduleReload')).toBe(false)
  })

  it('si la pestaña se oculta durante el refresh, el reintento queda abortado y no llega nada', async () => {
    // El reintento del interceptor reusa la config —y con ella la señal—, así
    // que el programador informa `aborted` en vez de un resultado.
    bench.setDuranteElEnvio(() => { bench.oculta.valor = true })
    bench.setOutcome({ status: 'aborted' })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'aborted', pending: ['c1'] })
    expect(bench.efectos).toEqual(['heartbeat'])   // sólo el intento; ningún efecto
  })
})

// ─── C · falla después de ocultarse ──────────────────────────────────────────

describe('(C) falla de red después de ocultarse', () => {
  it('no programa ningún fallback ni arranque de stream', async () => {
    bench.setDuranteElEnvio(() => { bench.oculta.valor = true })
    bench.setOutcome({ status: 'error', error: { response: { status: 500 } } })

    const r = await reconcileHlsExpiry(['c1', 'c2'], ['c1', 'c2'], bench.deps)

    expect(r).toEqual({ status: 'aborted', pending: ['c1', 'c2'] })
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
    // La respuesta la aplica el programador; acá sólo se decide el remonte.
    expect(bench.efectos).toEqual(['heartbeat', 'bump:c2'])
  })

  it('con todas readquiridas no hay remontes extra', async () => {
    bench.setOutcome({ status: 'ok', result: { startedIds: ['c1', 'c2'] } })

    const r = await reconcileHlsExpiry(['c1', 'c2'], ['c1', 'c2'], bench.deps)

    expect(r).toEqual({ status: 'reconciled', remounted: [] })
    expect(bench.efectos).toEqual(['heartbeat'])
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

    expect(r).toEqual({ status: 'aborted', pending: ['c1'] })
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

    expect(r).toEqual({ status: 'no_visible', pending: ['c1'] })
    expect(bench.hubo('heartbeat')).toBe(false)
  })

  it('marca el reinicio sólo tras una reconciliación real', async () => {
    await reconcileHlsExpiry(['c1', 'c2'], ['c1'], bench.deps)

    expect(bench.deps.lastRestartAt).toEqual({ c1: 1_000_000, c2: 1_000_000 })
  })
})

// ─── Revisión de #157 · el trabajo pendiente no se puede perder ──────────────
//
// hls.js considera FATAL el 401 y no vuelve a emitirlo: el player queda en
// "cargando" esperando que el padre lo rescate. Cualquier desenlace que no
// recupere la cámara tiene que devolverla para que alguien lo intente después.

describe('(1)(2) el heartbeat en vuelo se comparte, no se pierde el trabajo', () => {
  it('la reconciliación que se une a un heartbeat en curso recupera igual', async () => {
    // El programador ya no devuelve `busy` a `runNow`: se une al que viaja y
    // comparte su resultado. Un solo heartbeat, una sola recuperación.
    let llamadas = 0
    const b = makeDeps({
      runHeartbeat: async () => {
        llamadas++
        return { status: 'ok', result: { startedIds: [] } }
      },
    })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], b.deps)

    expect(r).toEqual({ status: 'reconciled', remounted: ['c1'] })
    expect(llamadas).toBe(1)
    expect(b.efectos.filter(e => e.startsWith('bump'))).toEqual(['bump:c1'])
  })

  it('un desenlace sin recuperación devuelve las cámaras para reintentarlas', async () => {
    bench.setOutcome({ status: 'busy' })

    const r = await reconcileHlsExpiry(['c1', 'c2'], ['c1', 'c2'], bench.deps)

    expect(r).toEqual({ status: 'aborted', pending: ['c1', 'c2'] })
  })

  it('reintentar con esas cámaras las recupera exactamente una vez', async () => {
    bench.setOutcome({ status: 'busy' })
    const primero = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)
    expect(primero.status).toBe('aborted')

    // Segundo intento con lo que quedó pendiente, ahora con un heartbeat bueno.
    bench.setOutcome({ status: 'ok', result: { startedIds: [] } })
    const segundo = await reconcileHlsExpiry(
      (primero as { pending: string[] }).pending, ['c1'], bench.deps,
    )

    expect(segundo).toEqual({ status: 'reconciled', remounted: ['c1'] })
    expect(bench.efectos.filter(e => e.startsWith('bump'))).toEqual(['bump:c1'])
  })
})

describe('(3) tras un desenlace sin recuperación, el fallback depende de la visibilidad', () => {
  it('visible: el error posterior sí programa el fallback', async () => {
    bench.setOutcome({ status: 'error', error: { response: { status: 500 } } })

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'failed', scheduled: ['c1'] })
  })

  it('oculta: ninguna operación, y la cámara vuelve como pendiente', async () => {
    bench.oculta.valor = true

    const r = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(r).toEqual({ status: 'hidden', pending: ['c1'] })
    expect(bench.efectos).toEqual([])
  })
})

describe('(4) lastRestartAt sólo registra intentos reales', () => {
  it.each([
    ['ocupado / abortado', { status: 'busy' } as const],
    ['abortado', { status: 'aborted' } as const],
  ])('no se toca con un desenlace %s', async (_n, outcome) => {
    bench.setOutcome(outcome)

    await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(bench.deps.lastRestartAt).toEqual({})
  })

  it('no se toca con la pestaña oculta', async () => {
    bench.oculta.valor = true

    await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(bench.deps.lastRestartAt).toEqual({})
  })

  it('no se toca cuando no hay cámaras visibles', async () => {
    await reconcileHlsExpiry(['c1'], [], bench.deps)

    expect(bench.deps.lastRestartAt).toEqual({})
  })

  it('sí se registra cuando hubo reconciliación', async () => {
    bench.setOutcome({ status: 'ok', result: { startedIds: [] } })

    await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(bench.deps.lastRestartAt).toEqual({ c1: 1_000_000 })
  })

  it('sí se registra cuando se programó un fallback real', async () => {
    bench.setOutcome({ status: 'error', error: { response: { status: 500 } } })

    await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(bench.deps.lastRestartAt).toEqual({ c1: 1_000_000 })
  })

  it('un desenlace perdido no consume la ventana de enfriamiento del reintento', async () => {
    // Éste es el daño concreto de marcarlo antes: el reintento quedaba
    // bloqueado 30 s sin que nadie hubiera recuperado nada.
    bench.setOutcome({ status: 'busy' })
    await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    bench.setOutcome({ status: 'ok', result: { startedIds: [] } })
    const segundo = await reconcileHlsExpiry(['c1'], ['c1'], bench.deps)

    expect(segundo.status).toBe('reconciled')   // no 'throttled'
  })
})

// ─── Expiraciones acumuladas con la pestaña oculta ───────────────────────────

describe('(5)(6)(7) consumo del conjunto pendiente al volver', () => {
  it('(5) regreso ANTES del TTL: startedIds vacío, el player se remonta igual', () => {
    // La sesión del backend seguía viva, así que no aparece en startedIds y
    // `applyHeartbeat` no la remontaría: sin este remonte el player se queda
    // cargando para siempre.
    const r = decideHiddenExpiryRemounts(['c1'], [], ['c1', 'c2'])

    expect(r).toEqual(['c1'])
  })

  it('(6) regreso DESPUÉS del TTL: la readquirida no se remonta dos veces', () => {
    // Ya la remonta `applyHeartbeat` al procesar startedIds.
    const r = decideHiddenExpiryRemounts(['c1'], ['c1'], ['c1'])

    expect(r).toEqual([])
  })

  it('(7) varias cámaras se deduplican por cameraId', () => {
    const r = decideHiddenExpiryRemounts(['c1', 'c2', 'c1', 'c2', 'c3'], ['c3'], ['c1', 'c2', 'c3'])

    expect(r).toEqual(['c1', 'c2'])
  })

  it('una cámara que ya no está en pantalla no se remonta', () => {
    const r = decideHiddenExpiryRemounts(['c1', 'fuera'], [], ['c1'])

    expect(r).toEqual(['c1'])
  })
})

describe('(8) la cámara en foco se recupera antes y después del TTL', () => {
  it('antes del TTL: sesión viva, se recupera el foco y se limpia su error', () => {
    const r = decideExpiryRecovery({
      pending: [], pendingFocus: 'cf', startedIds: [], visibleIds: ['cf'], currentFocus: 'cf',
    })

    expect(r).toEqual({ remount: [], focus: 'cf' })
  })

  it('después del TTL: readquirida por el backend, igual se recupera el foco', () => {
    const r = decideExpiryRecovery({
      pending: [], pendingFocus: 'cf', startedIds: ['cf'], visibleIds: ['cf'], currentFocus: 'cf',
    })

    // `focus` no nulo es lo que limpia el "Reconectando…": sin esto la tarjeta
    // quedaba trabada aunque el stream volviera.
    expect(r.focus).toBe('cf')
  })

  it('si el usuario ya salió del foco, no se recupera nada de él', () => {
    const r = decideExpiryRecovery({
      pending: [], pendingFocus: 'cf', startedIds: [], visibleIds: ['cf'], currentFocus: null,
    })

    expect(r.focus).toBeNull()
  })

  it('el foco no se remonta dos veces cuando también está en la cola de grilla', () => {
    const r = decideExpiryRecovery({
      pending: ['cf', 'c2'], pendingFocus: 'cf', startedIds: [],
      visibleIds: ['cf', 'c2'], currentFocus: 'cf',
    })

    expect(r).toEqual({ remount: ['c2'], focus: 'cf' })
  })
})

describe('(9) cambio de vista', () => {
  it('nada se recupera si las cámaras pendientes ya no están visibles', () => {
    // Al cambiar de NVR la vista muestra otras cámaras: recuperar las viejas
    // arrancaría streams sin espectador.
    const r = decideExpiryRecovery({
      pending: ['vieja1', 'vieja2'], pendingFocus: 'viejaF', startedIds: [],
      visibleIds: ['nueva1'], currentFocus: null,
    })

    expect(r).toEqual({ remount: [], focus: null })
  })
})
