// Programador del heartbeat de vista en vivo.
//
// POR QUÉ EXISTE ESTE MÓDULO
//
// El heartbeat vivía repartido: un `setInterval` con la guarda de visibilidad
// DENTRO del callback, otro `setInterval` sin ninguna guarda en el reproductor
// de vistas, y una tercera ruta —el vaciado de sesiones HLS expiradas— que
// llamaba al endpoint por su cuenta. Con la pestaña oculta, hls.js sigue
// cargando en segundo plano, sus 401 encolan reintentos y esa tercera ruta
// enviaba un heartbeat cada ~30 s (su propio acelerador por cámara). El
// servidor veía una vista viva, nunca expiraba las sesiones y FFmpeg seguía
// corriendo sin espectador.
//
// La lección de las rondas anteriores es la misma acá: una regla escrita en N
// lugares se corrige en N-1. Así que el "cuándo se puede latir" vive en un solo
// sitio —este módulo— y las páginas sólo lo conectan al DOM.
//
// GARANTÍAS
//
//   · Con la pestaña oculta NO se envía ningún heartbeat, y el intervalo se
//     CANCELA (no se limita a saltarse un tick).
//   · Nunca hay más de un intervalo armado, por muchas veces que se llame a
//     `start()` o se alterne visible/oculto.
//   · La cadencia la posee el intervalo, no el final de cada solicitud: una
//     respuesta que llega tarde —incluido el reintento del interceptor tras
//     renovar el JWT— no puede rearmar nada.
//   · Cada envío recibe un `AbortSignal` que se aborta al ocultar la pestaña o
//     al detener el programador, así que la solicitud en vuelo y su reintento
//     posterior a la renovación del token se cancelan de verdad.
//   · Al volver a visible se envía un heartbeat INMEDIATO y se rearma un único
//     intervalo.
//
// Es puro y con temporizadores inyectables: se prueba entero sin DOM.

export interface HeartbeatTimers {
  setInterval: (fn: () => void, ms: number) => any
  clearInterval: (id: any) => void
}

export interface HeartbeatSchedulerOptions {
  /** Cadencia del latido periódico, en ms. */
  intervalMs: number
  /** Estado de visibilidad. Se consulta en cada decisión, nunca se cachea. */
  isHidden: () => boolean
  /**
   * Envío real. Recibe la señal del ciclo actual: si la pestaña se oculta
   * mientras está en vuelo, la señal se aborta.
   */
  send: (signal: AbortSignal) => Promise<unknown>
  /** Diagnóstico opcional (logs de la página). */
  onSuspend?: () => void
  onResume?: () => void
  timers?: HeartbeatTimers
}

export interface HeartbeatScheduler {
  /** Arranca. Si la pestaña ya está oculta, no late ni arma nada. */
  start(): void
  /** Conectar a `visibilitychange`: decide suspender o reanudar. */
  handleVisibilityChange(): void
  /** Cierre definitivo (desmontaje, cambio de NVR). Idempotente. */
  stop(): void
  /** Sólo tests/diagnóstico: ¿hay un intervalo armado? */
  isArmed(): boolean
  /** Sólo tests/diagnóstico: ¿hay un envío en vuelo? */
  isInFlight(): boolean
}

const defaultTimers: HeartbeatTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
}

export function createHeartbeatScheduler(opts: HeartbeatSchedulerOptions): HeartbeatScheduler {
  const timers = opts.timers ?? defaultTimers

  let started = false
  let stopped = false
  let intervalId: any = null
  let controller: AbortController | null = null

  /** Arma el intervalo. Idempotente: si ya hay uno, no crea un segundo. */
  function arm(): void {
    if (stopped || intervalId !== null) return
    intervalId = timers.setInterval(fire, opts.intervalMs)
  }

  function disarm(): void {
    if (intervalId === null) return
    timers.clearInterval(intervalId)
    intervalId = null
  }

  /** Aborta el envío en vuelo, si lo hay. También cancela su reintento. */
  function abortInFlight(): void {
    if (!controller) return
    controller.abort()
    controller = null
  }

  function fire(): void {
    if (stopped || opts.isHidden()) return
    // Sin solapamiento: si el anterior sigue en vuelo, este tick se salta. La
    // cadencia la mantiene el intervalo, así que saltarse uno no desarma nada.
    if (controller) return

    const mine = new AbortController()
    controller = mine
    // El resultado no rearma ni reprograma NADA: por eso una respuesta tardía
    // —o el reintento tras renovar el JWT— no puede resucitar el latido con la
    // pestaña oculta.
    void Promise.resolve(opts.send(mine.signal))
      .catch(() => {})
      .finally(() => { if (controller === mine) controller = null })
  }

  function suspend(): void {
    disarm()
    abortInFlight()
    opts.onSuspend?.()
  }

  function resume(): void {
    if (stopped || opts.isHidden()) return
    opts.onResume?.()
    fire()      // inmediato
    arm()       // y un único intervalo
  }

  return {
    start() {
      if (stopped || started) return
      started = true
      // Si nace oculta no se late; el `visibilitychange` la reanudará.
      if (opts.isHidden()) return
      fire()
      arm()
    },
    handleVisibilityChange() {
      if (stopped) return
      if (opts.isHidden()) suspend()
      else resume()
    },
    stop() {
      if (stopped) return
      stopped = true
      disarm()
      abortInFlight()
    },
    isArmed() { return intervalId !== null },
    isInFlight() { return controller !== null },
  }
}
