// apps/api/src/routes/appearance.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

const updateAppearanceSchema = z.object({
  siteName: z.string().min(1).max(50).optional(),
  logoText: z.string().min(1).max(50).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  theme: z.enum(['dark', 'darker', 'midnight']).optional(),
  sidebarWidth: z.enum(['compact', 'normal']).optional(),
  showNVRsInSidebar: z.boolean().optional(),
  customCss: z.string().max(10000).optional(),
})

const appearancePlugin: FastifyPluginAsync = async (server) => {
  // Get current settings (public endpoint — needed for theming before login)
  server.get('/', async (_request, reply) => {
    let settings = await server.prisma.appearanceSettings.findUnique({
      where: { id: 'singleton' },
    })
    if (!settings) {
      settings = await server.prisma.appearanceSettings.create({
        data: { id: 'singleton' },
      })
    }
    return reply.send(settings)
  })

  // Update settings (ADMIN only)
  server.put('/', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const data = updateAppearanceSchema.parse(request.body)

    const settings = await server.prisma.appearanceSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    })

    return reply.send(settings)
  })
}

export default appearancePlugin
