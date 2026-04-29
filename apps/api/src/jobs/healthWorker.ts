// apps/api/src/jobs/healthWorker.ts
// Verifica el estado de todos los NVRs y cámaras cada 60 segundos
import cron from 'node-cron'
import type { FastifyInstance } from 'fastify'
import { getNVRStatus, getNVRChannels } from '../services/hikvision'
import { broadcastAlert } from '../routes/websocket'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.JWT_SECRET || 'visioncore_key'
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
            }

            // Marcar cámaras del NVR como offline
            await server.prisma.camera.updateMany({
              where: { nvrId: nvr.id },
              data: { online: false },
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
              }
            }

            // Verificar canales online
            const channels = await getNVRChannels(nvrDecrypted as any)
            for (const channel of channels) {
              const camera = nvr.cameras.find((c) => c.channel === channel.id)
              if (camera && camera.online !== channel.online) {
                await server.prisma.camera.update({
                  where: { id: camera.id },
                  data: { online: channel.online, lastCheck: new Date() },
                })

                if (!channel.online) {
                  const existingCamAlert = await server.prisma.alert.findFirst({
                    where: { cameraId: camera.id, type: 'CAMERA_OFFLINE', resolved: false },
                  })

                  if (!existingCamAlert) {
                    await server.prisma.alert.create({
                      data: {
                        nvrId: nvr.id,
                        cameraId: camera.id,
                        type: 'CAMERA_OFFLINE',
                        severity: 'MEDIUM',
                        message: `Cámara "${camera.name}" offline en ${nvr.name}`,
                      },
                    })
                  }
                } else {
                  await server.prisma.alert.updateMany({
                    where: { cameraId: camera.id, type: 'CAMERA_OFFLINE', resolved: false },
                    data: { resolved: true, resolvedAt: new Date() },
                  })
                }
              }
            }

            await server.prisma.nVR.update({
              where: { id: nvr.id },
              data: { lastSeen: new Date(), firmware: status.firmware },
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

  // Limpiar sesiones expiradas cada hora
  cron.schedule('0 * * * *', async () => {
    await server.prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
  })

  server.log.info('Health worker iniciado (intervalo: 60s)')
}
