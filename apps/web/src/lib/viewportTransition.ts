// Transición de viewport, como transacción explícita.
//
// POR QUÉ EXISTE
//
// #159 invalidaba el trabajo transitorio al empezar el cambio, pero la
// transición NO era atómica: `stopAllSessions()` invalidaba y después esperaba
// a `stopSessions()`, con el intervalo del programador todavía armado y
// `filteredCamerasRef` conteniendo aún las cámaras anteriores. Si vencía un
// tick durante ese `await`, salía un heartbeat con los IDs del viewport viejo
// — y como la generación se guardaba en UNA ref mutable compartida, ya pisada
// con el valor nuevo, `onResult` lo aceptaba y competía con el cierre.
//
// El error de fondo fue usar una ref mutable como identidad de varias
// solicitudes. Acá cada transición emite un TOKEN inmutable y cada solicitud
// captura el suyo en una variable local; comparar tokens es lo único que
// decide si un resultado puede aplicarse.
//
// La transacción tiene tres tiempos:
//
//   begin   → generación nueva, viewport "en transición", cadencia suspendida,
//             vuelo abortado, timers y colas tirados.
//   cierre  → se esperan las sesiones anteriores. Nada puede salir a la red ni
//             tocar estado durante este tramo.
//   commit  → sólo el token más reciente publica el viewport nuevo; se espera a
//             que los IDs nuevos estén publicados, se rearma la cadencia y sale
//             EXACTAMENTE un heartbeat inmediato.
//
// Todo con dependencias inyectadas: la secuencia completa se ejecuta en las
// pruebas con promesas y temporizadores reales, sin DOM.

/** Identidad inmutable de una transición. Nunca una ref compartida. */
export interface TransitionToken {
  readonly id: number
}

export interface ViewportTransitionDeps<V> {
  /** Desarma el intervalo y aborta el heartbeat en vuelo. */
  suspendScheduler: () => void
  /** Rearma el intervalo. No debe latir por sí solo. */
  armScheduler: () => void
  /** El único latido inmediato del commit. */
  runHeartbeatNow: () => Promise<unknown>
  /** Tira colas, pendientes, foco, cooldowns y timers del viewport anterior. */
  invalidateWork: (reason: string) => void
  /** Cierra las sesiones del viewport que se abandona. */
  closeSessions: (reason: string) => Promise<void>
  /** Publica el viewport nuevo (NVR, página o layout). */
  publishViewport: (next: V) => void
  /**
   * Espera a que los IDs del viewport nuevo estén realmente publicados. En la
   * página es el ciclo de React; en las pruebas, una promesa controlada.
   */
  awaitPublished: () => Promise<void>
  /** Con la pestaña oculta el commit no late: el regreso lo hará. */
  isHidden: () => boolean
  onEvent?: (event: string) => void
}

export type TransitionResult = 'committed' | 'superseded' | 'hidden_no_beat'

export interface ViewportTransition<V> {
  /** ¿Hay una transición en curso? Mientras sea true, nada sale a la red. */
  isTransitioning(): boolean
  /** Token vigente. */
  current(): TransitionToken
  /** ¿Este token sigue siendo el más reciente? */
  isCurrent(token: TransitionToken): boolean
  /** Abre la transacción y devuelve su token. */
  begin(reason: string): TransitionToken
  /** Cierra la transacción. Sólo el token más reciente publica. */
  commit(token: TransitionToken, next: V): Promise<TransitionResult>
  /** Secuencia completa: begin → cierre → commit. */
  run(reason: string, next: V): Promise<TransitionResult>
}

export function createViewportTransition<V>(
  deps: ViewportTransitionDeps<V>,
): ViewportTransition<V> {
  let counter = 0
  let token: TransitionToken = { id: 0 }
  let transitioning = false

  const emit = (e: string) => deps.onEvent?.(e)

  function begin(reason: string): TransitionToken {
    counter++
    token = { id: counter }
    transitioning = true
    // El orden importa: primero se corta la cadencia y se aborta lo que viaja,
    // y sólo después se tira el estado. Al revés quedaría una ventana en la que
    // un tick podría repoblar lo recién limpiado.
    deps.suspendScheduler()
    deps.invalidateWork(reason)
    emit(`begin:${reason}:${token.id}`)
    return token
  }

  async function commit(t: TransitionToken, next: V): Promise<TransitionResult> {
    // Una transición anterior que termina tarde no puede publicar su viewport:
    // A→B→C con cierres resueltos al revés debe terminar en C, no en B.
    if (t.id !== token.id) { emit(`superseded:${t.id}`); return 'superseded' }

    deps.publishViewport(next)
    // Los IDs nuevos tienen que estar publicados ANTES de latir, o el heartbeat
    // saldría con los del viewport anterior — que es exactamente el defecto.
    await deps.awaitPublished()
    if (t.id !== token.id) { emit(`superseded_after_publish:${t.id}`); return 'superseded' }

    transitioning = false
    deps.armScheduler()

    if (deps.isHidden()) {
      // Ocultarse durante la transición no puede iniciar ni revivir nada; el
      // latido de regreso reconciliará.
      emit(`commit_hidden:${t.id}`)
      return 'hidden_no_beat'
    }
    emit(`commit:${t.id}`)
    await deps.runHeartbeatNow()
    return 'committed'
  }

  return {
    isTransitioning: () => transitioning,
    current: () => token,
    isCurrent: (t) => t.id === token.id,
    begin,
    commit,
    async run(reason, next) {
      const t = begin(reason)
      await deps.closeSessions(reason)
      // El cierre pudo tardar y otra transición pudo empezar mientras tanto.
      if (t.id !== token.id) { emit(`superseded_after_close:${t.id}`); return 'superseded' }
      return commit(t, next)
    },
  }
}
