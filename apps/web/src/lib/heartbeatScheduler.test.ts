// A1 · el heartbeat debe callarse con la pestaña oculta.
//
// Defecto observado en la validación A1 sobre `9efc680`: la pestaña A estuvo
// oculta 150 s y siguió enviando heartbeats cada ~30 s para el viewId
// `a2365df8-1086-42df-b3af-1065b129a6d1`, que se mantuvo con `active=9` y
// expiraciones = 0. Al volver no hubo readquisición porque nada se había
// liberado.
//
// Los diez grupos del encargo se prueban acá, sobre el módulo puro: los
// temporizadores y la visibilidad son inyectados, así que no hay relojes reales
// ni DOM, y cada aserción mira el comportamiento observable —cuántos envíos,
// cuántos intervalos, qué señales se abortaron—.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHeartbeatScheduler, type HeartbeatTimers } from './heartbeatScheduler'

const INTERVAL = 30_000

/** Vacía la cola de microtareas: el envío marca "en vuelo" hasta que su promesa
 *  se asienta, y en producción entre tick y tick pasan 30 s. */
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

/** Temporizadores falsos con introspección: cuántos hay vivos y cuántos se crearon. */
function makeTimers() {
  let nextId = 1
  const activos = new Map<number, () => void>()
  let creados = 0
  let limpiados = 0

  const timers: HeartbeatTimers = {
    setInterval: (fn: () => void) => { creados++; const id = nextId++; activos.set(id, fn); return id },
    clearInterval: (id: any) => { if (activos.delete(id)) limpiados++ },
  }
  return {
    timers,
    /** Dispara todos los intervalos vivos una vez. */
    tick() { Array.from(activos.values()).forEach(fn => fn()) },
    vivos: () => activos.size,
    creados: () => creados,
    limpiados: () => limpiados,
  }
}

/** Envío controlable: cuenta llamadas, guarda señales y permite dejarlo en vuelo. */
function makeSend() {
  const signals: AbortSignal[] = []
  let resolver: (() => void) | null = null
  let pendiente = false

  const send = (signal: AbortSignal) => {
    signals.push(signal)
    if (!pendiente) return Promise.resolve()
    return new Promise<void>(r => { resolver = r })
  }
  return {
    send,
    signals,
    count: () => signals.length,
    /** Los envíos siguientes quedan colgados hasta `resolver()`. */
    dejarEnVuelo() { pendiente = true },
    resolver() { pendiente = false; resolver?.(); resolver = null },
    abortadas: () => signals.filter(s => s.aborted).length,
  }
}

function setup(oculta = { valor: false }) {
  const t = makeTimers()
  const s = makeSend()
  const eventos: string[] = []
  const sched = createHeartbeatScheduler({
    intervalMs: INTERVAL,
    isHidden: () => oculta.valor,
    send: s.send,
    onSuspend: () => eventos.push('suspend'),
    onResume: () => eventos.push('resume'),
    timers: t.timers,
  })
  return { sched, t, s, oculta, eventos }
}

let oculta: { valor: boolean }
beforeEach(() => { oculta = { valor: false } })

// ─── 1 · Visible ─────────────────────────────────────────────────────────────

describe('(1) visible', () => {
  it('late de inmediato al arrancar y arma un solo intervalo', () => {
    const { sched, t, s } = setup(oculta)

    sched.start()

    expect(s.count()).toBe(1)          // heartbeat inmediato
    expect(t.vivos()).toBe(1)          // un solo intervalo
    expect(sched.isArmed()).toBe(true)
  })

  it('mantiene la cadencia sin duplicar intervalos', async () => {
    const { sched, t, s } = setup(oculta)
    sched.start()

    await flush(); t.tick()
    await flush(); t.tick()

    expect(s.count()).toBe(3)          // 1 inmediato + 2 ticks
    expect(t.creados()).toBe(1)
  })

  it('arrancar dos veces no crea un segundo intervalo', () => {
    const { sched, t, s } = setup(oculta)

    sched.start()
    sched.start()

    expect(t.creados()).toBe(1)
    expect(s.count()).toBe(1)
  })
})

// ─── 2 · Oculta ──────────────────────────────────────────────────────────────

describe('(2) oculta', () => {
  it('cancela el intervalo y deja de enviar heartbeats periódicos', () => {
    const { sched, t, s } = setup(oculta)
    sched.start()
    const antes = s.count()

    oculta.valor = true
    sched.handleVisibilityChange()

    expect(sched.isArmed()).toBe(false)     // CANCELADO, no sólo "saltado"
    expect(t.vivos()).toBe(0)
    expect(t.limpiados()).toBe(1)

    t.tick()                                 // no queda nada que disparar
    expect(s.count()).toBe(antes)
  })

  it('si la vista nace oculta, no late ni arma nada', () => {
    oculta.valor = true
    const { sched, t, s } = setup(oculta)

    sched.start()

    expect(s.count()).toBe(0)
    expect(t.vivos()).toBe(0)
  })
})

// ─── 3 · Solicitud en vuelo ──────────────────────────────────────────────────

describe('(3) solicitud en vuelo', () => {
  it('ocultar durante una solicitud no rearma el intervalo al terminar', async () => {
    const { sched, t, s } = setup(oculta)
    s.dejarEnVuelo()
    sched.start()
    expect(sched.isInFlight()).toBe(true)

    oculta.valor = true
    sched.handleVisibilityChange()
    expect(sched.isArmed()).toBe(false)

    // La solicitud termina DESPUÉS de ocultarse.
    s.resolver()
    await Promise.resolve(); await Promise.resolve()

    expect(sched.isArmed()).toBe(false)     // nada se rearmó
    expect(t.vivos()).toBe(0)
    expect(s.count()).toBe(1)
  })

  it('aborta la señal de la solicitud en vuelo al ocultarse', () => {
    const { sched, s } = setup(oculta)
    s.dejarEnVuelo()
    sched.start()

    oculta.valor = true
    sched.handleVisibilityChange()

    expect(s.abortadas()).toBe(1)
  })
})

// ─── 4 · Token vencido ───────────────────────────────────────────────────────

describe('(4) token vencido y renovación del JWT', () => {
  it('el reintento posterior a la renovación queda cancelado si la pestaña se ocultó', async () => {
    // El interceptor reintenta con la MISMA config, así que hereda esta señal:
    // abortarla cancela también el reintento.
    const { sched, s } = setup(oculta)
    s.dejarEnVuelo()
    sched.start()
    const señal = s.signals[0]

    oculta.valor = true
    sched.handleVisibilityChange()

    expect(señal.aborted).toBe(true)
  })

  it('un 401 que rechaza el envío no deja intervalos duplicados ni bloquea el siguiente', async () => {
    const t = makeTimers()
    let llamadas = 0
    const sched = createHeartbeatScheduler({
      intervalMs: INTERVAL,
      isHidden: () => oculta.valor,
      send: () => { llamadas++; return Promise.reject(new Error('401')) },
      timers: t.timers,
    })

    sched.start()
    await Promise.resolve(); await Promise.resolve()
    t.tick()
    await Promise.resolve(); await Promise.resolve()

    expect(llamadas).toBe(2)          // el rechazo no dejó el envío "en vuelo"
    expect(t.creados()).toBe(1)       // ni creó un intervalo extra
  })
})

// ─── 5 · Regreso antes del TTL ───────────────────────────────────────────────

describe('(5) regreso antes del TTL', () => {
  it('late de inmediato al volver y rearma un único intervalo', () => {
    const { sched, t, s } = setup(oculta)
    sched.start()
    oculta.valor = true
    sched.handleVisibilityChange()
    const antes = s.count()

    oculta.valor = false
    sched.handleVisibilityChange()

    expect(s.count()).toBe(antes + 1)   // inmediato
    expect(t.vivos()).toBe(1)
    expect(t.creados()).toBe(2)         // el primero se canceló; éste es el nuevo
  })
})

// ─── 6 · Regreso después del TTL ─────────────────────────────────────────────

describe('(6) regreso después del TTL', () => {
  it('el heartbeat de regreso es uno solo, y es el que readquiere', () => {
    // La readquisición la resuelve el backend con ESTE heartbeat (devuelve
    // startedIds). Lo que el programador debe garantizar es que se envía
    // exactamente uno, no una ráfaga que dispare el límite de streams.
    const { sched, s } = setup(oculta)
    sched.start()
    oculta.valor = true
    sched.handleVisibilityChange()

    oculta.valor = false
    sched.handleVisibilityChange()

    expect(s.count()).toBe(2)           // el de arranque y el de regreso
  })
})

// ─── 7 · Alternancia rápida ──────────────────────────────────────────────────

describe('(7) alternancia rápida oculta/visible', () => {
  it('queda un solo intervalo tras muchas alternancias', () => {
    const { sched, t } = setup(oculta)
    sched.start()

    for (let i = 0; i < 20; i++) {
      oculta.valor = true;  sched.handleVisibilityChange()
      oculta.valor = false; sched.handleVisibilityChange()
    }

    expect(t.vivos()).toBe(1)
    expect(sched.isArmed()).toBe(true)
  })

  it('no se acumulan envíos solapados: con uno en vuelo, la alternancia no dispara otro', () => {
    const { sched, s } = setup(oculta)
    s.dejarEnVuelo()
    sched.start()
    expect(s.count()).toBe(1)

    // Vuelve a visible sin que el primero haya terminado… pero ese primero fue
    // abortado al ocultarse, así que el de regreso sí debe salir: uno, no dos.
    oculta.valor = true;  sched.handleVisibilityChange()
    oculta.valor = false; sched.handleVisibilityChange()

    expect(s.count()).toBe(2)
  })
})

// ─── 8 · Dos pestañas ────────────────────────────────────────────────────────

describe('(8) dos pestañas', () => {
  it('una pestaña oculta no interfiere con la visible', async () => {
    const ocultaA = { valor: false }
    const ocultaB = { valor: false }
    const a = setup(ocultaA)
    const b = setup(ocultaB)
    a.sched.start()
    b.sched.start()

    ocultaA.valor = true
    a.sched.handleVisibilityChange()

    await flush()
    a.t.tick()
    b.t.tick()

    expect(a.s.count()).toBe(1)       // A: sólo el de arranque
    expect(a.sched.isArmed()).toBe(false)
    expect(b.s.count()).toBe(2)       // B: arranque + tick, intacta
    expect(b.sched.isArmed()).toBe(true)
  })
})

// ─── 9 · Desmontaje / pagehide / cambio de NVR ───────────────────────────────

describe('(9) cierre', () => {
  it('detiene el intervalo y aborta lo que estuviera en vuelo', () => {
    const { sched, t, s } = setup(oculta)
    s.dejarEnVuelo()
    sched.start()

    sched.stop()

    expect(t.vivos()).toBe(0)
    expect(s.abortadas()).toBe(1)
    expect(sched.isArmed()).toBe(false)
  })

  it('detener dos veces limpia exactamente una vez', () => {
    const { sched, t } = setup(oculta)
    sched.start()

    sched.stop()
    sched.stop()

    expect(t.limpiados()).toBe(1)
  })

  it('tras detenerse, ni la visibilidad ni un tick tardío reviven el latido', () => {
    const { sched, t, s } = setup(oculta)
    sched.start()
    const antes = s.count()

    sched.stop()
    oculta.valor = false
    sched.handleVisibilityChange()
    t.tick()

    expect(s.count()).toBe(antes)
    expect(sched.isArmed()).toBe(false)
  })
})

// ─── 10 · Regresión del defecto observado ────────────────────────────────────

describe('(10) regresión de la validación A1', () => {
  it('150 s ocultos no producen ningún heartbeat', async () => {
    const { sched, t, s } = setup(oculta)
    sched.start()
    const alOcultarse = s.count()

    oculta.valor = true
    sched.handleVisibilityChange()

    // Cinco ciclos de 30 s: exactamente la ventana de la prueba fallida.
    for (let i = 0; i < 5; i++) { await flush(); t.tick() }

    expect(s.count()).toBe(alOcultarse)
    expect(sched.isArmed()).toBe(false)
  })

  it('una ruta que intente latir con la pestaña oculta no llega a enviar', async () => {
    // `fire()` es el único camino de envío y consulta la visibilidad en el
    // momento: aunque un tick sobreviviera por cualquier motivo, no envía.
    const { sched, t, s } = setup(oculta)
    sched.start()
    const antes = s.count()

    // Se oculta SIN notificar el cambio de visibilidad (peor caso: el listener
    // se perdió). El intervalo sigue vivo, pero el envío se niega igual.
    oculta.valor = true
    await flush()
    t.tick()

    expect(s.count()).toBe(antes)
  })
})
