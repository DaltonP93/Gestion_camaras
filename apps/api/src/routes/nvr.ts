// apps/api/src/routes/nvr.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { getNVRStatus, getNVRChannels } from '../services/hikvision'
import { publishAllStreams } from '../services/stream'
import { AuditAction } from '../services/audit'
import CryptoJS from 'crypto-js'

const connectionTestSchema = z.object({
  ipAddress: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(80),
  username: z.string().min(1),
  password: z.string().min(1),
})

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'

function encryptPassword(password: string): string {
  return CryptoJS.AES.encrypt(password, ENCRYPTION_KEY).toString()
}

function decryptPassword(encrypted: string): string {
  const bytes = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY)
  return bytes.toString(CryptoJS.enc.Utf8)
}

const nvrSchema = z.object({
  name: z.string().min(1).max(100),
  model: z.string().min(1),
  ipAddress: z.string().ip(),
  port: z.number().int().min(1).max(65535).default(80),
  rtspPort: z.number().int().min(1).max(65535).default(554),
  username: z.string().min(1),
  password: z.string().min(1),
  channels: z.number().int().min(1).max(128),
  hddCount: z.number().int().min(1).max(16).default(1),
  location: z.string().optional(),
})

export const nvrRoutes: FastifyPluginAsync = async (server) => {
  // POST /api/nvrs/test-connection — Probar conexión antes de guardar (ADMIN)
  server.post('/test-connection', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const data = connectionTestSchema.parse(request.body)

    const fakeNvr = {
      id: 'test',
      ipAddress: data.ipAddress,
      port: data.port,
      username: data.username,
      password: data.password,
      rtspPort: 554,
      channels: 0,
      hddCount: 0,
      firmware: null,
    } as any

    const status = await getNVRStatus(fakeNvr)

    if (!status.online) {
      return reply.status(503).send({
        success: false,
        message: 'No se pudo conectar al NVR. Verifica IP, puerto y credenciales.',
      })
    }

    return reply.send({
      success: true,
      firmware: status.firmware,
      diskUsage: status.diskUsage,
    })
  })

  // POST /api/nvrs/scan — Escanear subnet en busca de dispositivos Hikvision (ADMIN)
  server.post('/scan', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const scanSchema = z.object({
      subnet: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, 'Formato: 192.168.1').refine(
        (v) => v.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255),
        'Cada octeto debe estar entre 0 y 255',
      ),
      port: z.number().int().min(1).max(65535).default(80),
      start: z.number().int().min(1).max(254).default(1),
      end: z.number().int().min(1).max(254).default(254),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    const { subnet, port, start, end, username, password } = scanSchema.parse(request.body)

    const axios = (await import('axios')).default
    const range = Math.max(0, end - start) + 1
    const ips = Array.from({ length: range }, (_, i) => `${subnet}.${start + i}`)

    const probe = async (ip: string) => {
      try {
        const cfg: any = {
          timeout: 2000,
          validateStatus: (s: number) => s < 500,
        }
        if (username && password) {
          cfg.auth = { username, password }
        }
        const res = await axios.get(`http://${ip}:${port}/ISAPI/System/deviceInfo`, cfg)

        // 401 = dispositivo presente pero sin credenciales correctas
        if (res.status === 401) {
          const realm = (res.headers['www-authenticate'] || '').match(/realm="([^"]+)"/)?.[1]
          return {
            ip, port,
            requiresAuth: true,
            model: realm || '',
            serialNumber: '',
            firmware: '',
            channels: 0,
          }
        }

        // 200 = dispositivo respondió con info
        if (res.status === 200 && typeof res.data === 'string' && res.data.includes('DeviceInfo')) {
          // XML response - parse simple fields
          const xml = res.data as string
          const get = (tag: string) => xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1] || ''

          let channels = 0
          if (username && password) {
            try {
              const chRes = await axios.get(`http://${ip}:${port}/ISAPI/System/Video/inputs/channels`, {
                timeout: 2000,
                auth: { username, password },
              })
              const chXml = typeof chRes.data === 'string' ? chRes.data : ''
              channels = (chXml.match(/<VideoInputChannel>/g) || []).length
            } catch {}
          }

          return {
            ip, port,
            requiresAuth: false,
            model: get('model') || get('deviceType') || '',
            serialNumber: get('serialNumber') || '',
            firmware: get('firmwareVersion') || '',
            macAddress: get('macAddress') || '',
            deviceName: get('deviceName') || '',
            channels,
          }
        }

        if (res.status === 200 && res.data?.DeviceInfo) {
          const info = res.data.DeviceInfo
          return {
            ip, port,
            requiresAuth: false,
            model: info.model || info.deviceType || '',
            serialNumber: info.serialNumber || '',
            firmware: info.firmwareVersion || '',
            macAddress: info.macAddress || '',
            deviceName: info.deviceName || '',
            channels: 0,
          }
        }
      } catch {
        // No respondió o timeout
      }
      return null
    }

    // Ejecutar en lotes para no saturar la red
    const BATCH_SIZE = 50
    const discovered: any[] = []
    for (let i = 0; i < ips.length; i += BATCH_SIZE) {
      const batch = ips.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(batch.map(probe))
      results.forEach((r) => { if (r) discovered.push(r) })
    }

    return reply.send({ scanned: ips.length, discovered })
  })

  // POST /api/nvrs/detect — Auto-detectar info del NVR a partir de IP + credenciales (ADMIN)
  server.post('/detect', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const data = connectionTestSchema.parse(request.body)

    const fakeNvr = {
      id: 'detect',
      ipAddress: data.ipAddress,
      port: data.port,
      username: data.username,
      password: data.password,
      rtspPort: 554,
      channels: 0,
      hddCount: 0,
      firmware: null,
    } as any

    try {
      const status = await getNVRStatus(fakeNvr)
      if (!status.online) {
        return reply.status(503).send({
          success: false,
          message: 'No se pudo conectar. Verifica IP, puerto y credenciales.',
        })
      }

      const channels = await getNVRChannels(fakeNvr)

      return reply.send({
        success: true,
        model: '',
        serialNumber: '',
        firmware: status.firmware,
        channels: channels.length,
      })
    } catch (err: any) {
      server.log.warn(`[detect] ${data.ipAddress}: ${err.message}`)
      return reply.status(503).send({
        success: false,
        message: 'No se pudo conectar. Verifica IP, puerto y credenciales.',
      })
    }
  })

  // GET /api/nvrs — Listar todos los NVRs
  server.get('/', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const user = request.user

    let nvrs
    if (['ADMIN', 'SUPERVISOR'].includes(user.role)) {
      nvrs = await server.prisma.nVR.findMany({
        include: { cameras: { select: { id: true, channel: true, name: true, online: true, active: true } } },
        orderBy: { name: 'asc' },
      })
    } else {
      // Operador/Auditor: solo NVRs con permisos
      const permissions = await server.prisma.userPermission.findMany({
        where: { userId: user.sub, nvrId: { not: null } },
        select: { nvrId: true },
      })
      const nvrIds = permissions.map((p) => p.nvrId!).filter(Boolean)

      nvrs = await server.prisma.nVR.findMany({
        where: { id: { in: nvrIds } },
        include: { cameras: { select: { id: true, channel: true, name: true, online: true, active: true } } },
        orderBy: { name: 'asc' },
      })
    }

    // Ocultar contraseñas
    return reply.send(nvrs.map((nvr) => ({ ...nvr, password: undefined })))
  })

  // Helper: verificar que el usuario puede acceder a este NVR
  async function userCanAccessNvr(userId: string, role: string, nvrId: string): Promise<boolean> {
    if (role === 'ADMIN' || role === 'SUPERVISOR') return true
    const perm = await server.prisma.userPermission.findFirst({
      where: {
        userId,
        OR: [
          { nvrId },
          { camera: { nvrId } },
        ],
      },
      select: { id: true },
    })
    return !!perm
  }

  // GET /api/nvrs/:id — Detalle de NVR
  server.get('/:id', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!(await userCanAccessNvr(u.sub, u.role, id))) {
      return reply.status(403).send({ message: 'Sin permiso para este NVR' })
    }

    const nvr = await server.prisma.nVR.findUnique({
      where: { id },
      include: { cameras: true },
    })

    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    return reply.send({ ...nvr, password: undefined })
  })

  // GET /api/nvrs/:id/status — Estado en tiempo real del NVR
  server.get('/:id/status', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!(await userCanAccessNvr(u.sub, u.role, id))) {
      return reply.status(403).send({ message: 'Sin permiso para este NVR' })
    }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrWithDecryptedPass = { ...nvr, password: decryptPassword(nvr.password) }
    const status = await getNVRStatus(nvrWithDecryptedPass as any)

    // Actualizar lastSeen si está online
    if (status.online) {
      await server.prisma.nVR.update({
        where: { id },
        data: { lastSeen: new Date(), firmware: status.firmware },
      })
    }

    return reply.send(status)
  })

  // GET /api/nvrs/:id/channels — Canales del NVR desde ISAPI
  server.get('/:id/channels', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const u = request.user
    if (!(await userCanAccessNvr(u.sub, u.role, id))) {
      return reply.status(403).send({ message: 'Sin permiso para este NVR' })
    }

    const nvr = await server.prisma.nVR.findUnique({ where: { id } })
    if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

    const nvrDecrypted = { ...nvr, password: decryptPassword(nvr.password) }
    const channels = await getNVRChannels(nvrDecrypted as any)

    return reply.send(channels)
  })

  // POST /api/nvrs — Crear NVR (solo ADMIN)
  server.post('/', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const data = nvrSchema.parse(request.body)

    const nvr = await server.prisma.nVR.create({
      data: {
        ...data,
        password: encryptPassword(data.password),
        location: data.location || null,
      },
    })

    // Crear cámaras automáticamente basadas en el número de canales
    const cameraData = Array.from({ length: data.channels }, (_, i) => ({
      nvrId: nvr.id,
      channel: i + 1,
      name: `Canal ${i + 1}`,
    }))

    await server.prisma.camera.createMany({ data: cameraData })

    // Publicar streams en MediaMTX
    const cameras = await server.prisma.camera.findMany({ where: { nvrId: nvr.id } })
    const nvrDecrypted = { ...nvr, password: data.password }
    publishAllStreams(nvrDecrypted as any, cameras).catch(() => {})

    await AuditAction(server.prisma, request.user.sub, 'NVR_CREATED', nvr.id, request)

    return reply.status(201).send({ ...nvr, password: undefined })
  })

  // PUT /api/nvrs/:id — Actualizar NVR (solo ADMIN)
  server.put('/:id', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = nvrSchema.partial().parse(request.body)

    const updateData: any = { ...data }
    if (data.password) {
      updateData.password = encryptPassword(data.password)
    }

    const nvr = await server.prisma.nVR.update({
      where: { id },
      data: updateData,
    })

    await AuditAction(server.prisma, request.user.sub, 'NVR_UPDATED', nvr.id, request)

    return reply.send({ ...nvr, password: undefined })
  })

  // DELETE /api/nvrs/:id — Eliminar NVR (solo ADMIN)
  server.delete('/:id', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    await server.prisma.nVR.delete({ where: { id } })

    await AuditAction(server.prisma, request.user.sub, 'NVR_DELETED', id, request)

    return reply.send({ message: 'NVR eliminado' })
  })
}
