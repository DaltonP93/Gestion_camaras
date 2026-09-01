// A1 · la transición de viewport tiene que ser atómica.
//
// Hallazgo de la revisión de #159: `stopAllSessions()` invalidaba y DESPUÉS
// esperaba el cierre, con el intervalo todavía armado y `filteredCamerasRef`
// aún con las cámaras viejas. Un tick en esa ventana salía con los IDs del
// viewport anterior, y como la generación vivía en una ref mutable compartida
// —ya pisada con la nueva— el resultado se aceptaba.
//
// Acá se ejecuta la secuencia COMPLETA —programador → cierre pendiente →
// transición nueva → commit → heartbeat nuevo— con promesas y temporizadores
// reales. Nada de comprobar cadenas: el programador del banco es el de
// producción, y el "heartbeat" registra los IDs con los que sale.
import { describe, it, expect, beforeEach } from 'vitest'
import { createViewportTransition, type ViewportTransition } from './viewportTransition'
import {
  createHeartbeatScheduler,
  type HeartbeatTimers, type HeartbeatScheduler,
} from './heartbeatScheduler'

interface Viewport { nvr: string; ids: string[] }

/** Promesa que el test resuelve cuando quiere. */
function diferida<T = void>() {
  let resolver!: (v: T) => void
  const promise = new Promise<T>(r => { resolver = r })
  return { promise, resolver: (v?: any) => resolver(v) }
}

/**
 * Banco completo: programador real + coordinador real, con el viewport y la
 * publicación de IDs bajo control del test.
 */
function makeBench(opts: { intervalMs?: number; manual?: boolean } = {}) {
  const eventos: string[] = []
  /** Cada heartbeat que SALE, con los IDs del momento. */
  const latidos: string[][] = []
  /** Cada respuesta que llega a APLICARSE. Es lo que tocaría el estado. */
  const aplicados: string[][] = []
  const oculta = { valor: false }
  /** Solicitudes en vuelo cuando `manual`: el test decide cuándo responden. */
  const vuelos: Array<{ ids: string[]; responder: () => void }> = []

  // Viewport vigente: es lo que lee el `send` del programador, igual que
  // `filteredCamerasRef.current` en la página.
  let viewport: Viewport = { nvr: 'A', ids: ['a1', 'a2'] }

  // Temporizadores del intervalo, disparables a mano.
  let nextId = 1
  const intervalos = new Map<number, () => void>()
  const timers: HeartbeatTimers = {
    setInterval: (fn) => { const id = nextId++; intervalos.set(id, fn); return id },
    clearInterval: (id: any) => { intervalos.delete(id) },
  }

  const cierres: Array<{ reason: string; d: ReturnType<typeof diferida> }> = []
  const publicaciones: Array<ReturnType<typeof diferida>> = []

  const scheduler: HeartbeatScheduler<string[]> = createHeartbeatScheduler<string[]>({
    intervalMs: opts.intervalMs ?? 30_000,
    // La transición se comporta como "oculta" para el programador: es la misma
    // puerta que ya respetan el tick, el latido de regreso y `runNow`.
    isHidden: () => oculta.valor || transition.isTransitioning(),
    send: async () => {
      const ids = [...viewport.ids]
      latidos.push(ids)
      eventos.push(`heartbeat:${ids.join('|')}`)
      if (!opts.manual) return ids
      // Modo manual: la solicitud queda viajando hasta que el test la responda,
      // que es la ventana donde el viewport puede cambiar bajo sus pies.
      const d = diferida()
      vuelos.push({ ids, responder: d.resolver })
      await d.promise
      return ids
    },
    onResult: (ids) => {
      aplicados.push(ids)
      eventos.push(`apply:${ids.join('|')}`)
    },
    timers,
  })

  const transition: ViewportTransition<Viewport> = createViewportTransition<Viewport>({
    suspendScheduler: () => { eventos.push('suspend'); scheduler.suspend() },
    armScheduler: () => { eventos.push('arm'); scheduler.arm() },
    runHeartbeatNow: () => scheduler.runNow(),
    invalidateWork: (reason) => eventos.push(`invalidate:${reason}`),
    closeSessions: (reason) => {
      const d = diferida()
      cierres.push({ reason, d })
      eventos.push(`close_start:${reason}`)
      return d.promise.then(() => { eventos.push(`close_end:${reason}`) })
    },
    publishViewport: (next) => { viewport = next; eventos.push(`publish:${next.nvr}`) },
    awaitPublished: () => {
      const d = diferida()
      publicaciones.push(d)
      return d.promise
    },
    isHidden: () => oculta.valor,
    onEvent: (e) => eventos.push(e),
  })

  return {
    scheduler, transition, eventos, latidos, aplicados, oculta, cierres,
    publicaciones, vuelos,
    viewport: () => viewport,
    tick: () => Array.from(intervalos.values()).forEach(fn => fn()),
    intervalosVivos: () => intervalos.size,
  }
}

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

let b: ReturnType<typeof makeBench>
beforeEach(() => { b = makeBench() })

// ─── 1 · tick durante el cierre ──────────────────────────────────────────────

describe('un tick durante el cierre no puede latir por el viewport anterior', () => {
  it('cero heartbeats mientras stopSessions sigue pendiente', async () => {
    b.scheduler.start()
    await flush()
    expect(b.latidos).toEqual([['a1', 'a2']])       // el de arranque

    const corriendo = b.transition.run('nvr_change', { nvr: 'B', ids: ['b1'] })
    await flush()

    // El cierre está pendiente. Se fuerzan varios ticks.
    b.tick(); b.tick(); b.tick()
    await flush()

    expect(b.latidos).toHaveLength(1)               // ninguno nuevo
    expect(b.intervalosVivos()).toBe(0)             // el intervalo está desarmado

    b.cierres[0].d.resolver()
    await flush()
    b.publicaciones[0].resolver()
    await corriendo
  })

  it('runNow tampoco sale durante la transición', async () => {
    b.scheduler.start()
    await flush()
    const antes = b.latidos.length

    b.transition.begin('nvr_change')
    const r = await b.scheduler.runNow()

    expect(r).toEqual({ status: 'hidden' })
    expect(b.latidos).toHaveLength(antes)
  })
})

// ─── 2 · commit ──────────────────────────────────────────────────────────────

describe('el commit late exactamente una vez con los IDs nuevos', () => {
  it('un solo heartbeat, y con el viewport nuevo publicado', async () => {
    b.scheduler.start()
    await flush()
    b.latidos.length = 0

    const corriendo = b.transition.run('nvr_change', { nvr: 'B', ids: ['b1', 'b2'] })
    await flush()
    b.cierres[0].d.resolver()
    await flush()

    // Todavía no latió: falta que los IDs estén publicados.
    expect(b.latidos).toEqual([])

    b.publicaciones[0].resolver()
    expect(await corriendo).toBe('committed')

    expect(b.latidos).toEqual([['b1', 'b2']])       // exactamente uno, IDs nuevos
    expect(b.intervalosVivos()).toBe(1)             // cadencia rearmada, una sola
  })

  it('publica ANTES de latir, nunca al revés', async () => {
    b.scheduler.start(); await flush(); b.eventos.length = 0

    const corriendo = b.transition.run('page_change', { nvr: 'A', ids: ['a9'] })
    await flush(); b.cierres[0].d.resolver(); await flush()
    b.publicaciones[0].resolver()
    await corriendo

    const iPublish = b.eventos.findIndex(e => e.startsWith('publish:'))
    const iLatido = b.eventos.findIndex(e => e.startsWith('heartbeat:'))
    expect(iPublish).toBeGreaterThanOrEqual(0)
    expect(iLatido).toBeGreaterThan(iPublish)
  })

  it('la cadencia se suspende antes de invalidar', async () => {
    b.transition.begin('layout_change')

    expect(b.eventos.indexOf('suspend'))
      .toBeLessThan(b.eventos.findIndex(e => e.startsWith('invalidate:')))
  })
})

// ─── 3 · A→B→C fuera de orden ────────────────────────────────────────────────

describe('dos transiciones resueltas fuera de orden: gana la última', () => {
  it('B se descarta y el viewport termina en C', async () => {
    b.scheduler.start(); await flush(); b.latidos.length = 0

    const aB = b.transition.run('nvr_change', { nvr: 'B', ids: ['b1'] })
    await flush()
    const aC = b.transition.run('nvr_change', { nvr: 'C', ids: ['c1'] })
    await flush()

    // Los cierres se resuelven al REVÉS: primero el de C, después el de B.
    b.cierres[1].d.resolver()
    await flush()
    b.publicaciones[0].resolver()          // publicación de C
    await flush()
    b.cierres[0].d.resolver()              // B termina tarde
    await flush()

    expect(await aC).toBe('committed')
    expect(await aB).toBe('superseded')
    expect(b.viewport().nvr).toBe('C')
    expect(b.latidos).toEqual([['c1']])    // un solo latido, el de C
  })

  it('B abandona en el cierre, sin llegar a intentar el commit', async () => {
    b.scheduler.start(); await flush(); b.eventos.length = 0

    const aB = b.transition.run('nvr_change', { nvr: 'B', ids: ['b1'] })
    await flush()
    b.transition.begin('nvr_change')       // C invalida a B
    b.cierres[0].d.resolver()              // y ahora B termina de cerrar

    expect(await aB).toBe('superseded')
    // Se detiene EN el cierre: `commit` re-comprueba igual —la garantía está
    // sostenida dos veces— así que lo único que distingue "abandonar acá" de
    // "abandonar dentro del commit" es el diagnóstico.
    expect(b.eventos).toContain('superseded_after_close:1')
    expect(b.eventos.some(e => e.startsWith('publish:'))).toBe(false)
  })

  it('el commit tardío de B no publica su viewport', async () => {
    const tB = b.transition.begin('nvr_change')
    b.transition.begin('nvr_change')       // C invalida a B

    expect(await b.transition.commit(tB, { nvr: 'B', ids: ['b1'] })).toBe('superseded')
    expect(b.viewport().nvr).toBe('A')     // nada se publicó
  })

  it('tampoco publica si C aparece mientras B espera la publicación', async () => {
    b.scheduler.start(); await flush()
    const tB = b.transition.begin('nvr_change')
    const commitB = b.transition.commit(tB, { nvr: 'B', ids: ['b1'] })
    await flush()

    // B ya publicó su viewport, pero antes de que React confirme llega C.
    b.transition.begin('nvr_change')
    b.publicaciones[0].resolver()

    expect(await commitB).toBe('superseded')
    // Y no rearmó la cadencia ni latió por su cuenta.
    expect(b.latidos.some(ids => ids.join() === 'b1')).toBe(false)
  })
})

// ─── 4 · ocultarse durante la transición ─────────────────────────────────────

describe('ocultarse durante la transición', () => {
  it('no late ni arranca nada al confirmar', async () => {
    b.scheduler.start(); await flush(); b.latidos.length = 0

    const corriendo = b.transition.run('nvr_change', { nvr: 'B', ids: ['b1'] })
    await flush()
    b.oculta.valor = true                  // la pestaña se oculta durante el cierre
    b.cierres[0].d.resolver()
    await flush()
    b.publicaciones[0].resolver()

    expect(await corriendo).toBe('hidden_no_beat')
    expect(b.latidos).toEqual([])
  })

  it('tampoco deja el intervalo armado: sin espectador no hay cadencia', async () => {
    b.scheduler.start(); await flush(); b.latidos.length = 0

    const corriendo = b.transition.run('nvr_change', { nvr: 'B', ids: ['b1'] })
    await flush()
    b.oculta.valor = true
    b.cierres[0].d.resolver(); await flush(); b.publicaciones[0].resolver()
    await corriendo

    // Armar acá dejaría un tick vivo con la pestaña oculta hasta el próximo
    // `visibilitychange`: exactamente la sesión zombi que se persigue.
    expect(b.scheduler.isArmed()).toBe(false)
    expect(b.intervalosVivos()).toBe(0)
    expect(b.latidos).toEqual([])
    expect(b.transition.isTransitioning()).toBe(false)
  })

  it('al volver a visible: exactamente un heartbeat y un solo intervalo', async () => {
    b.scheduler.start(); await flush(); b.latidos.length = 0

    const corriendo = b.transition.run('nvr_change', { nvr: 'B', ids: ['b1'] })
    await flush()
    b.oculta.valor = true
    b.cierres[0].d.resolver(); await flush(); b.publicaciones[0].resolver()
    expect(await corriendo).toBe('hidden_no_beat')

    b.oculta.valor = false
    b.scheduler.handleVisibilityChange()
    await flush()

    expect(b.latidos).toEqual([['b1']])       // uno solo, y con los IDs nuevos
    expect(b.intervalosVivos()).toBe(1)       // un solo intervalo, no dos
    expect(b.scheduler.isArmed()).toBe(true)
  })

  it('el viewport igual queda publicado, para que el regreso reconcilie', async () => {
    const corriendo = b.transition.run('nvr_change', { nvr: 'B', ids: ['b1'] })
    await flush()
    b.oculta.valor = true
    b.cierres[0].d.resolver(); await flush(); b.publicaciones[0].resolver()
    await corriendo

    expect(b.viewport()).toEqual({ nvr: 'B', ids: ['b1'] })
  })
})

// ─── 4 bis · heartbeat viejo y nuevo superpuestos ────────────────────────────

describe('un heartbeat del viewport anterior sigue en vuelo al empezar el cambio', () => {
  it('su respuesta NO se aplica, aunque llegue después del commit', async () => {
    const m = makeBench({ manual: true })
    m.scheduler.start()
    await flush()
    expect(m.vuelos).toHaveLength(1)          // el de arranque, con ['a1','a2']

    // Cambio de viewport con la solicitud vieja todavía viajando.
    const corriendo = m.transition.run('nvr_change', { nvr: 'B', ids: ['b1'] })
    await flush()
    m.cierres[0].d.resolver()
    await flush()
    m.publicaciones[0].resolver()
    await flush()

    // El latido del commit sale y se responde.
    const nuevo = m.vuelos.find(v => v.ids.join() === 'b1')
    expect(nuevo).toBeDefined()
    nuevo!.responder()

    // Y AHORA responde el viejo, fuera de orden.
    m.vuelos[0].responder()
    await flush()
    await corriendo

    // Sólo se aplicó el del viewport nuevo. El viejo quedó abortado al
    // suspender la cadencia: ni aplica estado, ni reencola expiraciones.
    expect(m.aplicados).toEqual([['b1']])
    expect(m.eventos.filter(e => e.startsWith('apply:'))).toEqual(['apply:b1'])
  })

  it('la solicitud vieja se aborta al empezar la transición, no al terminarla', async () => {
    const m = makeBench({ manual: true })
    m.scheduler.start()
    await flush()
    expect(m.scheduler.isInFlight()).toBe(true)

    m.transition.begin('nvr_change')

    expect(m.scheduler.isInFlight()).toBe(false)
    expect(m.scheduler.isArmed()).toBe(false)
  })

  it('el commit late una sola vez aunque el viejo responda justo antes', async () => {
    const m = makeBench({ manual: true })
    m.scheduler.start()
    await flush()
    m.latidos.length = 0

    const corriendo = m.transition.run('page_change', { nvr: 'A', ids: ['a9'] })
    await flush()
    m.vuelos[0].responder()                   // el viejo contesta durante el cierre
    await flush()
    m.cierres[0].d.resolver()
    await flush()
    m.publicaciones[0].resolver()
    await flush()
    m.vuelos[m.vuelos.length - 1].responder()
    await corriendo

    expect(m.latidos).toEqual([['a9']])
    expect(m.aplicados).toEqual([['a9']])
  })
})

// ─── 5 · tokens, no una ref compartida ───────────────────────────────────────

describe('la identidad es un token por transición, no una ref mutable', () => {
  it('cada begin emite un token distinto e inmutable', () => {
    const t1 = b.transition.begin('a')
    const t2 = b.transition.begin('b')

    expect(t1).not.toBe(t2)
    expect(t1.id).not.toBe(t2.id)
    // El token viejo NO se ve alterado por la transición nueva: ése era el
    // defecto de usar una única ref como identidad de varias solicitudes.
    expect(b.transition.isCurrent(t1)).toBe(false)
    expect(b.transition.isCurrent(t2)).toBe(true)
  })

  it('un token capturado antes sigue sirviendo para descartar trabajo viejo', async () => {
    const viejo = b.transition.begin('nvr_change')
    b.transition.begin('nvr_change')

    // Así lo usa cada solicitud: captura al empezar, compara al terminar.
    const puedeAplicar = b.transition.isCurrent(viejo)

    expect(puedeAplicar).toBe(false)
  })
})

// ─── 6 · estado en transición ────────────────────────────────────────────────

describe('la bandera de transición', () => {
  it('se levanta en begin y baja en commit', async () => {
    expect(b.transition.isTransitioning()).toBe(false)

    const t = b.transition.begin('nvr_change')
    expect(b.transition.isTransitioning()).toBe(true)

    const commit = b.transition.commit(t, { nvr: 'B', ids: ['b1'] })
    await flush()
    b.publicaciones[0].resolver()
    await commit

    expect(b.transition.isTransitioning()).toBe(false)
  })

  it('una transición superada no baja la bandera de la vigente', async () => {
    const tB = b.transition.begin('nvr_change')
    b.transition.begin('nvr_change')       // C, la vigente

    await b.transition.commit(tB, { nvr: 'B', ids: ['b1'] })

    expect(b.transition.isTransitioning()).toBe(true)   // sigue la de C
  })
})
