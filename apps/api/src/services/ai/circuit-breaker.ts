// apps/api/src/services/ai/circuit-breaker.ts
//
// Circuit breaker para la base de IA (C22, Hito 5). Aísla al pipeline de un
// proveedor de inferencia caído: tras N fallos abre el circuito y deja de
// llamarlo por `openMs`, luego prueba en half-open. Puro y con reloj inyectable.
// Un breaker abierto JAMÁS debe traducirse en bloqueo del video (el pipeline
// simplemente omite la inferencia).

export type BreakerState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerOptions {
  failureThreshold: number
  openMs: number
  /** Llamadas simultáneas permitidas en half-open (default 1). */
  halfOpenMaxCalls?: number
}

export class CircuitBreaker {
  private _state: BreakerState = 'closed'
  private failures = 0
  private openedAt = 0
  private halfOpenInFlight = 0

  constructor(
    private readonly opts: CircuitBreakerOptions,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  state(): BreakerState {
    this.maybeHalfOpen()
    return this._state
  }

  private maybeHalfOpen(): void {
    if (this._state === 'open' && this.clock() - this.openedAt >= this.opts.openMs) {
      this._state = 'half_open'
      this.halfOpenInFlight = 0
    }
  }

  /** ¿Se permite un intento ahora? En half-open consume un cupo limitado. */
  tryAcquire(): boolean {
    this.maybeHalfOpen()
    if (this._state === 'closed') return true
    if (this._state === 'open') return false
    const max = this.opts.halfOpenMaxCalls ?? 1
    if (this.halfOpenInFlight < max) {
      this.halfOpenInFlight++
      return true
    }
    return false
  }

  onSuccess(): void {
    if (this._state === 'half_open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1)
      this._state = 'closed'
    }
    this.failures = 0
  }

  onFailure(): void {
    if (this._state === 'half_open') {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1)
      this.trip()
      return
    }
    this.failures++
    if (this.failures >= this.opts.failureThreshold) this.trip()
  }

  private trip(): void {
    this._state = 'open'
    this.openedAt = this.clock()
    this.failures = 0
  }
}
