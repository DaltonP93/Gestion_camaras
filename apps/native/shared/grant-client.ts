// apps/native/shared/grant-client.ts
//
// Cliente de grants para el shared-core. Obtiene, mantiene y revoca el grant
// efímero contra el API, sobre un transporte inyectado (fetch real en la app;
// mock en tests). Revoca SIEMPRE el grant anterior al cambiar de cámara/vista y
// al liberar — no deja grants vivos huérfanos.

import type { EphemeralMediaGrant } from './playback'

export interface GrantRequest {
  viewId: string
  cameraId: string
  transport: 'rtsps' | 'whep'
  codec: 'h264' | 'hevc'
  device: string
}

export type GrantOutcome =
  | { ok: true; grant: EphemeralMediaGrant }
  | { ok: false; status: number; code: string }

export interface GrantTransport {
  requestGrant(req: GrantRequest): Promise<GrantOutcome>
  revokeGrant(grantId: string): Promise<void>
}

export class MediaGrantClient {
  private current: EphemeralMediaGrant | null = null
  // P0-4/P0-1: una revocación fallida NO se olvida: queda pendiente y se reintenta.
  private readonly pending = new Set<string>()

  constructor(private readonly transport: GrantTransport) {}

  hasActive(): boolean { return this.current !== null }
  activeGrantId(): string | null { return this.current?.grantId ?? null }
  pendingRevokes(): number { return this.pending.size }

  /** Adquiere un grant. Si ya había uno activo, lo revoca antes. */
  async acquire(req: GrantRequest): Promise<GrantOutcome> {
    await this.release()
    const outcome = await this.transport.requestGrant(req)
    if (outcome.ok) this.current = outcome.grant
    return outcome
  }

  /** Revoca el grant activo (idempotente). Un fallo lo deja pendiente. */
  async release(): Promise<void> {
    const g = this.current
    if (!g) return
    this.current = null
    await this.revokeWithRetry(g.grantId)
  }

  /** Revoca un grant específico (p.ej. uno tardío superado). */
  async revokeGrantId(grantId: string): Promise<void> {
    await this.revokeWithRetry(grantId)
  }

  private async revokeWithRetry(grantId: string): Promise<void> {
    try {
      await this.transport.revokeGrant(grantId)
      this.pending.delete(grantId)
    } catch {
      this.pending.add(grantId) // no se olvida: se reintenta con retryPending()
    }
  }

  /** Reintenta las revocaciones pendientes; devuelve cuántas se completaron. */
  async retryPending(): Promise<number> {
    let ok = 0
    for (const id of [...this.pending]) {
      try { await this.transport.revokeGrant(id); this.pending.delete(id); ok++ } catch { /* sigue pendiente */ }
    }
    return ok
  }
}
