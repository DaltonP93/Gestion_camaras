// apps/api/src/jobs/healthWorker.ts
// Verifica el estado de todos los NVRs y cámaras cada 60 segundos
import cron from 'node-cron'
import type { FastifyInstance } from 'fastify'
import { getNVRStatus, getNVRChannels } from '../services/hikvision'
import { broadcastAlert } from '../routes/websocket'
import { publishStream, getStreamPath, listRegisteredConfigPaths, clearRegisteredPath } from '../services/stream'
import { sendAlertNotification } from '../services/notification.service'
import { cleanupIdleSessions } from '../services/stream-manager'
import { decryptNvrPasswordOrNull as decryptPass } from '../services/credentials'

// Throttle DECRYPT_ERROR logs: solo una vez cada 10 minutos por NVR
const decryptErrorLastLog = new Map<string, number>()
const DECRYPT_ERROR_LOG_INTERVAL_MS = 10 * 60 * 1000

function logDecryptError(server: FastifyInstance, nvrId: string, nvrName: string, context: string) {
  const now = Date.now()
  const last = decryptErrorLastLog.get(nvrId) ?? 0
  if (now - last >= DECRYPT_ERROR_LOG_INTERVAL_MS) {
    decryptErrorLastLog.set(nvrId, now)
    server.log.error(`[${context}] DECRYPT_ERROR para NVR ${nvrName} (${nvrId}) — contraseña no descifrable. Verifica NVR_CREDENTIAL_KEY y vuelve a guardar las credenciales del NVR.`)
  }
}

export function startHealthWorker(server: FastifyInstance) {
  // Verificar estado de NVRs cada 60 segundos
  cron.schedule('*/60 * * * * *', async () => {
    try {
      const nvrs = await server.prisma.nVR.findMany({
        where: { active: true },
        include: { cameras: { where: { active: true } } },
      })

      for (const nvr of nvrs) {
        try {
          const plainPass = decryptPass(nvr.password)
          if (!plainPass) {
            logDecryptError(server, nvr.id, nvr.name, 'healthWorker')
            continue
          }
          const nvrDecrypted = { ...nvr, password: plainPass }
          const status = await getNVRStatus(nvrDecrypted as any)

          if (!status.online) {
            // Crear alerta si el NVR está offline
            const existingAlert = await server.prisma.alert.findFirst({
              where: { nvrId: nvr.id, type: 'NVR_OFFLINE', resolved: false },
            })

            if (!existingAlert) {
              const alert = await server.prisma.alert.create({
                data: {
                  nvrId: nvr.id,
                  type: 'NVR_OFFLINE',
                  severity: 'HIGH',
                  message: `NVR ${nvr.name} está offline`,
                  detail: { ipAddress: nvr.ipAddress },
                },
              })

              broadcastAlert({
                type: 'alert',
                alert: {
                  id: alert.id,
                  type: alert.type,
                  severity: alert.severity,
                  message: alert.message,
                  nvrName: nvr.name,
                  createdAt: alert.createdAt,
                },
              })

              // Enviar email automático (no bloquea el worker)
              sendAlertNotification(server.prisma, {
                id: alert.id,
                type: alert.type,
                severity: alert.severity,
                message: alert.message,
                detail: alert.detail,
                nvrId: alert.nvrId,
              }).catch((e) => server.log.error(`Email NVR_OFFLINE: ${e}`))
            }

            // Marcar NVR offline; no tocar camera.online — el validador RTSP lo gestiona
            await server.prisma.nVR.update({
              where: { id: nvr.id },
              data: { online: false },
            })
            await server.prisma.camera.updateMany({
              where: { nvrId: nvr.id },
              data: { onlineInNvr: false } as any,
            })
          } else {
            // NVR online: resolver alerta si existía
            await server.prisma.alert.updateMany({
              where: { nvrId: nvr.id, type: 'NVR_OFFLINE', resolved: false },
              data: { resolved: true, resolvedAt: new Date() },
            })

            // Verificar HDD lleno
            if (status.diskUsage >= 90) {
              const existingDiskAlert = await server.prisma.alert.findFirst({
                where: { nvrId: nvr.id, type: 'HDD_FULL', resolved: false },
              })

              if (!existingDiskAlert) {
                const alert = await server.prisma.alert.create({
                  data: {
                    nvrId: nvr.id,
                    type: 'HDD_FULL',
                    severity: status.diskUsage >= 95 ? 'CRITICAL' : 'HIGH',
                    message: `HDD de ${nvr.name} al ${status.diskUsage}% de capacidad`,
                    detail: { diskUsage: status.diskUsage },
                  },
                })

                broadcastAlert({
                  type: 'alert',
                  alert: { ...alert, nvrName: nvr.name },
                })

                sendAlertNotification(server.prisma, {
                  id: alert.id,
                  type: alert.type,
                  severity: alert.severity,
                  message: alert.message,
                  detail: alert.detail,
                  nvrId: alert.nvrId,
                }).catch((e) => server.log.error(`Email HDD_FULL: ${e}`))
              }
            }

            // Actualizar onlineInNvr desde ISAPI y gestionar alertas CAMERA_OFFLINE
            const channels = await getNVRChannels(nvrDecrypted as any)
            const offlineCameraIds: string[] = []
            const onlineCameraIds: string[] = []

            for (const channel of channels) {
              const camera = nvr.cameras.find((c) => c.channel === channel.id)
              if (!camera) continue
              if (channel.online) {
                onlineCameraIds.push(camera.id)
              } else {
                offlineCameraIds.push(camera.id)
              }
            }

            // Only update onlineInNvr — never overwrite RTSP-based online field
            // here. Batched: 2 updateMany instead of one UPDATE per channel.
            const checkedAt = new Date()
            if (onlineCameraIds.length > 0) {
              await server.prisma.camera.updateMany({
                where: { id: { in: onlineCameraIds } },
                data: { onlineInNvr: true, lastCheck: checkedAt } as any,
              })
            }
            if (offlineCameraIds.length > 0) {
              await server.prisma.camera.updateMany({
                where: { id: { in: offlineCameraIds } },
                data: { onlineInNvr: false, lastCheck: checkedAt } as any,
              })
            }

            // Resolver alertas para cámaras que volvieron online (batch)
            if (onlineCameraIds.length > 0) {
              await server.prisma.alert.updateMany({
                where: { cameraId: { in: onlineCameraIds }, type: 'CAMERA_OFFLINE', resolved: false },
                data: { resolved: true, resolvedAt: new Date() },
              })
            }

            // Crear alertas para cámaras que siguen offline (evitar duplicados)
            for (const cameraId of offlineCameraIds) {
              const existingCamAlert = await server.prisma.alert.findFirst({
                where: { cameraId, type: 'CAMERA_OFFLINE', resolved: false },
              })
              if (!existingCamAlert) {
                const camera = nvr.cameras.find((c) => c.id === cameraId)!
                const alert = await server.prisma.alert.create({
                  data: {
                    cameraId,
                    nvrId: nvr.id,
                    type: 'CAMERA_OFFLINE',
                    severity: 'HIGH',
                    message: `Cámara ${camera.name} sin señal en ${nvr.name}`,
                    detail: { channel: camera.channel, nvrName: nvr.name },
                  },
                })
                broadcastAlert({
                  type: 'alert',
                  alert: { ...alert, nvrName: nvr.name },
                })
                sendAlertNotification(server.prisma, {
                  id: alert.id, type: alert.type, severity: alert.severity,
                  message: alert.message, detail: alert.detail,
                  cameraId: alert.cameraId, nvrId: alert.nvrId,
                }).catch((e) => server.log.error(`Email CAMERA_OFFLINE: ${e}`))
              }
            }

            await server.prisma.nVR.update({
              where: { id: nvr.id },
              data: { online: true, lastSeen: new Date(), firmware: status.firmware },
            })
          }
        } catch (err) {
          server.log.error(`Health check error para NVR ${nvr.name}: ${err}`)
        }
      }
    } catch (err) {
      server.log.error(`Health worker error: ${err}`)
    }
  })

  // Re-registrar paths en MediaMTX cada 5 minutos (recupera reinicios de mediamtx)
  // Solo registra paths que faltan en MediaMTX — evita spam "path already exists" /
  // "reloading configuration" cuando los paths ya existen con la config correcta.
  cron.schedule('*/5 * * * *', async () => {
    try {
      // Obtener qué paths tiene MediaMTX configurados actualmente.
      // Si la API no responde (null), saltar este ciclo sin hacer nada.
      const mediamtxPaths = await listRegisteredConfigPaths()
      if (mediamtxPaths === null) return  // MediaMTX no disponible

      const nvrs = await server.prisma.nVR.findMany({
        where: { active: true },
        include: { cameras: { where: { active: true } } },
      })

      let registered = 0
      for (const nvr of nvrs) {
        const plainPass = decryptPass(nvr.password)
        if (!plainPass) {
          logDecryptError(server, nvr.id, nvr.name, 'healthWorker:streams')
          continue
        }
        const nvrDecrypted = { ...nvr, password: plainPass }
        for (const camera of nvr.cameras) {
          // Skip cameras where RTSP is confirmed down — don't register paths that will 500
          const camRtspSubOk = (camera as any).rtspSubOk as boolean | null
          if (camera.online === false || camRtspSubOk === false) continue
          const path = getStreamPath(nvrDecrypted as any, camera)
          if (!mediamtxPaths.has(path)) {
            // Path ausente en MediaMTX (p.ej. reinicio de MediaMTX) — re-registrar
            clearRegisteredPath(path)  // invalidar cache local para forzar POST
            await publishStream(nvrDecrypted as any, camera)
            registered++
          }
        }
      }

      if (registered > 0) {
        server.log.info(`[healthWorker] ${registered} path(s) re-registrados en MediaMTX tras reinicio`)
      }
    } catch {
      // Silencioso — mediamtx puede estar temporalmente caído
    }
  })

  // Limpiar sesiones de stream idle cada 2 minutos
  cron.schedule('*/2 * * * *', async () => {
    const removed = await cleanupIdleSessions(server)
    if (removed > 0) server.log.info(`[stream-manager] ${removed} sesiones idle eliminadas`)
  })

  // Limpiar sesiones expiradas cada hora
  cron.schedule('0 * * * *', async () => {
    await server.prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
  })

  // Retención de datos: purga diaria (03:30) de tablas que crecen sin límite.
  // Plazos configurables por env; 0 desactiva la purga de esa tabla.
  const ALERTS_RETENTION_DAYS     = Number(process.env.ALERTS_RETENTION_DAYS ?? 90)
  const DELIVERIES_RETENTION_DAYS = Number(process.env.DELIVERIES_RETENTION_DAYS ?? 90)
  const AUDIT_RETENTION_DAYS      = Number(process.env.AUDIT_RETENTION_DAYS ?? 365)
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)

  cron.schedule('30 3 * * *', async () => {
    try {
      let purged = { alerts: 0, deliveries: 0, audit: 0 }
      if (ALERTS_RETENTION_DAYS > 0) {
        // Solo alertas ya resueltas — las activas nunca se purgan
        const r = await server.prisma.alert.deleteMany({
          where: { resolved: true, createdAt: { lt: daysAgo(ALERTS_RETENTION_DAYS) } },
        })
        purged.alerts = r.count
      }
      if (DELIVERIES_RETENTION_DAYS > 0) {
        const r = await server.prisma.notificationDelivery.deleteMany({
          where: { createdAt: { lt: daysAgo(DELIVERIES_RETENTION_DAYS) } },
        })
        purged.deliveries = r.count
      }
      if (AUDIT_RETENTION_DAYS > 0) {
        const r = await server.prisma.auditLog.deleteMany({
          where: { createdAt: { lt: daysAgo(AUDIT_RETENTION_DAYS) } },
        })
        purged.audit = r.count
      }
      if (purged.alerts + purged.deliveries + purged.audit > 0) {
        server.log.info(
          `[retention] purga diaria: alerts=${purged.alerts} (${ALERTS_RETENTION_DAYS}d)` +
          ` deliveries=${purged.deliveries} (${DELIVERIES_RETENTION_DAYS}d)` +
          ` auditLogs=${purged.audit} (${AUDIT_RETENTION_DAYS}d)`
        )
      }
    } catch (err) {
      server.log.error(`[retention] error en purga diaria: ${err}`)
    }
  })

  server.log.info('Health worker iniciado (intervalo: 60s)')
}
