// apps/api/src/routes/nvrConfig.ts
// Read-only NVR channel video/audio configuration endpoints.
// All writes will be added separately after backup/diff workflow is ready.
import type { FastifyPluginAsync } from 'fastify'
import CryptoJS from 'crypto-js'
import { getChannelVideoConfig, getAllChannelsVideoConfig } from '../services/nvr-config/hikvision'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'

function decryptPass(p: string): string | null {
  try {
    const plain = CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)
    return plain || null
  } catch {
    return null
  }
}

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
}
