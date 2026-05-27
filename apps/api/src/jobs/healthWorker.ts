// apps/api/src/jobs/healthWorker.ts
// Verifica el estado de todos los NVRs y cámaras cada 60 segundos
import cron from 'node-cron'
import type { FastifyInstance } from 'fastify'
import { getNVRStatus, getNVRChannels } from '../services/hikvision'
import { broadcastAlert } from '../routes/websocket'
import { publishStream, getStreamPath, listRegisteredConfigPaths, clearRegisteredPath } from '../services/stream'
import { sendAlertNotification } from '../services/notification.service'
import { cleanupIdleSessions } from '../services/stream-manager'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

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
          const nvrDecrypted = { ...nvr, password: decryptPass(nvr.password) }
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
                  detail: JSON.stringify({ ipAddress: nvr.ipAddress }),
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
                    detail: JSON.stringify({ diskUsage: status.diskUsage }),
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

            // Actualizar onlineInNvr desde ISAPI (informativo; no toca camera.online)
            // camera.online se gestiona exclusivamente por el validador RTSP
            const channels = await getNVRChannels(nvrDecrypted as any)
            for (const channel of channels) {
              const camera = nvr.cameras.find((c) => c.channel === channel.id)
              if (!camera) continue
              const onlineInNvr = channel.online
              // Only update onlineInNvr — never overwrite RTSP-based online field here
              await server.prisma.camera.update({
                where: { id: camera.id },
                data: { onlineInNvr, lastCheck: new Date() } as any,
              })
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
        const nvrDecrypted = { ...nvr, password: decryptPass(nvr.password) }
        for (const camera of nvr.cameras) {
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

  server.log.info('Health worker iniciado (intervalo: 60s)')
}
