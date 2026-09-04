// apps/native/shared/native-controller.ts
//
// Track 2 — Capstone del cliente nativo. Compone las piezas de C22/N2 en un único
// controlador usable por la app de plataforma (Tauri/Windows/Android/iOS):
//
//   coordinator (grant+decoder, latest-wins)  +  lifecycle-binder (hidden/visible/
//   pagehide → invalidate/dispose)  +  applyPlaybackDecision (decisión server →
//   coordinador).
//
// Cierra el lazo de N2a: el `onResume` del binder ahora RE-APLICA la última
// decisión del servidor (al volver a foreground se vuelve a abrir con el mismo
// contexto), en vez de dejar el gancho vacío. Es TS puro (sin DOM/Tauri): la
// plataforma cablea sus eventos a onHidden/onVisible/onPageHide/dispose.
//
// No cambia autoridad ni invariantes: la decisión la toma el servidor
// (decideLivePlayback); la reserva de cupo sigue en el stream-manager (C1–C21);
// aquí sólo se orquesta el lifecycle del cliente. Sólo corre si la app nativa lo
// usa (detrás de las flags nativas ya existentes).

import type { PlaybackCallbacks } from './playback'
import { NativeLifecycleBinder, type LifecycleControllable } from './lifecycle-binder'
import {
  applyPlaybackDecision,
  type AppliedDecision,
  type ApplyContext,
  type ApplyOutcome,
  type PlaybackCoordinatorLike,
} from './apply-decision'

/** El coordinador real (LivePlaybackCoordinator) satisface ambas superficies. */
export interface NativeControllerCoordinator extends PlaybackCoordinatorLike, LifecycleControllable {}

export interface NativeControllerOptions { log?: (m: string) => void }

export class NativePlaybackController {
  private readonly binder: NativeLifecycleBinder
  private last: { decision: AppliedDecision; ctx: ApplyContext } | null = null
  private disposed = false

  constructor(
    private readonly coordinator: NativeControllerCoordinator,
    opts: NativeControllerOptions = {},
  ) {
    this.binder = new NativeLifecycleBinder(coordinator, {
      log: opts.log,
      onResume: () => this.resume(),  // al volver a visible, re-aplica la última decisión
    })
  }

  get suspended(): boolean { return this.binder.isSuspended }
  get isDisposed(): boolean { return this.disposed }
  get lastDecision(): AppliedDecision | null { return this.last?.decision ?? null }

  /** Aplica una decisión del servidor y la recuerda (para el resume). */
  async show(decision: AppliedDecision, ctx: ApplyContext): Promise<ApplyOutcome> {
    if (this.disposed) return { mode: 'none', reason: 'unavailable' }
    this.last = { decision, ctx }
    return applyPlaybackDecision(decision, this.coordinator, ctx)
  }

  /** Re-aplica la última decisión (lo invoca el binder al volver a visible). */
  private async resume(): Promise<void> {
    if (this.disposed || !this.last) return
    await applyPlaybackDecision(this.last.decision, this.coordinator, this.last.ctx)
  }

  // ── Passthroughs de lifecycle (la plataforma cablea sus eventos aquí) ──
  onHidden(): Promise<void> { return this.binder.onHidden() }
  onVisible(): Promise<void> { return this.binder.onVisible() }
  onPageHide(persisted = false): Promise<void> { return this.binder.onPageHide(persisted) }

  /** Desmontaje definitivo (idempotente): dispone el coordinador y olvida el estado. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.last = null
    await this.binder.onTeardown()
  }
}

// Reexport para la app: un único punto de entrada de tipos del cliente.
export type { AppliedDecision, ApplyContext, ApplyOutcome, PlaybackCallbacks }
