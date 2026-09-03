// apps/api/src/services/ai/mock-provider.ts
//
// Proveedor de inferencia MOCK — sólo para pruebas y la demo desactivada. No es
// un modelo real; sirve para verificar el pipeline (cola/breaker/dedup) sin
// fingir detección productiva.

import type {
  InferenceProvider,
  InferenceInput,
  InferenceProviderStatus,
  ModelState,
  Track,
} from './contracts'

export interface MockProviderOptions {
  tracks?: (input: InferenceInput) => Track[]
  fail?: boolean
  /** Si se define, `infer` espera ese tiempo (para probar timeouts con fake timers). */
  hangMs?: number
  state?: ModelState
}

export class MockInferenceProvider implements InferenceProvider {
  readonly providerId = 'mock'
  /** Última señal recibida (para verificar que el timeout hizo abort()). */
  lastSignal: AbortSignal | null = null
  constructor(private readonly opts: MockProviderOptions = {}) {}

  status(): InferenceProviderStatus {
    return {
      providerId: this.providerId,
      modelId: 'mock',
      modelVersion: '0.0.0',
      state: this.opts.state ?? 'ready',
      updatedAt: 0,
    }
  }

  async infer(input: InferenceInput, signal?: AbortSignal): Promise<Track[]> {
    this.lastSignal = signal ?? null
    if (signal?.aborted) throw new Error('aborted')
    if (this.opts.hangMs && this.opts.hangMs > 0) {
      // Cancelable: abort() detiene la espera (el trabajo deja de estar en vuelo).
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.hangMs)
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
      })
    }
    if (signal?.aborted) throw new Error('aborted')
    if (this.opts.fail) throw new Error('mock provider failure')
    return this.opts.tracks ? this.opts.tracks(input) : []
  }
}
