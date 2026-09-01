// A1 (posterior a #160) · operaciones que cruzan un await y sobreviven al
// cambio de viewport.
//
// Las cuatro carreras que quedaban después de la transacción tienen la misma
// forma: la operación empieza en el viewport A, espera algo, y al volver decide
// como si perteneciera al viewport B. Acá se ejecutan las funciones REALES de
// producción —`restartStreamFlow`, `exitFocusFlow`, `hdReacquireFlow`,
// `limitHitFlow`— contra el coordinador de transición REAL, con promesas y
// temporizadores reales. Lo que se observa son los efectos: qué se programó,
// qué se remontó, qué se arrancó, qué sesión quedó viva del otro lado.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  restartStreamFlow, exitFocusFlow, hdReacquireFlow, limitHitFlow,
  type EnterFocusOutcome,
} from './liveViewFlows'
import { beginOperation } from './guardedOperation'
import { createViewportTransition, type ViewportTransition } from './viewportTransition'

function diferida<T = void>() {
  let resolver!: (v: T) => void
  const promise = new Promise<T>(r => { resolver = r })
  return { promise, resolver: (v?: any) => resolver(v) }
}

/** Transición real, sin programador: acá lo que importa es la vigencia. */
function makeTransition() {
  const eventos: string[] = []
  const t: ViewportTransition<null> = createViewportTransition<null>({
    suspendScheduler: () => {},
    armScheduler: () => {},
    runHeartbeatNow: async () => null,
    invalidateWork: () => {},
    closeSessions: async () => {},
    publishViewport: () => {},
    awaitPublished: async () => {},
    isHidden: () => false,
    onEvent: (e) => eventos.push(e),
  })
  return { t, eventos }
}

const esperar = (ms: number) => new Promise<void>(r => { setTimeout(r, ms) })

// ─── 1 · reinicio manual ─────────────────────────────────────────────────────

describe('(1) reinicio pendiente y cambio de NVR', () => {
  let tr: ReturnType<typeof makeTransition>
  beforeEach(() => { tr = makeTransition() })

  it('no programa el arranque de la cámara anterior', async () => {
    const programados: string[] = []
    const post = diferida()
    const token = tr.t.current()

    const corriendo = restartStreamFlow({
      op: beginOperation(() => tr.t.isCurrent(token)),
      resetLocal: () => {},
      restart: () => post.promise,
      scheduleStart: () => { programados.push('a1') },
    })

    // El POST queda pendiente y el usuario cambia de NVR.
    await tr.t.run('nvr_change', null)
    // Recién ahora contesta el reinicio.
    post.resolver()

    expect(await corriendo).toBe('discarded')
    expect(programados).toEqual([])
  })

  it('sí lo programa si el viewport no cambió', async () => {
    const programados: string[] = []
    const post = diferida()
    const token = tr.t.current()

    const corriendo = restartStreamFlow({
      op: beginOperation(() => tr.t.isCurrent(token)),
      resetLocal: () => {},
      restart: () => post.promise,
      scheduleStart: () => { programados.push('a1') },
    })
    post.resolver()

    expect(await corriendo).toBe('scheduled')
    expect(programados).toEqual(['a1'])
  })

  it('la limpieza local ocurre igual: es la intención del usuario', async () => {
    const orden: string[] = []
    const post = diferida()
    const token = tr.t.current()

    const corriendo = restartStreamFlow({
      op: beginOperation(() => tr.t.isCurrent(token)),
      resetLocal: () => { orden.push('reset') },
      restart: () => { orden.push('post'); return post.promise },
      scheduleStart: () => { orden.push('schedule') },
    })
    await tr.t.run('nvr_change', null)
    post.resolver()
    await corriendo

    expect(orden).toEqual(['reset', 'post'])
  })
})

// ─── 2 · salida de foco ──────────────────────────────────────────────────────

describe('(2) cambio de viewport durante las esperas de la salida de foco', () => {
  let tr: ReturnType<typeof makeTransition>
  beforeEach(() => { tr = makeTransition() })

  function correrSalida(token: { id: number }) {
    const efectos: string[] = []
    const promesa = exitFocusFlow({
      op: beginOperation(() => tr.t.isCurrent(token)),
      settleMs: 20,
      remountMs: 20,
      clearFocus: () => { efectos.push('clear_focus') },
      closeFocusSessions: () => { efectos.push('close_focus') },
      bumpPlayerKeys: () => { efectos.push('bump') },
      startVisibleStreams: () => { efectos.push('start_visible') },
      onDiscard: (stage) => { efectos.push(`discard:${stage}`) },
    })
    return { efectos, promesa }
  }

  it('cambio durante la PRIMERA espera: ni remonte ni arranque', async () => {
    const token = tr.t.current()
    const { efectos, promesa } = correrSalida(token)

    await tr.t.run('nvr_change', null)          // durante los 20 ms de asentado
    expect(await promesa).toBe('discarded_settle')

    expect(efectos).toEqual(['clear_focus', 'close_focus', 'discard:settle'])
    // Y nada llega tarde después.
    await esperar(60)
    expect(efectos).not.toContain('bump')
    expect(efectos).not.toContain('start_visible')
  })

  it('cambio durante la SEGUNDA espera: se remontó, pero no se arranca nada', async () => {
    const token = tr.t.current()
    const { efectos, promesa } = correrSalida(token)

    await esperar(30)                            // pasó el asentado, hubo bump
    expect(efectos).toContain('bump')
    await tr.t.run('page_change', null)          // ahora cambia el viewport

    expect(await promesa).toBe('discarded_remount')
    expect(efectos).not.toContain('start_visible')
    await esperar(60)
    expect(efectos).not.toContain('start_visible')
  })

  it('sin cambio, la secuencia completa corre en orden', async () => {
    const token = tr.t.current()
    const { efectos, promesa } = correrSalida(token)

    expect(await promesa).toBe('restarted')
    expect(efectos).toEqual(['clear_focus', 'close_focus', 'bump', 'start_visible'])
  })

  it('el foco se baja siempre: es lo que el usuario pidió', async () => {
    const token = tr.t.current()
    tr.t.begin('layout_change')                  // ya superada antes de empezar
    const { efectos, promesa } = correrSalida(token)
    await promesa

    expect(efectos).toContain('clear_focus')
    expect(efectos).toContain('close_focus')
    expect(efectos).not.toContain('bump')
  })
})

// ─── 3 · readquisición de HD descartada ──────────────────────────────────────

describe('(3) readquisición de HD cuya entrada en foco fue descartada', () => {
  function bancoHd(resultado: EnterFocusOutcome<{ id: string }, { code: string }>) {
    const efectos: string[] = []
    const flujo = () => hdReacquireFlow<{ id: string }, { code: string }>({
      enterFocus: async () => resultado,
      planFallback: (code) => {
        efectos.push(`plan:${code}`)
        return { showErrorOverlay: false, clearStreamInfo: true, streamType: 'sub', remountPlayer: true }
      },
      errorCodeOf: (e) => e.code,
      clearFocusError: () => { efectos.push('clear_error') },
      clearFocusInfo: () => { efectos.push('clear_info') },
      setFocusType: (t) => { efectos.push(`set_type:${t}`) },
      remountPlayer: () => { efectos.push('remount') },
      onSuperseded: () => { efectos.push('superseded') },
    })
    return { efectos, flujo }
  }

  it('cero repliegue y cero efectos sobre el viewport nuevo', async () => {
    const { efectos, flujo } = bancoHd({ status: 'superseded' })

    expect(await flujo()).toBe('superseded')
    expect(efectos).toEqual(['superseded'])
    // Explícito, porque cada uno de éstos era un efecto real sobre otra vista:
    expect(efectos).not.toContain('clear_error')
    expect(efectos).not.toContain('clear_info')
    expect(efectos.some(e => e.startsWith('set_type:'))).toBe(false)
    expect(efectos).not.toContain('remount')
    expect(efectos.some(e => e.startsWith('plan:'))).toBe(false)
  })

  it('un fallo REAL sí repliega', async () => {
    const { efectos, flujo } = bancoHd({ status: 'error', error: { code: 'TRANSCODE_LIMIT_REACHED' } })

    expect(await flujo()).toBe('fell_back')
    expect(efectos).toEqual([
      'plan:TRANSCODE_LIMIT_REACHED', 'clear_error', 'clear_info', 'set_type:sub', 'remount',
    ])
  })

  it('un éxito no toca nada', async () => {
    const { efectos, flujo } = bancoHd({ status: 'ok', info: { id: 'x' }, actualType: 'main' })

    expect(await flujo()).toBe('ok')
    expect(efectos).toEqual([])
  })
})

// ─── 4 · límite de streams cruzando el cambio ────────────────────────────────

describe('(4) cambio de viewport durante el manejo del límite de streams', () => {
  let tr: ReturnType<typeof makeTransition>
  beforeEach(() => { tr = makeTransition() })

  function bancoLimite(token: { id: number }, cierre: Promise<void>) {
    const efectos: string[] = []
    const promesa = limitHitFlow({
      op: beginOperation(() => tr.t.isCurrent(token)),
      nonVisible: () => ['viejo1', 'viejo2'],
      stopSessions: async (ids) => { efectos.push(`stop:${ids.join(',')}`); await cierre },
      forgetStreams: (ids) => { efectos.push(`forget:${ids.join(',')}`) },
      clearBackoff: () => { efectos.push('clear_backoff') },
      clearPendingStart: () => { efectos.push('clear_pending') },
      retry: async () => { efectos.push('retry') },
      applyBackoff: () => { efectos.push('apply_backoff') },
      showLimitError: () => { efectos.push('show_error') },
      onDiscard: (stage) => { efectos.push(`discard:${stage}`) },
    })
    return { efectos, promesa }
  }

  it('no reintenta la cámara vieja ni toca el estado nuevo', async () => {
    const token = tr.t.current()
    const cierre = diferida()
    const { efectos, promesa } = bancoLimite(token, cierre.promise)

    await tr.t.run('nvr_change', null)     // el cambio ocurre durante el cierre
    cierre.resolver()

    expect(await promesa).toBe('discarded')
    expect(efectos).toEqual(['stop:viejo1,viejo2', 'discard:after_stop'])
    expect(efectos).not.toContain('retry')
    expect(efectos).not.toContain('clear_backoff')
    expect(efectos).not.toContain('forget:viejo1,viejo2')
  })

  it('sin cambio, libera y reintenta', async () => {
    const token = tr.t.current()
    const cierre = diferida()
    const { efectos, promesa } = bancoLimite(token, cierre.promise)
    cierre.resolver()

    expect(await promesa).toBe('retried')
    expect(efectos).toEqual([
      'stop:viejo1,viejo2', 'forget:viejo1,viejo2', 'clear_backoff', 'clear_pending', 'retry',
    ])
  })

  it('sin nada que liberar y con el viewport superado, no muestra el error', async () => {
    const token = tr.t.current()
    tr.t.begin('nvr_change')
    const efectos: string[] = []

    const r = await limitHitFlow({
      op: beginOperation(() => tr.t.isCurrent(token)),
      nonVisible: () => [],
      stopSessions: async () => {},
      forgetStreams: () => {},
      clearBackoff: () => {},
      clearPendingStart: () => {},
      retry: async () => { efectos.push('retry') },
      applyBackoff: () => { efectos.push('apply_backoff') },
      showLimitError: () => { efectos.push('show_error') },
    })

    expect(r).toBe('discarded')
    expect(efectos).toEqual([])
  })

  it('sin nada que liberar y con el viewport vigente, aplica backoff y avisa', async () => {
    const token = tr.t.current()
    const efectos: string[] = []

    const r = await limitHitFlow({
      op: beginOperation(() => tr.t.isCurrent(token)),
      nonVisible: () => [],
      stopSessions: async () => {},
      forgetStreams: () => {},
      clearBackoff: () => {},
      clearPendingStart: () => {},
      retry: async () => {},
      applyBackoff: () => { efectos.push('apply_backoff') },
      showLimitError: () => { efectos.push('show_error') },
    })

    expect(r).toBe('backoff')
    expect(efectos).toEqual(['apply_backoff', 'show_error'])
  })
})
