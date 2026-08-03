// apps/api/src/services/recordings/nvr-playback-admission.ts
//
// Control de ADMISIÓN de reproducción histórica POR NVR.
//
// Los NVR limitan cuántas sesiones RTSP de playback conceden a la vez; al
// excederlo responden "RTSP/1.0 453 Not Enough Bandwidth". El límite es del
// DISPOSITIVO, no de la cámara ni de VisionCore. Este controlador no intenta
// evadirlo: lo administra para evitar errores al usuario, tormentas de
// reintentos y procesos FFmpeg innecesarios.
//
// NO hardcodea ningún NVR ni nombre de cámara: todo sale de la configuración o
// del comportamiento observado.
//
// Un LEASE representa una sesión RTSP real de playback contra ese NVR. No debe
// confundirse con la sesión de UI, la sesión de API ni el proceso FFmpeg: el
// lease se toma antes de abrir el RTSP y se libera SÓLO cuando el proceso ya no
// puede emitir bytes (salió y fue recolectado).
//
// Lógica PURA: sin Fastify, sin Prisma, sin FFmpeg. El reloj es inyectable.

export interface AdmissionRequest {
  nvrId: string
  sessionId: string
  userId: string
  cameraId: string
  cameraName?: string | null
  slotIndex: number
  requestedAt?: number
}

export interface PlaybackLease {
  nvrId: string
  sessionId: string
  userId: string
  cameraId: string
  cameraName: string | null
  slotIndex: number
  acquiredAt: number
  firstByteAt: number | null
  pid: number | null
  processAlive: boolean
}

export interface QueuedRequest {
  nvrId: string
  sessionId: string
  userId: string
  cameraId: string
  cameraName: string | null
  slotIndex: number
  queuedAt: number
}

export interface AdmissionDecision {
  granted: boolean
  queued: boolean
  /** Posición 1-based en la cola (sólo si queued). */
  position: number | null
  activeCount: number
  queuedCount: number
  configuredLimit: number | null
  effectiveLimit: number
  /** Estimación grosera de espera, en segundos (sólo si queued). */
  estimatedRetryAfterSec: number | null
}

export interface NvrCapacitySnapshot {
  nvrId: string
  configuredLimit: number | null
  effectiveLimit: number
  activeCount: number
  queuedCount: number
  last453At: number | null
  cooldownUntil: number | null
  temporaryCapacityReduction: boolean
  active: Array<{
    sessionId: string
    cameraId: string
    cameraName: string | null
    userId: string
    slotIndex: number
    pid: number | null
    processAlive: boolean
    acquiredAt: number
    firstByteAt: number | null
  }>
  queue: Array<{
    sessionId: string
    cameraId: string
    cameraName: string | null
    userId: string
    position: number
    queuedAt: number
  }>
}

export interface AdmissionControllerOptions {
  /** Reloj inyectable (tests deterministas). */
  now?: () => number
  /** Límite por defecto cuando no hay configuración por NVR ni global. */
  safeDefaultLimit?: number
  /** Cuánto dura la reducción temporal de capacidad tras un 453. */
  cooldownMs?: number
  /** Estimación de duración media de un lease, para estimatedRetryAfterSec. */
  averageLeaseMs?: number
}

/** Valor seguro cuando no hay nada configurado: 1 sesión por NVR. */
export const SAFE_DEFAULT_LIMIT = 1
/** Cooldown por defecto de la reducción temporal tras un 453. */
export const DEFAULT_CAPACITY_COOLDOWN_MS = 2 * 60 * 1000
/** Estimación por defecto de duración de un lease (para retry-after). */
export const DEFAULT_AVERAGE_LEASE_MS = 30_000

interface NvrState {
  configuredLimit: number | null
  leases: Map<string, PlaybackLease>
  queue: QueuedRequest[]
  last453At: number | null
  cooldownUntil: number | null
  /** Límite reducido temporalmente por un 453 (null = sin reducción). */
  reducedLimit: number | null
}

/**
 * Controlador ÚNICO de admisión de reproducción por NVR.
 *
 * Precedencia del límite:
 *   nvr.maxConcurrentPlaybackSessions → default global → valor seguro (1)
 * Modo AUTO (configuredLimit === null): parte del default global y se ajusta a
 * la baja SÓLO de forma temporal cuando el NVR responde 453, nunca de forma
 * permanente por un fallo puntual.
 */
export class NvrPlaybackAdmissionController {
  private readonly states = new Map<string, NvrState>()
  private globalDefaultLimit: number | null = null
  private readonly now: () => number
  private readonly safeDefaultLimit: number
  private readonly cooldownMs: number
  private readonly averageLeaseMs: number

  constructor(opts: AdmissionControllerOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.safeDefaultLimit = Math.max(1, opts.safeDefaultLimit ?? SAFE_DEFAULT_LIMIT)
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? DEFAULT_CAPACITY_COOLDOWN_MS)
    this.averageLeaseMs = Math.max(1_000, opts.averageLeaseMs ?? DEFAULT_AVERAGE_LEASE_MS)
  }

  // ─── Configuración ─────────────────────────────────────────────────────────

  /** Default global (RecordingsSettings.recordingsDefaultMaxConcurrentPerNvr). */
  setGlobalDefaultLimit(limit: number | null): void {
    this.globalDefaultLimit = normalizeLimit(limit)
  }

  /** Límite configurado en el NVR (null = auto/heredar). */
  configureNvr(nvrId: string, configuredLimit: number | null): void {
    const st = this.stateOf(nvrId)
    st.configuredLimit = normalizeLimit(configuredLimit)
  }

  /** Límite efectivo actual, aplicando la reducción temporal vigente. */
  effectiveLimitFor(nvrId: string): number {
    const st = this.stateOf(nvrId)
    this.restoreCapacityIfElapsed(nvrId, st)
    const base = st.configuredLimit ?? this.globalDefaultLimit ?? this.safeDefaultLimit
    if (st.reducedLimit != null) return Math.max(1, Math.min(base, st.reducedLimit))
    return Math.max(1, base)
  }

  configuredLimitFor(nvrId: string): number | null {
    return this.stateOf(nvrId).configuredLimit
  }

  activeCount(nvrId: string): number { return this.stateOf(nvrId).leases.size }
  queuedCount(nvrId: string): number { return this.stateOf(nvrId).queue.length }

  // ─── Admisión ──────────────────────────────────────────────────────────────

  /**
   * Pide capacidad para una sesión. Si hay cupo concede el lease; si no, encola
   * la solicitud (FIFO) y devuelve la posición. Es idempotente por sessionId:
   * volver a pedir con la misma sesión no duplica lease ni entrada en cola.
   */
  acquire(req: AdmissionRequest): AdmissionDecision {
    const st = this.stateOf(req.nvrId)
    const now = req.requestedAt ?? this.now()
    this.restoreCapacityIfElapsed(req.nvrId, st)

    // Idempotencia: ya tiene lease.
    if (st.leases.has(req.sessionId)) return this.decision(req.nvrId, true, null)

    // Idempotencia: ya está en cola → devolver su posición actual.
    const existingIdx = st.queue.findIndex(q => q.sessionId === req.sessionId)
    if (existingIdx >= 0) return this.decision(req.nvrId, false, existingIdx + 1)

    const limit = this.effectiveLimitFor(req.nvrId)
    if (st.leases.size < limit) {
      st.leases.set(req.sessionId, {
        nvrId: req.nvrId,
        sessionId: req.sessionId,
        userId: req.userId,
        cameraId: req.cameraId,
        cameraName: req.cameraName ?? null,
        slotIndex: req.slotIndex,
        acquiredAt: now,
        firstByteAt: null,
        pid: null,
        processAlive: false,
      })
      return this.decision(req.nvrId, true, null)
    }

    st.queue.push({
      nvrId: req.nvrId,
      sessionId: req.sessionId,
      userId: req.userId,
      cameraId: req.cameraId,
      cameraName: req.cameraName ?? null,
      slotIndex: req.slotIndex,
      queuedAt: now,
    })
    return this.decision(req.nvrId, false, st.queue.length)
  }

  /**
   * Libera el lease de una sesión. IDEMPOTENTE: múltiples eventos
   * exit/close/error liberan una sola vez y promueven una sola vez.
   * Devuelve las solicitudes de cola que pasan a tener cupo.
   */
  release(args: { nvrId: string; sessionId: string; reason: string }): {
    released: boolean
    promoted: QueuedRequest[]
    durationMs: number | null
  } {
    const st = this.stateOf(args.nvrId)
    const lease = st.leases.get(args.sessionId)
    if (!lease) {
      // Puede ser una sesión que estaba en cola: quitarla sin promover.
      const removed = this.removeFromQueue(st, args.sessionId)
      return { released: removed, promoted: [], durationMs: null }
    }
    st.leases.delete(args.sessionId)
    const durationMs = this.now() - lease.acquiredAt
    return { released: true, promoted: this.promote(args.nvrId, st), durationMs }
  }

  /** Quita una solicitud de la cola (cancelación explícita del usuario). */
  cancelQueued(args: { nvrId: string; sessionId: string; reason: string }): boolean {
    return this.removeFromQueue(this.stateOf(args.nvrId), args.sessionId)
  }

  /**
   * Reporta un 453 del NVR. Aplica una reducción TEMPORAL de capacidad: el
   * límite efectivo baja, como máximo, a la cantidad de sesiones que ya estaban
   * reproduciendo correctamente (con primer byte). Nunca marca el NVR offline ni
   * aprende el límite de forma permanente.
   */
  report453(args: { nvrId: string; sessionId?: string; at?: number }): {
    effectiveLimit: number
    reduced: boolean
    cooldownUntil: number
  } {
    const st = this.stateOf(args.nvrId)
    const now = args.at ?? this.now()
    const before = this.effectiveLimitFor(args.nvrId)

    // Sesiones que YA estaban reproduciendo bien (excluyendo la que recibió 453).
    const healthy = [...st.leases.values()]
      .filter(l => l.firstByteAt != null && l.sessionId !== args.sessionId).length

    const target = Math.max(1, healthy)
    st.reducedLimit = st.reducedLimit == null ? target : Math.min(st.reducedLimit, target)
    st.last453At = now
    st.cooldownUntil = now + this.cooldownMs

    return {
      effectiveLimit: this.effectiveLimitFor(args.nvrId),
      reduced: this.effectiveLimitFor(args.nvrId) < before,
      cooldownUntil: st.cooldownUntil,
    }
  }

  /** Marca que esta sesión ya produjo su primer byte (reproduce de verdad). */
  markFirstByte(args: { nvrId: string; sessionId: string; at?: number }): void {
    const lease = this.stateOf(args.nvrId).leases.get(args.sessionId)
    if (lease && lease.firstByteAt == null) lease.firstByteAt = args.at ?? this.now()
  }

  /** Asocia el proceso FFmpeg al lease (diagnóstico). */
  attachProcess(args: { nvrId: string; sessionId: string; pid: number | null; alive: boolean }): void {
    const lease = this.stateOf(args.nvrId).leases.get(args.sessionId)
    if (!lease) return
    lease.pid = args.pid
    lease.processAlive = args.alive
  }

  hasLease(nvrId: string, sessionId: string): boolean {
    return this.stateOf(nvrId).leases.has(sessionId)
  }

  isQueued(nvrId: string, sessionId: string): boolean {
    return this.stateOf(nvrId).queue.some(q => q.sessionId === sessionId)
  }

  queuePositionOf(nvrId: string, sessionId: string): number | null {
    const idx = this.stateOf(nvrId).queue.findIndex(q => q.sessionId === sessionId)
    return idx >= 0 ? idx + 1 : null
  }

  // ─── Diagnóstico ───────────────────────────────────────────────────────────

  snapshot(nvrNames: Map<string, string> = new Map()): NvrCapacitySnapshot[] {
    const out: NvrCapacitySnapshot[] = []
    for (const [nvrId, st] of this.states) {
      this.restoreCapacityIfElapsed(nvrId, st)
      if (st.leases.size === 0 && st.queue.length === 0 && st.last453At == null) continue
      out.push({
        nvrId,
        configuredLimit: st.configuredLimit,
        effectiveLimit: this.effectiveLimitFor(nvrId),
        activeCount: st.leases.size,
        queuedCount: st.queue.length,
        last453At: st.last453At,
        cooldownUntil: st.cooldownUntil,
        temporaryCapacityReduction: st.reducedLimit != null,
        active: [...st.leases.values()].map(l => ({
          sessionId: l.sessionId,
          cameraId: l.cameraId,
          cameraName: l.cameraName ?? nvrNames.get(l.cameraId) ?? null,
          userId: l.userId,
          slotIndex: l.slotIndex,
          pid: l.pid,
          processAlive: l.processAlive,
          acquiredAt: l.acquiredAt,
          firstByteAt: l.firstByteAt,
        })),
        queue: st.queue.map((q, i) => ({
          sessionId: q.sessionId,
          cameraId: q.cameraId,
          cameraName: q.cameraName,
          userId: q.userId,
          position: i + 1,
          queuedAt: q.queuedAt,
        })),
      })
    }
    return out
  }

  /** Limpieza total (reinicio del API / shutdown): no deja estado falso. */
  resetAll(): void { this.states.clear() }

  // ─── Internos ──────────────────────────────────────────────────────────────

  private stateOf(nvrId: string): NvrState {
    let st = this.states.get(nvrId)
    if (!st) {
      st = { configuredLimit: null, leases: new Map(), queue: [], last453At: null, cooldownUntil: null, reducedLimit: null }
      this.states.set(nvrId, st)
    }
    return st
  }

  /** Restaura la capacidad cuando venció el cooldown (prueba controlada). */
  private restoreCapacityIfElapsed(nvrId: string, st: NvrState): void {
    if (st.reducedLimit == null || st.cooldownUntil == null) return
    if (this.now() < st.cooldownUntil) return
    st.reducedLimit = null
    st.cooldownUntil = null
  }

  /** Promueve de la cola mientras haya cupo. FIFO determinista. */
  private promote(nvrId: string, st: NvrState): QueuedRequest[] {
    const promoted: QueuedRequest[] = []
    const limit = this.effectiveLimitFor(nvrId)
    while (st.leases.size < limit && st.queue.length > 0) {
      const next = st.queue.shift()!
      st.leases.set(next.sessionId, {
        nvrId: next.nvrId,
        sessionId: next.sessionId,
        userId: next.userId,
        cameraId: next.cameraId,
        cameraName: next.cameraName,
        slotIndex: next.slotIndex,
        acquiredAt: this.now(),
        firstByteAt: null,
        pid: null,
        processAlive: false,
      })
      promoted.push(next)
    }
    return promoted
  }

  private removeFromQueue(st: NvrState, sessionId: string): boolean {
    const idx = st.queue.findIndex(q => q.sessionId === sessionId)
    if (idx < 0) return false
    st.queue.splice(idx, 1)
    return true
  }

  private decision(nvrId: string, granted: boolean, position: number | null): AdmissionDecision {
    const st = this.stateOf(nvrId)
    return {
      granted,
      queued: !granted,
      position,
      activeCount: st.leases.size,
      queuedCount: st.queue.length,
      configuredLimit: st.configuredLimit,
      effectiveLimit: this.effectiveLimitFor(nvrId),
      estimatedRetryAfterSec: granted || position == null
        ? null
        : Math.max(1, Math.ceil((position * this.averageLeaseMs) / 1000)),
    }
  }
}

function normalizeLimit(v: unknown): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(64, Math.floor(n))
}

/**
 * ¿Esta categoría de error indica que el NVR agotó su capacidad de playback?
 * Un 453 es una condición del DISPOSITIVO COMPLETO: cambiar la forma de la URI
 * dentro de la misma solicitud no tiene sentido, así que la cadena de variantes
 * debe detenerse de inmediato.
 */
export function isNvrCapacityCategory(category: string | null | undefined): boolean {
  return category === 'NVR_BANDWIDTH_OR_SESSION_LIMIT'
}

/** ¿El texto de stderr revela un 453 / falta de ancho de banda del NVR? */
export function stderrIndicates453(text: string | null | undefined): boolean {
  if (!text) return false
  return /\b453\b|not enough bandwidth/i.test(text)
}
