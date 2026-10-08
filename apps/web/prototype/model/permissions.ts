// Reglas de acceso del prototipo. Replican el contrato RBAC ACTUAL de la API (no lo
// amplían): el prototipo sirve para revisar la experiencia, no para cambiar quién
// ve qué. Referencias (rama base):
//   - vivo / PTZ: apps/api/src/routes/cameras.ts `userCanAccessCamera`
//     (ADMIN y SUPERVISOR sin restricción por recurso; el resto necesita
//     UserPermission.canView / canPtz por cámara);
//   - grabaciones: apps/api/src/routes/recordings.ts (OPERATOR sin acceso; AUDITOR
//     necesita canPlayback por cámara; ADMIN/SUPERVISOR sin restricción);
//   - visores: apps/api/src/routes/views.ts (crear/editar/borrar ADMIN y SUPERVISOR,
//     SUPERVISOR sólo los propios; ver: ADMIN todos, el resto públicos, propios o
//     con acceso explícito);
//   - eventos de análisis: apps/api/src/routes/analytics.ts GET /events (ADMIN,
//     SUPERVISOR, AUDITOR; quien no es ADMIN sólo ve cámaras con canView explícito
//     —también SUPERVISOR, a diferencia de vivo—; OPERATOR sin acceso);
//   - configuración de detección: PUT /api/analytics/config/:cameraId (ADMIN y
//     SUPERVISOR); seguridad, usuarios, alertas/SMTP y auditoría: sólo ADMIN.
// La configuración (sección → rol) sigue la matriz de docs/frigate/NATIVE_INTEGRATION_PROPOSAL.md.
import { CAMERA_PERMISSIONS, type Camera, type CameraPermission, type ProtoUser, type Role, type Viewer } from '../data/mock'

const UNRESTRICTED: ReadonlySet<Role> = new Set(['ADMIN', 'SUPERVISOR'])

function permFor(user: ProtoUser, cameraId: string): CameraPermission | undefined {
  return (CAMERA_PERMISSIONS[user.id] ?? []).find(p => p.cameraId === cameraId)
}

export function canViewLive(user: ProtoUser, camera: Camera): boolean {
  if (UNRESTRICTED.has(user.role)) return true
  const p = permFor(user, camera.id)
  return !!p && p.canView && p.canViewLive
}

export function canPtz(user: ProtoUser, camera: Camera): boolean {
  if (!camera.ptz) return false
  if (UNRESTRICTED.has(user.role)) return true
  return !!permFor(user, camera.id)?.canPtz
}

export function canUseHighQuality(user: ProtoUser, camera: Camera): boolean {
  if (UNRESTRICTED.has(user.role)) return true
  return !!permFor(user, camera.id)?.canHighQuality
}

export function canPlayback(user: ProtoUser, camera: Camera): boolean {
  if (user.role === 'OPERATOR') return false
  if (UNRESTRICTED.has(user.role)) return true
  return !!permFor(user, camera.id)?.canPlayback
}

export function canDownload(user: ProtoUser, camera: Camera): boolean {
  if (!canPlayback(user, camera)) return false
  if (UNRESTRICTED.has(user.role)) return true
  return !!permFor(user, camera.id)?.canDownload
}

export function canSeeRecordingsModule(user: ProtoUser): boolean {
  return user.role !== 'OPERATOR'
}

export function canSeeEventsModule(user: ProtoUser): boolean {
  return user.role !== 'OPERATOR'
}

/** Eventos: ADMIN todas; el resto sólo cámaras con canView EXPLÍCITO (incluye SUPERVISOR). */
export function canSeeCameraEvents(user: ProtoUser, camera: Camera): boolean {
  if (!canSeeEventsModule(user)) return false
  if (user.role === 'ADMIN') return true
  return !!permFor(user, camera.id)?.canView
}

// ─── Visores ──────────────────────────────────────────────────────────────────

export function canCreateViewer(user: ProtoUser): boolean {
  return UNRESTRICTED.has(user.role)
}

export function canEditViewer(user: ProtoUser, viewer: Viewer): boolean {
  if (user.role === 'ADMIN') return true
  return user.role === 'SUPERVISOR' && viewer.createdById === user.id
}

export function canSeeViewer(user: ProtoUser, viewer: Viewer): boolean {
  return user.role === 'ADMIN' || viewer.isPublic || viewer.createdById === user.id || viewer.accessUserIds.includes(user.id)
}

export function isSharedViewer(viewer: Viewer): boolean {
  return viewer.isPublic || viewer.accessUserIds.length > 0
}

// ─── Configuración ────────────────────────────────────────────────────────────

export type SettingsSection =
  | 'general' | 'apariencia' | 'sistema'
  | 'nvr' | 'camaras'
  | 'usuarios' | 'permisos' | 'seguridad' | 'auditoria'
  | 'alertas' | 'notificaciones'
  | 'visores'
  | 'deteccion' | 'zonas' | 'eventos-almacenamiento'

export type Access = 'edit' | 'read' | 'none'

/**
 * Sección → acceso por rol. Mantiene lo que hoy permite la API: la configuración
 * del sistema es de ADMIN; SUPERVISOR administra sus visores, la detección
 * (PUT /api/analytics/config) y los datos de cámara (PUT /api/cameras/:id), y
 * consulta los NVR con acciones de sync/salud (alta, edición y baja: sólo ADMIN);
 * OPERATOR y AUDITOR no ven configuración del sistema (sólo los visores que
 * tienen asignados). La auditoría es sólo de ADMIN (GET /api/users/audit/activity).
 */
export const SETTINGS_ACCESS: Record<SettingsSection, Record<Role, Access>> = {
  general:                  { ADMIN: 'edit', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  apariencia:               { ADMIN: 'edit', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  sistema:                  { ADMIN: 'edit', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  nvr:                      { ADMIN: 'edit', SUPERVISOR: 'read', OPERATOR: 'none', AUDITOR: 'none' },
  camaras:                  { ADMIN: 'edit', SUPERVISOR: 'edit', OPERATOR: 'none', AUDITOR: 'none' },
  usuarios:                 { ADMIN: 'edit', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  permisos:                 { ADMIN: 'edit', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  seguridad:                { ADMIN: 'edit', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  auditoria:                { ADMIN: 'read', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  alertas:                  { ADMIN: 'edit', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  notificaciones:           { ADMIN: 'edit', SUPERVISOR: 'none', OPERATOR: 'none', AUDITOR: 'none' },
  visores:                  { ADMIN: 'edit', SUPERVISOR: 'edit', OPERATOR: 'read', AUDITOR: 'read' },
  deteccion:                { ADMIN: 'edit', SUPERVISOR: 'edit', OPERATOR: 'none', AUDITOR: 'none' },
  zonas:                    { ADMIN: 'edit', SUPERVISOR: 'edit', OPERATOR: 'none', AUDITOR: 'none' },
  'eventos-almacenamiento': { ADMIN: 'edit', SUPERVISOR: 'read', OPERATOR: 'none', AUDITOR: 'none' },
}

export function settingsAccess(user: ProtoUser, section: SettingsSection): Access {
  return SETTINGS_ACCESS[section][user.role]
}

export function canSeeSettings(user: ProtoUser): boolean {
  return (Object.keys(SETTINGS_ACCESS) as SettingsSection[]).some(s => settingsAccess(user, s) !== 'none')
}
