// apps/api/src/services/media/session-policy.ts
//
// N2d — Política de sesión de medios única por usuario (multi-dispositivo). Al
// emitir un grant para una sesión nueva, revoca los grants de la sesión previa
// del MISMO usuario (un login/stream en el dispositivo B corta el del A).
//
// Usa revocación por ÍNDICE de sesión (markRevoked → REVOKED en validateAndClaim),
// NO el epoch por usuario: el epoch revocaría TODAS las sesiones (incluida la
// nueva); aquí sólo se corta la OTRA. La revocación en sí es durable (índice
// Redis en prod). Detrás de SINGLE_ACTIVE_MEDIA_SESSION (OFF por defecto): con la
// flag apagada, register es un no-op sin efectos ⇒ idéntico a C22.2.
//
// HONESTIDAD: el mapa "usuario→sesión activa" es EN-PROCESO. En un despliegue
// multi-worker cada worker ve su propio mapa, así que la detección de "sesión
// previa" es best-effort por proceso (la forma durable guardaría la sesión activa
// en Redis). La revocación disparada sí es cross-process (índice compartido).

export interface SessionRevoker {
  revokeBySession(sessionId: string, byUserId?: string): Promise<number>
}

export class SingleActiveSessionPolicy {
  private readonly active = new Map<string, string>()  // userId → sessionId vigente

  constructor(
    private readonly revoker: SessionRevoker,
    private readonly enabled: boolean,
  ) {}

  isEnabled(): boolean { return this.enabled }
  activeSession(userId: string): string | null { return this.active.get(userId) ?? null }

  /**
   * Marca `sessionId` como la sesión activa del usuario. Si había otra distinta,
   * revoca sus grants y devuelve cuántos se revocaron. No-op si está deshabilitada.
   */
  async register(userId: string, sessionId: string): Promise<{ revokedPrior: number }> {
    if (!this.enabled) return { revokedPrior: 0 }
    const prior = this.active.get(userId)
    this.active.set(userId, sessionId)
    if (prior && prior !== sessionId) {
      const revokedPrior = await this.revoker.revokeBySession(prior, userId)
      return { revokedPrior }
    }
    return { revokedPrior: 0 }
  }

  /** Olvida la sesión (logout de ese dispositivo) si es la activa. */
  forget(userId: string, sessionId: string): void {
    if (this.active.get(userId) === sessionId) this.active.delete(userId)
  }
}
