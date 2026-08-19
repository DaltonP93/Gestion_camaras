// A1 · el trabajo transitorio del viewport se invalida de verdad.
//
// Hallazgo de la revisión de #158: la limpieza vivía sólo en el cleanup del
// efecto del programador, y cambiar de NVR, página, layout o navegar por
// `camera_query` NO desmonta `LiveViewPage`. La prueba que lo "verificaba" era
// estructural —comprobaba que el archivo contuviera `pendingExpiry.current
// .clear()`— así que pasaba aunque esa línea no se ejecutara nunca.
//
// Acá se EJECUTA la operación de invalidación y se comprueban sus efectos, más
// la generación que impide que un trabajo del viewport anterior aplique algo
// después de la limpieza.
import { describe, it, expect, beforeEach } from 'vitest'
import { createViewportWork, type ViewportWork } from './viewportWork'

/** Temporizadores falsos con registro de cuáles se cancelaron. */
function makeTimers() {
  const cancelados: any[] = []
  return {
    timers: { clearTimeout: (id: any) => { cancelados.push(id) } },
    cancelados,
  }
}

function setup() {
  const t = makeTimers()
  const cancelacionesDeHeartbeat: number[] = []
  const invalidaciones: Array<{ epoch: number; reason: string }> = []
  const work = createViewportWork({
    timers: t.timers,
    cancelInFlightHeartbeat: () => cancelacionesDeHeartbeat.push(1),
    onInvalidate: (info) => invalidaciones.push(info),
  })
  return { work, t, cancelacionesDeHeartbeat, invalidaciones }
}

let ctx: ReturnType<typeof setup>
let work: ViewportWork
beforeEach(() => { ctx = setup(); work = ctx.work })

/** Deja el viewport con todo el trabajo transitorio que puede acumular. */
function conTrabajoPendiente() {
  work.enqueueExpiry('c1')
  work.enqueueExpiry('c2')
  work.addPending(['c3'])
  work.setPendingFocus('cf')
  work.lastRestartAt['c1'] = 1_000
  work.setExpiryTimer('timer-flush')
  work.trackTimer('timer-fallback')
  work.trackTimer('timer-stagger')
}

// ─── A · temporizador de vaciado pendiente + cambio de viewport ──────────────

describe('(A) temporizador HLS pendiente y cambio de NVR', () => {
  it('cancela el temporizador y vacía la cola', () => {
    work.enqueueExpiry('c1')
    work.setExpiryTimer('timer-flush')

    work.invalidate('nvr_change')

    expect(ctx.t.cancelados).toContain('timer-flush')
    expect(work.hasExpiryTimer()).toBe(false)
    expect(work.queueSize()).toBe(0)
  })

  it('cancela el heartbeat en vuelo del viewport anterior', () => {
    work.invalidate('nvr_change')

    expect(ctx.cancelacionesDeHeartbeat).toHaveLength(1)
  })
})

// ─── B · trabajo en vuelo durante el cambio ──────────────────────────────────

describe('(B) un flush en vuelo no puede reinsertar lo viejo', () => {
  it('la generación capturada deja de ser la vigente', () => {
    const epoch = work.epoch()
    expect(work.isCurrent(epoch)).toBe(true)

    work.invalidate('nvr_change')

    expect(work.isCurrent(epoch)).toBe(false)
  })

  it('lo que el trabajo viejo intente reinsertar se descarta al comprobar la generación', () => {
    // Así lo usa la página: captura al empezar, comprueba antes de aplicar.
    const epoch = work.epoch()
    work.invalidate('nvr_change')

    // El flush viejo termina y querría devolver sus cámaras al conjunto.
    if (work.isCurrent(epoch)) work.addPending(['vieja1', 'vieja2'])

    expect(work.pendingSize()).toBe(0)
  })

  it('cada invalidación avanza la generación, así que no se repite una vieja', () => {
    const e0 = work.epoch()
    work.invalidate('nvr_change')
    const e1 = work.epoch()
    work.invalidate('page_change')

    expect(new Set([e0, e1, work.epoch()]).size).toBe(3)
  })
})

// ─── D · pendientes y foco ───────────────────────────────────────────────────

describe('(D) pendientes y foco pendiente', () => {
  it('se limpian con el cambio', () => {
    conTrabajoPendiente()

    work.invalidate('layout_change')

    expect(work.pendingSize()).toBe(0)
    expect(work.pendingFocus()).toBeNull()
    expect(work.queueSize()).toBe(0)
  })

  it('tras invalidar no queda nada que consumir, así que no se remonta nada anterior', () => {
    conTrabajoPendiente()
    work.invalidate('page_change')

    expect(work.takePending()).toEqual([])
    expect(work.takePendingFocus()).toBeNull()
  })
})

// ─── E · temporizadores de fallback y stagger ────────────────────────────────

describe('(E) temporizadores de fallback ya programados', () => {
  it('se cancelan todos', () => {
    work.trackTimer('fallback-500ms')
    work.trackTimer('stagger-1')

    work.invalidate('nvr_change')

    expect(ctx.t.cancelados).toEqual(expect.arrayContaining(['fallback-500ms', 'stagger-1']))
    expect(work.trackedTimers()).toBe(0)
  })

  it('los ya cancelados no se vuelven a cancelar en la siguiente invalidación', () => {
    work.trackTimer('fallback-500ms')
    work.invalidate('nvr_change')
    ctx.t.cancelados.length = 0

    work.invalidate('page_change')

    expect(ctx.t.cancelados).toEqual([])
  })
})

// ─── F · enfriamiento ────────────────────────────────────────────────────────

describe('(F) regreso al NVR anterior', () => {
  it('no queda un cooldown falso: lastRestartAt se limpia', () => {
    work.lastRestartAt['c1'] = 1_000
    work.lastRestartAt['c2'] = 2_000

    work.invalidate('nvr_change')

    expect(work.lastRestartAt).toEqual({})
  })

  it('es el MISMO objeto, así que quien lo tenga capturado ve la limpieza', () => {
    // La reconciliación recibe esta referencia; si `invalidate` la reemplazara
    // en vez de vaciarla, el consumidor seguiría viendo los valores viejos.
    const referencia = work.lastRestartAt
    referencia['c1'] = 1_000

    work.invalidate('nvr_change')

    expect(referencia).toEqual({})
  })
})

// ─── Invariantes de la operación ─────────────────────────────────────────────

describe('la invalidación es completa e idempotente', () => {
  it('deja TODO el trabajo transitorio en cero de una sola vez', () => {
    conTrabajoPendiente()

    work.invalidate('unmount')

    expect({
      cola: work.queueSize(),
      pendientes: work.pendingSize(),
      foco: work.pendingFocus(),
      enfriamiento: Object.keys(work.lastRestartAt).length,
      temporizadores: work.trackedTimers(),
      temporizadorDeVaciado: work.hasExpiryTimer(),
    }).toEqual({
      cola: 0, pendientes: 0, foco: null,
      enfriamiento: 0, temporizadores: 0, temporizadorDeVaciado: false,
    })
  })

  it('invalidar dos veces seguidas no rompe nada', () => {
    conTrabajoPendiente()

    work.invalidate('nvr_change')
    work.invalidate('nvr_change')

    expect(work.pendingSize()).toBe(0)
    expect(ctx.invalidaciones).toHaveLength(2)
  })

  it('el viewport nuevo puede volver a acumular trabajo enseguida', () => {
    // Requisito explícito: invalidar NO deja la vista inutilizada; sólo tira lo
    // anterior. El programador no se detiene, y acá se comprueba que el estado
    // vuelve a admitir trabajo.
    work.invalidate('nvr_change')

    work.enqueueExpiry('nueva1')
    work.addPending(['nueva2'])

    expect(work.takeExpiryQueue()).toEqual(['nueva1'])
    expect(work.takePending()).toEqual(['nueva2'])
  })
})

// ─── Acumuladores ────────────────────────────────────────────────────────────

describe('acumulación de trabajo', () => {
  it('la cola y los pendientes deduplican por cameraId', () => {
    work.enqueueExpiry('c1'); work.enqueueExpiry('c1')
    work.addPending(['c2', 'c2', 'c3'])

    expect(work.takeExpiryQueue()).toEqual(['c1'])
    expect(work.takePending()).toEqual(['c2', 'c3'])
  })

  it('`take` vacía: el conjunto se consume exactamente una vez', () => {
    work.addPending(['c1'])

    expect(work.takePending()).toEqual(['c1'])
    expect(work.takePending()).toEqual([])
  })

  it('un segundo temporizador de vaciado cancela el anterior', () => {
    work.setExpiryTimer('t1')
    work.setExpiryTimer('t2')

    expect(ctx.t.cancelados).toEqual(['t1'])
    expect(work.hasExpiryTimer()).toBe(true)
  })
})
