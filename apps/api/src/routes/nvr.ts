// apps/api/src/routes/nvr.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  getNVRStatus, getNVRChannels, getIpCameraList,
  getStorageInfo, getNVRUsers, getDeviceInfo, rebootDevice,
  adoptIpCamera, getFreeChannels, debugGetCameraNameSources,
  createNVRUser, updateNVRUser, changeNVRUserPassword, deleteNVRUser,
} from '../services/hikvision'
import { publishAllStreams } from '../services/stream'
import { validateAndUpdateCameraHealth } from '../services/stream-validator'
import { AuditAction } from '../services/audit'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'

const encryptPassword = (p: string) => CryptoJS.AES.encrypt(p, ENCRYPTION_KEY).toString()
const decryptPassword = (enc: string) => CryptoJS.AES.decrypt(enc, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// Strip debug/non-schema fields before passing a HikStorageDisk to Prisma
function sanitizeDiskForDb(disk: any) {
  const { _rawCapacity, _rawFree, rawCapacity, rawFree, ...dbDisk } = disk
  return dbDisk
}

const connectionTestSchema = z.object({
  ipAddress: z.string().min(1),
  port:      z.number().int().min(1).max(65535).default(80),
  username:  z.string().min(1),
  password:  z.string().min(1),
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
    const data = connectionTestSchema.parse(request.body)
    const fakeNvr = { id: 'test', ...data, rtspPort: 554, channels: 0, hddCount: 0, firmware: null } as any

    const status = await getNVRStatus(fakeNvr)
    if (!status.online) {
      const message = status.errorReason === 'auth'    ? 'Credenciales incorrectas (usuario o contraseña)'
                    : status.errorReason === 'network' ? `No se pudo alcanzar ${data.ipAddress}:${data.port} — verifica IP, puerto y que el NVR esté encendido`
                    :                                    'No se pudo conectar al NVR. Verifica IP, puerto y credenciales.'
      return reply.status(503).send({ success: false, message })
    }

    return reply.send({ success: true, firmware: status.firmware, diskUsage: status.diskUsage })
  })

  // POST /api/nvrs/detect — Auto-detectar info del NVR
  server.post('/detect', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const data = connectionTestSchema.parse(request.body)
    const fakeNvr = { id: 'detect', ...data, rtspPort: 554, channels: 0, hddCount: 0, firmware: null } as any

    try {
      const [status, info, channels] = await Promise.allSettled([
        getNVRStatus(fakeNvr),
        getDeviceInfo(fakeNvr),
        getIpCameraList(fakeNvr),
      ])

      const s = status.status === 'fulfilled' ? status.value : null
      if (!s?.online) return reply.status(503).send({ success: false, message: 'No se pudo conectar' })

      const d = info.status === 'fulfilled' ? info.value : null
      const c = channels.status === 'fulfilled' ? channels.value : []

      return reply.send({
        success: true,
        model:           d?.model || '',
        serialNumber:    d?.serialNumber || '',
        firmware:        d?.firmware || s.firmware || '',
        encodingVersion: d?.encodingVersion || '',
        webVersion:      d?.webVersion || '',
        channels:        c.length || d?.channelCount || 0,
        hddCount:        d?.hddCount || 0,
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

    if (['ADMIN', 'SUPERVISOR'].includes(user.role)) {
      nvrs = await server.prisma.nVR.findMany({
        include: { cameras: { select: { id: true, channel: true, name: true, online: true, active: true, channelCode: true } } },
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
        include: { cameras: { select: { id: true, channel: true, name: true, online: true, active: true, channelCode: true } } },
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
        storageReason = `No soportado por este modelo/firmware (HTTP ${(e as any).httpStatus})`
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
        usersReason = `No soportado por este modelo/firmware (HTTP ${(e as any).httpStatus})`
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
        // online: solo se fuerza a true desde ISAPI; a false lo gestiona la validación RTSP
        const onlineInNvr = cam.status?.toLowerCase().includes('online') || cam.status?.toLowerCase().includes('en línea')
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
            online:         onlineInNvr,
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
            ...(onlineInNvr ? { online: true } : {}),
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

  // POST /api/nvrs — Crear NVR
  server.post('/', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const data = nvrSchema.parse(request.body)

    const nvr = await server.prisma.nVR.create({
      data: { ...data, password: encryptPassword(data.password), location: data.location || null },
    })

    const cameraData = Array.from({ length: data.channels }, (_, i) => ({
      nvrId: nvr.id, channel: i + 1, channelCode: `D${i + 1}`, name: `Canal ${i + 1}`,
    }))
    await server.prisma.camera.createMany({ data: cameraData })

    const cameras   = await server.prisma.camera.findMany({ where: { nvrId: nvr.id } })
    const nvrDec    = { ...nvr, password: data.password }
    publishAllStreams(nvrDec as any, cameras).catch(() => {})

    await AuditAction(server.prisma, request.user.sub, 'NVR_CREATED', nvr.id, request)
    return reply.status(201).send({ ...nvr, password: undefined })
  })

  // PUT /api/nvrs/:id
  server.put('/:id', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = nvrSchema.partial().parse(request.body)

    const updateData: any = { ...data }
    if (data.password) updateData.password = encryptPassword(data.password)

    const nvr = await server.prisma.nVR.update({ where: { id }, data: updateData })
    await AuditAction(server.prisma, request.user.sub, 'NVR_UPDATED', nvr.id, request)

    const cameras  = await server.prisma.camera.findMany({ where: { nvrId: id, active: true } })
    const plainPass = data.password ? data.password : decryptPassword(nvr.password)
    publishAllStreams({ ...nvr, password: plainPass } as any, cameras).catch(() => {})

    return reply.send({ ...nvr, password: undefined })
  })

  // DELETE /api/nvrs/:id
  server.delete('/:id', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await server.prisma.nVR.delete({ where: { id } })
    await AuditAction(server.prisma, request.user.sub, 'NVR_DELETED', id, request)
    return reply.send({ message: 'NVR eliminado' })
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
}
