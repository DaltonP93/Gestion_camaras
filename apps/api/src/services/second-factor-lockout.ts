// apps/api/src/services/second-factor-lockout.ts
//
// C03 — Bloqueo por USUARIO ante fallos del 2.º factor y de la re-autenticación.
//
// Con trustProxy acotado (lib/trusted-proxy) los cupos de @fastify/rate-limit pasan
// a ser por CLIENTE. Detrás de nginx el cupo de /2fa/verify (10 cada 5 min) era, de
// hecho, un tope global que también frenaba la adivinación del TOTP; ahora quien ya
// tiene la contraseña sumaría 10 intentos por cada IP que controle (y el tempToken
// no se consume: MFA-04). El login por contraseña sí tiene bloqueo por cuenta; sin
// esto el 2.º factor quedaba más débil que el 1.º.
//
// Este contador vive en Redis por usuario (no por IP ni por tempToken) y lo usan
// todas las rutas que verifican un factor de un usuario ya identificado:
// /2fa/verify, /step-up (TOTP o contraseña), /2fa/disable y
// /2fa/backup-codes/regenerate. Al llegar a `lockoutMaxAttempts` fallos se bloquea
// la cuenta (`User.lockedUntil`) por `lockoutDurationMinutes`: los mismos ajustes y
// el mismo campo que el bloqueo del login (que entonces también rechaza el login).
//
// Orden, sin carreras:
//   1) cuenta bloqueada ⇒ se rechaza SIN contar ni verificar;
//   2) se RESERVA el intento (INCR + PEXPIRE atómicos) ANTES de verificar: en una
//      ráfaga paralela sólo `lockoutMaxAttempts` peticiones llegan a verificar un
//      código; el resto recibe ACCOUNT_LOCKED aunque la cuenta todavía no figure
//      bloqueada en la base;
//   3) acierto ⇒ se borra el contador; fallo que alcanza el máximo ⇒ `lockedUntil`.
// El contador NO se borra al bloquear (así una petición en vuelo no empieza un
// conteo nuevo): vence solo (TTL = duración del bloqueo desde el último intento
// verificado) o lo borra el desbloqueo del admin (POST /api/users/:id/unlock). El
// restablecimiento de contraseña limpia `lockedUntil` pero NO este contador, a
// propósito: quien controle el correo no reinicia los intentos de TOTP con cada reset.
//
// Fail-closed: si Redis no responde, la reserva lanza y la ruta responde 500 sin
// verificar el código. Borrar el contador tras un acierto es best-effort (no
// impide el login; el contador vence solo).

export interface SecondFactorRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  del(key: string): Promise<unknown>
}

export interface LockoutSettings {
  lockoutMaxAttempts: number
  lockoutDurationMinutes: number
}

const PREFIX = 'auth:2fa-fail:'
export const secondFactorFailKey = (userId: string): string => `${PREFIX}${userId}`

// SECOND_FACTOR_RESERVE: INCR + PEXPIRE en un solo paso (nunca queda un contador
// sin TTL si Redis falla entre ambos comandos). El TTL se renueva sólo con intentos
// que llegan a verificar (n ≤ máximo): los rechazados por agotamiento no estiran
// la vida del contador.
const RESERVE_SCRIPT = `-- SECOND_FACTOR_RESERVE
local n = redis.call('INCR', KEYS[1])
if n <= tonumber(ARGV[2]) then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`

export type SecondFactorAttempt =
  | { ok: false; minutesLeft: number }
  | {
      ok: true
      attempt: number
      /** Fallo verificado: true si este fallo bloqueó la cuenta. */
      fail(): Promise<{ locked: boolean; minutes: number }>
      /** Acierto: reinicia el contador (best-effort). */
      succeed(): Promise<void>
    }

/**
 * Antes de verificar un factor de `user`: rechaza si la cuenta está bloqueada o si
 * ya se agotaron los intentos; si no, reserva el intento y devuelve cómo cerrarlo.
 */
export async function beginSecondFactorAttempt(
  deps: {
    redis: SecondFactorRedis
    /** Persiste el bloqueo (User.lockedUntil, el mismo campo que el login). */
    lockAccount: (userId: string, until: Date) => Promise<unknown>
    onClearError?: (err: unknown) => void
  },
  user: { id: string; lockedUntil: Date | null },
  sec: LockoutSettings,
  now: () => number = Date.now,
): Promise<SecondFactorAttempt> {
  const t = now()
  if (user.lockedUntil && user.lockedUntil.getTime() > t) {
    return { ok: false, minutesLeft: Math.ceil((user.lockedUntil.getTime() - t) / 60_000) }
  }
  const lockoutMs = sec.lockoutDurationMinutes * 60_000
  const key = secondFactorFailKey(user.id)
  const attempt = Number(await deps.redis.eval(RESERVE_SCRIPT, 1, key, lockoutMs, sec.lockoutMaxAttempts))
  if (!Number.isFinite(attempt) || attempt > sec.lockoutMaxAttempts) {
    return { ok: false, minutesLeft: sec.lockoutDurationMinutes }
  }
  return {
    ok: true,
    attempt,
    async fail() {
      if (attempt < sec.lockoutMaxAttempts) return { locked: false, minutes: sec.lockoutDurationMinutes }
      await deps.lockAccount(user.id, new Date(now() + lockoutMs))
      return { locked: true, minutes: sec.lockoutDurationMinutes }
    },
    async succeed() {
      try { await deps.redis.del(key) } catch (err) { deps.onClearError?.(err) }
    },
  }
}

/** Desbloqueo del admin: borra el contador (si no, el próximo intento seguiría agotado). */
export async function clearSecondFactorFailures(redis: Pick<SecondFactorRedis, 'del'>, userId: string): Promise<void> {
  await redis.del(secondFactorFailKey(userId))
}
