// apps/api/src/services/media/native-readiness.ts
//
// Readiness UNIFICADA del relay nativo y predicado RBAC compartido (C22.2, P0-5).
// Negociación (/client-capabilities) y emisión (/media-grant) DEBEN usar el mismo
// juicio: no basta `!!server.redis`. Si el usuario no puede obtener el grant
// elegido, la negociación no puede devolver una decisión nativa.

export interface ReadinessSignals {
  playbackEnabled: boolean   // NATIVE_PLAYBACK_ENABLED
  relayEnabled: boolean      // NATIVE_MEDIA_RELAY_ENABLED
  secretPresent: boolean     // MEDIA_RELAY_SECRET !== ''
  storeAtomic: boolean       // crossProcessAtomic (Redis)
  backendHealthy: boolean    // store.healthy() (Redis operativo)
  transportOffered: boolean  // el cliente ofrece rtsps/whep
}

export type ReadinessReason =
  | 'PLAYBACK_DISABLED' | 'RELAY_DISABLED' | 'SECRET_MISSING'
  | 'STORE_NOT_ATOMIC' | 'BACKEND_UNHEALTHY' | 'NO_NATIVE_TRANSPORT'

export interface ReadinessResult { ready: boolean; reasons: ReadinessReason[] }

export function evaluateReadiness(s: ReadinessSignals): ReadinessResult {
  const reasons: ReadinessReason[] = []
  if (!s.playbackEnabled) reasons.push('PLAYBACK_DISABLED')
  if (!s.relayEnabled) reasons.push('RELAY_DISABLED')
  if (!s.secretPresent) reasons.push('SECRET_MISSING')
  if (!s.storeAtomic) reasons.push('STORE_NOT_ATOMIC')
  if (!s.backendHealthy) reasons.push('BACKEND_UNHEALTHY')
  if (!s.transportOffered) reasons.push('NO_NATIVE_TRANSPORT')
  return { ready: reasons.length === 0, reasons }
}

export interface NativeReadinessConfig {
  playbackEnabled: boolean
  relayEnabled: boolean
  secretPresent: boolean
  storeAtomic: boolean
  /** Comprobación viva del backend (Redis ping). */
  checkHealth: () => Promise<boolean>
}

/**
 * Servicio de readiness que DEGRADA al fallar el backend y sólo se RECUPERA tras
 * una comprobación de salud exitosa. Comparte estado entre negociación y emisión.
 */
export class NativeRelayReadiness {
  private lastHealthy = false
  constructor(private readonly cfg: NativeReadinessConfig) {}

  async evaluate(transportOffered: boolean): Promise<ReadinessResult> {
    let healthy = false
    try { healthy = await this.cfg.checkHealth() } catch { healthy = false }
    this.lastHealthy = healthy
    return evaluateReadiness({
      playbackEnabled: this.cfg.playbackEnabled,
      relayEnabled: this.cfg.relayEnabled,
      secretPresent: this.cfg.secretPresent,
      storeAtomic: this.cfg.storeAtomic,
      backendHealthy: healthy,
      transportOffered,
    })
  }

  /** Último estado de salud observado (para diagnóstico). */
  get healthySnapshot(): boolean { return this.lastHealthy }
}

// ─── RBAC compartido por negociación e emisión ──────────────────────
export interface MediaAccessInput {
  role: string
  effectiveType: 'sub' | 'main'
  /** Permiso del usuario para la cámara (null si no tiene fila). */
  perm: { canView: boolean; canHighQuality: boolean } | null
}

export function hasMediaAccess(i: MediaAccessInput): boolean {
  if (i.role === 'ADMIN' || i.role === 'SUPERVISOR') return true
  if (!i.perm || i.perm.canView !== true) return false
  if (i.effectiveType === 'main') return i.perm.canHighQuality === true
  return true
}

export type AccessDenial = 'NONE' | 'NO_LIVE_VIEW' | 'NO_HD'

export function accessDenialReason(i: MediaAccessInput): AccessDenial {
  if (i.role === 'ADMIN' || i.role === 'SUPERVISOR') return 'NONE'
  if (!i.perm || i.perm.canView !== true) return 'NO_LIVE_VIEW'
  if (i.effectiveType === 'main' && i.perm.canHighQuality !== true) return 'NO_HD'
  return 'NONE'
}

/** Deriva el tipo efectivo server-side desde el códec real de la cámara. */
export function deriveEffectiveType(mainCodec: string | null | undefined): 'sub' | 'main' {
  return /hevc|h\.?265|hvc1/i.test(mainCodec ?? '') ? 'main' : 'sub'
}
