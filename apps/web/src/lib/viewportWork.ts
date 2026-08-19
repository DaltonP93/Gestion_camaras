// Trabajo transitorio del viewport de vista en vivo, con generación.
//
// POR QUÉ EXISTE
//
// #158 afirmaba que al cambiar de NVR se limpiaban temporizador, cola,
// pendientes y foco, pero esa limpieza vivía SÓLO en el cleanup del efecto del
// programador. Cambiar de NVR, de página, de layout o navegar por
// `camera_query` no desmonta `LiveViewPage`: el efecto no se vuelve a ejecutar
// y nada de eso se limpiaba. El test que lo "verificaba" era estructural —
// comprobaba que el archivo contuviera `pendingExpiry.current.clear()`, no que
// se ejecutara en el cambio— así que daba verde igual.
//
// Y había una segunda mitad: un heartbeat de la vista anterior podía seguir en
// vuelo durante el cambio, aplicar su respuesta sobre el viewport nuevo, ser
// compartido por el `runNow` del nuevo, o reinsertar expiraciones viejas
// DESPUÉS de la limpieza.
//
// Este módulo es dueño de todo ese estado y ofrece UNA operación —`invalidate`—
// que lo tira entero y avanza la generación. Cada trabajo en curso captura su
// generación al empezar y la comprueba al terminar: si cambió, no aplica nada.
// Limpiar sin generación no alcanza, porque lo que ya estaba viajando vuelve
// después de la limpieza.

export interface ViewportWorkTimers {
  clearTimeout: (id: any) => void
}

export interface ViewportWorkOptions {
  /**
   * Cancela la solicitud de heartbeat en vuelo SIN detener el programador: al
   * cambiar de NVR se invalida el trabajo anterior, pero el viewport nuevo
   * tiene que poder reconciliar de inmediato.
   */
  cancelInFlightHeartbeat?: () => void
  timers?: ViewportWorkTimers
  onInvalidate?: (info: { epoch: number; reason: string }) => void
}

export interface ViewportWork {
  /** Generación actual. Cada trabajo la captura al empezar. */
  epoch(): number
  /** ¿La generación capturada sigue siendo la vigente? */
  isCurrent(epoch: number): boolean

  /** Cola de expiraciones HLS a punto de reconciliarse. */
  enqueueExpiry(cameraId: string): void
  queueSize(): number
  /** Vacía la cola y devuelve su contenido. */
  takeExpiryQueue(): string[]

  /** Expiraciones diferidas: pestaña oculta o desenlaces sin recuperación. */
  addPending(cameraIds: readonly string[]): void
  pendingSize(): number
  /** Vacía el conjunto pendiente y devuelve su contenido, deduplicado. */
  takePending(): string[]

  setPendingFocus(cameraId: string | null): void
  pendingFocus(): string | null
  takePendingFocus(): string | null

  /** Marcas de enfriamiento por cámara. Se pasa tal cual a la reconciliación. */
  readonly lastRestartAt: Record<string, number>

  /** Temporizador del vaciado coalescido (2 s). Uno solo a la vez. */
  setExpiryTimer(id: any): void
  hasExpiryTimer(): boolean
  clearExpiryTimer(): void

  /** Cualquier otro temporizador del viewport: fallback de 500 ms, stagger. */
  trackTimer(id: any): void
  trackedTimers(): number

  /**
   * Tira TODO el trabajo transitorio y avanza la generación. Idempotente y
   * segura de llamar varias veces.
   */
  invalidate(reason: string): void
}

const defaultTimers: ViewportWorkTimers = {
  clearTimeout: (id) => clearTimeout(id),
}

export function createViewportWork(opts: ViewportWorkOptions = {}): ViewportWork {
  const timers = opts.timers ?? defaultTimers

  let epoch = 0
  const queue = new Set<string>()
  const pending = new Set<string>()
  let focus: string | null = null
  let expiryTimer: any = null
  let tracked: any[] = []
  const lastRestartAt: Record<string, number> = {}

  function clearExpiryTimer(): void {
    if (expiryTimer === null) return
    timers.clearTimeout(expiryTimer)
    expiryTimer = null
  }

  return {
    epoch: () => epoch,
    isCurrent: (e) => e === epoch,

    enqueueExpiry(cameraId) { queue.add(cameraId) },
    queueSize: () => queue.size,
    takeExpiryQueue() {
      const out = Array.from(queue)
      queue.clear()
      return out
    },

    addPending(cameraIds) { cameraIds.forEach(id => pending.add(id)) },
    pendingSize: () => pending.size,
    takePending() {
      const out = Array.from(pending)
      pending.clear()
      return out
    },

    setPendingFocus(cameraId) { focus = cameraId },
    pendingFocus: () => focus,
    takePendingFocus() {
      const out = focus
      focus = null
      return out
    },

    lastRestartAt,

    setExpiryTimer(id) {
      // Uno solo: si hubiera otro, el anterior quedaría huérfano.
      clearExpiryTimer()
      expiryTimer = id
    },
    hasExpiryTimer: () => expiryTimer !== null,
    clearExpiryTimer,

    trackTimer(id) { tracked.push(id) },
    trackedTimers: () => tracked.length,

    invalidate(reason) {
      epoch++
      clearExpiryTimer()
      queue.clear()
      pending.clear()
      focus = null
      tracked.forEach(id => timers.clearTimeout(id))
      tracked = []
      // El enfriamiento pertenece al viewport anterior: conservarlo dejaría
      // cámaras del NVR nuevo bloqueadas 30 s por un intento que nunca las
      // tocó, y al volver al NVR anterior tampoco debe haber falsos cooldowns.
      Object.keys(lastRestartAt).forEach(k => { delete lastRestartAt[k] })
      // Lo que ya está viajando se cancela acá; lo que resuelva igual quedará
      // descartado por la comprobación de generación.
      opts.cancelInFlightHeartbeat?.()
      opts.onInvalidate?.({ epoch, reason })
    },
  }
}
