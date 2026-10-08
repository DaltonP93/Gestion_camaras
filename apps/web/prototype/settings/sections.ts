// Organización de la configuración: grupos y secciones al estilo de la página de
// ajustes de Frigate (navegación lateral por sección, un formulario por sección con
// "cambios sin guardar · Guardar · Deshacer"), pero con TODAS las funciones de
// VisionCore —administración, seguridad y NVR— además de detección y eventos.
// Cada sección declara su fuente de datos real (API/modelo) para la integración.
import type { SettingsSection } from '../model/permissions'

export type FieldType = 'text' | 'number' | 'toggle' | 'select' | 'email' | 'password'

export interface Field {
  key: string
  label: string
  type: FieldType
  options?: string[]
  help?: string
  min?: number
  max?: number
}

export interface SectionDef {
  id: SettingsSection
  title: string
  /** Fuente real que reemplazará al dato simulado. */
  source: string
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
        fields: [
          { key: 'siteName', label: 'Nombre del sitio', type: 'text' },
          { key: 'timezone', label: 'Zona horaria', type: 'select', options: ['America/Asuncion', 'America/Argentina/Buenos_Aires', 'UTC'] },
          { key: 'language', label: 'Idioma', type: 'select', options: ['es', 'en'] },
        ],
        initial: { siteName: 'Sitio simulado', timezone: 'America/Asuncion', language: 'es' } },
      { id: 'apariencia', title: 'Apariencia', source: 'AppearanceSettings · GET/PUT /api/appearance',
        fields: [
          { key: 'theme', label: 'Tema', type: 'select', options: ['oscuro', 'claro'] },
          { key: 'brandColor', label: 'Color de marca', type: 'text' },
          { key: 'fontScale', label: 'Escala tipográfica', type: 'number', min: 0.8, max: 1.4 },
        ],
        initial: { theme: 'oscuro', brandColor: '#e51d1d', fontScale: 1 } },
      { id: 'sistema', title: 'Sistema y mantenimiento', source: 'GET /api/health, /api/admin/diagnostics/*, /metrics',
        custom: true },
    ],
  },
  {
    title: 'Dispositivos',
    sections: [
      { id: 'nvr', title: 'NVR', source: 'NVR · /api/nvrs (alta/edición/baja ADMIN; sync y salud ADMIN/SUPERVISOR) · ISAPI del NVR', custom: true },
      { id: 'camaras', title: 'Cámaras', source: 'Camera · /api/cameras, /api/nvrs/:id/video-audio · ISAPI del NVR', custom: true },
    ],
  },
  {
    title: 'Acceso',
    sections: [
      { id: 'usuarios', title: 'Usuarios', source: 'User · /api/users (ADMIN)', custom: true },
      { id: 'permisos', title: 'Permisos por cámara', source: 'UserPermission / UserFeaturePermissions · /api/users/:id/permissions (ADMIN)', custom: true },
      { id: 'seguridad', title: 'Seguridad', source: 'SecuritySettings · GET/PUT /api/security/settings (ADMIN + step-up)',
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
      { id: 'auditoria', title: 'Auditoría', source: 'AuditLog · GET /api/users/audit/activity (ADMIN)', custom: true },
    ],
  },
  {
    title: 'Notificaciones',
    sections: [
      { id: 'alertas', title: 'Alertas', source: 'AlertSettings · GET/PUT /api/alerts/settings (ADMIN)',
        fields: [
          { key: 'minSeverity', label: 'Severidad mínima', type: 'select', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          { key: 'cameraOffline', label: 'Cámara sin conexión', type: 'toggle' },
          { key: 'nvrOffline', label: 'NVR sin conexión', type: 'toggle' },
          { key: 'diskError', label: 'Error de disco del NVR', type: 'toggle' },
          { key: 'detection', label: 'Eventos de detección', type: 'toggle' },
        ],
        initial: { minSeverity: 'MEDIUM', cameraOffline: true, nvrOffline: true, diskError: true, detection: false } },
      { id: 'notificaciones', title: 'Correo y canales', source: 'AlertSettings (SMTP, Slack, Teams, webhook) · POST /api/alerts/settings/test-email (ADMIN)',
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
      { id: 'visores', title: 'Visores', source: 'CameraView / CameraViewAccess · /api/views', custom: true },
    ],
  },
  {
    title: 'Análisis',
    sections: [
      { id: 'deteccion', title: 'Detección', source: 'CameraAnalyticsConfig · GET/PUT /api/analytics/config/:cameraId (ADMIN, SUPERVISOR)',
        fields: [
          { key: 'enabled', label: 'Detección habilitada', type: 'toggle' },
          { key: 'objects', label: 'Objetos', type: 'select', options: ['persona', 'persona y vehículo', 'persona, vehículo y animal'] },
          { key: 'minScore', label: 'Confianza mínima (%)', type: 'number', min: 10, max: 99 },
          { key: 'motionSensitivity', label: 'Sensibilidad de movimiento', type: 'select', options: ['baja', 'media', 'alta'] },
        ],
        initial: { enabled: true, objects: 'persona y vehículo', minScore: 70, motionSensitivity: 'media' } },
      { id: 'zonas', title: 'Zonas y máscaras', source: 'CameraAnalyticsConfig (zonas) — editor de polígonos', custom: true },
      { id: 'eventos-almacenamiento', title: 'Eventos y almacenamiento', source: 'nuevo: política de retención de eventos (servidor) — archivo continuo sólo en el NVR',
        fields: [
          { key: 'retainDays', label: 'Retención de eventos (días)', type: 'number', min: 1, max: 365 },
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
