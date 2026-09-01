// A1 (post #160, correctivo 13) · vigencia publicada en el commit.
//
// El token de carga del correctivo 12 sólo se invalidaba en el cleanup PASIVO de
// un `useEffect`. Entre el commit de la ruta nueva (B ya renderizada) y ese
// cleanup, una continuación de Promise de A corría y todavía pasaba `isCurrent()`.
//
// `createScopeGuard` publica el scope nuevo de inmediato: publicar B invalida A
// en el acto, SIN depender de que corra el cleanup de A. Se ejercita el CÓDIGO
// REAL (el guard y `runScopedViewLoad`); el orden commit-antes-de-cleanup se
// modela llamando `publish()` (lo que el layout effect hace en el commit) sin
// llamar `invalidate()` (lo que haría el cleanup, que aquí NO corrió).
import { describe, it, expect } from 'vitest'
import { createScopeGuard } from './scopeGuard'
import { runScopedViewLoad } from './scopedViewLoad'
import { closeStaleStart } from './viewportSessionClose'
import { createSessionRegistry } from './sessionRegistry'
import { createPendingCloseQueue } from './pendingCloses'
import { resolveCreatedType } from './streamTypes'

describe('createScopeGuard: publicar invalida al anterior en el acto', () => {
  it('publicar B invalida A sin necesidad de invalidar A por cleanup', () => {
    const g = createScopeGuard()
    const a = g.publish()
    expect(g.isCurrent(a)).toBe(true)

    // "B se comprometió/renderizó": su layout effect publica. NO se llamó al
    // cleanup pasivo de A. Aun así, A ya no es vigente.
    const b = g.publish()
    expect(g.isCurrent(a)).toBe(false)
    expect(g.isCurrent(b)).toBe(true)
    expect(a).not.toBe(b)                       // identidad exacta, nunca colisiona
  })

  it('invalidar sólo afecta si el scope sigue vigente', () => {
    const g = createScopeGuard()
    const a = g.publish()
    const b = g.publish()
    // El cleanup tardío de A no puede tumbar el scope vigente B.
    g.invalidate(a)
    expect(g.isCurrent(b)).toBe(true)
    // Invalidar el vigente sí lo baja.
    g.invalidate(b)
    expect(g.isCurrent(b)).toBe(false)
  })
})

interface View { cameraSlots: Array<{ cameraId: string | null }> }
function diferida<T>() {
  let resolver!: (v: T) => void
  const promise = new Promise<T>(r => { resolver = r })
  return { promise, resolver }
}
const tick = () => new Promise(r => setTimeout(r, 0))
const vacia: View = { cameraSlots: [] }

describe('carga de vista: B comprometida antes del cleanup pasivo de A', () => {
  it('resolver A tras el commit de B no aplica NADA de A', async () => {
    const g = createScopeGuard()
    const scopeA = g.publish()                  // A montó (layout effect de A)
    const dA = diferida<View>()
    const log: string[] = []

    const runA = runScopedViewLoad<View, unknown, unknown>({
      id: 'A',
      isCurrent: () => g.isCurrent(scopeA),
      fetchView: () => dA.promise,
      assignedIds: () => [],
      fetchCamera: async () => ({}),
      fetchStream: async () => ({}),
      onView: () => log.push('onView:A'),
      onSlots: () => log.push('onSlots:A'),
      onError: () => log.push('onError:A'),
      onSettled: () => log.push('onSettled:A'),
    })

    // B se comprometió (su layout effect publicó), PERO el cleanup pasivo de A
    // todavía no corrió. Sólo con eso, A ya no es vigente.
    g.publish()
    dA.resolver(vacia)                           // recién ahora resuelve A
    await runA

    expect(log).toEqual([])                      // ni view, ni slots, ni settled, ni error
  })

  it('un POST de grilla de A en vuelo se cierra por attemptId y se encola si no confirma', async () => {
    const g = createScopeGuard()
    const scopeA = g.publish()
    const registry = createSessionRegistry()
    const pending = createPendingCloseQueue()
    const dPost = diferida<{ streamPath: string }>()
    const cerrados: string[] = []

    // Re-arranque de grilla de A: POST en vuelo cuando B se compromete.
    const run = (async () => {
      const scope = scopeA
      if (!g.isCurrent(scope)) return
      const info = await dPost.promise
      const created = resolveCreatedType(info, 'sub')
      if (!g.isCurrent(scope)) {
        // Cierre no confirmado (500): debe encolarse por identidad.
        await closeStaleStart({
          cameraId: 'c1', info, requested: 'sub', startAttemptId: 'sa-A',
          viewId: 'v1', registry, pending,
          close: (_c, tipo, _r, _v, expected) => {
            cerrados.push(`${tipo}:${expected}`)
            return { emitted: true, status: 500 }
          },
        })
        return
      }
      registry.add({ cameraId: 'c1', streamType: created, startAttemptId: 'sa-A' })
    })()

    g.publish()                                  // B se compromete
    dPost.resolver({ streamPath: '/c1_main' })   // A llega tarde, redirigida a main
    await run

    // No se registró la sesión de A; se cerró por su attemptId y tipo REAL…
    expect(registry.has('c1')).toBe(false)
    expect(cerrados).toEqual(['main:sa-A'])
    // …y como el cierre no confirmó (500), quedó en la cola para reintentar.
    expect(pending.has('c1', 'main', 'sa-A')).toBe(true)
  })

  it('camino feliz: A sigue vigente todo el tiempo y aplica', async () => {
    const g = createScopeGuard()
    const scopeA = g.publish()
    const log: string[] = []
    await runScopedViewLoad<View, unknown, unknown>({
      id: 'A',
      isCurrent: () => g.isCurrent(scopeA),
      fetchView: async () => ({ cameraSlots: [] }),
      assignedIds: () => [],
      fetchCamera: async () => ({}),
      fetchStream: async () => ({}),
      onView: () => log.push('onView:A'),
      onSlots: () => log.push('onSlots:A'),
      onError: () => log.push('onError:A'),
      onSettled: () => log.push('onSettled:A'),
    })
    await tick()
    expect(log).toEqual(['onView:A', 'onSlots:A', 'onSettled:A'])
  })
})
