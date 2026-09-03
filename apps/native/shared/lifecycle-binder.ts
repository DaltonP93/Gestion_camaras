// apps/native/shared/lifecycle-binder.ts
//
// N2a — Auto-revocación por lifecycle del cliente. Cierra el hueco honesto de
// C22.2: existía el coordinador (invalidate/dispose) pero nada lo conducía desde
// los eventos reales de la app. Este binder mapea señales ABSTRACTAS de lifecycle
// a acciones del coordinador, sin depender del DOM/Tauri (la plataforma cablea
// visibilitychange/pagehide/eventos de ventana a estos métodos).
//
//   - onHidden  (background/pestaña oculta/pérdida de red): revoca el grant y
//     suelta el decoder (no dejar un stream autenticado vivo mientras no se ve).
//   - onVisible (foreground/visible): pide re-abrir (el app tiene el GrantRequest).
//   - onPageHide(persisted): bfcache ⇒ hidden; si no, desmontaje definitivo.
//   - onTeardown (logout/cierre): dispose idempotente; tras él todo es no-op.
//
// Idempotente por estado (suspended/disposed): no doble-invalida ni re-dispone.

/** Superficie mínima del coordinador que este binder necesita. */
export interface LifecycleControllable {
  invalidate(): Promise<void>
  dispose(): Promise<void>
}

export interface LifecycleBinderOptions {
  /** Al volver a visible tras una suspensión: el app re-abre (tiene el GrantRequest). */
  onResume?: () => void | Promise<void>
  log?: (m: string) => void
}

export class NativeLifecycleBinder {
  private suspended = false
  private disposed = false

  constructor(
    private readonly ctrl: LifecycleControllable,
    private readonly opts: LifecycleBinderOptions = {},
  ) {}

  get isSuspended(): boolean { return this.suspended }
  get isDisposed(): boolean { return this.disposed }

  /** Background / oculto / pérdida de red: revoca el grant y suelta el decoder. */
  async onHidden(): Promise<void> {
    if (this.disposed || this.suspended) return
    this.suspended = true
    this.opts.log?.('lifecycle_hidden -> invalidate')
    await this.ctrl.invalidate()
  }

  /** Foreground / visible: si estaba suspendido, pide re-abrir. */
  async onVisible(): Promise<void> {
    if (this.disposed || !this.suspended) return
    this.suspended = false
    this.opts.log?.('lifecycle_visible -> resume')
    await this.opts.onResume?.()
  }

  /** pagehide: persisted=true (bfcache) ⇒ como hidden; si no, desmontaje definitivo. */
  async onPageHide(persisted = false): Promise<void> {
    if (persisted) { await this.onHidden(); return }
    await this.onTeardown()
  }

  /** Desmontaje definitivo (logout/cierre). Idempotente. */
  async onTeardown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.opts.log?.('lifecycle_teardown -> dispose')
    await this.ctrl.dispose()
  }
}
