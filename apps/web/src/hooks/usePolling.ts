// usePolling — polling secuencial y respetuoso del navegador.
//
// A diferencia de setInterval, la siguiente ejecución se agenda SOLO cuando
// termina la anterior (nunca se solapan aunque una request tarde), se pausa
// mientras la pestaña está oculta (document.hidden) y aplica backoff exponencial
// ante respuestas 429 respetando Retry-After. Cada ejecución recibe un AbortSignal
// que se cancela al desmontar o al cambiar de dependencia.
//
// Esto reemplaza los setInterval fijos que, combinados con reintentos de cámaras,
// heartbeats y errores HLS, generaban tormentas de requests y 429.
//
// La lógica de scheduling vive en createSequentialPoller (pura, testeable sin DOM);
// el hook sólo la conecta a document.visibilitychange y al ciclo de vida de React.
import { useEffect, useRef } from 'react'
import { getRetryAfterMs } from '../lib/api'

interface PollerDeps {
  intervalMs: number
  maxBackoffMs?: number
  isHidden?: () => boolean
  retryAfterMs?: (err: any, fallback: number) => number
}

export function createSequentialPoller(
  fn: (signal: AbortSignal) => Promise<void>,
  { intervalMs, maxBackoffMs = 60_000, isHidden = () => false, retryAfterMs = getRetryAfterMs }: PollerDeps,
) {
  let stopped = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let backoffMs = 0

  function schedule(ms: number) {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, ms)
  }

  async function tick() {
    if (stopped || inFlight) return
    if (isHidden()) { schedule(intervalMs); return }   // pausa con pestaña oculta
    inFlight = true
    controller = new AbortController()
    try {
      await fn(controller.signal)
      backoffMs = 0
    } catch (err: any) {
      if (err?.response?.status === 429) {
        const suggested = retryAfterMs(err, Math.max(intervalMs, (backoffMs || intervalMs) * 2))
        backoffMs = Math.min(suggested, maxBackoffMs)
      }
      // otros errores: intervalo normal (los callbacks los manejan)
    } finally {
      inFlight = false
    }
    schedule(backoffMs || intervalMs)
  }

  return {
    start() { if (!stopped) tick() },
    // Reanudar de inmediato al volver visible (si no hay una request en vuelo)
    resume() { if (!stopped && !inFlight && !isHidden()) tick() },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      controller?.abort()
    },
    // Introspección para tests
    isInFlight() { return inFlight },
  }
}

interface PollingOptions {
  intervalMs: number
  enabled?: boolean
  pauseWhenHidden?: boolean
  maxBackoffMs?: number
}

export function usePolling(
  fn: (signal: AbortSignal) => Promise<void>,
  { intervalMs, enabled = true, pauseWhenHidden = true, maxBackoffMs = 60_000 }: PollingOptions,
) {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    const poller = createSequentialPoller((signal) => fnRef.current(signal), {
      intervalMs,
      maxBackoffMs,
      isHidden: () => pauseWhenHidden && document.visibilityState === 'hidden',
    })
    const onVisible = () => { if (document.visibilityState === 'visible') poller.resume() }
    document.addEventListener('visibilitychange', onVisible)
    poller.start()
    return () => {
      poller.stop()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs, enabled, pauseWhenHidden, maxBackoffMs])
}
