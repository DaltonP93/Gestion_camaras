// apps/native/shared/native-controller.test.ts
//
// Track 2 — capstone del cliente nativo. Verifica que compone coordinador +
// binder + apply-decision, y que el resume (volver a visible) RE-APLICA la última
// decisión del servidor. Cubre además el ciclo hidden→visible y el dispose.

import { describe, it, expect, beforeEach } from 'vitest'
import { NativePlaybackController, type NativeControllerCoordinator } from './native-controller'
import type { GrantRequest } from './grant-client'
import type { CoordinatorOpenResult } from './coordinator'

class FakeCoordinator implements NativeControllerCoordinator {
  calls: string[] = []
  reqs: GrantRequest[] = []
  async open(req: GrantRequest): Promise<CoordinatorOpenResult> { this.calls.push('open'); this.reqs.push(req); return { published: true } }
  async invalidate(): Promise<void> { this.calls.push('invalidate') }
  async dispose(): Promise<void> { this.calls.push('dispose') }
}

const ctx = { viewId: 'v1', cameraId: 'cam1', device: 'win', callbacks: {} }

describe('NativePlaybackController', () => {
  let coord: FakeCoordinator
  let ctrl: NativePlaybackController
  beforeEach(() => { coord = new FakeCoordinator(); ctrl = new NativePlaybackController(coord) })

  it('show(native) abre el coordinador y recuerda la decisión', async () => {
    const out = await ctrl.show({ decision: 'native_hevc', transport: 'rtsps' }, ctx)
    expect(out.mode).toBe('native')
    expect(coord.calls).toEqual(['open'])
    expect(ctrl.lastDecision).toEqual({ decision: 'native_hevc', transport: 'rtsps' })
  })

  it('hidden→visible RE-APLICA la última decisión nativa (re-open)', async () => {
    await ctrl.show({ decision: 'native_hevc', transport: 'rtsps' }, ctx)   // open
    await ctrl.onHidden()                                                   // invalidate
    expect(ctrl.suspended).toBe(true)
    await ctrl.onVisible()                                                  // resume → open otra vez
    expect(ctrl.suspended).toBe(false)
    expect(coord.calls).toEqual(['open', 'invalidate', 'open'])
    expect(coord.reqs).toHaveLength(2)
    expect(coord.reqs[1]).toMatchObject({ transport: 'rtsps', codec: 'hevc' })
  })

  it('resume de una decisión de servidor re-invalida (no abre nativo)', async () => {
    await ctrl.show({ decision: 'server_h264', transport: 'hls' }, ctx)     // invalidate
    await ctrl.onHidden()                                                   // invalidate
    await ctrl.onVisible()                                                  // resume → invalidate
    expect(coord.calls).toEqual(['invalidate', 'invalidate', 'invalidate'])
  })

  it('onVisible sin haber mostrado nada no hace nada raro', async () => {
    await ctrl.onHidden()      // invalidate (aunque no haya nada)
    await ctrl.onVisible()     // resume: last=null ⇒ no-op
    expect(coord.calls).toEqual(['invalidate'])
  })

  it('dispose dispone el coordinador; tras él show/lifecycle son inertes', async () => {
    await ctrl.show({ decision: 'native_hevc', transport: 'rtsps' }, ctx)   // open
    await ctrl.dispose()                                                    // dispose
    expect(ctrl.isDisposed).toBe(true)
    const out = await ctrl.show({ decision: 'native_hevc', transport: 'rtsps' }, ctx)
    expect(out).toEqual({ mode: 'none', reason: 'unavailable' })
    await ctrl.onHidden(); await ctrl.onVisible()
    expect(coord.calls).toEqual(['open', 'dispose'])
  })

  it('onPageHide(false) desmonta (dispose vía binder)', async () => {
    await ctrl.show({ decision: 'native_h264', transport: 'whep' }, ctx)    // open
    await ctrl.onPageHide(false)                                            // dispose
    expect(coord.calls).toEqual(['open', 'dispose'])
  })
})
