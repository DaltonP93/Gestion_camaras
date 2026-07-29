import { describe, it, expect, vi, afterEach } from 'vitest'
import { withStepUp } from './stepup'
import { useStepUpStore } from '@/stores/stepUpStore'

const err403 = { response: { status: 403, data: { code: 'STEP_UP_REQUIRED' } } }

afterEach(() => vi.restoreAllMocks())

describe('withStepUp', () => {
  it('devuelve el resultado sin pedir step-up si la llamada tiene éxito', async () => {
    const call = vi.fn().mockResolvedValue('ok')
    await expect(withStepUp(call)).resolves.toBe('ok')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith()
  })

  it('ante 403 STEP_UP_REQUIRED pide token y reintenta con header x-step-up-token', async () => {
    vi.spyOn(useStepUpStore, 'getState').mockReturnValue({ request: async () => 'TOKEN' } as any)
    const call = vi.fn()
      .mockRejectedValueOnce(err403)
      .mockResolvedValueOnce('done')
    await expect(withStepUp(call)).resolves.toBe('done')
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenNthCalledWith(2, { 'x-step-up-token': 'TOKEN' })
  })

  it('propaga errores que no son step-up sin abrir el modal', async () => {
    const spy = vi.spyOn(useStepUpStore, 'getState')
    const call = vi.fn().mockRejectedValue({ response: { status: 500 } })
    await expect(withStepUp(call)).rejects.toEqual({ response: { status: 500 } })
    expect(spy).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('propaga la cancelación del usuario', async () => {
    vi.spyOn(useStepUpStore, 'getState').mockReturnValue({
      request: async () => { throw new Error('step-up-cancelled') },
    } as any)
    const call = vi.fn().mockRejectedValue(err403)
    await expect(withStepUp(call)).rejects.toThrow('step-up-cancelled')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
