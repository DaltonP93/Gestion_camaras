// Operación de varios tramos que pertenece a UN viewport.
//
// POR QUÉ EXISTE
//
// La transacción de viewport arregló el tick durante el cierre, pero quedaron
// operaciones que empiezan antes de un `await` y siguen decidiendo después:
// el reinicio manual (POST y luego programar el arranque), la salida de foco
// (dos esperas y luego remontar y arrancar la grilla) y el manejo del límite de
// streams (liberar sesiones y luego reintentar).
//
// Todas compartían el mismo error: capturaban —o volvían a capturar— la
// identidad del viewport DESPUÉS del await. Con eso, una operación del NVR
// anterior terminaba adoptando el token del NVR nuevo y arrancaba cámaras que
// ya no estaban en pantalla. Capturar tarde equivale a no capturar.
//
// Acá la identidad se toma UNA vez, al abrir la operación, y cada tramo
// posterior se pregunta si sigue siendo vigente. `sleep` es la espera de la
// casa: no deja `new Promise(r => setTimeout(r))` sueltos, porque devuelve si
// la operación sobrevivió a la espera y quien la usa está obligado a mirarlo.

export interface GuardedOperationTimers {
  setTimeout: (fn: () => void, ms: number) => any
}

export interface GuardedOperation {
  /** ¿La operación sigue perteneciendo al viewport en el que nació? */
  isCurrent(): boolean
  /**
   * Espera `ms`. Devuelve `false` si el viewport cambió durante la espera:
   * quien llama tiene que abandonar, no continuar.
   */
  sleep(ms: number): Promise<boolean>
}

const defaultTimers: GuardedOperationTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
}

/**
 * Abre una operación sobre la vigencia dada. `isCurrent` tiene que estar ya
 * ligado al token capturado por quien abre — no puede leer el token vigente en
 * el momento de la comprobación, que es exactamente el defecto que evita.
 */
export function beginOperation(
  isCurrent: () => boolean,
  timers: GuardedOperationTimers = defaultTimers,
): GuardedOperation {
  return {
    isCurrent,
    sleep: (ms) => new Promise<boolean>(resolve => {
      timers.setTimeout(() => resolve(isCurrent()), ms)
    }),
  }
}
