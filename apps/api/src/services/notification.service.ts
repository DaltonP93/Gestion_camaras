// Notification Service — orquesta canales de notificación para alertas VisionCore
import type { PrismaClient } from '@prisma/client'
import { sendAlertEmail } from './providers/email.provider'

const SEVERITY_ORDER: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }

interface AlertForNotification {
  id: string
  type: string
  severity: string
  message: string
  detail?: unknown
  nvrId?: string | null
  cameraId?: string | null
}

function buildEmailHtml(alert: AlertForNotification, extra: { nvrName?: string; cameraName?: string } = {}): string {
  const severityColors: Record<string, string> = {
    LOW: '#64748b',
    MEDIUM: '#f59e0b',
    HIGH: '#f97316',
    CRITICAL: '#ef4444',
  }

  const typeLabels: Record<string, string> = {
    NVR_OFFLINE: 'NVR Offline',
    CAMERA_OFFLINE: 'Cámara Offline',
    HDD_FULL: 'HDD Lleno',
    HDD_ERROR: 'Error de HDD',
    MOTION_DETECTED: 'Movimiento Detectado',
    RECORDING_ERROR: 'Error de Grabación',
    AUTH_FAILED: 'Fallo de Autenticación',
  }

  const actionRecommendations: Record<string, string> = {
    NVR_OFFLINE: 'Verificar conectividad de red y estado del dispositivo NVR.',
    CAMERA_OFFLINE: 'Verificar cableado, alimentación y configuración de la cámara en el NVR.',
    HDD_FULL: 'Liberar espacio eliminando grabaciones antiguas o agregar capacidad de almacenamiento.',
    HDD_ERROR: 'Revisar el estado físico del disco duro y considerar su reemplazo.',
    MOTION_DETECTED: 'Revisar grabaciones de la cámara afectada.',
    RECORDING_ERROR: 'Verificar configuración de grabación y estado del HDD.',
    AUTH_FAILED: 'Verificar credenciales del NVR en VisionCore.',
  }

  const color = severityColors[alert.severity] || '#64748b'
  const typeLabel = typeLabels[alert.type] || alert.type
  const action = actionRecommendations[alert.type] || 'Revisar el sistema VisionCore.'

  const details: string[] = []
  if (extra.nvrName) details.push(`<tr><td style="color:#94a3b8;padding:4px 0">Dispositivo NVR</td><td style="font-weight:600">${extra.nvrName}</td></tr>`)
  if (extra.cameraName) details.push(`<tr><td style="color:#94a3b8;padding:4px 0">Cámara</td><td style="font-weight:600">${extra.cameraName}</td></tr>`)

  const detailObj = typeof alert.detail === 'string' ? JSON.parse(alert.detail as string) : alert.detail
  if (detailObj && typeof detailObj === 'object') {
    for (const [k, v] of Object.entries(detailObj)) {
      if (k !== 'password' && k !== 'pass' && k !== 'token') {
        details.push(`<tr><td style="color:#94a3b8;padding:4px 0">${k}</td><td>${String(v)}</td></tr>`)
      }
    }
  }

  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#1e293b;border-radius:12px;overflow:hidden">
    <!-- Header -->
    <div style="background:${color};padding:20px 24px">
      <div style="color:white;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;opacity:.85">VisionCore VMS</div>
      <div style="color:white;font-size:20px;font-weight:700;margin-top:4px">⚠️ ${typeLabel}</div>
    </div>
    <!-- Body -->
    <div style="padding:24px">
      <p style="margin:0 0 20px;color:#e2e8f0;font-size:15px">${alert.message}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#e2e8f0">
        <tr><td style="color:#94a3b8;padding:4px 0">Tipo</td><td style="font-weight:600">${typeLabel}</td></tr>
        <tr><td style="color:#94a3b8;padding:4px 0">Severidad</td>
            <td><span style="background:${color};color:white;padding:1px 8px;border-radius:4px;font-size:11px;font-weight:700">${alert.severity}</span></td></tr>
        ${details.join('')}
        <tr><td style="color:#94a3b8;padding:4px 0">Fecha/hora</td><td>${new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion' })}</td></tr>
      </table>
      <div style="margin-top:20px;padding:12px 16px;background:#0f172a;border-radius:8px;border-left:3px solid ${color}">
        <div style="color:#94a3b8;font-size:11px;font-weight:600;text-transform:uppercase;margin-bottom:4px">Acción recomendada</div>
        <div style="color:#e2e8f0;font-size:13px">${action}</div>
      </div>
    </div>
    <div style="padding:12px 24px;background:#0f172a;color:#475569;font-size:11px;text-align:center">
      VisionCore VMS · Notificación automática · No responder a este mensaje
    </div>
  </div>
</body>
</html>`
}

function buildEmailText(alert: AlertForNotification, extra: { nvrName?: string; cameraName?: string } = {}): string {
  const lines = [
    `VisionCore VMS — Alerta: ${alert.type}`,
    `Severidad: ${alert.severity}`,
    `Mensaje: ${alert.message}`,
    extra.nvrName ? `NVR: ${extra.nvrName}` : '',
    extra.cameraName ? `Cámara: ${extra.cameraName}` : '',
    `Fecha: ${new Date().toLocaleString('es-PY')}`,
  ]
  return lines.filter(Boolean).join('\n')
}

export async function sendAlertNotification(
  prisma: PrismaClient,
  alert: AlertForNotification,
): Promise<void> {
  // 1. Cargar settings y verificar reglas
  const settings = await prisma.alertSettings.findUnique({ where: { id: 'singleton' } })
  if (!settings || !settings.emailEnabled) return

  // 2. Verificar severidad mínima
  const minSev = SEVERITY_ORDER[settings.minSeverity] ?? 2
  const alertSev = SEVERITY_ORDER[alert.severity] ?? 0
  if (alertSev < minSev) return

  // 3. Verificar tipo habilitado
  const alertTypes = (typeof settings.alertTypes === 'string'
    ? JSON.parse(settings.alertTypes as string)
    : settings.alertTypes) as Record<string, boolean>
  if (alertTypes[alert.type] === false) return

  // 4. Verificar duplicado — no enviar si ya hay un delivery exitoso reciente (< 30 min)
  const recentDelivery = await prisma.notificationDelivery.findFirst({
    where: {
      alertId: alert.id,
      channel: 'email',
      status: 'sent',
      sentAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
    },
  })
  if (recentDelivery) return

  // 5. Cargar contexto (NVR/cámara)
  const extra: { nvrName?: string; cameraName?: string } = {}
  if (alert.nvrId) {
    const nvr = await prisma.nVR.findUnique({ where: { id: alert.nvrId }, select: { name: true } })
    if (nvr) extra.nvrName = nvr.name
  }
  if (alert.cameraId) {
    const cam = await prisma.camera.findUnique({ where: { id: alert.cameraId }, select: { name: true } })
    if (cam) extra.cameraName = cam.name
  }

  const typeLabels: Record<string, string> = {
    NVR_OFFLINE: 'NVR Offline',
    CAMERA_OFFLINE: 'Cámara Offline',
    HDD_FULL: 'HDD Lleno',
    HDD_ERROR: 'Error de HDD',
    MOTION_DETECTED: 'Movimiento Detectado',
    RECORDING_ERROR: 'Error de Grabación',
    AUTH_FAILED: 'Fallo de Autenticación',
  }

  const subject = `[VisionCore] ${alert.severity}: ${typeLabels[alert.type] || alert.type}${extra.nvrName ? ` — ${extra.nvrName}` : ''}`

  // 6. Registrar delivery pendiente con TODO el contexto denormalizado (tipo,
  //    cámara, NVR, asunto) y la marca del intento — así el historial es completo
  //    aunque la alerta se elimine por retención (P1).
  const attemptedAt = new Date()
  const delivery = await prisma.notificationDelivery.create({
    data: {
      alertId: alert.id,
      channel: 'email',
      status: 'pending',
      recipient: settings.recipientEmails,
      attemptedAt,
      subject,
      alertType: alert.type,
      cameraName: extra.cameraName ?? null,
      nvrName: extra.nvrName ?? null,
    } as any,
  })

  // 7. Enviar email
  const result = await sendAlertEmail(prisma, {
    subject,
    html: buildEmailHtml(alert, extra),
    text: buildEmailText(alert, extra),
  })

  // 8. Actualizar registro. Los FALLIDOS registran failedAt (no dependen de sentAt)
  //    y errorCode; se cuenta el intento (attempts) para el historial.
  const now = new Date()
  await prisma.notificationDelivery.update({
    where: { id: delivery.id },
    data: {
      status: result.success ? 'sent' : 'failed',
      recipient: result.recipient || settings.recipientEmails,
      error: result.error || null,
      errorCode: (result as any).errorCode ?? null,
      sentAt: result.success ? now : null,
      failedAt: result.success ? null : now,
    } as any,
  })
}
