// apps/api/src/services/current-actor.ts
//
// ACTOR VIGENTE (política de permisos §7.2, defectos C02/C14 de la revisión conjunta).
//
// El access JWT `{sub, username, role}` era stateless: tras logout, revocar sesiones,
// cambio de contraseña, reset de 2FA, desactivación, borrado o cambio de rol, una
// copia seguía abriendo rutas hasta su `exp` (60 min por defecto, hasta 24 h), y el
// rol que decidía era el del claim. Además los tokens opacos de grabación (fileToken,
// descarga de 24 h, stream de preview) no estaban ligados a nadie.
//
// Ahora el access lleva `sid` = `Session.id` (la fila que la rotación de refresh
// conserva) y CADA petición autenticada pasa por `loadCurrentActor`:
//   - el usuario existe y está activo;
//   - la sesión que originó el token sigue viva (no borrada, no vencida);
//   - el rol y el username que deciden son los de la BASE, no los del claim.
// Es UNA consulta indexada (PK de `users` + PK de `sessions` en un EXISTS), sin
// caché: la revocación surte efecto en la petición siguiente por construcción.
//
// Los medios de grabación ya emitidos se ligan a `{userId, sid, cameraId}` y se
// revalidan al servir con `checkRecordingMediaAccess` (mismas reglas de rol que el
// alta: ADMIN/SUPERVISOR, AUDITOR con canPlayback, OPERATOR no).
//
// Ningún mensaje ni valor devuelto incluye tokens; los ids se recortan en los logs
// de los llamadores.

import crypto from 'crypto'

type PrismaLike = any

/** Largo máximo aceptado para el claim `sid` (un cuid tiene 25). Evita consultas con basura. */
const MAX_SID_LENGTH = 64

export interface CurrentActor {
  userId: string
  sid: string
  role: string
  username: string
}

export type ActorRejection =
  /** El token no trae `sid` (access emitido antes de este cambio, u otro tipo de token). */
  | 'NO_SESSION_CLAIM'
  /** Usuario borrado o desactivado, o sesión cerrada/revocada/vencida. */
  | 'NOT_CURRENT'

export type ActorResult = { ok: true; actor: CurrentActor } | { ok: false; reason: ActorRejection }

/**
 * Carga el actor vigente para los claims `{sub, sid}`. Lanza sólo si la base falla
 * (el llamador decide fail-closed); un actor no vigente es `{ ok: false }`.
 */
export async function loadCurrentActor(
  prisma: PrismaLike,
  claims: { sub?: unknown; sid?: unknown } | null | undefined,
  now: Date = new Date(),
): Promise<ActorResult> {
  const sub = claims?.sub
  const sid = claims?.sid
  if (typeof sub !== 'string' || sub.length === 0 || typeof sid !== 'string' || sid.length === 0 || sid.length > MAX_SID_LENGTH) {
    return { ok: false, reason: 'NO_SESSION_CLAIM' }
  }
  // Una sola sentencia: `users` por PK con EXISTS sobre `sessions` por PK. La
  // condición de sesión exige que la fila sea del MISMO usuario.
  const user = await prisma.user.findFirst({
    where: { id: sub, active: true, sessions: { some: { id: sid, expiresAt: { gt: now } } } },
    select: { role: true, username: true },
  })
  if (!user) return { ok: false, reason: 'NOT_CURRENT' }
  return { ok: true, actor: { userId: sub, sid, role: user.role, username: user.username } }
}

/**
 * PUENTE DE DESPLIEGUE (access emitido antes de ligarlo a su sesión, sin `sid`):
 * id de la sesión VIVA del usuario `userId` cuyo refresh token vigente es
 * `refreshToken` (la cookie HttpOnly que el navegador manda a /api/auth/*), o null.
 * Quien tiene esa cookie ya puede renovar el access de esa sesión, así que ligar el
 * access previo a ella no le da nada nuevo; un access copiado sin la cookie no
 * encuentra sesión. Mismo hash que guarda routes/auth.ts (`hashToken`: sha256 hex).
 * Lanza sólo si la base falla.
 */
export async function liveSessionIdForRefreshToken(
  prisma: PrismaLike, userId: unknown, refreshToken: unknown, now: Date = new Date(),
): Promise<string | null> {
  if (typeof userId !== 'string' || !userId || typeof refreshToken !== 'string' || !refreshToken) return null
  const row = await prisma.session.findFirst({
    where: {
      refreshToken: crypto.createHash('sha256').update(refreshToken).digest('hex'),
      userId, expiresAt: { gt: now },
    },
    select: { id: true },
  })
  return row?.id ?? null
}

/**
 * ¿El actor puede reproducir grabaciones de la cámara? Mismas reglas que
 * `POST /recordings/playback` y `/preview/start`: ADMIN y SUPERVISOR sí; AUDITOR
 * sólo con `canPlayback` sobre la cámara; OPERATOR (y cualquier otro rol) no.
 * La exportación con `canDownload` es una decisión pendiente (D5): no se agrega aquí.
 */
export async function actorCanPlaybackCamera(prisma: PrismaLike, actor: CurrentActor, cameraId: string): Promise<boolean> {
  if (actor.role === 'ADMIN' || actor.role === 'SUPERVISOR') return true
  if (actor.role !== 'AUDITOR') return false
  const perm = await prisma.userPermission.findFirst({
    where: { userId: actor.userId, cameraId, canPlayback: true },
    select: { id: true },
  })
  return !!perm
}

/** A quién y a qué quedó ligado un token opaco de grabación al emitirlo. */
export interface RecordingMediaBinding {
  userId?: string
  sid?: string
  cameraId?: string
}

export type MediaAccessResult =
  | { ok: true }
  /** Token sin ligadura (emitido antes de este cambio): se rechaza (fail-closed). */
  | { ok: false; reason: 'UNBOUND' }
  /** El titular ya no es un actor vigente (logout, sesiones revocadas, baja, borrado). */
  | { ok: false; reason: 'ACTOR_REVOKED' }
  /** El titular sigue vigente pero ya no puede reproducir esa cámara (rol o permiso). */
  | { ok: false; reason: 'PLAYBACK_REVOKED' }

/**
 * Revalida un medio de grabación YA EMITIDO al servir cada petición (fileToken,
 * token de descarga, stream de preview, re-entrega de URLs en /status). Lanza sólo
 * si la base falla; el llamador responde 503 sin servir.
 */
export async function checkRecordingMediaAccess(
  prisma: PrismaLike,
  binding: RecordingMediaBinding,
  now: Date = new Date(),
): Promise<MediaAccessResult> {
  if (!binding.userId || !binding.sid || !binding.cameraId) return { ok: false, reason: 'UNBOUND' }
  const r = await loadCurrentActor(prisma, { sub: binding.userId, sid: binding.sid }, now)
  if (!r.ok) return { ok: false, reason: 'ACTOR_REVOKED' }
  if (!(await actorCanPlaybackCamera(prisma, r.actor, binding.cameraId))) return { ok: false, reason: 'PLAYBACK_REVOKED' }
  return { ok: true }
}
