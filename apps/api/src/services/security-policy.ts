// Política de seguridad configurable (P0). Helpers PUROS + tipos compartidos.
//
// Antes: la política de contraseña estaba hardcodeada (mín. 8) y los ajustes de
// Seguridad de la UI NO se persistían (guardado falso de 600 ms). Este módulo fija
// los valores por defecto seguros y la lógica pura (validación de contraseña, poda
// de sesiones concurrentes, TTL del access token) que la ruta de auth aplica.

export interface SecuritySettingsShape {
  passwordMinLength: number
  requireStrongPassword: boolean
  sessionTimeoutMinutes: number
  maxSessions: number
  lockoutMaxAttempts: number
  lockoutDurationMinutes: number
  // Política MFA — se PERSISTE ahora; su enforcement llega en la fase siguiente.
  mfaRequired: boolean
  mfaGracePeriodLogins: number
}

// Valores por defecto seguros. Contraseña mínima REAL de 12 (requisito P0).
export const DEFAULT_SECURITY_SETTINGS: SecuritySettingsShape = {
  passwordMinLength: 12,
  requireStrongPassword: true,
  sessionTimeoutMinutes: 60,
  maxSessions: 5,
  lockoutMaxAttempts: 5,
  lockoutDurationMinutes: 15,
  mfaRequired: false,
  mfaGracePeriodLogins: 3,
}

// Límites de validación de los ajustes (para la ruta PUT).
export const SECURITY_LIMITS = {
  passwordMinLength: { min: 8, max: 128 },
  sessionTimeoutMinutes: { min: 5, max: 1440 },
  maxSessions: { min: 1, max: 50 },
  lockoutMaxAttempts: { min: 3, max: 20 },
  lockoutDurationMinutes: { min: 1, max: 1440 },
  mfaGracePeriodLogins: { min: 0, max: 20 },
}

export interface PasswordPolicyResult {
  valid: boolean
  errors: string[]
}

export interface PasswordPolicyOptions {
  minLength?: number
  requireStrong?: boolean
}

/**
 * Valida una contraseña contra la política. minLength por defecto 12; requireStrong
 * exige mayúscula, minúscula, dígito y carácter especial.
 */
export function evaluatePasswordPolicy(password: string, opts: PasswordPolicyOptions = {}): PasswordPolicyResult {
  const minLength = opts.minLength ?? DEFAULT_SECURITY_SETTINGS.passwordMinLength
  const requireStrong = opts.requireStrong ?? true
  const errors: string[] = []
  if (password.length < minLength) errors.push(`Mínimo ${minLength} caracteres`)
  if (requireStrong) {
    if (!/[A-Z]/.test(password))        errors.push('Al menos 1 letra mayúscula')
    if (!/[a-z]/.test(password))        errors.push('Al menos 1 letra minúscula')
    if (!/[0-9]/.test(password))        errors.push('Al menos 1 número')
    if (!/[^A-Za-z0-9]/.test(password)) errors.push('Al menos 1 carácter especial (!@#$%...)')
  }
  return { valid: errors.length === 0, errors }
}

export interface SessionLike {
  id: string
  lastUsedAt?: Date | string | null
  createdAt?: Date | string | null
}

/**
 * Poda de sesiones concurrentes: dado el conjunto ACTUAL de sesiones de un usuario
 * (incluida la recién creada) y el máximo permitido, devuelve los ids a revocar —
 * las MÁS ANTIGUAS por uso (lastUsedAt, con createdAt de respaldo). Si no se supera
 * el máximo, devuelve []. Determinista.
 */
export function sessionsToPrune(sessions: readonly SessionLike[], maxSessions: number): string[] {
  const max = Math.max(1, Math.floor(maxSessions))
  if (sessions.length <= max) return []
  const ts = (s: SessionLike) => {
    const v = s.lastUsedAt ?? s.createdAt
    const t = v ? new Date(v).getTime() : 0
    return Number.isFinite(t) ? t : 0
  }
  // Más recientes primero; conservar `max`, revocar el resto.
  const sorted = [...sessions].sort((a, b) => ts(b) - ts(a))
  return sorted.slice(max).map((s) => s.id)
}

// ─── Enforcement MFA (fase 4b) ────────────────────────────────

export type MfaGateAction =
  | 'none'      // sin 2FA y sin política: login normal
  | 'challenge' // el usuario tiene 2FA: pedir segundo factor
  | 'grace'     // política activa, sin 2FA, aún con inicios de gracia: permitir pero exigir enrolamiento
  | 'enroll'    // política activa, sin 2FA y gracia agotada: bloquear tokens normales hasta enrolar

export interface MfaGateInput {
  mfaRequired: boolean
  userHasMfa: boolean
  graceLoginsUsed: number
  gracePeriodLogins: number
}

export interface MfaGateDecision {
  action: MfaGateAction
  graceRemaining: number   // inicios de gracia que quedarán tras ESTE login (0 en 'enroll'/'challenge'/'none')
}

/**
 * Decide qué hacer en el login respecto al segundo factor. Puro y determinista.
 *
 * - Si el usuario ya tiene MFA → siempre 'challenge' (haya o no política).
 * - Si la política NO exige MFA y el usuario no lo tiene → 'none'.
 * - Si la política exige MFA y el usuario no lo tiene:
 *     · quedan inicios de gracia → 'grace' (se consumirá uno).
 *     · gracia agotada (o período 0) → 'enroll' (enrolamiento forzoso).
 */
export function decideMfaGate(input: MfaGateInput): MfaGateDecision {
  if (input.userHasMfa) return { action: 'challenge', graceRemaining: 0 }
  if (!input.mfaRequired) return { action: 'none', graceRemaining: 0 }
  const period = Math.max(0, Math.floor(input.gracePeriodLogins))
  const used = Math.max(0, Math.floor(input.graceLoginsUsed))
  if (used < period) {
    return { action: 'grace', graceRemaining: period - used - 1 }
  }
  return { action: 'enroll', graceRemaining: 0 }
}

/**
 * TTL del access token como CADENA de duración ("<minutos>m") a partir de los
 * minutos configurados, acotado a los límites. Se devuelve string (no número) a
 * propósito: `@fastify/jwt` v10 (fast-jwt) interpreta un `expiresIn` NUMÉRICO como
 * MILISEGUNDOS — un número en segundos haría expirar el token en ~ms (review Codex
 * #129 P1). Toda la base usa strings de duración; mantenemos esa convención.
 */
export function accessTokenTtl(sessionTimeoutMinutes: number): string {
  const m = Math.min(
    SECURITY_LIMITS.sessionTimeoutMinutes.max,
    Math.max(SECURITY_LIMITS.sessionTimeoutMinutes.min, Math.floor(sessionTimeoutMinutes) || DEFAULT_SECURITY_SETTINGS.sessionTimeoutMinutes),
  )
  return `${m}m`
}
