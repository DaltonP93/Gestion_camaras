// Orquestación del step-up (re-autenticación para acciones sensibles, fase 4c).
// `request()` abre el modal y devuelve una promesa que se resuelve con el token de
// elevación cuando el usuario verifica, o se rechaza si cancela. El <StepUpModal/>
// (montado una vez en App) consume este estado.
import { create } from 'zustand'

interface StepUpState {
  open: boolean
  _resolve: ((token: string) => void) | null
  _reject: ((err: unknown) => void) | null
  request: () => Promise<string>
  resolveWith: (token: string) => void
  cancel: () => void
}

export const useStepUpStore = create<StepUpState>((set, get) => ({
  open: false,
  _resolve: null,
  _reject: null,
  request: () =>
    new Promise<string>((resolve, reject) => {
      // Si ya había una petición abierta, se cancela para no dejar promesas colgadas.
      get()._reject?.(new Error('step-up-superseded'))
      set({ open: true, _resolve: resolve, _reject: reject })
    }),
  resolveWith: (token) => {
    get()._resolve?.(token)
    set({ open: false, _resolve: null, _reject: null })
  },
  cancel: () => {
    get()._reject?.(new Error('step-up-cancelled'))
    set({ open: false, _resolve: null, _reject: null })
  },
}))
