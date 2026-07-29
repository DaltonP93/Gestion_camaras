// Helper para envolver llamadas a la API que pueden exigir step-up (fase 4c).
// Si la llamada devuelve 403 con code STEP_UP_REQUIRED, abre el modal de verificación,
// obtiene el token de elevación y reintenta la MISMA llamada con el header
// x-step-up-token. El `call` recibe los headers extra a fusionar.
import { useStepUpStore } from '@/stores/stepUpStore'

export async function withStepUp<T>(
  call: (headers?: Record<string, string>) => Promise<T>,
): Promise<T> {
  try {
    return await call()
  } catch (err: any) {
    const isStepUp =
      err?.response?.status === 403 && err?.response?.data?.code === 'STEP_UP_REQUIRED'
    if (!isStepUp) throw err
    const token = await useStepUpStore.getState().request()
    return call({ 'x-step-up-token': token })
  }
}
