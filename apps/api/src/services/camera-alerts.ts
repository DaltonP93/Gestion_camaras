// Helpers de alertas de salud de cámara: dedup (una alerta no resuelta por
// cámara+tipo), broadcast WS, email y logs estructurados. Centraliza TASK 3/8 y
// evita duplicar la lógica entre CAMERA_OFFLINE y CAMERA_STREAM_ERROR.
// Nunca registra contraseñas, URLs RTSP completas ni JWT.

import type { FastifyInstance } from 'fastify'
import { broadcastAlert } from '../routes/websocket'
import { sendAlertNotification } from './notification.service'

export type CameraAlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export type OfflineType = 'CAMERA_OFFLINE' | 'CAMERA_STREAM_ERROR' | 'STREAM_DEGRADED'
export type RecoveredType = 'CAMERA_RECOVERED' | 'CAMERA_STREAM_RECOVERED'

export interface CamCtx { id: string; name: string; channel: number }
export interface NvrCtx { id: string; name: string }

function normalizeSeverity(s: string | undefined, fallback: CameraAlertSeverity): CameraAlertSeverity {
  const up = (s || '').toUpperCase()
  return (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).includes(up as any) ? (up as CameraAlertSeverity) : fallback
}

/**
 * Crea (o deduplica) una alerta de caída para una cámara. Máximo UNA no resuelta
 * por (cameraId, type). Emite broadcast + email (una vez) y logs estructurados.
 */
export async function raiseCameraAlert(server: FastifyInstance, opts: {
  camera: CamCtx; nvr: NvrCtx; type: OfflineType;
  severity: string; message: string; detail: Record<string, unknown>; sendEmail: boolean;
}): Promise<{ created: boolean; alertId: string }> {
  const severity = normalizeSeverity(opts.severity, opts.type === 'CAMERA_OFFLINE' ? 'HIGH' : 'MEDIUM')
  const existing = await server.prisma.alert.findFirst({
    where: { cameraId: opts.camera.id, type: opts.type as any, resolved: false },
  })
  if (existing) {
    server.log.info(
      `[camera-health] camera_alert_deduplicated cameraId=${opts.camera.id} channel=${opts.camera.channel}` +
      ` type=${opts.type} alertId=${existing.id}`
    )
    return { created: false, alertId: existing.id }
  }
  const alert = await server.prisma.alert.create({
    data: {
      cameraId: opts.camera.id, nvrId: opts.nvr.id, type: opts.type as any,
      severity: severity as any, message: opts.message, detail: opts.detail as any,
    },
  })
  server.log.info(
    `[camera-health] camera_alert_created cameraId=${opts.camera.id} nvrId=${opts.nvr.id}` +
    ` channel=${opts.camera.channel} type=${opts.type} severity=${severity} alertId=${alert.id}`
  )
  broadcastAlert({
    type: 'alert',
    alert: {
      id: alert.id, type: alert.type, severity: alert.severity, message: alert.message,
      cameraId: opts.camera.id, nvrId: opts.nvr.id, nvrName: opts.nvr.name, cameraName: opts.camera.name,
      detail: alert.detail, resolved: false, createdAt: alert.createdAt,
    },
  })
  if (opts.sendEmail) {
    sendAlertNotification(server.prisma, {
      id: alert.id, type: alert.type, severity: alert.severity, message: alert.message,
      detail: alert.detail, cameraId: alert.cameraId, nvrId: alert.nvrId,
    }).catch((e) => server.log.error(`[camera-health] email ${opts.type} error: ${e}`))
  }
  return { created: true, alertId: alert.id }
}

/**
 * Resuelve la alerta de caída activa de la cámara y registra la recuperación como
 * un alert informativo (resolved+read → NO infla la campana). Emite un evento WS
 * `alert_resolved` para bajar el contador sin recargar, y broadcast del registro
 * de recuperación. Email de recuperación una sola vez.
 */
export async function recoverCameraAlert(server: FastifyInstance, opts: {
  camera: CamCtx; nvr: NvrCtx; offlineType: OfflineType; recoveredType: RecoveredType;
  message: string; detail: Record<string, unknown>; sendEmail: boolean;
}): Promise<{ resolved: number }> {
  const active = await server.prisma.alert.findMany({
    where: { cameraId: opts.camera.id, type: opts.offlineType as any, resolved: false },
    select: { id: true },
  })
  if (active.length === 0) return { resolved: 0 }

  const now = new Date()
  await server.prisma.alert.updateMany({
    where: { cameraId: opts.camera.id, type: opts.offlineType as any, resolved: false },
    data: { resolved: true, resolvedAt: now },
  })
  server.log.info(
    `[camera-health] camera_alert_resolved cameraId=${opts.camera.id} channel=${opts.camera.channel}` +
    ` type=${opts.offlineType} count=${active.length}`
  )
  // Bajar el contador de la campana en vivo (sin recargar).
  for (const a of active) broadcastAlert({ type: 'alert_resolved', alertId: a.id })

  // Registro separado de recuperación (resolved+read: no afecta la campana).
  const rec = await server.prisma.alert.create({
    data: {
      cameraId: opts.camera.id, nvrId: opts.nvr.id, type: opts.recoveredType as any,
      severity: 'LOW' as any, message: opts.message, detail: opts.detail as any,
      resolved: true, resolvedAt: now, readAt: now,
    },
  })
  broadcastAlert({
    type: 'alert',
    alert: {
      id: rec.id, type: rec.type, severity: rec.severity, message: rec.message,
      cameraId: opts.camera.id, nvrId: opts.nvr.id, nvrName: opts.nvr.name, cameraName: opts.camera.name,
      resolved: true, resolvedAt: now, readAt: now, createdAt: rec.createdAt,
    },
  })
  if (opts.sendEmail) {
    sendAlertNotification(server.prisma, {
      id: rec.id, type: rec.type, severity: rec.severity, message: rec.message,
      detail: rec.detail, cameraId: rec.cameraId, nvrId: rec.nvrId,
    }).catch((e) => server.log.error(`[camera-health] email ${opts.recoveredType} error: ${e}`))
  }
  return { resolved: active.length }
}

/**
 * Resuelve TODAS las alertas no resueltas de (cameraId, type) sin crear registro
 * de recuperación (para estados informativos como STREAM_DEGRADED). Emite
 * alert_resolved por WS para bajar el contador en vivo.
 */
export async function resolveCameraAlertQuiet(
  server: FastifyInstance, cameraId: string, type: OfflineType,
): Promise<number> {
  const active = await server.prisma.alert.findMany({
    where: { cameraId, type: type as any, resolved: false },
    select: { id: true },
  })
  if (active.length === 0) return 0
  await server.prisma.alert.updateMany({
    where: { cameraId, type: type as any, resolved: false },
    data: { resolved: true, resolvedAt: new Date() },
  })
  for (const a of active) broadcastAlert({ type: 'alert_resolved', alertId: a.id })
  server.log.info(`[camera-health] camera_alert_resolved cameraId=${cameraId} type=${type} count=${active.length} quiet=true`)
  return active.length
}
