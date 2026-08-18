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

/**
 * Resultado de una ejecución puntual. `runNow` NUNCA lanza: quien la llama
 * decide qué hacer con cada desenlace, y "oculta", "ocupada" o "abortada" son
 * desenlaces normales, no errores.
 */
export type HeartbeatOutcome<T> =
  | { status: 'ok'; result: T }
  /** La pestaña está oculta: no se envió nada. */
  | { status: 'hidden' }
  /**
   * Ya había un heartbeat en vuelo y quien llamó NO quiso unirse a él.
   * Con `runNow` no se devuelve nunca: ahí se comparte el resultado, porque
   * perder el trabajo de quien llamó era el defecto de la revisión de #157.
   */
  | { status: 'busy' }
  /** Se abortó por ocultarse o detenerse mientras viajaba. */
  | { status: 'aborted' }
  | { status: 'error'; error: unknown }

export interface HeartbeatSchedulerOptions<T = unknown> {
  /** Cadencia del latido periódico, en ms. */
  intervalMs: number
  /** Estado de visibilidad. Se consulta en cada decisión, nunca se cachea. */
  isHidden: () => boolean
  /**
   * Envío real. Recibe la señal del ciclo actual: si la pestaña se oculta
   * mientras está en vuelo, la señal se aborta.
   */
  send: (signal: AbortSignal) => Promise<T>
  /**
   * Se invoca UNA VEZ por solicitud realmente enviada y exitosa, sea cual sea
   * la ruta que la originó. Es el único punto donde se aplica la respuesta.
   *
   * Antes sólo corría para la cadencia y `runNow` devolvía el resultado para
   * que el llamador lo aplicara. Con la unión al heartbeat en curso eso ya no
   * sirve: dos rutas comparten una misma respuesta y la aplicarían dos veces,
   * duplicando remontes. Ahora aplica el dueño de la solicitud, y quien se une
   * sólo lee el resultado para decidir SUS efectos (qué players remontar).
   */
  onResult?: (result: T) => void
  /** Diagnóstico opcional (logs de la página). */
  onSuspend?: () => void
  onResume?: () => void
  timers?: HeartbeatTimers
}

export interface HeartbeatScheduler<T = unknown> {
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
  /**
   * Ejecuta un heartbeat FUERA de la cadencia (reconciliación puntual), por el
   * mismo camino cancelable y con el mismo cerrojo de "uno a la vez".
   *
   * Existe para que ninguna ruta de la página tenga que hablar con la API por
   * su cuenta: ésa fue exactamente la grieta por la que `flushHlsExpiry` seguía
   * latiendo con la pestaña oculta.
   */
  runNow(): Promise<HeartbeatOutcome<T>>
}

const defaultTimers: HeartbeatTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
}

export function createHeartbeatScheduler<T = unknown>(
  opts: HeartbeatSchedulerOptions<T>,
): HeartbeatScheduler<T> {
  const timers = opts.timers ?? defaultTimers

  let started = false
  let stopped = false
  let intervalId: any = null
  let controller: AbortController | null = null
  /**
   * Promesa de la solicitud en vuelo. Quien llegue mientras haya una se UNE a
   * ella en vez de perder su trabajo: misma respuesta, una sola solicitud.
   */
  let inFlight: Promise<HeartbeatOutcome<T>> | null = null

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
    // El hueco queda libre de inmediato. Si no, al volver a visible el latido
    // de regreso se encontraría con una solicitud "en vuelo" que ya está
    // abortada y se saltaría el turno: no habría heartbeat inmediato.
    // Quien se haya unido a esa promesa sigue recibiendo su `aborted`.
    inFlight = null
  }

  /**
   * Única puerta de salida hacia la API. Todo —el tick periódico, el latido de
   * regreso y las reconciliaciones puntuales— pasa por acá, así que la guarda
   * de visibilidad, el cerrojo de "uno a la vez" y la señal de cancelación se
   * aplican por igual y no pueden divergir.
   */
  async function execute(): Promise<HeartbeatOutcome<T>> {
    const mine = new AbortController()
    controller = mine
    try {
      const result = await opts.send(mine.signal)
      // La pestaña pudo ocultarse mientras la solicitud viajaba: el resultado
      // ya no describe lo que el usuario ve, y aplicarlo reviviría sesiones.
      if (mine.signal.aborted || opts.isHidden()) return { status: 'aborted' }
      // Punto ÚNICO de aplicación: una solicitud, una aplicación, sin importar
      // cuántas rutas compartan su resultado.
      opts.onResult?.(result)
      return { status: 'ok', result }
    } catch (error) {
      if (mine.signal.aborted) return { status: 'aborted' }
      return { status: 'error', error }
    } finally {
      // El resultado no rearma ni reprograma NADA: por eso una respuesta tardía
      // —o el reintento tras renovar el JWT— no puede resucitar el latido con
      // la pestaña oculta.
      if (controller === mine) controller = null
    }
  }

  /**
   * Única puerta de salida hacia la API.
   *
   * `join` decide qué pasa si ya hay una solicitud en vuelo: la cadencia se
   * salta el turno (`busy`, porque el intervalo ya traerá el siguiente), y una
   * reconciliación puntual se UNE a la que está viajando. Sin esa unión, un
   * `busy` perdía las cámaras que esperaban recuperación y el player se quedaba
   * cargando para siempre (revisión de #157).
   */
  function run(join: boolean): Promise<HeartbeatOutcome<T>> {
    if (stopped || opts.isHidden()) return Promise.resolve({ status: 'hidden' as const })
    if (inFlight) {
      return join ? inFlight : Promise.resolve({ status: 'busy' as const })
    }
    const promesa = execute().finally(() => { if (inFlight === promesa) inFlight = null })
    inFlight = promesa
    return promesa
  }

  function fire(): void {
    void run(false)
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
    runNow() { return run(true) },
  }
}
