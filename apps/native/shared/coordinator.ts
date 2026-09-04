// apps/native/shared/coordinator.ts
//
// Coordinador ÚNICO que posee conjuntamente el grant y el decoder (C22.1, P0-4).
// Evita que MediaGrantClient y LivePlaybackSession sean lifecycles separados:
//
//   - Generación monotónica desde la solicitud del grant hasta el decoder.
//   - LATEST-REQUEST-WINS: si llega una solicitud B mientras A está en vuelo, A
//     queda obsoleta; su grant tardío se REVOCA y no publica; B permanece.
//   - open(A) → open(B) libera el handle A (vía la sesión) antes de publicar B.
//   - No abre el decoder con un grant vencido.
//   - Revocación fallida NO se olvida: queda pendiente y se reintenta.
//   - dispose idempotente; callbacks de generaciones viejas descartados (sesión).

import type { GrantRequest, GrantTransport } from './grant-client'
import type { EphemeralMediaGrant, PlaybackCallbacks } from './playback'
import type { LivePlaybackSession } from './session-controller'

export interface CoordinatorOpenResult {
  published: boolean
  reason?: 'SUPERSEDED' | 'GRANT_DENIED' | 'GRANT_EXPIRED' | 'STALE' | 'ERROR'
}

export class LivePlaybackCoordinator {
  private seq = 0
  private active = 0
  private currentGrant: EphemeralMediaGrant | null = null
  private readonly pending = new Set<string>()

  constructor(
    private readonly transport: GrantTransport,
    private readonly session: LivePlaybackSession,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  pendingRevokes(): number { return this.pending.size }
  activeGrantId(): string | null { return this.currentGrant?.grantId ?? null }

  private async revoke(grantId: string): Promise<void> {
    try { await this.transport.revokeGrant(grantId); this.pending.delete(grantId) }
    catch { this.pending.add(grantId) }
  }

  async retryPendingRevokes(): Promise<number> {
    let ok = 0
    for (const id of [...this.pending]) {
      try { await this.transport.revokeGrant(id); this.pending.delete(id); ok++ } catch { /* sigue pendiente */ }
    }
    return ok
  }

  async open(req: GrantRequest, cb: PlaybackCallbacks): Promise<CoordinatorOpenResult> {
    const rid = ++this.seq
    this.active = rid

    // Revoca el grant previo (cambio de cámara/vista).
    if (this.currentGrant) { const prev = this.currentGrant; this.currentGrant = null; await this.revoke(prev.grantId) }

    const outcome = await this.transport.requestGrant(req)
    if (rid !== this.active) { // superado durante la adquisición
      if (outcome.ok) await this.revoke(outcome.grant.grantId)
      return { published: false, reason: 'SUPERSEDED' }
    }
    if (!outcome.ok) return { published: false, reason: 'GRANT_DENIED' }
    if (outcome.grant.expiresAt <= this.clock()) {
      await this.revoke(outcome.grant.grantId)
      return { published: false, reason: 'GRANT_EXPIRED' }
    }

    const res = await this.session.open(outcome.grant, cb)
    if (rid !== this.active) { // superado durante el open
      await this.revoke(outcome.grant.grantId)
      return { published: false, reason: 'SUPERSEDED' }
    }
    if (!res.published) {
      await this.revoke(outcome.grant.grantId)
      return { published: false, reason: res.reason }
    }
    this.currentGrant = outcome.grant
    return { published: true }
  }

  /** Cambio de viewport: invalida trabajo en vuelo, libera decoder y revoca grant. */
  async invalidate(): Promise<void> {
    this.active = ++this.seq
    await this.session.invalidate()
    if (this.currentGrant) { const g = this.currentGrant; this.currentGrant = null; await this.revoke(g.grantId) }
  }

  /** Desmontaje definitivo (idempotente). */
  async dispose(): Promise<void> {
    this.active = ++this.seq
    await this.session.dispose()
    if (this.currentGrant) { const g = this.currentGrant; this.currentGrant = null; await this.revoke(g.grantId) }
  }
}
