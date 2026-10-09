// src/stores/authPersist.ts
// Qué guarda el store de auth en localStorage ('visioncore-auth') y cómo se migra lo
// que ya quedó guardado en navegadores existentes.
//
// v0 (sin versión) persistía el objeto ENTERO de /auth/me, que incluía
// permissions[].nvr (usuario, clave cifrada, IP y puertos del NVR) y
// permissions[].camera (IP, rtspUrl). La API ya no los manda, pero los navegadores
// que los tienen guardados los conservarían para siempre: migrate los descarta al
// hidratar y partialize persiste sólo la allowlist, aunque una API vieja mande de más.
import type { User } from '@/types'

export const AUTH_PERSIST_VERSION = 1

// Lo que la UI necesita para el primer render, antes de que /auth/me responda
// (Sidebar, ProfilePage, StepUpModal, guards de rol y canFeature). Nada de permisos
// granulares ni relaciones NVR/cámara. Los tokens viven en cookies HttpOnly: nunca acá.
const PERSISTED_USER_KEYS = [
  'id', 'username', 'fullName', 'email', 'role', 'avatarUrl', 'phone', 'twoFactorEnabled',
] as const

export interface PersistedAuth {
  user: User | null
  isAuthenticated: boolean
}

/** Allowlist del usuario persistible; cualquier otra clave se descarta. */
export function toPersistedUser(user: unknown): User | null {
  if (!user || typeof user !== 'object') return null
  const src = user as Record<string, unknown>
  if (typeof src.id !== 'string' || typeof src.role !== 'string') return null
  const out: Record<string, unknown> = {}
  for (const k of PERSISTED_USER_KEYS) if (src[k] !== undefined) out[k] = src[k]
  // featurePermissions: sólo los flags booleanos (sin id/userId de la fila).
  const fp = src.featurePermissions
  if (fp && typeof fp === 'object') {
    out.featurePermissions = Object.fromEntries(
      Object.entries(fp as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean'),
    )
  }
  // El tipo User declara campos (active/createdAt) que /auth/me ya no devuelve y
  // nada lee del store de auth; el cast es deliberado.
  return out as unknown as User
}

export function partializeAuth(state: PersistedAuth): PersistedAuth {
  return { user: toPersistedUser(state.user), isAuthenticated: state.isAuthenticated }
}

/** Cualquier versión anterior ⇒ se reconstruye SÓLO desde la allowlist. */
export function migrateAuthState(persisted: unknown, _version: number): PersistedAuth {
  const s = (persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>
  const user = toPersistedUser(s.user)
  // Sin usuario válido no hay sesión que conservar: loadUser() la revalida con la cookie.
  return { user, isAuthenticated: s.isAuthenticated === true && user !== null }
}
