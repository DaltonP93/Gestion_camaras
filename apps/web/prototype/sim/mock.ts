// Datos 100 % SIMULADOS del prototipo. Ningún nombre, id, IP o credencial es real
// y nada de este archivo se envía a la API: el prototipo no hace peticiones de red.
//
// Los tipos replican la forma de los modelos reales (prisma/schema.prisma) que la
// integración usará, para que el prototipo ejercite las mismas reglas:
//   UserPermission (permisos por cámara), UserFeaturePermissions, CameraView +
//   CameraViewAccess (visores), RecordingsSettings / NVR.maxConcurrentPlaybackSessions
//   (límite de sesiones de reproducción por NVR), SecuritySettings, AlertSettings.

export type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

export interface ProtoUser {
  id: string
  name: string
  role: Role
}

export interface Nvr {
  id: string
  name: string
  model: string
  online: boolean
  /** Sesiones de reproducción histórica concurrentes que acepta el NVR. */
  maxConcurrentPlaybackSessions: number
}

/** Tramo grabado, en segundos desde las 00:00 del día simulado. */
export interface Segment { start: number; end: number }

export interface Camera {
  id: string
  nvrId: string
  channel: number
  name: string
  mainCodec: 'H264' | 'H265'
  subCodec: 'H264' | 'H265'
  online: boolean
  /**
   * Pistas ARCHIVADAS en el NVR para el día simulado. `main` = pista canal*100+1,
   * `sub` = canal*100+2. Muchos NVR sólo graban la principal: `sub` vacío.
   */
  archived: { main: Segment[]; sub: Segment[] }
  ptz: boolean
}

/** Permisos por cámara (subconjunto de UserPermission). */
export interface CameraPermission {
  cameraId: string
  canView: boolean
  canViewLive: boolean
  canPlayback: boolean
  canPtz: boolean
  canHighQuality: boolean
  canDownload: boolean
  canAddToViews: boolean
}

export type Layout = '1x1' | '2x2' | '3x3' | '4x4'

/** Visor (CameraView). Personal = sin isPublic y sin accesos; compartido = lo contrario. */
export interface Viewer {
  id: string
  name: string
  layout: Layout
  /** Una cámara (o null) por celda, en orden de lectura. */
  cameraSlots: Array<string | null>
  isPublic: boolean
  createdById: string
  /** CameraViewAccess: usuarios con acceso explícito. */
  accessUserIds: string[]
  updatedAt: string
}

export interface DetectionEvent {
  id: string
  cameraId: string
  label: 'persona' | 'vehículo' | 'animal'
  zone: string | null
  score: number
  /** Segundos desde las 00:00 del día simulado. */
  start: number
  end: number
  /** true si el clip quedó retenido en el almacenamiento local de eventos. */
  retained: boolean
}

const H = 3600

export const SIM_DAY = '2026-10-07'
/** Ventana de reproducción simulada: 08:00–12:00. */
export const WINDOW = { start: 8 * H, end: 12 * H }

export const USERS: ProtoUser[] = [
  { id: 'u-admin', name: 'Administración (sim.)', role: 'ADMIN' },
  { id: 'u-sup', name: 'Supervisión (sim.)', role: 'SUPERVISOR' },
  { id: 'u-op', name: 'Operación (sim.)', role: 'OPERATOR' },
  { id: 'u-aud', name: 'Auditoría (sim.)', role: 'AUDITOR' },
]

export const NVRS: Nvr[] = [
  { id: 'nvr-a', name: 'NVR Recepción', model: 'NVR simulado 16 canales', online: true, maxConcurrentPlaybackSessions: 4 },
  { id: 'nvr-b', name: 'NVR Depósito', model: 'NVR simulado 8 canales', online: true, maxConcurrentPlaybackSessions: 2 },
]

const full: Segment[] = [{ start: WINDOW.start, end: WINDOW.end }]

export const CAMERAS: Camera[] = [
  // Graba principal y subflujo completos.
  { id: 'cam-a1', nvrId: 'nvr-a', channel: 1, name: 'Acceso principal', mainCodec: 'H264', subCodec: 'H264', online: true, ptz: true,
    archived: { main: full, sub: full } },
  // Sólo principal (caso frecuente): la grilla NO puede asumir subflujo.
  { id: 'cam-a2', nvrId: 'nvr-a', channel: 2, name: 'Recepción', mainCodec: 'H265', subCodec: 'H264', online: true, ptz: false,
    archived: { main: full, sub: [] } },
  // Principal con hueco 09:30–09:45; subflujo sólo hasta las 10:00.
  { id: 'cam-a3', nvrId: 'nvr-a', channel: 3, name: 'Pasillo norte', mainCodec: 'H264', subCodec: 'H264', online: true, ptz: false,
    archived: { main: [{ start: 8 * H, end: 9.5 * H }, { start: 9.75 * H, end: 12 * H }], sub: [{ start: 8 * H, end: 10 * H }] } },
  { id: 'cam-a4', nvrId: 'nvr-a', channel: 4, name: 'Estacionamiento', mainCodec: 'H265', subCodec: 'H265', online: true, ptz: true,
    archived: { main: full, sub: full } },
  // Grabación por eventos: tramos cortos.
  { id: 'cam-a5', nvrId: 'nvr-a', channel: 5, name: 'Caja', mainCodec: 'H264', subCodec: 'H264', online: true, ptz: false,
    archived: { main: [{ start: 8 * H, end: 8.25 * H }, { start: 9 * H, end: 9.5 * H }, { start: 11 * H, end: 11.5 * H }], sub: [] } },
  { id: 'cam-a6', nvrId: 'nvr-a', channel: 6, name: 'Sala técnica', mainCodec: 'H264', subCodec: 'H264', online: false, ptz: false,
    archived: { main: [{ start: 8 * H, end: 10.5 * H }], sub: [] } },
  { id: 'cam-b1', nvrId: 'nvr-b', channel: 1, name: 'Muelle de carga', mainCodec: 'H264', subCodec: 'H264', online: true, ptz: false,
    archived: { main: full, sub: full } },
  { id: 'cam-b2', nvrId: 'nvr-b', channel: 2, name: 'Depósito interior', mainCodec: 'H265', subCodec: 'H264', online: true, ptz: false,
    archived: { main: full, sub: [] } },
  { id: 'cam-b3', nvrId: 'nvr-b', channel: 3, name: 'Portón', mainCodec: 'H264', subCodec: 'H264', online: true, ptz: true,
    archived: { main: [{ start: 8 * H, end: 11 * H }], sub: [{ start: 8 * H, end: 11 * H }] } },
]

const perm = (cameraId: string, p: Partial<CameraPermission>): CameraPermission => ({
  cameraId, canView: true, canViewLive: true, canPlayback: false, canPtz: false,
  canHighQuality: false, canDownload: false, canAddToViews: false, ...p,
})

/** Permisos por cámara (UserPermission) de los usuarios simulados. */
export const CAMERA_PERMISSIONS: Record<string, CameraPermission[]> = {
  // SUPERVISOR no necesita filas para vivo/grabaciones, pero los EVENTOS de análisis
  // hoy sí filtran por canView también para SUPERVISOR (ver model/permissions.ts).
  'u-sup': [perm('cam-a1', {}), perm('cam-a2', {}), perm('cam-a4', {}), perm('cam-b1', {})],
  'u-op': [
    perm('cam-a1', { canPtz: true, canAddToViews: true }),
    perm('cam-a2', {}),
    perm('cam-a3', {}),
    perm('cam-b1', { canHighQuality: true }),
  ],
  'u-aud': [
    perm('cam-a1', { canPlayback: true, canDownload: true }),
    perm('cam-a2', { canPlayback: true }),
    perm('cam-a5', { canPlayback: true }),
    perm('cam-b1', { canPlayback: true }),
    perm('cam-b2', { canPlayback: true }),
  ],
}

export const INITIAL_VIEWERS: Viewer[] = [
  { id: 'v-entrada', name: 'Entradas', layout: '2x2', cameraSlots: ['cam-a1', 'cam-a2', 'cam-a4', 'cam-b3'],
    isPublic: true, createdById: 'u-sup', accessUserIds: [], updatedAt: '2026-10-06T12:00:00Z' },
  { id: 'v-deposito', name: 'Depósito', layout: '2x2', cameraSlots: ['cam-b1', 'cam-b2', 'cam-b3', 'cam-a5'],
    isPublic: false, createdById: 'u-admin', accessUserIds: ['u-op', 'u-aud'], updatedAt: '2026-10-06T12:00:00Z' },
  { id: 'v-sup-ronda', name: 'Ronda supervisión', layout: '3x3',
    cameraSlots: ['cam-a1', 'cam-a2', 'cam-a3', 'cam-a4', 'cam-a5', 'cam-a6', 'cam-b1', 'cam-b2', 'cam-b3'],
    isPublic: false, createdById: 'u-sup', accessUserIds: [], updatedAt: '2026-10-06T12:00:00Z' },
]

export const EVENTS: DetectionEvent[] = [
  { id: 'e1', cameraId: 'cam-a1', label: 'persona', zone: 'Puerta', score: 0.91, start: 8 * H + 600, end: 8 * H + 640, retained: true },
  { id: 'e2', cameraId: 'cam-a4', label: 'vehículo', zone: 'Entrada vehicular', score: 0.88, start: 8.5 * H, end: 8.5 * H + 90, retained: true },
  { id: 'e3', cameraId: 'cam-b1', label: 'vehículo', zone: 'Muelle', score: 0.79, start: 9 * H + 120, end: 9 * H + 400, retained: true },
  { id: 'e4', cameraId: 'cam-a3', label: 'persona', zone: null, score: 0.64, start: 9.6 * H, end: 9.6 * H + 30, retained: false },
  { id: 'e5', cameraId: 'cam-b3', label: 'animal', zone: 'Portón', score: 0.71, start: 10 * H, end: 10 * H + 20, retained: false },
  { id: 'e6', cameraId: 'cam-a2', label: 'persona', zone: 'Mostrador', score: 0.93, start: 10.5 * H, end: 10.5 * H + 75, retained: true },
  { id: 'e7', cameraId: 'cam-b2', label: 'persona', zone: null, score: 0.82, start: 11.2 * H, end: 11.2 * H + 40, retained: true },
]

export function cameraById(id: string): Camera | undefined {
  return CAMERAS.find(c => c.id === id)
}

export function nvrById(id: string): Nvr | undefined {
  return NVRS.find(n => n.id === id)
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const hh = String(Math.floor(s / H)).padStart(2, '0')
  const mm = String(Math.floor((s % H) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
