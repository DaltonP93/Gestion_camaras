// apps/api/src/routes/nvr.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  getNVRStatus, getNVRChannels, getIpCameraList,
  getStorageInfo, getNVRUsers, getDeviceInfo, rebootDevice,
  adoptIpCamera, getFreeChannels, debugGetCameraNameSources,
  createNVRUser, updateNVRUser, changeNVRUserPassword, deleteNVRUser,
  testNVRConnection, getIpCameraSourcesDebug, probeInputProxy,
} from '../services/hikvision'
import { publishAllStreams } from '../services/stream'
import { validateAndUpdateCameraHealth } from '../services/stream-validator'
import { AuditAction } from '../services/audit'
import { checkIsapiRecordingSupport, detectProviderFromCapabilities, buildIsapiSearchXml } from '../services/recordingProvider'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'

const encryptPassword = (p: string) => CryptoJS.AES.encrypt(p, ENCRYPTION_KEY).toString()
const decryptPassword = (enc: string) => CryptoJS.AES.decrypt(enc, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

function safeDecrypt(enc: string): string | null {
  try {
    const plain = CryptoJS.AES.decrypt(enc, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)
    return plain || null
  } catch {
    return null
  }
}

// Rechaza valores que claramente son máscaras/placeholders, no contraseñas reales.
function isMaskedPassword(value: string): boolean {
  if (!value) return false
  // Solo puntos, bullets o asteriscos → placeholder visual
  if (/^[•\*•]+$/.test(value)) return true
  // 8 caracteres o menos, todos iguales → placeholder
  if (value.length <= 12 && new Set(value.split('')).size === 1) return true
  return false
}

// Strip debug/non-schema fields before passing a HikStorageDisk to Prisma
function sanitizeDiskForDb(disk: any) {
  const { _rawCapacity, _rawFree, rawCapacity, rawFree, ...dbDisk } = disk
  return dbDisk
}

const connectionTestSchema = z.object({
  nvrId:     z.string().optional(),   // Si está presente y no hay password, usa credencial guardada
  ipAddress: z.string().min(1),
  port:      z.number().int().min(1).max(65535).default(80),
  username:  z.string().min(1),
  password:  z.string().optional(),
})

const nvrSchema = z.object({
  name:     z.string().min(1).max(100),
  model:    z.string().min(1),
  ipAddress: z.string().ip(),
  port:     z.number().int().min(1).max(65535).default(80),
  rtspPort: z.number().int().min(1).max(65535).default(554),
  sdkPort:  z.number().int().min(1).max(65535).default(8000).optional(),
  username: z.string().min(1),
  password: z.string().min(1),
  channels: z.number().int().min(1).max(256),
  hddCount: z.number().int().min(1).max(16).default(1),
  location: z.string().optional(),
})

export const nvrRoutes: FastifyPluginAsync = async (server) => {

  // POST /api/nvrs/test-connection
  server.post('/test-connection', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const raw = connectionTestSchema.parse(request.body)

    // Resolve password: use provided value, or load from stored NVR when editing
    let password = raw.password || ''
    let passwordSource: 'provided' | 'stored' | 'missing' = 'provided'

    if (isMaskedPassword(password)) {
      server.log.warn(`[test-connection] contraseña con valor de máscara recibida — ignorando`)
      password = ''
    }

    if (!password && raw.nvrId) {
      const storedNvr = await server.prisma.nVR.findUnique({ where: { id: raw.nvrId } })
      if (!storedNvr) return reply.status(404).send({ success: false, message: 'NVR no encontrado' })
      const dec = safeDecrypt(storedNvr.password)
      if (!dec) {
        server.log.error(`[test-connection] DECRYPT_ERROR nvrId=${raw.nvrId} name=${storedNvr.name}`)
        return reply.status(422).send({
          success: false,
          errorCode: 'DECRYPT_ERROR',
          message: 'La contraseña guardada no se puede descifrar. Vuelva a guardar la contraseña real del NVR.',
        })
      }
      password = dec
      passwordSource = 'stored'
    }

    if (!password) {
      return reply.status(400).send({ success: false, errorCode: 'PASSWORD_MISSING', message: 'Ingresa la contraseña para probar la conexión' })
    }

    const data = { ipAddress: raw.ipAddress, port: raw.port, username: raw.username, password }
    const result = await testNVRConnection(data)

    server.log.info(`[test-connection] ${data.ipAddress}:${data.port} errorCode=${result.errorCode ?? 'none'} user=${data.username} passwordSource=${passwordSource} reachable=${result.reachable}`)

    if (!result.reachable) {
      const httpStatus = (result.errorCode === 'AUTH_FAILED') ? 422 : 503
      return reply.status(httpStatus).send({
        success: false,
        errorCode: result.errorCode,
        message: result.errorMessage,
        hint: result.hint,
        endpoints: result.endpoints,
      })
    }

    return reply.send({
      success: true,
      firmware: result.firmware,
      model: result.model,
      serialNumber: result.serialNumber,
      ...(result.errorCode ? { errorCode: result.errorCode, warning: result.errorMessage, hint: result.hint } : {}),
      endpoints: result.endpoints,
    })
  })

  // POST /api/nvrs/detect — Auto-detectar info del NVR
  server.post('/detect', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const raw = connectionTestSchema.parse(request.body)

    // Resolve password: use provided value, or load from stored NVR when editing
    let password = raw.password || ''
    let passwordSource: 'provided' | 'stored' | 'missing' = 'provided'

    if (isMaskedPassword(password)) {
      server.log.warn(`[detect] contraseña con valor de máscara recibida — ignorando`)
      password = ''
    }

    if (!password && raw.nvrId) {
      const storedNvr = await server.prisma.nVR.findUnique({ where: { id: raw.nvrId } })
      if (!storedNvr) return reply.status(404).send({ success: false, message: 'NVR no encontrado' })
      const dec = safeDecrypt(storedNvr.password)
      if (!dec) {
        server.log.error(`[detect] DECRYPT_ERROR nvrId=${raw.nvrId} name=${storedNvr.name}`)
        return reply.status(422).send({
          success: false,
          errorCode: 'DECRYPT_ERROR',
          message: 'La contraseña guardada no se puede descifrar. Vuelva a guardar la contraseña real del NVR.',
        })
      }
      password = dec
      passwordSource = 'stored'
    }

    if (!password) {
      return reply.status(400).send({ success: false, errorCode: 'PASSWORD_MISSING', message: 'Ingresa la contraseña para auto-detectar' })
    }

    const data = { ipAddress: raw.ipAddress, port: raw.port, username: raw.username, password }
    const fakeNvr = { id: 'detect', ...data, rtspPort: 554, channels: 0, hddCount: 0, firmware: null } as any

    try {
      const [connResult, info, channels] = await Promise.allSettled([
        testNVRConnection(data),
        getDeviceInfo(fakeNvr),
        getIpCameraList(fakeNvr),
      ])

      const conn = connResult.status === 'fulfilled' ? connResult.value : null

      if (!conn?.reachable) {
        const errorCode = conn?.errorCode ?? 'NETWORK_UNREACHABLE'
        const message   = conn?.errorMessage ?? 'No se pudo conectar al NVR'
        server.log.warn(`[detect] ${data.ipAddress}:${data.port} errorCode=${errorCode} user=${data.username} passwordSource=${passwordSource}`)
        const httpStatus = errorCode === 'AUTH_FAILED' ? 422 : 503
        return reply.status(httpStatus).send({
          success: false, errorCode, message, hint: conn?.hint, endpoints: conn?.endpoints,
        })
      }

      const d = info.status === 'fulfilled' ? info.value : null
      const c = channels.status === 'fulfilled' ? channels.value : []

      server.log.info(`[detect] ${data.ipAddress}:${data.port} ok model=${conn.model || d?.model} channels=${c.length || d?.channelCount}`)
      return reply.send({
        success: true,
        model:           d?.model || conn.model || '',
        serialNumber:    d?.serialNumber || conn.serialNumber || '',
        firmware:        d?.firmware || conn.firmware || '',
        encodingVersion: d?.encodingVersion || '',
        webVersion:      d?.webVersion || '',
        channels:        c.length || d?.channelCount || conn.channelCount || 0,
        hddCount:        d?.hddCount || 0,
        ...(conn.errorCode ? { warning: conn.errorMessage, hint: conn.hint } : {}),
      })
    } catch (err: any) {
      return reply.status(503).send({ success: false, message: err.message })
    }
  })

  // POST /api/nvrs/scan — Escanear subnet
  server.post('/scan', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const scanSchema = z.object({
      subnet:   z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
      port:     z.number().int().min(1).max(65535).default(80),
      start:    z.number().int().min(1).max(254).default(1),
      end:      z.number().int().min(1).max(254).default(254),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    const { subnet, port, start, end, username, password } = scanSchema.parse(request.body)
    const axios = (await import('axios')).default
    const ips = Array.from({ length: Math.max(0, end - start) + 1 }, (_, i) => `${subnet}.${start + i}`)

    const probe = async (ip: string) => {
      try {
        const cfg: any = { timeout: 2000, validateStatus: (s: number) => s < 500 }
        if (username && password) cfg.auth = { username, password }
        const res = await axios.get(`http://${ip}:${port}/ISAPI/System/deviceInfo`, cfg)

        if (res.status === 401) return { ip, port, requiresAuth: true, model: '', serialNumber: '', firmware: '' }
        if (res.status === 200) {
          const xml = typeof res.data === 'string' ? res.data : ''
          const g   = (t: string) => xml.match(new RegExp(`<${t}>([^<]+)</${t}>`))?.[1] || ''
          return {
            ip, port, requiresAuth: false,
            model: g('model') || g('deviceType'),
            serialNumber: g('serialNumber'),
            firmware: g('firmwareVersion'),
            macAddress: g('macAddress'),
            deviceName: g('deviceName'),
          }
        }
      } catch {}
      return null
    }

    const BATCH_SIZE = 50
    const discovered: any[] = []
    for (let i = 0; i < ips.length; i += BATCH_SIZE) {
      const results = await Promise.all(ips.slice(i, i + BATCH_SIZE).map(probe))
      results.forEach(r => { if (r) discovered.push(r) })
    }

    return reply.send({ scanned: ips.length, discovered })
  })

  // GET /api/nvrs
  server.get('/', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = request.user
    let nvrs

    const nvrInclude = {
      cameras: { select: { id: true, channel: true, name: true, online: true, active: true, channelCode: true } },
      hdds: { orderBy: { diskNumber: 'asc' as const } },
    }

    if (['ADMIN', 'SUPERVISOR'].includes(user.role)) {
      nvrs = await server.prisma.nVR.findMany({
        include: nvrInclude,
        orderBy: { name: 'asc' },
      })
    } else {
      const permissions = await server.prisma.userPermission.findMany({
        where: { userId: user.sub, nvrId: { not: null } },
        select: { nvrId: true },
      })
      const nvrIds = permissions.map((p: any) => p.nvrId!).filter(Boolean)
      nvrs = await server.prisma.nVR.findMany({
        where: { id: { in: nvrIds } },
        include: nvrInclude,
        orderBy: { name: 'asc' },
      })
    }

    return reply.send(nvrs.map((nvr: any) => ({ ...nvr, password: undefined })))
  })

  async function userCanAccessNvr(userId: string, role: string, nvrId: string): Promise<boolean> {
    if (role === 'ADMIN' || role === 'SUPERVISOR') return true
    const perm = await server.prisma.userPermission.findFirst({
      where: { userId, OR: [{ nvrId }, { camera: { nvrId } }] },
      select: { id: true },
    })
    return !!perm
  }

  // GET /api/nvrs/:id
  server.get('/:id', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!await userCanAccessNvr(u.sub, u.role, id)) return reply.status(403).send({ message: 'Sin permiso' })

    const nvr = await server.prisma.nVR.findUnique({
      where: { id },
      include: { cameras: true, hdds: { orderBy: { diskNumber: 'asc' } } },
    })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })
    return reply.send({ ...nvr, password: undefined })
  })

  // GET /api/nvrs/:id/status — Estado en tiempo real
  server.get('/:id/status', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!await userCanAccessNvr(u.sub, u.role, id)) return reply.status(403).send({ message: 'Sin permiso' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const status = await getNVRStatus(nvrDec as any)

    if (status.online) {
      await server.prisma.nVR.update({ where: { id }, data: { lastSeen: new Date(), firmware: status.firmware } })
    }

    return reply.send(status)
  })

  // GET /api/nvrs/:id/device-info — Información detallada del dispositivo
  server.get('/:id/device-info', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!await userCanAccessNvr(u.sub, u.role, id)) return reply.status(403).send({ message: 'Sin permiso' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const info   = await getDeviceInfo(nvrDec as any)
    if (!info) return reply.status(503).send({ message: 'No se pudo obtener info del dispositivo' })

    return reply.send(info)
  })

  // GET /api/nvrs/:id/storage — HDDs del NVR
  server.get('/:id/storage', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!await userCanAccessNvr(u.sub, u.role, id)) return reply.status(403).send({ message: 'Sin permiso' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    let disks: any[] = []
    let storageSupported = true
    let storageReason: string | undefined

    try {
      disks = await getStorageInfo(nvrDec as any)
      for (const disk of disks) {
        const dbDisk = sanitizeDiskForDb(disk)
        await server.prisma.nvrHdd.upsert({
          where: { nvrId_diskNumber: { nvrId: id, diskNumber: dbDisk.diskNumber } },
          create: { nvrId: id, ...dbDisk, lastSyncAt: new Date() },
          update: { ...dbDisk, lastSyncAt: new Date() },
        })
      }
    } catch (e: any) {
      if ((e as any).unsupported) {
        storageSupported = false
        const httpSt = (e as any).httpStatus
        const permDenied = (e as any).permissionDenied
        storageReason = permDenied
          ? `Usuario sin permiso para leer almacenamiento (HTTP ${httpSt}) — usa un usuario Administrador del NVR`
          : `No soportado por este modelo/firmware (HTTP ${httpSt})`
        server.log.warn(`[storage] ${nvr.name} (${nvr.ipAddress}): ${e.message}`)
      } else {
        server.log.error({ err: e }, '[storage] Error sincronizando HDDs del NVR')
        return reply.status(500).send({ message: 'No se pudo sincronizar almacenamiento del NVR. Ver logs del servidor.' })
      }
    }

    return reply.send({
      disks,
      supported: storageSupported,
      ...(storageReason ? { reason: storageReason } : {}),
      syncedAt: new Date().toISOString(),
    })
  })

  // GET /api/nvrs/:id/users — Usuarios configurados en el NVR
  server.get('/:id/users', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    let users: any[] = []
    let usersSupported = true
    let usersReason: string | undefined

    try {
      users = await getNVRUsers(nvrDec as any)
    } catch (e: any) {
      if ((e as any).unsupported) {
        usersSupported = false
        const httpSt = (e as any).httpStatus
        const permDenied = (e as any).permissionDenied
        usersReason = permDenied
          ? `Usuario sin permiso para gestión de usuarios (HTTP ${httpSt}) — usa un usuario Administrador del NVR`
          : `No soportado por este modelo/firmware (HTTP ${httpSt})`
        server.log.warn(`[users] ${nvr.name} (${nvr.ipAddress}): ${e.message}`)
      } else {
        throw e
      }
    }

    return reply.send({
      users,
      supported: usersSupported,
      ...(usersReason ? { reason: usersReason } : {}),
    })
  })

  // GET /api/nvrs/:id/cameras — Cámaras IP del NVR desde ISAPI
  server.get('/:id/cameras', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!await userCanAccessNvr(u.sub, u.role, id)) return reply.status(403).send({ message: 'Sin permiso' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const ipCams = await getIpCameraList(nvrDec as any)

    // También retornar las cámaras de DB
    const dbCams = await server.prisma.camera.findMany({
      where: { nvrId: id },
      orderBy: { channel: 'asc' },
    })

    return reply.send({ fromNvr: ipCams, fromDb: dbCams })
  })

  // POST /api/nvrs/:id/sync — Sincronización completa del NVR
  server.post('/:id/sync', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const result = { synced: 0, failed: 0, cameras: 0, hdds: 0, errors: [] as string[] }

    // 1. Estado del NVR
    const status = await getNVRStatus(nvrDec as any)

    // 2. Info del dispositivo
    const info = await getDeviceInfo(nvrDec as any)

    // 3. Actualizar NVR en DB
    await server.prisma.nVR.update({
      where: { id },
      data: {
        online:          status.online,
        lastSeen:        status.online ? new Date() : undefined,
        firmware:        info?.firmware || status.firmware || undefined,
        encodingVersion: info?.encodingVersion || undefined,
        webVersion:      info?.webVersion || undefined,
        lastSyncAt:      new Date(),
        lastError:       status.online ? null : `Offline: ${status.errorReason}`,
      },
    })

    // 4. Obtener cámaras IP reales del NVR
    const ipCams = await getIpCameraList(nvrDec as any)

    // 5. Upsert cámaras en DB (sin duplicar)
    for (const cam of ipCams) {
      try {
        // onlineInNvr: lo que reporta el NVR vía ISAPI (puede ser unreliable)
        // null = NVR no reportó estado; false = NVR reportó explícitamente offline
        const onlineInNvr: boolean | null = cam.status
          ? (cam.status.toLowerCase().includes('online') || cam.status.toLowerCase().includes('en línea'))
          : null
        await server.prisma.camera.upsert({
          where:  { nvrId_channel: { nvrId: id, channel: cam.channel } },
          create: {
            nvrId:          id,
            channel:        cam.channel,
            channelCode:    cam.channelCode,
            name:           cam.name,
            ipAddress:      cam.ipAddress,
            protocol:       cam.protocol,
            managementPort: cam.managementPort,
            securityStatus: cam.securityStatus,
            online:         onlineInNvr ?? false,
            onlineInNvr:    onlineInNvr,
            lastSyncAt:     new Date(),
          },
          update: {
            channelCode:    cam.channelCode,
            name:           cam.name,
            ipAddress:      cam.ipAddress,
            protocol:       cam.protocol,
            managementPort: cam.managementPort,
            securityStatus: cam.securityStatus,
            onlineInNvr:    onlineInNvr,
            // Only force online=true if NVR confirms; never force to false here —
            // validateAndUpdateCameraHealth sets online=true when RTSP works.
            ...(onlineInNvr === true ? { online: true } : {}),
            lastSyncAt:     new Date(),
          },
        })
        result.cameras++
      } catch (e: any) {
        result.errors.push(`Canal ${cam.channel}: ${e.message}`)
      }
    }

    // Si no hay cámaras IP del NVR, intentar actualizar nombres desde VideoInput o crear entradas genéricas
    if (ipCams.length === 0) {
      const existing = await server.prisma.camera.count({ where: { nvrId: id } })
      if (existing === 0) {
        const channelCount = info?.channelCount || nvr.channels
        for (let ch = 1; ch <= channelCount; ch++) {
          try {
            await server.prisma.camera.create({
              data: { nvrId: id, channel: ch, channelCode: `D${ch}`, name: `Canal ${ch}` },
            })
            result.cameras++
          } catch {}
        }
      } else {
        // Try to get real names from VideoInput and update existing cameras
        try {
          const channels = await getNVRChannels(nvrDec as any)
          for (const ch of channels) {
            const isGenericName = !ch.name || /^(Canal\s*\d+|D\d+|IPCamera\s*\d*|Camera\s*\d*)$/i.test(ch.name.trim())
            if (!isGenericName) {
              await server.prisma.camera.updateMany({
                where: { nvrId: id, channel: ch.id },
                data: { name: ch.name },
              })
            }
          }
        } catch {}
      }
    }

    // 6. HDDs — algunos modelos no soportan /ISAPI/ContentMgmt/Storage (403/404/405)
    try {
      const disks = await getStorageInfo(nvrDec as any)
      for (const disk of disks) {
        try {
          const dbDisk = sanitizeDiskForDb(disk)
          await server.prisma.nvrHdd.upsert({
            where:  { nvrId_diskNumber: { nvrId: id, diskNumber: dbDisk.diskNumber } },
            create: { nvrId: id, ...dbDisk, lastSyncAt: new Date() },
            update: { ...dbDisk, lastSyncAt: new Date() },
          })
          result.hdds++
        } catch {}
      }
    } catch (e: any) {
      if (!(e as any).unsupported) {
        result.errors.push(`HDDs: ${e.message}`)
      }
      // unsupported: modelo no soporta storage ISAPI — continuar sync sin HDDs
    }

    // 7. Trigger async RTSP health check for cameras that need it (fire and forget).
    // Cameras with UNKNOWN status are always re-checked (may have been created before codec detection).
    // NOTE: validateAndUpdateCameraHealth decrypts the password internally — pass nvr as-is from DB.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const camerasToProbe = await server.prisma.camera.findMany({
      where: {
        nvrId: id,
        active: true,
        OR: [
          { lastRtspCheckAt: null },
          { lastRtspCheckAt: { lt: oneHourAgo } },
          { streamHealthStatus: 'UNKNOWN' },
        ],
      },
      include: { nvr: true },
    })

    if (camerasToProbe.length > 0) {
      Promise.all(
        camerasToProbe.map(cam =>
          validateAndUpdateCameraHealth(server.prisma, cam.nvr as any, cam as any)
            .catch(() => {})
        )
      ).catch(() => {})
    }

    await AuditAction(server.prisma, request.user.sub, 'NVR_SYNCED', id, request, result)

    return reply.send({ success: true, ...result, syncedAt: new Date().toISOString() })
  })

  // POST /api/nvrs/:id/sync-cameras — Sincronizar metadatos de cámaras IP desde NVR
  server.post('/:id/sync-cameras', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const decPass = safeDecrypt(nvr.password)
    if (!decPass) {
      return reply.status(422).send({ success: false, errorCode: 'DECRYPT_ERROR', message: 'Contraseña no descifrable. Vuelve a guardar las credenciales del NVR.' })
    }
    const nvrDec = { ...nvr, password: decPass }

    // Probe InputProxy first to determine ISAPI access level.
    // probeInputProxy never throws — returns semantic status string.
    const isapIStatus = await probeInputProxy(nvrDec as any)
    server.log.info(`[sync-cameras] ${nvr.name} InputProxy probe: ${isapIStatus}`)

    // Persist ISAPI status on NVR so frontend can show semantic states without another API call
    await server.prisma.nVR.update({ where: { id }, data: { isapIStatus } })

    if (isapIStatus === 'no_permission') {
      return reply.status(403).send({
        success: false,
        errorCode: 'ISAPI_PERMISSION_DENIED',
        isapIStatus,
        message: 'Sin permiso ISAPI (HTTP 403/401) para leer Cámara IP. Usa un usuario Administrador del NVR.',
      })
    }

    if (isapIStatus === 'unsupported') {
      server.log.info(`[sync-cameras] ${nvr.name} InputProxy no soportado — continuando con fallbacks (VideoInput / Streaming / getNVRChannels)`)
    }

    // isapIStatus === 'available' | 'unsupported' | 'error' | 'unknown' — proceed with getIpCameraList
    // getIpCameraList has its own fallback chain: InputProxy → VideoInput → Streaming → getNVRChannels
    const ipCams = await getIpCameraList(nvrDec as any)

    // Log first 5 cameras so we can diagnose name/source issues from server logs
    server.log.info(
      `[sync-cameras] ${nvr.name} ipCams sample: ${ipCams.slice(0, 5).map(c => `ch${c.channel}:src=${c.metadataSource}:name="${c.name}"`).join(', ')}`
    )

    const isPlaceholder = (name?: string | null): boolean => {
      if (!name) return true
      const n = name.trim()
      return (
        /^canal\s+\d+$/i.test(n) ||
        /^c[aá]mara\s+\d+$/i.test(n) ||
        /^camera\s*\d*$/i.test(n) ||
        /^ipcamera\s*\d*$/i.test(n) ||
        /^d\d+$/i.test(n) ||
        /^channel\s+\d+$/i.test(n) ||
        /^\d{3,4}$/.test(n) ||
        n === ''
      )
    }

    const syncLog: Array<{ channel: number; source: string; changes: string[] }> = []
    let synced = 0
    let updatedMetadata = 0
    let preservedMetadata = 0
    let ipUpdated = 0
    let portUpdated = 0
    let nameUpdated = 0
    let nameCandidates = 0
    let skippedNameBecauseEmpty = 0
    let skippedNameBecauseNotPlaceholder = 0
    let statusUpdated = 0
    let skipped = 0

    const forceNames = (request.query as any).forceNames === 'true' || (request.body as any)?.forceNames === true

    for (const cam of ipCams) {
      const existing = await server.prisma.camera.findUnique({
        where: { nvrId_channel: { nvrId: id, channel: cam.channel } },
        select: { id: true, name: true, ipAddress: true, managementPort: true, protocol: true },
      })
      if (!existing) continue

      const changes: Partial<{
        name: string; ipAddress: string; managementPort: number
        protocol: string; securityStatus: string; onlineInNvr: boolean; channelCode: string; lastSyncAt: Date
      }> = {}
      const changeLog: string[] = []

      // Only InputProxy (channels or status endpoint) carries real IP/port/protocol/status data.
      // VideoInput and Streaming provide names only; fallback provides nothing reliable.
      // inputproxy_status_secure = status-only response from /channels?security=1 (IP/port/online but no name)
      const isFromInputProxy = cam.metadataSource === 'inputproxy_channels_secure' ||
                               cam.metadataSource === 'inputproxy_channels' ||
                               cam.metadataSource === 'inputproxy_status_secure' ||
                               cam.metadataSource === 'inputproxy_status'
      // Name candidates: sources that can actually supply real camera names
      const hasRealName      = cam.metadataSource === 'inputproxy_channels_secure' ||
                               cam.metadataSource === 'inputproxy_channels' ||
                               cam.metadataSource === 'videoinput' ||
                               cam.metadataSource === 'streaming'

      // Name: update when real name available AND (DB has placeholder OR forceNames=true)
      if (hasRealName) {
        if (!cam.name || isPlaceholder(cam.name)) {
          skippedNameBecauseEmpty++
          server.log.debug(`[sync-cameras] ch${cam.channel} name skip: cam.name="${cam.name}" is empty/placeholder (src=${cam.metadataSource})`)
        } else if (!isPlaceholder(existing.name) && !forceNames) {
          skippedNameBecauseNotPlaceholder++
          server.log.debug(`[sync-cameras] ch${cam.channel} name skip: existing="${existing.name}" not placeholder, forceNames=${forceNames}`)
        } else {
          nameCandidates++
          changes.name = cam.name
          changeLog.push(`name: "${cam.name}"`)
          nameUpdated++
          server.log.info(`[sync-cameras] ch${cam.channel} name: "${existing.name}" → "${cam.name}" (src=${cam.metadataSource} forceNames=${forceNames})`)
        }
      }

      // IP: only from InputProxy — other sources don't have IP at all
      if (isFromInputProxy && cam.ipAddress && cam.ipAddress !== existing.ipAddress) {
        changes.ipAddress = cam.ipAddress
        changeLog.push(`ip: ${cam.ipAddress}`)
        ipUpdated++
      }

      // Port: only from InputProxy AND only when an ipAddress is also known
      // (port alone without IP is meaningless and would show "—:8000" in UI)
      if (isFromInputProxy && cam.managementPort > 0 && cam.ipAddress && cam.managementPort !== existing.managementPort) {
        changes.managementPort = cam.managementPort
        changeLog.push(`port: ${cam.managementPort}`)
        portUpdated++
      }

      // Protocol: only from InputProxy
      if (isFromInputProxy && cam.protocol && cam.protocol !== existing.protocol) {
        changes.protocol = cam.protocol
        changeLog.push(`protocol: ${cam.protocol}`)
      }

      // onlineInNvr: only from InputProxy (status is set by InputProxy status endpoint)
      const statusStr = (cam.status || '').toLowerCase()
      if (isFromInputProxy && (statusStr === 'online' || statusStr === 'offline')) {
        changes.onlineInNvr = statusStr === 'online'
        changeLog.push(`onlineInNvr: ${changes.onlineInNvr}`)
        statusUpdated++
      }

      // securityStatus: only from InputProxy
      if (isFromInputProxy && (cam.passwordStatus || cam.chanDetectResult)) {
        changes.securityStatus = cam.passwordStatus || cam.chanDetectResult || ''
        changeLog.push(`securityStatus: ${changes.securityStatus}`)
      }

      // channelCode and lastSyncAt are always written — derived from channel number, always reliable
      changes.channelCode = cam.channelCode || `D${cam.channel}`
      changes.lastSyncAt = new Date()

      await server.prisma.camera.update({ where: { id: existing.id }, data: changes as any })

      if (changeLog.length > 0) {
        syncLog.push({ channel: cam.channel, source: cam.metadataSource, changes: changeLog })
        synced++
        if (isFromInputProxy) updatedMetadata++
      } else {
        if (!isFromInputProxy) preservedMetadata++
        skipped++
      }
    }

    // Determine the best metadata source used across all cameras
    const sourcePriority = ['inputproxy_channels_secure', 'inputproxy_channels', 'inputproxy_status_secure', 'inputproxy_status', 'videoinput', 'streaming', 'fallback'] as const
    const usedSources = new Set(ipCams.map(c => c.metadataSource))
    const sourceUsed = sourcePriority.find(s => usedSources.has(s)) ?? 'none'

    const hasRealIpSource = sourceUsed === 'inputproxy_channels_secure' || sourceUsed === 'inputproxy_channels' ||
                            sourceUsed === 'inputproxy_status_secure' || sourceUsed === 'inputproxy_status'
    const warning = !hasRealIpSource
      ? `Sin acceso a datos IP desde ISAPI (fuente: ${sourceUsed}). IP, puerto, protocolo y estado no se actualizaron — se conservaron datos existentes. Use el diagnóstico de endpoints para identificar el endpoint correcto.`
      : undefined

    // Determine if real names were synced or if this model lacks a name source
    const nameSource: 'real' | 'none' = nameUpdated > 0 ? 'real' : 'none'
    let nameReason: string | undefined
    if (nameSource === 'none') {
      if (sourceUsed === 'inputproxy_status_secure' || sourceUsed === 'inputproxy_status') {
        nameReason = '/InputProxy/channels devuelve estructura de estado sin nombres. Los nombres deben configurarse manualmente en el NVR o vía interfaz web.'
      } else if (sourceUsed === 'inputproxy_channels_secure' || sourceUsed === 'inputproxy_channels') {
        nameReason = 'Los nombres en el NVR son genéricos (Canal 1, D1…). Configure nombres reales en la interfaz del NVR.'
      } else if (sourceUsed === 'videoinput' || sourceUsed === 'streaming') {
        nameReason = 'VideoInput/Streaming solo devuelven nombres genéricos en este modelo.'
      } else {
        nameReason = 'Ningún endpoint ISAPI disponible expone nombres reales de cámara.'
      }
    }

    server.log.info(`[sync-cameras] ${nvr.name} sourceUsed=${sourceUsed} nameCandidates=${nameCandidates} nameUpdated=${nameUpdated} ipUpdated=${ipUpdated} portUpdated=${portUpdated} statusUpdated=${statusUpdated} skipped=${skipped} total=${ipCams.length} isapIStatus=${isapIStatus} forceNames=${forceNames}`)
    await AuditAction(server.prisma, request.user.sub, 'NVR_CAMERAS_SYNCED', id, request, { synced, total: ipCams.length, isapIStatus, sourceUsed, ipUpdated, nameUpdated })

    return reply.send({
      success: true,
      total: ipCams.length,
      synced,
      ipUpdated,
      portUpdated,
      nameUpdated,
      nameCandidates,
      skippedNameBecauseEmpty,
      skippedNameBecauseNotPlaceholder,
      statusUpdated,
      skipped,
      updatedMetadata,
      preservedMetadata,
      sourceUsed,
      isapIStatus,
      nameSource,
      nameReason,
      warning,
      log: syncLog,
      syncedAt: new Date().toISOString(),
    })
  })

  // GET /api/nvrs/:id/ip-camera-sources-debug — Diagnóstico de endpoints ISAPI
  server.get('/:id/ip-camera-sources-debug', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const plain = safeDecrypt(nvr.password)
    if (!plain) {
      return reply.status(422).send({ success: false, errorCode: 'DECRYPT_ERROR', message: 'Contraseña no descifrable. Vuelve a guardar las credenciales del NVR.' })
    }

    const nvrDec = { ...nvr, password: plain }
    const results = await getIpCameraSourcesDebug(nvrDec as any)

    return reply.send({ nvr: { id: nvr.id, name: nvr.name, ipAddress: nvr.ipAddress, port: nvr.port }, endpoints: results })
  })

  // POST /api/nvrs/:id/sync-streams — Solo re-registrar streams en MediaMTX
  server.post('/:id/sync-streams', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const cameras  = await server.prisma.camera.findMany({ where: { nvrId: id, active: true } })
    const nvrDec   = { ...nvr, password: decryptPassword(nvr.password) }
    const result   = await publishAllStreams(nvrDec as any, cameras)

    return reply.send({ success: true, synced: result.success, failed: result.failed, total: cameras.length })
  })

  // POST /api/nvrs/:id/force-names-sync — Forzar sincronización de nombres reales de cámaras
  server.post('/:id/force-names-sync', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }

    // Obtener nombres desde ambos endpoints
    const [ipCams, nvrcChannels] = await Promise.all([
      getIpCameraList(nvrDec as any),
      getNVRChannels(nvrDec as any).catch(() => [] as Awaited<ReturnType<typeof getNVRChannels>>),
    ])

    // Build map of channel → name from NVRChannels (VideoInput names)
    const videoInputNames = new Map<number, string>()
    for (const ch of nvrcChannels) {
      if (ch.name) videoInputNames.set(ch.id, ch.name)
    }

    // Placeholder detection: matches auto-generated names and Hikvision streaming channel IDs
    const isPlaceholder = (n: string) =>
      !n ||
      /^(IPCamera\s*\d*|Camera\s*\d*|Canal\s*\d*|Channel\s*\d*|D\d+)$/i.test(n.trim()) ||
      /^\d{3,4}$/.test(n.trim())  // Hikvision stream IDs: 101, 201, 1201 etc.

    // Load current DB names to avoid overwriting real names with placeholders
    const existingCameras = await server.prisma.camera.findMany({
      where: { nvrId: id },
      select: { channel: true, name: true },
    })
    const existingNames = new Map(existingCameras.map(c => [c.channel, c.name]))

    const syncLog: Array<{
      channel: number
      channelCode: string
      name: string
      ipAddress: string
      protocol: string
      source: 'input_proxy' | 'video_input' | 'merged' | 'preserved'
      previous?: string
    }> = []

    for (const cam of ipCams) {
      const videoName = videoInputNames.get(cam.channel) || ''
      const currentDbName = existingNames.get(cam.channel) || ''

      let bestName = cam.name
      let source: 'input_proxy' | 'video_input' | 'merged' | 'preserved' = 'input_proxy'

      if (isPlaceholder(cam.name) && !isPlaceholder(videoName)) {
        bestName = videoName
        source = 'video_input'
      } else if (!isPlaceholder(cam.name) && !isPlaceholder(videoName) && cam.name !== videoName) {
        source = 'merged'
      }

      // Never overwrite a real DB name with a placeholder — keep whatever is already good
      if (isPlaceholder(bestName) && !isPlaceholder(currentDbName)) {
        bestName = currentDbName
        source = 'preserved'
      }

      await server.prisma.camera.updateMany({
        where: { nvrId: id, channel: cam.channel },
        data: { name: bestName, lastSyncAt: new Date() },
      })

      syncLog.push({
        channel:     cam.channel,
        channelCode: cam.channelCode,
        name:        bestName,
        ipAddress:   cam.ipAddress,
        protocol:    cam.protocol,
        source,
        ...(source === 'preserved' ? { previous: currentDbName } : {}),
      })
    }

    await AuditAction(server.prisma, request.user.sub, 'NVR_NAMES_SYNCED', id, request, { count: syncLog.length })

    // Include per-endpoint debug info so admins can diagnose parsing issues
    const debug = await debugGetCameraNameSources(nvrDec as any).catch(() => null)

    return reply.send({ success: true, synced: syncLog.length, log: syncLog, debug })
  })

  // POST /api/nvrs/:id/validate-health — Forzar validación RTSP de todas las cámaras
  server.post('/:id/validate-health', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const cameras = await server.prisma.camera.findMany({ where: { nvrId: id, active: true } })

    // Fire and forget — each probe can take up to 15s; return count immediately.
    // validateAndUpdateCameraHealth decrypts the password internally — pass nvr as-is from DB.
    Promise.all(
      cameras.map(cam =>
        validateAndUpdateCameraHealth(server.prisma, nvr as any, cam as any).catch(() => {})
      )
    ).catch(() => {})

    return reply.send({ success: true, validating: cameras.length, message: `Validando ${cameras.length} cámaras en segundo plano...` })
  })

  // POST /api/nvrs/:id/reboot — Reiniciar NVR
  server.post('/:id/reboot', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const ok = await rebootDevice(nvrDec as any)

    await AuditAction(server.prisma, request.user.sub, 'NVR_REBOOT', id, request)

    if (!ok) return reply.status(503).send({ success: false, message: 'No se pudo reiniciar el NVR' })
    return reply.send({ success: true, message: 'NVR reiniciando...' })
  })

  // POST /api/nvrs/:id/onboard — Pipeline completo de onboarding (detect + sync + validate)
  // Llamado automáticamente tras crear una NVR nueva, o manualmente desde el detalle.
  server.post('/:id/onboard', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const decPass = safeDecrypt(nvr.password)
    if (!decPass) {
      return reply.status(422).send({ success: false, errorCode: 'DECRYPT_ERROR', message: 'Contraseña no descifrable. Vuelve a guardar las credenciales del NVR.' })
    }
    const nvrDec = { ...nvr, password: decPass }
    const result: Record<string, any> = {}

    // Step 1: Connection test
    const conn = await testNVRConnection(nvrDec as any).catch(() => null)
    result.connection = { ok: conn?.reachable ?? false, errorCode: conn?.errorCode }
    if (!conn?.reachable) {
      server.log.warn(`[onboard] ${nvr.name} (${nvr.ipAddress}) connection failed: ${conn?.errorCode ?? 'NETWORK_UNREACHABLE'}`)
    }

    // Step 2: Device info
    const info = await getDeviceInfo(nvrDec as any).catch(() => null)
    if (info) {
      await server.prisma.nVR.update({
        where: { id },
        data: {
          firmware:        info.firmware        || undefined,
          encodingVersion: info.encodingVersion || undefined,
          webVersion:      info.webVersion      || undefined,
          online:          conn?.reachable ?? true,
          lastSeen:        conn?.reachable ? new Date() : undefined,
          lastSyncAt:      new Date(),
          lastError:       conn?.reachable ? null : undefined,
        },
      })
      result.deviceInfo = { model: info.model, firmware: info.firmware, channels: info.channelCount, hdds: info.hddCount }
    }

    // Step 3: ISAPI probe
    const isapIStatus = await probeInputProxy(nvrDec as any)
    await server.prisma.nVR.update({ where: { id }, data: { isapIStatus } })
    result.isapIStatus = isapIStatus

    // Step 4: Sync cameras from ISAPI
    const ipCams = await getIpCameraList(nvrDec as any)
    const sourcePriority = ['inputproxy_channels_secure', 'inputproxy_channels', 'inputproxy_status_secure', 'inputproxy_status', 'videoinput', 'streaming', 'fallback'] as const
    const usedSources = new Set(ipCams.map((c: any) => c.metadataSource))
    const sourceUsed = sourcePriority.find(s => usedSources.has(s)) ?? 'none'

    const isPlaceholder = (name?: string | null): boolean => {
      if (!name) return true
      const n = name.trim()
      return /^canal\s+\d+$/i.test(n) || /^c[aá]mara\s+\d+$/i.test(n) || /^camera\s*\d*$/i.test(n) ||
             /^ipcamera\s*\d*$/i.test(n) || /^d\d+$/i.test(n) || /^channel\s+\d+$/i.test(n) ||
             /^\d{3,4}$/.test(n) || n === ''
    }

    let nameUpdated = 0, ipUpdated = 0, portUpdated = 0, camerasSynced = 0

    for (const cam of ipCams) {
      const onlineInNvr = (cam.status || '').toLowerCase() === 'online'
      const isFromInputProxy = ['inputproxy_channels_secure', 'inputproxy_channels', 'inputproxy_status_secure', 'inputproxy_status'].includes(cam.metadataSource)

      try {
        const existing = await server.prisma.camera.findUnique({
          where: { nvrId_channel: { nvrId: id, channel: cam.channel } },
        })

        const updates: any = { channelCode: cam.channelCode || `D${cam.channel}`, lastSyncAt: new Date() }

        if (cam.name && !isPlaceholder(cam.name)) {
          updates.name = cam.name
          if (!existing || isPlaceholder(existing.name)) nameUpdated++
        }
        if (isFromInputProxy) {
          if (cam.ipAddress && cam.ipAddress !== existing?.ipAddress) { updates.ipAddress = cam.ipAddress; if (existing) ipUpdated++ }
          if (cam.managementPort > 0 && cam.ipAddress) { updates.managementPort = cam.managementPort; if (existing && cam.managementPort !== existing.managementPort) portUpdated++ }
          if (cam.protocol) updates.protocol = cam.protocol
          if (cam.securityStatus) updates.securityStatus = cam.securityStatus
          updates.onlineInNvr = onlineInNvr
          if (onlineInNvr) updates.online = true
        }

        if (existing) {
          await server.prisma.camera.update({ where: { id: existing.id }, data: updates })
        } else {
          await server.prisma.camera.create({
            data: {
              nvrId: id, channel: cam.channel,
              name: (!cam.name || isPlaceholder(cam.name)) ? `Canal ${cam.channel}` : cam.name,
              ...updates,
            },
          })
        }
        camerasSynced++
      } catch {}
    }

    // If no cameras from ISAPI and none in DB, create placeholders
    const dbCameraCount = await server.prisma.camera.count({ where: { nvrId: id } })
    if (dbCameraCount === 0) {
      const channelCount = info?.channelCount || nvr.channels
      const cameraData = Array.from({ length: channelCount }, (_, i) => ({
        nvrId: id, channel: i + 1, channelCode: `D${i + 1}`, name: `Canal ${i + 1}`,
      }))
      await server.prisma.camera.createMany({ data: cameraData, skipDuplicates: true })
      camerasSynced = channelCount
    }

    result.syncCameras = { total: ipCams.length, synced: camerasSynced, nameUpdated, ipUpdated, portUpdated, sourceUsed }

    // Step 5: HDDs
    try {
      const disks = await getStorageInfo(nvrDec as any)
      for (const disk of disks) {
        const dbDisk = sanitizeDiskForDb(disk)
        await server.prisma.nvrHdd.upsert({
          where:  { nvrId_diskNumber: { nvrId: id, diskNumber: dbDisk.diskNumber } },
          create: { nvrId: id, ...dbDisk, lastSyncAt: new Date() },
          update: { ...dbDisk, lastSyncAt: new Date() },
        })
      }
      result.storage = { hdds: disks.length }
    } catch {
      result.storage = { hdds: 0, reason: 'No soportado por este modelo' }
    }

    // Step 6: RTSP health validation (async)
    const camerasToProbe = await server.prisma.camera.findMany({ where: { nvrId: id, active: true }, include: { nvr: true } })
    if (camerasToProbe.length > 0) {
      Promise.all(camerasToProbe.map(cam =>
        validateAndUpdateCameraHealth(server.prisma, cam.nvr as any, cam as any).catch(() => {})
      )).catch(() => {})
    }
    result.rtspValidation = { validating: camerasToProbe.length, async: true }

    // Step 7: Publish streams
    const allCameras = await server.prisma.camera.findMany({ where: { nvrId: id, active: true } })
    publishAllStreams(nvrDec as any, allCameras).catch(() => {})
    result.streams = { published: allCameras.length }

    server.log.info(`[onboard] ${nvr.name} (${nvr.ipAddress}): cameras=${camerasSynced} names=${nameUpdated} ips=${ipUpdated} ports=${portUpdated} source=${sourceUsed} isapi=${isapIStatus}`)
    await AuditAction(server.prisma, request.user.sub, 'NVR_ONBOARDED', id, request, result)

    return reply.send({ success: true, nvrId: id, ...result })
  })

  // POST /api/nvrs — Crear NVR
  server.post('/', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const data = nvrSchema.parse(request.body)

    const nvr = await server.prisma.nVR.create({
      data: { ...data, password: encryptPassword(data.password), location: data.location || null },
    })

    // Create placeholder cameras immediately so the NVR is usable right away.
    // The onboarding pipeline (async below) will overwrite them with real ISAPI data.
    const cameraData = Array.from({ length: data.channels }, (_, i) => ({
      nvrId: nvr.id, channel: i + 1, channelCode: `D${i + 1}`, name: `Canal ${i + 1}`,
    }))
    await server.prisma.camera.createMany({ data: cameraData })

    await AuditAction(server.prisma, request.user.sub, 'NVR_CREATED', nvr.id, request)

    // Fire-and-forget onboarding: sync real camera data, HDDs, RTSP health.
    // Uses the plaintext password from the current request (no decrypt needed).
    const nvrDec = { ...nvr, password: data.password }
    ;(async () => {
      try {
        const ipCams = await getIpCameraList(nvrDec as any)
        const sourcePriority = ['inputproxy_channels_secure', 'inputproxy_channels', 'inputproxy_status_secure', 'inputproxy_status', 'videoinput', 'streaming', 'fallback'] as const
        const usedSources = new Set(ipCams.map((c: any) => c.metadataSource))
        const sourceUsed = sourcePriority.find(s => usedSources.has(s)) ?? 'none'

        const isPlaceholder = (n?: string | null) => !n || /^canal\s+\d+$/i.test(n.trim()) || /^d\d+$/i.test(n.trim()) || /^camera\s*\d*$/i.test(n.trim()) || /^ipcamera\s*\d*$/i.test(n.trim()) || /^channel\s+\d+$/i.test(n.trim()) || /^\d{3,4}$/.test(n.trim())
        const isFromInputProxy = (src: string) => ['inputproxy_channels_secure', 'inputproxy_channels', 'inputproxy_status_secure', 'inputproxy_status'].includes(src)

        for (const cam of ipCams) {
          const existing = await server.prisma.camera.findUnique({
            where: { nvrId_channel: { nvrId: nvr.id, channel: cam.channel } },
          })
          if (!existing) continue
          const updates: any = { channelCode: cam.channelCode || `D${cam.channel}`, lastSyncAt: new Date() }
          if (cam.name && !isPlaceholder(cam.name)) updates.name = cam.name
          if (isFromInputProxy(cam.metadataSource)) {
            if (cam.ipAddress) updates.ipAddress = cam.ipAddress
            if (cam.managementPort > 0 && cam.ipAddress) updates.managementPort = cam.managementPort
            if (cam.protocol) updates.protocol = cam.protocol
            if (cam.securityStatus) updates.securityStatus = cam.securityStatus
            const online = (cam.status || '').toLowerCase() === 'online'
            updates.onlineInNvr = online
            if (online) updates.online = true
          }
          await server.prisma.camera.update({ where: { id: existing.id }, data: updates }).catch(() => {})
        }

        const cameras = await server.prisma.camera.findMany({ where: { nvrId: nvr.id, active: true }, include: { nvr: true } })
        await publishAllStreams(nvrDec as any, cameras).catch(() => {})

        // RTSP health validation
        await Promise.all(cameras.map(cam =>
          validateAndUpdateCameraHealth(server.prisma, cam.nvr as any, cam as any).catch(() => {})
        )).catch(() => {})

        server.log.info(`[nvr-create] ${nvr.name} (${nvr.ipAddress}) onboarding done: ipCams=${ipCams.length} source=${sourceUsed}`)
      } catch (err: any) {
        server.log.warn(`[nvr-create] ${nvr.name} onboarding error: ${err?.message}`)
      }
    })()

    return reply.status(201).send({ ...nvr, password: undefined })
  })

  // PUT /api/nvrs/:id
  server.put('/:id', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = nvrSchema.partial().parse(request.body)

    const existing = await server.prisma.nVR.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ message: 'NVR no encontrado' })

    const updateData: any = { ...data }

    if (data.password) {
      if (isMaskedPassword(data.password)) {
        return reply.status(400).send({
          success: false,
          errorCode: 'MASKED_PASSWORD',
          message: 'Se recibió un valor de máscara como contraseña. Ingresa la contraseña real o deja el campo vacío.',
        })
      }
      updateData.password = encryptPassword(data.password)
    } else {
      // Never overwrite existing password if field is blank
      delete updateData.password
    }

    const nvr = await server.prisma.nVR.update({ where: { id }, data: updateData })
    await AuditAction(server.prisma, request.user.sub, 'NVR_UPDATED', nvr.id, request)

    const cameras  = await server.prisma.camera.findMany({ where: { nvrId: id, active: true } })
    const plainPass = data.password ? data.password : decryptPassword(nvr.password)
    if (plainPass) {
      publishAllStreams({ ...nvr, password: plainPass } as any, cameras).catch(() => {})
    } else {
      server.log.error(`[nvr-update] DECRYPT_ERROR para NVR ${nvr.id} — streams no re-publicados. Verifica NVR_CREDENTIAL_KEY.`)
    }

    return reply.send({ ...nvr, password: undefined, passwordSaved: !!data.password })
  })

  // DELETE /api/nvrs/:id
  server.delete('/:id', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await server.prisma.nVR.delete({ where: { id } })
    await AuditAction(server.prisma, request.user.sub, 'NVR_DELETED', id, request)
    return reply.send({ message: 'NVR eliminado' })
  })

  // ─── Recording capabilities ────────────────────────────────

  // GET /api/nvrs/:id/recording-capabilities
  server.get('/:id/recording-capabilities', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!await userCanAccessNvr(u.sub, u.role, id)) return reply.status(403).send({ message: 'Sin permiso' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const capError: string | null = (nvr as any).recordingCapabilityError ?? null
    const capErrorCode = capError
      ? (/credencial|auth|401|403/i.test(capError) ? 'AUTH_FAILED'
        : /timeout/i.test(capError) ? 'NETWORK_TIMEOUT'
        : /red|network|econnrefused/i.test(capError) ? 'NETWORK_ERROR'
        : /xml|400|inválido|par[aá]metros/i.test(capError) ? 'INVALID_REQUEST'
        : 'UNSUPPORTED_MODEL')
      : null
    return reply.send({
      nvrId:                        nvr.id,
      recordingProvider:            (nvr as any).recordingProvider        ?? 'ISAPI',
      supportsIsapiRecording:       (nvr as any).supportsIsapiRecording   ?? null,
      supportsSdkRecording:         (nvr as any).supportsSdkRecording     ?? false,
      recordingCapabilityAt:        (nvr as any).recordingCapabilityAt    ?? null,
      recordingCapabilityError:     capError,
      recordingCapabilityErrorCode: capErrorCode,
      playbackWebUrl:               (nvr as any).playbackWebUrl           ?? null,
      sdkEnabled:                   (nvr as any).sdkEnabled               ?? false,
    })
  })

  // POST /api/nvrs/:id/recording-capabilities/check
  server.post('/:id/recording-capabilities/check', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const plain = safeDecrypt(nvr.password)
    if (!plain) {
      return reply.status(422).send({ success: false, errorCode: 'DECRYPT_ERROR', message: 'Contraseña no descifrable.' })
    }

    const creds = { ipAddress: nvr.ipAddress, port: nvr.port, username: nvr.username, password: plain }
    const { supported, error, errorCode, httpStatus, responseBody } = await checkIsapiRecordingSupport(creds)

    // INVALID_REQUEST (HTTP 400) means the endpoint EXISTS — the NVR parsed our XML but rejected
    // the channel query (e.g. channel D1..D4 has no recordings or isn't provisioned).
    // This is categorically different from 404/405/501 (endpoint missing = truly unsupported).
    // So on 400, record provider=ISAPI and supportsIsapiRecording=null (unknown pending retry).
    const provider = (errorCode === 'INVALID_REQUEST')
      ? 'ISAPI'
      : detectProviderFromCapabilities(supported)

    const updated = await server.prisma.nVR.update({
      where: { id },
      data: {
        recordingProvider:        provider,
        supportsIsapiRecording:   errorCode === 'INVALID_REQUEST' ? null : supported,
        recordingCapabilityAt:    new Date(),
        recordingCapabilityError: error ?? null,
      } as any,
    })

    server.log.info(`[recording-check] nvrId=${id} supported=${supported} errorCode=${errorCode} httpStatus=${httpStatus} provider=${provider}`)

    await AuditAction(server.prisma, request.user.sub, 'NVR_RECORDING_CAPABILITY_CHECKED', id, request, { supported, provider, error, errorCode })

    return reply.send({
      nvrId:                      updated.id,
      recordingProvider:          (updated as any).recordingProvider        ?? provider,
      supportsIsapiRecording:     (updated as any).supportsIsapiRecording   ?? supported,
      supportsSdkRecording:       (updated as any).supportsSdkRecording     ?? false,
      recordingCapabilityAt:      (updated as any).recordingCapabilityAt    ?? new Date().toISOString(),
      recordingCapabilityError:   (updated as any).recordingCapabilityError ?? null,
      recordingCapabilityErrorCode: errorCode ?? null,
      playbackWebUrl:             (updated as any).playbackWebUrl           ?? null,
      sdkEnabled:                 (updated as any).sdkEnabled               ?? false,
    })
  })

  // PUT /api/nvrs/:id/recording-capabilities
  server.put('/:id/recording-capabilities', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const schema = z.object({
      recordingProvider: z.enum(['ISAPI', 'HIKVISION_SDK', 'MEDIAMTX_LOCAL', 'MANUAL_NVR', 'UNSUPPORTED']).optional(),
      playbackWebUrl:    z.string().url().nullable().optional(),
      sdkEnabled:        z.boolean().optional(),
    })
    const body = schema.parse(request.body)

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const updated = await server.prisma.nVR.update({
      where: { id },
      data: body as any,
    })

    await AuditAction(server.prisma, request.user.sub, 'NVR_RECORDING_CAPABILITIES_UPDATED', id, request, body)

    return reply.send({
      nvrId:                    updated.id,
      recordingProvider:        (updated as any).recordingProvider        ?? 'ISAPI',
      supportsIsapiRecording:   (updated as any).supportsIsapiRecording   ?? null,
      supportsSdkRecording:     (updated as any).supportsSdkRecording     ?? false,
      recordingCapabilityAt:    (updated as any).recordingCapabilityAt    ?? null,
      recordingCapabilityError: (updated as any).recordingCapabilityError ?? null,
      playbackWebUrl:           (updated as any).playbackWebUrl           ?? null,
      sdkEnabled:               (updated as any).sdkEnabled               ?? false,
    })
  })

  // GET /api/nvrs/:id/recording-capabilities/debug — ADMIN: diagnose ISAPI search capability
  server.get('/:id/recording-capabilities/debug', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query  = request.query as { channel?: string }
    const channel = query.channel ? parseInt(query.channel) : 1

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const plain = safeDecrypt(nvr.password)
    if (!plain) return reply.status(422).send({ message: 'Contraseña no descifrable.' })

    const creds = { ipAddress: nvr.ipAddress, port: nvr.port, username: nvr.username, password: plain }
    const result = await checkIsapiRecordingSupport(creds)

    const now   = new Date()
    const start = new Date(now.getTime() - 5000)
    const xmlForChannel = buildIsapiSearchXml({ trackId: channel * 100 + 1, startTime: start, endTime: now, maxResults: 1 })

    return reply.send({
      nvrId:       id,
      nvrIp:       nvr.ipAddress,
      channel,
      trackId:     channel * 100 + 1,
      supported:   result.supported,
      errorCode:   result.errorCode ?? null,
      error:       result.error ?? null,
      httpStatus:  result.httpStatus ?? null,
      requestXml:  result.requestXml ?? null,
      requestXmlForChannel: xmlForChannel,
      responseBody: result.responseBody?.slice(0, 2000) ?? null,
    })
  })

  // GET /api/nvrs/:id/free-channels — Canales libres para adoptar cámara
  server.get('/:id/free-channels', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })
    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const freeChannels = await getFreeChannels(nvrDec as any, nvr.channels)
    return reply.send({ freeChannels, total: nvr.channels })
  })

  // POST /api/nvrs/:id/cameras/adopt — Adoptar cámara IP en NVR via ISAPI
  server.post('/:id/cameras/adopt', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const schema = z.object({
      channel:   z.number().int().min(1),
      name:      z.string().min(1).max(100),
      ipAddress: z.string().ip(),
      port:      z.number().int().default(8000),
      username:  z.string().min(1),
      password:  z.string().min(1),
      protocol:  z.string().default('HIKVISION'),
    })
    const params = schema.parse(request.body)

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }

    // 1. Intentar adoptar via ISAPI
    const adoptResult = await adoptIpCamera(nvrDec as any, params)
    if (!adoptResult.success) {
      return reply.status(400).send({ message: `Error al adoptar: ${adoptResult.error}` })
    }

    // 2. Upsert en DB
    const camera = await server.prisma.camera.upsert({
      where: { nvrId_channel: { nvrId: id, channel: params.channel } },
      update: {
        name: params.name,
        ipAddress: params.ipAddress,
        managementPort: params.port,
        protocol: params.protocol,
        active: true,
        lastSyncAt: new Date(),
      },
      create: {
        nvrId: id,
        channel: params.channel,
        name: params.name,
        ipAddress: params.ipAddress,
        managementPort: params.port,
        protocol: params.protocol,
        ptzEnabled: false,
        active: true,
        online: false,
        lastSyncAt: new Date(),
      },
    })

    await AuditAction(server.prisma, request.user.sub, 'CAMERA_ADOPTED', camera.id, request, {
      channel: params.channel, name: params.name, ipAddress: params.ipAddress,
    })

    // 3. Registrar en MediaMTX
    const cameras = await server.prisma.camera.findMany({ where: { nvrId: id, active: true } })
    publishAllStreams(nvrDec as any, cameras).catch(() => {})

    return reply.send({ success: true, camera, message: 'Cámara adoptada correctamente' })
  })

  // ─── Gestión de usuarios NVR ───────────────────────────────

  // POST /api/nvrs/:id/users — Crear usuario en el NVR
  server.post('/:id/users', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const schema = z.object({
      name:      z.string().min(1).max(32).regex(/^[a-zA-Z0-9_@.-]+$/, 'Solo letras, números y _ @ . -'),
      password:  z.string().min(8).max(64),
      userLevel: z.enum(['Administrator', 'Operator', 'User']).default('Operator'),
    })
    const params = schema.parse(request.body)

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const result = await createNVRUser(nvrDec as any, params)

    await AuditAction(server.prisma, request.user.sub, 'NVR_USER_CREATED', id, request, {
      nvrName: nvr.name, targetUser: params.name, userLevel: params.userLevel,
      success: result.success, error: result.error,
    })

    if (!result.success) {
      const status = result.unsupported ? 501 : 400
      return reply.status(status).send({ message: result.error, unsupported: result.unsupported ?? false })
    }
    return reply.status(201).send({ success: true, id: result.id })
  })

  // PUT /api/nvrs/:id/users/:userId — Editar usuario NVR
  server.put('/:id/users/:userId', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string }
    const schema = z.object({
      name:      z.string().min(1).max(32).regex(/^[a-zA-Z0-9_@.-]+$/),
      userLevel: z.enum(['Administrator', 'Operator', 'User']),
      enabled:   z.boolean().optional(),
    })
    const params = schema.parse(request.body)

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const result = await updateNVRUser(nvrDec as any, parseInt(userId), params)

    await AuditAction(server.prisma, request.user.sub, 'NVR_USER_UPDATED', id, request, {
      nvrName: nvr.name, userId, changes: { name: params.name, userLevel: params.userLevel, enabled: params.enabled },
      success: result.success, error: result.error,
    })

    if (!result.success) {
      const status = result.unsupported ? 501 : 400
      return reply.status(status).send({ message: result.error, unsupported: result.unsupported ?? false })
    }
    return reply.send({ success: true })
  })

  // POST /api/nvrs/:id/users/:userId/change-password — Cambiar contraseña de usuario NVR
  server.post('/:id/users/:userId/change-password', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string }
    const schema = z.object({
      newPassword: z.string().min(8).max(64),
      userName:    z.string().min(1),
    })
    const { newPassword, userName } = schema.parse(request.body)

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const result = await changeNVRUserPassword(nvrDec as any, parseInt(userId), newPassword, userName)

    await AuditAction(server.prisma, request.user.sub, 'NVR_USER_PASSWORD_CHANGED', id, request, {
      nvrName: nvr.name, userId, userName, success: result.success, error: result.error,
    })

    if (!result.success) {
      const status = result.unsupported ? 501 : 400
      return reply.status(status).send({ message: result.error, unsupported: result.unsupported ?? false })
    }
    return reply.send({ success: true })
  })

  // DELETE /api/nvrs/:id/users/:userId — Eliminar usuario NVR
  server.delete('/:id/users/:userId', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    // Get current users first to capture name for audit
    const users = await getNVRUsers({ ...nvr, password: decryptPassword(nvr.password) } as any)
    const target = users.find(u => u.id === parseInt(userId))

    const nvrDec = { ...nvr, password: decryptPassword(nvr.password) }
    const result = await deleteNVRUser(nvrDec as any, parseInt(userId))

    await AuditAction(server.prisma, request.user.sub, 'NVR_USER_DELETED', id, request, {
      nvrName: nvr.name, userId, userName: target?.name ?? '?',
      success: result.success, error: result.error,
    })

    if (!result.success) {
      const status = result.unsupported ? 501 : 400
      return reply.status(status).send({ message: result.error, unsupported: result.unsupported ?? false })
    }
    return reply.send({ success: true })
  })

  // GET /api/nvrs/:id/video-audio — Get all channel configs from ISAPI
  server.get('/:id/video-audio', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    // Get all cameras from DB for this NVR
    const cameras = await server.prisma.camera.findMany({ where: { nvrId: id }, orderBy: { channel: 'asc' } })
    if (cameras.length === 0) return reply.send([])

    const decPass = decryptPassword(nvr.password)
    const nvrDec = { ...nvr, password: decPass }

    const { fetchChannelVideoConfig } = await import('../services/hikvision')

    const results = await Promise.allSettled(
      cameras.map(async (cam) => {
        try {
          const config = await fetchChannelVideoConfig(nvrDec as any, cam.channel)
          return { cameraId: cam.id, channelCode: (cam as any).channelCode, cameraName: cam.name, ...config }
        } catch (e: any) {
          return { cameraId: cam.id, channel: cam.channel, channelCode: (cam as any).channelCode, cameraName: cam.name, error: e.message, main: null, sub: null, fetchedAt: new Date().toISOString() }
        }
      })
    )

    return reply.send(results.map(r => r.status === 'fulfilled' ? r.value : { error: 'fetch failed' }))
  })

  // GET /api/nvrs/:id/video-audio/:channel — Get single channel video config
  server.get('/:id/video-audio/:channel', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id, channel } = request.params as { id: string; channel: string }
    const channelNo = parseInt(channel, 10)
    if (isNaN(channelNo) || channelNo < 1) return reply.status(400).send({ message: 'Canal inválido' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const decPass = decryptPassword(nvr.password)
    const nvrDec = { ...nvr, password: decPass }

    const { fetchChannelVideoConfig } = await import('../services/hikvision')
    const config = await fetchChannelVideoConfig(nvrDec as any, channelNo)
    return reply.send(config)
  })

  // GET /api/nvrs/:id/video-audio/:channel/capabilities — Stream capabilities (codecs, resolutions, fps)
  server.get('/:id/video-audio/:channel/capabilities', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id, channel } = request.params as { id: string; channel: string }
    const channelNo = parseInt(channel, 10)
    if (isNaN(channelNo) || channelNo < 1) return reply.status(400).send({ message: 'Canal inválido' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const decPass = safeDecrypt(nvr.password)
    if (!decPass) return reply.status(422).send({ message: 'Contraseña no descifrable.' })

    const { getChannelCapabilities } = await import('../services/nvr-config/hikvision')
    const caps = await getChannelCapabilities(id, {
      ipAddress: nvr.ipAddress,
      port:      nvr.port,
      username:  nvr.username,
      password:  decPass,
    }, channelNo)

    return reply.send(caps)
  })

  // PUT /api/nvrs/:id/video-audio/:channel — Update full channel video config via ISAPI + backup
  server.put('/:id/video-audio/:channel', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id, channel } = request.params as { id: string; channel: string }
    const channelNo = parseInt(channel, 10)
    if (isNaN(channelNo)) return reply.status(400).send({ message: 'Canal inválido' })

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const body = request.body as {
      // Legacy short keys (mainFps, etc.) AND full field names accepted
      streamType?: 'main' | 'sub' | 'both'
      mainFps?: number;    mainBitrate?: number
      subFps?: number;     subBitrate?: number
      // Full field set (maps to main or sub depending on streamType)
      videoCodecType?: string
      width?: number;     height?: number
      fps?: number;       bitrateMax?: number
      bitrateType?: string
      audioEnabled?: boolean
      audioCodecType?: string
      audioBitrate?: number
    }

    // Reject explicit 0 for fps or bitrate
    if (body.mainFps === 0 || body.subFps === 0 || body.fps === 0) {
      return reply.status(400).send({ message: 'FPS no puede ser 0' })
    }
    if (body.mainBitrate === 0 || body.subBitrate === 0 || body.bitrateMax === 0) {
      return reply.status(400).send({ message: 'Bitrate no puede ser 0' })
    }

    const decPass = decryptPassword(nvr.password)
    const nvrDec = { ...nvr, password: decPass }
    const user = request.user

    // 1. Read current config and save backup
    const { fetchChannelVideoConfig, updateChannelFpsAndBitrate } = await import('../services/hikvision')
    const { putChannelVideoConfig: putConfig } = await import('../services/nvr-config/hikvision')

    const current = await fetchChannelVideoConfig(nvrDec as any, channelNo).catch(() => null)

    await server.prisma.nvrChannelConfigBackup.create({
      data: {
        nvrId: id,
        channelNo,
        streamType: body.streamType ?? 'both',
        configJson: JSON.stringify(current ?? {}),
        createdByUserId: user.sub,
        reason: 'before_edit',
      },
    }).catch(() => {})

    const nvrCreds = { ipAddress: nvr.ipAddress, port: nvr.port, username: nvr.username, password: decPass }

    // 2a. Legacy path: mainFps/mainBitrate/subFps/subBitrate keys
    if (body.mainFps !== undefined || body.mainBitrate !== undefined || body.subFps !== undefined || body.subBitrate !== undefined) {
      try {
        await updateChannelFpsAndBitrate(nvrDec as any, channelNo, body)
      } catch (e: any) {
        return reply.status(422).send({ message: `Error al escribir configuración: ${e.message}` })
      }
    }

    // 2b. Full field path: update with codec/resolution/fps/bitrate/audio via putConfig
    if (body.streamType && body.streamType !== 'both' && (
      body.videoCodecType !== undefined || body.width !== undefined || body.fps !== undefined ||
      body.bitrateMax !== undefined || body.bitrateType !== undefined ||
      body.audioEnabled !== undefined || body.audioCodecType !== undefined || body.audioBitrate !== undefined
    )) {
      const update: Record<string, any> = {}
      if (body.videoCodecType !== undefined) update.videoCodecType = body.videoCodecType
      if (body.width !== undefined)          update.width = body.width
      if (body.height !== undefined)         update.height = body.height
      if (body.fps !== undefined && body.fps > 0) update.fps = body.fps
      if (body.bitrateType !== undefined)    update.bitrateType = body.bitrateType
      if (body.bitrateMax !== undefined && body.bitrateMax > 0) update.bitrateMax = body.bitrateMax
      if (body.audioEnabled !== undefined)   update.audioEnabled = body.audioEnabled
      if (body.audioCodecType !== undefined) update.audioCodecType = body.audioCodecType
      if (body.audioBitrate !== undefined)   update.audioBitrate = body.audioBitrate

      const result = await putConfig(id, nvrCreds, channelNo, body.streamType as 'main' | 'sub', update)
      if (!result.success) {
        return reply.status(422).send({ message: result.error ?? 'Error al escribir configuración en NVR' })
      }

      await AuditAction(server.prisma, user.sub, 'NVR_CHANNEL_CONFIG_UPDATED', id, request, { channelNo, streamType: body.streamType, ...update })
      return reply.send(result.config)
    }

    // 3. Reread and return
    const updated = await fetchChannelVideoConfig(nvrDec as any, channelNo).catch(() => null)
    return reply.send(updated ?? { message: 'Guardado — no se pudo releer' })
  })
}
