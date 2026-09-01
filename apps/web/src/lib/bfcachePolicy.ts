// Política COHERENTE de `pagehide`/`pageshow` frente al back-forward cache.
//
// EL DEFECTO QUE CORRIGE
//
// Antes se hacía `suspend` en `pagehide.persisted` (parada PARCIAL: no detenía el
// scheduler adoptado de LiveView ni su `viewportWork`) y luego `reload` en
// `pageshow.persisted`. Un híbrido incoherente: la maquinaria adoptada seguía
// viva en el bfcache y una respuesta tardía podía aplicar estado.
//
// LA POLÍTICA ELEGIDA: FORZAR RECARGA.
//
//   · Cualquier `pagehide` (real o persistido) ABANDONA el lifecycle por completo
//     —`ctrl.disposeView()`: ejecuta los hooks de dispose (detiene el scheduler
//     adoptado e invalida `viewportWork`), invalida el scope, aborta lo en vuelo,
//     cancela timers, detiene heartbeat/retry y cierra el `viewId` con keepalive—.
//     Una respuesta tardía ya no puede registrar ni aplicar nada.
//   · `pageshow` PERSISTIDO (vuelve del bfcache): se fuerza una RECARGA LIMPIA,
//     que crea un scope/heartbeat/viewId nuevos y reconcilia. Nunca se reanuda un
//     lifecycle viejo, así que el `viewId` nuevo no coexiste con sesiones del
//     anterior (ya cerradas en el `pagehide`).
//   · `pageshow` NO persistido (carga normal): nada que hacer.
//
// El `pagehide` no ramifica por `persisted` —siempre abandona—; la única decisión
// que depende de `persisted` es la recarga en `pageshow`. Es pura y se prueba sin
// DOM; el adaptador real (que `disposeView` detiene la maquinaria adoptada) se
// prueba contra el controlador.

export type PageShowAction = 'reload' | 'ignore'

/**
 * Al mostrar la página de nuevo: si vuelve del bfcache (`persisted`), recarga
 * limpio; si es una carga normal, nada.
 */
export function pageShowAction(persisted: boolean): PageShowAction {
  return persisted ? 'reload' : 'ignore'
}
