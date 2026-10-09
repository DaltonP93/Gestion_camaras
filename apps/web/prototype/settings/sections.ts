// Organización de la configuración: grupos y secciones al estilo de la página de
// ajustes de Frigate (navegación lateral por sección, un formulario por sección con
// "cambios sin guardar · Guardar · Deshacer"), pero con TODAS las funciones de
// VisionCore —administración, seguridad y NVR— además de detección y eventos.
// Cada sección declara su fuente de datos real (API/modelo) para la integración y
// su ESTADO DE BACKEND (model/backend.ts): 'simulado' (no existe todavía) o
// 'existente' (la API lo tiene, pero el prototipo no lo llama). Un control puede
// diferir de su sección (p. ej. un campo que el modelo real no tiene). Cada control
// 'existente' se verifica contra el campo real del backend (apiField o key).
import type { SettingsSection } from '../model/permissions'
import { SIMULATED, type BackendStatus } from '../model/backend'

export type FieldType = 'text' | 'number' | 'toggle' | 'select' | 'email' | 'password'

export interface Field {
  key: string
  label: string
  type: FieldType
  options?: string[]
  help?: string
  min?: number
  max?: number
  /** Sólo si difiere del estado de su sección. */
  backend?: BackendStatus
  /**
   * Controles 'existente': nombre del campo real si difiere de `key` (columna del
   * modelo Prisma que escribe la ruta citada y clave del esquema zod de su cuerpo).
   * 'columna.CLAVE' = clave dentro de una columna JSON. Lo verifica
   * model/backendEndpoints.test.ts leyendo prisma/schema.prisma y apps/api/src/routes.
   */
  apiField?: string
}

export interface SectionDef {
  id: SettingsSection
  title: string
  /** Fuente real que reemplazará al dato simulado. */
  source: string
  /** Estado de backend de la sección (marca persistente en pantalla). */
  backend: BackendStatus
  fields?: Field[]
  initial?: Record<string, string | number | boolean>
  /** true: la sección tiene contenido propio además (o en lugar) del formulario. */
  custom?: boolean
}

export interface GroupDef { title: string; sections: SectionDef[] }

export const SETTINGS_GROUPS: GroupDef[] = [
  {
    title: 'Sistema',
    sections: [
      { id: 'general', title: 'General', source: 'nuevo: configuración del sistema (singleton) — hoy repartido en .env',
        backend: SIMULATED,
        fields: [
          { key: 'siteName', label: 'Nombre del sitio', type: 'text', backend: { kind: 'existente', endpoint: 'AppearanceSettings.siteName · PUT /api/appearance' } },
          { key: 'timezone', label: 'Zona horaria', type: 'select', options: ['America/Asuncion', 'America/Argentina/Buenos_Aires', 'UTC'] },
          { key: 'language', label: 'Idioma', type: 'select', options: ['es', 'en'] },
        ],
        initial: { siteName: 'Sitio simulado', timezone: 'America/Asuncion', language: 'es' } },
      { id: 'apariencia', title: 'Apariencia', source: 'AppearanceSettings · GET/PUT /api/appearance',
        backend: { kind: 'existente', endpoint: 'GET/PUT /api/appearance' },
        fields: [
          // themeMode (V2) y no el theme legacy: sólo themeMode admite el tema claro (light).
          { key: 'theme', label: 'Tema', type: 'select', options: ['oscuro', 'claro'], apiField: 'themeMode' },
          { key: 'brandColor', label: 'Color de marca', type: 'text', apiField: 'primaryColor' },
          { key: 'fontScale', label: 'Escala tipográfica', type: 'number', min: 0.8, max: 1.4 },
        ],
        initial: { theme: 'oscuro', brandColor: '#e51d1d', fontScale: 1 } },
      { id: 'sistema', title: 'Sistema y mantenimiento', source: 'GET /api/health, /api/admin/diagnostics/*, /metrics',
        backend: { kind: 'existente', endpoint: 'GET /api/health/deep · /api/admin/diagnostics/* · POST /api/recordings/diagnostics/playback', note: 'estados simulados' },
        custom: true },
    ],
  },
  {
    title: 'Dispositivos',
    sections: [
      { id: 'nvr', title: 'NVR', source: 'NVR · /api/nvrs (alta/edición/baja ADMIN; sync y salud ADMIN/SUPERVISOR) · ISAPI del NVR',
        backend: { kind: 'existente', endpoint: '/api/nvrs' }, custom: true },
      { id: 'camaras', title: 'Cámaras', source: 'Camera · /api/cameras, /api/nvrs/:id/video-audio · ISAPI del NVR',
        backend: { kind: 'existente', endpoint: 'GET /api/cameras · PUT /api/cameras/:id · GET /api/nvrs/:id/video-audio' }, custom: true },
    ],
  },
  {
    title: 'Acceso',
    sections: [
      { id: 'usuarios', title: 'Usuarios', source: 'User · /api/users (ADMIN)',
        backend: { kind: 'existente', endpoint: '/api/users' }, custom: true },
      { id: 'permisos', title: 'Permisos por cámara', source: 'UserPermission / UserFeaturePermissions · /api/users/:id/permissions (ADMIN)',
        backend: { kind: 'existente', endpoint: 'GET/PUT /api/users/:id/permissions' }, custom: true },
      { id: 'seguridad', title: 'Seguridad', source: 'SecuritySettings · GET/PUT /api/security/settings (ADMIN + step-up)',
        backend: { kind: 'existente', endpoint: 'GET/PUT /api/security/settings' },
        fields: [
          { key: 'passwordMinLength', label: 'Longitud mínima de contraseña', type: 'number', min: 8, max: 128 },
          { key: 'requireStrongPassword', label: 'Exigir contraseña robusta', type: 'toggle' },
          { key: 'sessionTimeoutMinutes', label: 'Duración de la sesión (min)', type: 'number', min: 5, max: 1440 },
          { key: 'maxSessions', label: 'Sesiones simultáneas por usuario', type: 'number', min: 1, max: 20 },
          { key: 'lockoutMaxAttempts', label: 'Intentos antes de bloquear', type: 'number', min: 1, max: 20 },
          { key: 'lockoutDurationMinutes', label: 'Duración del bloqueo (min)', type: 'number', min: 1, max: 1440 },
          { key: 'mfaRequired', label: 'Exigir segundo factor', type: 'toggle', help: 'La política se guarda; su aplicación llega en una fase posterior.' },
        ],
        initial: { passwordMinLength: 12, requireStrongPassword: true, sessionTimeoutMinutes: 60, maxSessions: 5, lockoutMaxAttempts: 5, lockoutDurationMinutes: 15, mfaRequired: false } },
      { id: 'auditoria', title: 'Auditoría', source: 'AuditLog · GET /api/users/audit/activity (ADMIN)',
        backend: { kind: 'existente', endpoint: 'GET /api/users/audit/activity' }, custom: true },
    ],
  },
  {
    title: 'Notificaciones',
    sections: [
      { id: 'alertas', title: 'Alertas', source: 'AlertSettings · GET/PUT /api/alerts/settings (ADMIN)',
        backend: { kind: 'existente', endpoint: 'GET/PUT /api/alerts/settings' },
        fields: [
          { key: 'minSeverity', label: 'Severidad mínima', type: 'select', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          { key: 'cameraOffline', label: 'Cámara sin conexión', type: 'toggle', apiField: 'alertTypes.CAMERA_OFFLINE' },
          { key: 'nvrOffline', label: 'NVR sin conexión', type: 'toggle', apiField: 'alertTypes.NVR_OFFLINE' },
          { key: 'diskError', label: 'Error de disco del NVR', type: 'toggle', apiField: 'alertTypes.HDD_ERROR' },
          { key: 'detection', label: 'Eventos de detección', type: 'toggle', backend: { kind: 'simulado', note: 'no hay un interruptor único de detecciones: AlertSettings.alertTypes acepta una clave por tipo (PERSON_DETECTED, VEHICLE_DETECTED, ZONE_INTRUSION, LINE_CROSSING, LOITERING, OCCUPANCY_LIMIT; ausente ⇒ se notifica, false ⇒ no) y el aviso por cámara está en CameraAnalyticsConfig.alertConfig. Este control agruparía esas seis claves' } },
        ],
        initial: { minSeverity: 'MEDIUM', cameraOffline: true, nvrOffline: true, diskError: true, detection: false } },
      { id: 'notificaciones', title: 'Correo y canales', source: 'AlertSettings (SMTP, Slack, Teams, webhook) · POST /api/alerts/settings/test-email (ADMIN)',
        backend: { kind: 'existente', endpoint: 'GET/PUT /api/alerts/settings' },
        fields: [
          { key: 'emailEnabled', label: 'Correo habilitado', type: 'toggle' },
          { key: 'smtpHost', label: 'Servidor SMTP', type: 'text' },
          { key: 'smtpPort', label: 'Puerto', type: 'number', min: 1, max: 65535 },
          { key: 'smtpUser', label: 'Usuario SMTP', type: 'text' },
          { key: 'smtpPassword', label: 'Contraseña SMTP', type: 'password', help: 'Se guarda cifrada; nunca se vuelve a mostrar.' },
          { key: 'recipientEmails', label: 'Destinatarios', type: 'text' },
          { key: 'webhookEnabled', label: 'Webhook habilitado', type: 'toggle' },
        ],
        initial: { emailEnabled: true, smtpHost: 'smtp.example.test', smtpPort: 587, smtpUser: 'alertas', smtpPassword: '', recipientEmails: 'ops@example.test', webhookEnabled: false } },
    ],
  },
  {
    title: 'Vivo',
    sections: [
      { id: 'visores', title: 'Visores', source: 'CameraView / CameraViewAccess · /api/views',
        backend: { kind: 'existente', endpoint: 'GET/POST /api/views · PUT/DELETE /api/views/:id' }, custom: true },
    ],
  },
  {
    title: 'Análisis',
    sections: [
      { id: 'deteccion', title: 'Detección', source: 'CameraAnalyticsConfig · GET/PUT /api/analytics/config/:cameraId (ADMIN, SUPERVISOR)',
        backend: { kind: 'existente', endpoint: 'GET/PUT /api/analytics/config/:cameraId' },
        fields: [
          { key: 'enabled', label: 'Detección habilitada', type: 'toggle' },
          { key: 'objects', label: 'Objetos', type: 'select', options: ['persona', 'persona y vehículo', 'persona, vehículo y animal'], apiField: 'classes' },
          { key: 'minScore', label: 'Confianza mínima (%)', type: 'number', min: 10, max: 99, apiField: 'minConfidence' },
          { key: 'motionSensitivity', label: 'Sensibilidad de movimiento', type: 'select', options: ['baja', 'media', 'alta'], backend: { kind: 'simulado', note: 'CameraAnalyticsConfig no tiene este campo' } },
        ],
        initial: { enabled: true, objects: 'persona y vehículo', minScore: 70, motionSensitivity: 'media' } },
      { id: 'zonas', title: 'Zonas y máscaras', source: 'CameraAnalyticsConfig (zonas) — editor de polígonos',
        backend: { kind: 'existente', endpoint: 'PUT /api/analytics/config/:cameraId (zones)' }, custom: true },
      { id: 'eventos-almacenamiento', title: 'Eventos y almacenamiento', source: 'nuevo: política de retención de eventos (servidor) — archivo continuo sólo en el NVR',
        backend: SIMULATED,
        fields: [
          { key: 'retainDays', label: 'Retención de eventos (días)', type: 'number', min: 1, max: 365,
            backend: { kind: 'simulado', note: 'hoy es fija por variable de entorno (ANALYTICS_RETENTION_DAYS, purga diaria); sin API para cambiarla' } },
          { key: 'preCapture', label: 'Segundos antes del evento', type: 'number', min: 0, max: 60 },
          { key: 'postCapture', label: 'Segundos después del evento', type: 'number', min: 0, max: 300 },
          { key: 'quotaGb', label: 'Cuota de almacenamiento local (GB)', type: 'number', min: 10, max: 4000 },
          { key: 'onQuota', label: 'Al llegar a la cuota', type: 'select', options: ['alertar y dejar de retener nuevos', 'alertar (nunca borrar eventos vigentes)'] },
        ],
        initial: { retainDays: 30, preCapture: 5, postCapture: 15, quotaGb: 500, onQuota: 'alertar (nunca borrar eventos vigentes)' } },
    ],
  },
]

export const ALL_SECTIONS: SectionDef[] = SETTINGS_GROUPS.flatMap(g => g.sections)

/** Estado efectivo de un control: el propio si lo declara; si no, el de su sección. */
export function fieldBackend(section: SectionDef, field: Field): BackendStatus {
  return field.backend ?? section.backend
}

/**
 * Acciones de las secciones con contenido propio (botones). Todas existen en la API
 * actual; en el prototipo no se ejecutan.
 */
export const SECTION_ACTIONS: Record<string, { label: string; endpoint: string }> = {
  'action-diagnostics': { label: 'Diagnóstico de reproducción', endpoint: 'POST /api/recordings/diagnostics/playback' },
  'action-add-nvr': { label: 'Agregar NVR', endpoint: 'POST /api/nvrs' },
  'action-sync-nvr': { label: 'Sincronizar canales', endpoint: 'POST /api/nvrs/:id/sync-cameras' },
  'action-validate-nvr': { label: 'Validar salud', endpoint: 'POST /api/nvrs/:id/validate-health' },
  'action-add-user': { label: 'Agregar usuario', endpoint: 'POST /api/users' },
}
