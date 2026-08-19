// Arranques diferidos del viewport (reinicio manual, reintento de grid,
// fallback a main_h264, escalonado del grid).
//
// POR QUÉ EXISTE
//
// Cada uno de esos cuatro caminos hacía su propio `setTimeout` suelto. Ninguno
// se registraba en ningún lado, así que la invalidación del viewport no podía
// cancelarlos, y ninguno comprobaba nada al dispararse: 3 s después de cambiar
// de NVR seguía arrancando una cámara que ya no estaba en pantalla — un FFmpeg
// nuevo sin espectador, justo lo contrario de lo que buscaba el cambio.
//
// Acá el temporizador se registra al programarse y, al vencer, comprueba DOS
// cosas antes de arrancar nada: que la pestaña siga visible y que el viewport
// siga siendo el mismo. Las dos, porque cancelar no alcanza —un temporizador ya
// en vuelo hacia su callback no se puede cancelar— ni comprobar alcanza tampoco
// —dejar vivos temporizadores de 3 s de viewports viejos es basura acumulada—.

export interface DeferredStartTimers {
  setTimeout: (fn: () => void, ms: number) => any
}

export interface DeferredStartOptions {
  /** Sólo para el log. */
  cameraId: string
  reason: string
  delayMs: number
  /** El viewport sigue siendo aquél en el que se programó el arranque. */
  isCurrent: () => boolean
  /** Con la pestaña oculta no se arranca nada: no hay espectador. */
  isHidden: () => boolean
  /** Registra el temporizador para que la invalidación pueda cancelarlo. */
  track: (id: any) => void
  start: () => void
  onDiscard?: (info: { cameraId: string; reason: string; cause: string }) => void
  timers?: DeferredStartTimers
}

const defaultTimers: DeferredStartTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
}

export function scheduleDeferredStart(opts: DeferredStartOptions): void {
  const timers = opts.timers ?? defaultTimers
  const id = timers.setTimeout(() => {
    const cause = opts.isHidden() ? 'tab_hidden'
      : !opts.isCurrent() ? 'viewport_changed'
      : null
    if (cause) {
      opts.onDiscard?.({ cameraId: opts.cameraId, reason: opts.reason, cause })
      return
    }
    opts.start()
  }, opts.delayMs)
  opts.track(id)
}
