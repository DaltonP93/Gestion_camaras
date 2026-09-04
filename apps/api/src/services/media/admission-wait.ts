// apps/api/src/services/media/admission-wait.ts
//
// N2b — Espera CANCELABLE de cupo de transcode. Upgrade real del predicado puro
// `decideAdmissionOrWait` (live-playback-decision.ts): en vez de un único
// start/wait, espera activamente a que se libere un cupo, con timeout y
// cancelación (AbortSignal).
//
// HONESTIDAD / INVARIANTE: esto OBSERVA la disponibilidad; NO reserva el cupo. La
// reserva atómica del límite de 2 transcodes sigue siendo del stream-manager
// (C1–C21) — la autoridad no se mueve. Este helper sólo evita el busy-wait del
// llamador y le da un punto de cancelación limpio; el llamador debe pedir el cupo
// real al stream-manager tras 'acquired' (que puede, en la carrera, volver a
// esperar). NO reduce el TTL de seguridad de 90s ni sube MAX_TRANSCODE_SESSIONS.

export type WaitOutcome = 'acquired' | 'timeout' | 'cancelled'

export interface CancelableWaitOptions {
  /** Tiempo máximo total de espera en ms. */
  timeoutMs: number
  /** Intervalo entre sondeos en ms (default 250). */
  pollMs?: number
  /** Cancelación externa (pagehide/cambio de cámara/desmontaje). */
  signal?: AbortSignal
  /** Reloj inyectable (pruebas). */
  now?: () => number
  /** Sleep inyectable (pruebas); debe RECHAZAR si `signal` aborta. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new Error('aborted')) }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Espera hasta que `probeAvailable()` reporte ≥1 cupo libre, o hasta timeout, o
 * hasta cancelación. Devuelve el desenlace. No reserva nada (ver nota de arriba).
 */
export async function waitForCapacity(
  probeAvailable: () => number,
  opts: CancelableWaitOptions,
): Promise<WaitOutcome> {
  const now = opts.now ?? (() => Date.now())
  const pollMs = Math.max(1, opts.pollMs ?? 250)
  const sleep = opts.sleep ?? defaultSleep
  const deadline = now() + Math.max(0, opts.timeoutMs)

  for (;;) {
    if (opts.signal?.aborted) return 'cancelled'
    if (probeAvailable() >= 1) return 'acquired'
    if (now() >= deadline) return 'timeout'
    const remaining = deadline - now()
    try { await sleep(Math.min(pollMs, Math.max(1, remaining)), opts.signal) }
    catch { return 'cancelled' }  // sleep rechaza cuando el signal aborta
  }
}
