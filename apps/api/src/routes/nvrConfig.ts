// apps/api/src/routes/nvrConfig.ts
// NVR channel video/audio configuration endpoints (read + write with backup).
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  getChannelVideoConfig,
  getAllChannelsVideoConfig,
  putChannelVideoConfig,
  getChannelCapabilities,
} from '../services/nvr-config/hikvision'
import { AuditAction } from '../services/audit'
import { decryptNvrPasswordOrNull as decryptPass } from '../services/credentials'

export const nvrConfigRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/nvrs/:nvrId/channels/:channelId/video-config
  // Returns main + sub stream configuration for the given channel.
  // channelId is 1-based numeric channel number.
  server.get('/:nvrId/channels/:channelId/video-config',
    { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] },
    async (request, reply) => {
      const { nvrId, channelId } = request.params as { nvrId: string; channelId: string }
      const channel = parseInt(channelId)
      if (isNaN(channel) || channel < 1 || channel > 64) {
        return reply.status(400).send({ message: 'channelId inválido (1-64)' })
      }

      const nvr = await server.prisma.nVR.findUnique({ where: { id: nvrId } })
      if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

      const plainPass = decryptPass(nvr.password)
      if (!plainPass) {
        return reply.status(503).send({
          message: 'No se pueden descifrar las credenciales del NVR. Verifica NVR_CREDENTIAL_KEY.',
        })
      }

      const config = await getChannelVideoConfig(nvrId, {
        ipAddress: nvr.ipAddress,
        port:      nvr.port,
        username:  nvr.username,
        password:  plainPass,
      }, channel)

      return reply.send(config)
    }
  )

  // GET /api/nvrs/:nvrId/channels/video-config
  // Returns video config for all channels in this NVR (reads from DB cameras list).
  server.get('/:nvrId/channels/video-config',
    { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] },
    async (request, reply) => {
      const { nvrId } = request.params as { nvrId: string }

      const nvr = await server.prisma.nVR.findUnique({
        where: { id: nvrId },
        include: { cameras: { where: { active: true }, select: { channel: true }, orderBy: { channel: 'asc' } } },
      })
      if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

      const plainPass = decryptPass(nvr.password)
      if (!plainPass) {
        return reply.status(503).send({
          message: 'No se pueden descifrar las credenciales del NVR. Verifica NVR_CREDENTIAL_KEY.',
        })
      }

      const channels = (nvr as any).cameras.map((c: any) => c.channel as number)
      if (channels.length === 0) {
        return reply.send([])
      }

      const configs = await getAllChannelsVideoConfig(nvrId, {
        ipAddress: nvr.ipAddress,
        port:      nvr.port,
        username:  nvr.username,
        password:  plainPass,
      }, channels)

      return reply.send(configs)
    }
  )

  // PUT /api/nvrs/:nvrId/channels/:channelId/video-config
  // Writes video/audio config for a channel after saving a backup of the current config.
  const putVideoConfigSchema = z.object({
    streamType: z.enum(['main', 'sub']),
    update: z.object({
      videoCodecType: z.string().optional(),
      width:          z.number().int().optional(),
      height:         z.number().int().optional(),
      fps:            z.number().optional(),
      bitrateType:    z.enum(['CBR', 'VBR']).optional(),
      bitrateMax:     z.number().int().optional(),
      qualityLevel:   z.string().optional(),
      audioEnabled:   z.boolean().optional(),
      audioCodecType: z.string().optional(),
      audioBitrate:   z.number().int().optional(),
    }),
  })

  server.put('/:nvrId/channels/:channelId/video-config',
    { preHandler: [server.authorize(['ADMIN'])] },
    async (request, reply) => {
      const { nvrId, channelId } = request.params as { nvrId: string; channelId: string }
      const channel = parseInt(channelId)
      if (isNaN(channel) || channel < 1 || channel > 64) {
        return reply.status(400).send({ message: 'channelId inválido (1-64)' })
      }

      const parsed = putVideoConfigSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ message: 'Cuerpo de solicitud inválido', errors: parsed.error.flatten() })
      }
      const { streamType, update } = parsed.data

      const nvr = await server.prisma.nVR.findUnique({ where: { id: nvrId } })
      if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

      const plainPass = decryptPass(nvr.password)
      if (!plainPass) {
        return reply.status(503).send({
          message: 'No se pueden descifrar las credenciales del NVR. Verifica NVR_CREDENTIAL_KEY.',
        })
      }

      const nvrCreds = {
        ipAddress: nvr.ipAddress,
        port:      nvr.port,
        username:  nvr.username,
        password:  plainPass,
      }

      // Read current config as backup before writing
      const current = await getChannelVideoConfig(nvrId, nvrCreds, channel)

      // Save backup
      await server.prisma.nvrChannelConfigBackup.create({
        data: {
          nvrId,
          channelNo:       channel,
          streamType,
          configJson:      JSON.stringify(current),
          createdByUserId: (request.user as any).sub,
          reason:          'before_edit',
        },
      })

      // Apply update
      const result = await putChannelVideoConfig(nvrId, nvrCreds, channel, streamType, update)
      if (!result.success) {
        return reply.status(502).send({ message: result.error ?? 'Error al escribir configuración en NVR' })
      }

      await AuditAction(server.prisma, (request.user as any).sub, 'NVR_CHANNEL_CONFIG_UPDATED', nvrId, request)

      return reply.send(result.config)
    }
  )

  // POST /api/nvrs/:nvrId/channels/:channelId/video-config/restore
  // Restores channel config from a backup (latest or specified by backupId).
  const restoreSchema = z.object({
    backupId:   z.string().optional(),
    streamType: z.enum(['main', 'sub']),
  })

  server.post('/:nvrId/channels/:channelId/video-config/restore',
    { preHandler: [server.authorize(['ADMIN'])] },
    async (request, reply) => {
      const { nvrId, channelId } = request.params as { nvrId: string; channelId: string }
      const channel = parseInt(channelId)
      if (isNaN(channel) || channel < 1 || channel > 64) {
        return reply.status(400).send({ message: 'channelId inválido (1-64)' })
      }

      const parsed = restoreSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({ message: 'Cuerpo de solicitud inválido', errors: parsed.error.flatten() })
      }
      const { backupId, streamType } = parsed.data

      // Find the backup to restore
      let backup: { configJson: string } | null = null
      if (backupId) {
        backup = await server.prisma.nvrChannelConfigBackup.findFirst({
          where: { id: backupId, nvrId, channelNo: channel },
          select: { configJson: true },
        })
      } else {
        backup = await server.prisma.nvrChannelConfigBackup.findFirst({
          where: { nvrId, channelNo: channel, streamType },
          orderBy: { createdAt: 'desc' },
          select: { configJson: true },
        })
      }

      if (!backup) {
        return reply.status(404).send({ message: 'No se encontró backup para este canal' })
      }

      const nvr = await server.prisma.nVR.findUnique({ where: { id: nvrId } })
      if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

      const plainPass = decryptPass(nvr.password)
      if (!plainPass) {
        return reply.status(503).send({
          message: 'No se pueden descifrar las credenciales del NVR. Verifica NVR_CREDENTIAL_KEY.',
        })
      }

      const nvrCreds = {
        ipAddress: nvr.ipAddress,
        port:      nvr.port,
        username:  nvr.username,
        password:  plainPass,
      }

      // Parse backup config
      let savedConfig: import('../services/nvr-config/hikvision').ChannelVideoConfig
      try {
        savedConfig = JSON.parse(backup.configJson)
      } catch {
        return reply.status(500).send({ message: 'Backup corrupto: JSON inválido' })
      }

      // Extract the relevant stream config
      const streamConfig = streamType === 'main' ? savedConfig.main : savedConfig.sub
      if (!streamConfig) {
        return reply.status(404).send({ message: `El backup no contiene configuración del stream ${streamType}` })
      }

      // Map VideoStreamConfig fields to VideoStreamUpdate
      const updatePayload: import('../services/nvr-config/hikvision').VideoStreamUpdate = {
        videoCodecType: streamConfig.videoCodecType,
        width:          streamConfig.width,
        height:         streamConfig.height,
        fps:            streamConfig.fps,
        bitrateType:    streamConfig.bitrateType,
        bitrateMax:     streamConfig.bitrateMax,
        qualityLevel:   streamConfig.qualityLevel,
        audioEnabled:   streamConfig.audioEnabled,
        audioCodecType: streamConfig.audioCodecType,
        audioBitrate:   streamConfig.audioBitrate,
      }

      const result = await putChannelVideoConfig(nvrId, nvrCreds, channel, streamType, updatePayload)
      if (!result.success) {
        return reply.status(502).send({ message: result.error ?? 'Error al restaurar configuración en NVR' })
      }

      await AuditAction(server.prisma, (request.user as any).sub, 'NVR_CHANNEL_CONFIG_RESTORED', nvrId, request)

      return reply.send(result.config)
    }
  )

  // GET /api/nvrs/:nvrId/channels/:channelId/video-config/capabilities
  // Returns allowed codecs, resolutions, fps, bitrate range for main and sub streams.
  server.get('/:nvrId/channels/:channelId/video-config/capabilities',
    { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] },
    async (request, reply) => {
      const { nvrId, channelId } = request.params as { nvrId: string; channelId: string }
      const channel = parseInt(channelId)
      if (isNaN(channel) || channel < 1 || channel > 64) {
        return reply.status(400).send({ message: 'channelId inválido (1-64)' })
      }

      const nvr = await server.prisma.nVR.findUnique({ where: { id: nvrId } })
      if (!nvr) return reply.status(404).send({ message: 'NVR no encontrado' })

      const plainPass = decryptPass(nvr.password)
      if (!plainPass) {
        return reply.status(503).send({ message: 'No se pueden descifrar las credenciales del NVR.' })
      }

      const caps = await getChannelCapabilities(nvrId, {
        ipAddress: nvr.ipAddress,
        port:      nvr.port,
        username:  nvr.username,
        password:  plainPass,
      }, channel)

      return reply.send(caps)
    }
  )
}
