// apps/native/shared/lifecycle-binder.test.ts
//
// N2a — auto-revocación por lifecycle. Verifica que hidden invalida (una vez),
// visible reanuda, pagehide persisted/no-persisted difieren, y que tras teardown
// todo es no-op e idempotente.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NativeLifecycleBinder, type LifecycleControllable } from './lifecycle-binder'

class FakeCtrl implements LifecycleControllable {
  calls: string[] = []
  async invalidate(): Promise<void> { this.calls.push('invalidate') }
  async dispose(): Promise<void> { this.calls.push('dispose') }
}

describe('NativeLifecycleBinder', () => {
  let ctrl: FakeCtrl
  beforeEach(() => { ctrl = new FakeCtrl() })

  it('onHidden invalida una sola vez (idempotente mientras esté suspendido)', async () => {
    const b = new NativeLifecycleBinder(ctrl)
    await b.onHidden()
    await b.onHidden()
    expect(ctrl.calls).toEqual(['invalidate'])
    expect(b.isSuspended).toBe(true)
  })

  it('onVisible reanuda sólo si estaba suspendido', async () => {
    const onResume = vi.fn()
    const b = new NativeLifecycleBinder(ctrl, { onResume })
    await b.onVisible()                 // no estaba suspendido ⇒ no-op
    expect(onResume).not.toHaveBeenCalled()
    await b.onHidden()
    await b.onVisible()
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(b.isSuspended).toBe(false)
  })

  it('ciclo hidden→visible→hidden invalida en cada suspensión', async () => {
    const b = new NativeLifecycleBinder(ctrl)
    await b.onHidden(); await b.onVisible(); await b.onHidden()
    expect(ctrl.calls).toEqual(['invalidate', 'invalidate'])
  })

  it('onPageHide(true) = hidden; onPageHide(false) = dispose', async () => {
    const b1 = new NativeLifecycleBinder(new FakeCtrl())
    const c1 = (b1 as any).ctrl as FakeCtrl
    await b1.onPageHide(true)
    expect(c1.calls).toEqual(['invalidate'])

    const c2 = new FakeCtrl()
    const b2 = new NativeLifecycleBinder(c2)
    await b2.onPageHide(false)
    expect(c2.calls).toEqual(['dispose'])
    expect(b2.isDisposed).toBe(true)
  })

  it('tras teardown, todo es no-op (hidden/visible/pagehide/teardown)', async () => {
    const b = new NativeLifecycleBinder(ctrl)
    await b.onTeardown()
    await b.onTeardown()               // idempotente
    await b.onHidden()
    await b.onVisible()
    await b.onPageHide(false)
    expect(ctrl.calls).toEqual(['dispose'])
    expect(b.isDisposed).toBe(true)
  })
})
