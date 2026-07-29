import { describe, it, expect } from 'vitest'
import { useStepUpStore } from './stepUpStore'

describe('stepUpStore', () => {
  it('request() abre el modal y se resuelve con resolveWith', async () => {
    const p = useStepUpStore.getState().request()
    expect(useStepUpStore.getState().open).toBe(true)
    useStepUpStore.getState().resolveWith('TOKEN')
    await expect(p).resolves.toBe('TOKEN')
    expect(useStepUpStore.getState().open).toBe(false)
  })

  it('cancel() rechaza la promesa y cierra el modal', async () => {
    const p = useStepUpStore.getState().request()
    useStepUpStore.getState().cancel()
    await expect(p).rejects.toThrow('step-up-cancelled')
    expect(useStepUpStore.getState().open).toBe(false)
  })

  it('una nueva request() supersede la anterior (rechaza la vieja)', async () => {
    const first = useStepUpStore.getState().request()
    const second = useStepUpStore.getState().request()
    await expect(first).rejects.toThrow('step-up-superseded')
    useStepUpStore.getState().resolveWith('T2')
    await expect(second).resolves.toBe('T2')
  })
})
