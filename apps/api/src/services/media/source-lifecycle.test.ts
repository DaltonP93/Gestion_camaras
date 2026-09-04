// apps/api/src/services/media/source-lifecycle.test.ts
//
// N1 — lifecycle de fuente → registro de instancia. Cubre el invariante clave:
// un `ready` duplicado NUNCA rota la instancia (no invalida grants vivos); sólo
// un ciclo notReady→ready rota. Reconcile tolera eventos perdidos y API caída.

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryGrantStore } from './grant-store'
import {
  SourceLifecycleController,
  startSourceLifecyclePoller,
  type MediaMtxPathLister,
} from './source-lifecycle'

const P = 'nvr_cam1_sub'
const P2 = 'nvr_cam2_main'

describe('SourceLifecycleController', () => {
  let store: MemoryGrantStore
  let ctrl: SourceLifecycleController
  beforeEach(() => {
    store = new MemoryGrantStore()
    ctrl = new SourceLifecycleController(store)
  })

  it('onReady registra la fuente y la marca viva', async () => {
    await ctrl.onReady(P)
    expect(await store.currentInstance(P)).not.toBeNull()
    expect(ctrl.knownPaths()).toEqual([P])
  })

  it('onReady DUPLICADO no rota la instancia (keepalive, mismo token)', async () => {
    await ctrl.onReady(P)
    const first = await store.currentInstance(P)
    await ctrl.onReady(P)
    await ctrl.onReady(P)
    expect(await store.currentInstance(P)).toBe(first)  // NO rotó
  })

  it('onNotReady retira; un ready posterior ROTA (reconexión ⇒ instancia nueva)', async () => {
    await ctrl.onReady(P)
    const first = await store.currentInstance(P)
    await ctrl.onNotReady(P)
    expect(await store.currentInstance(P)).toBeNull()
    expect(ctrl.knownPaths()).toEqual([])
    await ctrl.onReady(P)
    const second = await store.currentInstance(P)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)  // rotó tras reconexión
  })

  it('onNotReady de un path desconocido es no-op', async () => {
    await ctrl.onNotReady('nvr_nope_sub')
    expect(ctrl.knownPaths()).toEqual([])
  })

  it('ignora paths que no matchean el naming VMS', async () => {
    await ctrl.onReady('random_thing')
    await ctrl.onReady('nvr_bad')  // sin sufijo _sub/_main
    expect(ctrl.knownPaths()).toEqual([])
  })

  it('reconcile registra las nuevas, refresca las vigentes (sin rotar), retira las ausentes', async () => {
    await ctrl.reconcile([P, P2])
    const iP = await store.currentInstance(P)
    const iP2 = await store.currentInstance(P2)
    expect(iP).not.toBeNull()
    expect(iP2).not.toBeNull()

    // Segunda pasada con las mismas: no rota ninguna.
    await ctrl.reconcile([P, P2])
    expect(await store.currentInstance(P)).toBe(iP)
    expect(await store.currentInstance(P2)).toBe(iP2)

    // P2 desaparece de la lista viva ⇒ se retira; P sigue.
    await ctrl.reconcile([P])
    expect(await store.currentInstance(P)).toBe(iP)
    expect(await store.currentInstance(P2)).toBeNull()
    expect(ctrl.knownPaths()).toEqual([P])
  })

  it('reconcile(null) NO retira nada (API caída ⇒ sin rotaciones/expulsiones espurias)', async () => {
    await ctrl.onReady(P)
    const first = await store.currentInstance(P)
    await ctrl.reconcile(null)
    expect(await store.currentInstance(P)).toBe(first)
    expect(ctrl.knownPaths()).toEqual([P])
  })

  it('fallo de registro (backend caído) NO marca vivo ⇒ el próximo reconcile reintenta', async () => {
    store.setHealthy(false)
    await ctrl.onReady(P)
    expect(ctrl.knownPaths()).toEqual([])           // no se marcó vivo
    expect(await store.currentInstance(P)).toBeNull()
    store.setHealthy(true)
    await ctrl.reconcile([P])                         // reintento
    expect(await store.currentInstance(P)).not.toBeNull()
    expect(ctrl.knownPaths()).toEqual([P])
  })
})

describe('startSourceLifecyclePoller', () => {
  it('ejecuta un reconcile inicial inmediato contra el lister', async () => {
    const store = new MemoryGrantStore()
    const ctrl = new SourceLifecycleController(store)
    const lister: MediaMtxPathLister = { async listReadyPaths() { return [P] } }
    const poller = startSourceLifecyclePoller(ctrl, lister, 1_000_000)  // intervalo enorme: sólo la pasada inicial
    await new Promise((r) => setTimeout(r, 10))
    poller.stop()
    expect(await store.currentInstance(P)).not.toBeNull()
  })
})
