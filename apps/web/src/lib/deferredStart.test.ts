// A1 · los arranques diferidos no pueden sobrevivir al viewport que los pidió.
//
// Requisito 7 de la revisión de #159: el reinicio (3 s), el reintento de grid
// (300 ms), el fallback a main_h264 (300 ms) y el escalonado tienen que quedar
// invalidados por un cambio de NVR/página/layout.
//
// Temporizadores REALES y esperas reales: si la cancelación o la guarda no
// funcionaran, `arrancadas` tendría la cámara del viewport viejo. Se combinan
// los tres módulos de producción —`scheduleDeferredStart`, `createViewportWork`
// y `createViewportTransition`— tal como los cablea la página.
import { describe, it, expect, beforeEach } from 'vitest'
import { scheduleDeferredStart } from './deferredStart'
import { createViewportWork, type ViewportWork } from './viewportWork'
import { createViewportTransition, type ViewportTransition } from './viewportTransition'

const esperar = (ms: number) => new Promise<void>(r => { setTimeout(r, ms) })

function makeBench() {
  const arrancadas: string[] = []
  const descartes: Array<{ cameraId: string; cause: string }> = []
  const oculta = { valor: false }

  const viewportWork: ViewportWork = createViewportWork()
  const transition: ViewportTransition<null> = createViewportTransition<null>({
    suspendScheduler: () => {},
    armScheduler: () => {},
    runHeartbeatNow: async () => null,
    invalidateWork: (reason) => viewportWork.invalidate(reason),
    closeSessions: async () => {},
    publishViewport: () => {},
    awaitPublished: async () => {},
    isHidden: () => oculta.valor,
  })

  /** Mismo cableado que `scheduleStart` en la página. */
  function scheduleStart(cameraId: string, delayMs: number, reason: string) {
    const token = transition.current()
    scheduleDeferredStart({
      cameraId, reason, delayMs,
      isCurrent: () => transition.isCurrent(token),
      isHidden: () => oculta.valor,
      track: (id) => viewportWork.trackTimer(id),
      start: () => { arrancadas.push(cameraId) },
      onDiscard: ({ cameraId: id, cause }) => { descartes.push({ cameraId: id, cause }) },
    })
  }

  return { arrancadas, descartes, oculta, viewportWork, transition, scheduleStart }
}

let b: ReturnType<typeof makeBench>
beforeEach(() => { b = makeBench() })

describe('un arranque diferido programado antes del cambio', () => {
  it('NO arranca después de un cambio de NVR (temporizadores reales)', async () => {
    b.scheduleStart('a1', 20, 'restart_stream')
    b.scheduleStart('a2', 20, 'grid_retry')
    b.scheduleStart('a3', 20, 'grid_fallback_to_main_h264')
    b.scheduleStart('a4', 20, 'stagger')

    await b.transition.run('nvr_change', null)   // invalida y cancela

    await esperar(60)
    expect(b.arrancadas).toEqual([])
  })

  it('los temporizadores quedan cancelados, no sólo ignorados', async () => {
    b.scheduleStart('a1', 20, 'stagger')
    expect(b.viewportWork.trackedTimers()).toBe(1)

    await b.transition.run('page_change', null)
    await esperar(60)

    // Cancelado de verdad: el callback no llegó a correr, así que tampoco hubo
    // descarte que registrar. Si sólo se hubiera ignorado, habría un descarte.
    expect(b.descartes).toEqual([])
    expect(b.arrancadas).toEqual([])
    expect(b.viewportWork.trackedTimers()).toBe(0)
  })

  it('sí arranca si el viewport no cambió', async () => {
    b.scheduleStart('a1', 20, 'restart_stream')
    await esperar(60)
    expect(b.arrancadas).toEqual(['a1'])
  })
})

describe('la guarda del disparo, para lo que la cancelación no alcanza', () => {
  it('un temporizador que ya venció comprueba el token igual', async () => {
    // Se programa con 0 ms y se cambia el viewport SIN pasar por la
    // invalidación, que es como se comporta un callback ya encolado.
    const token = b.transition.current()
    scheduleDeferredStart({
      cameraId: 'a1', reason: 'grid_retry', delayMs: 0,
      isCurrent: () => b.transition.isCurrent(token),
      isHidden: () => false,
      track: () => {},
      start: () => { b.arrancadas.push('a1') },
      onDiscard: ({ cameraId, cause }) => { b.descartes.push({ cameraId, cause }) },
    })
    b.transition.begin('layout_change')

    await esperar(20)
    expect(b.arrancadas).toEqual([])
    expect(b.descartes).toEqual([{ cameraId: 'a1', cause: 'viewport_changed' }])
  })

  it('con la pestaña oculta no arranca nada, aunque el viewport sea el mismo', async () => {
    b.scheduleStart('a1', 20, 'stagger')
    b.oculta.valor = true

    await esperar(60)
    expect(b.arrancadas).toEqual([])
    expect(b.descartes).toEqual([{ cameraId: 'a1', cause: 'tab_hidden' }])
  })

  it('ocultarse DURANTE la transición tampoco revive un arranque', async () => {
    b.scheduleStart('a1', 20, 'restart_stream')
    const corriendo = b.transition.run('nvr_change', null)
    b.oculta.valor = true
    await corriendo

    // Y el viewport nuevo tampoco programa nada mientras está oculta.
    b.scheduleStart('b1', 20, 'stagger')
    await esperar(60)

    expect(b.arrancadas).toEqual([])
  })
})

describe('el viewport nuevo puede programar enseguida', () => {
  it('lo programado después del cambio sí arranca', async () => {
    b.scheduleStart('a1', 20, 'stagger')
    await b.transition.run('nvr_change', null)
    b.scheduleStart('b1', 20, 'stagger')

    await esperar(60)
    expect(b.arrancadas).toEqual(['b1'])
  })
})
