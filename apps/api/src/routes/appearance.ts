// apps/api/src/routes/appearance.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

// Accept empty string or valid URL; coerce null/'' to null for storage
const urlField = z
  .union([z.string().url().max(2048), z.literal('')])
  .nullable()
  .optional()
  .transform((v) => (!v ? null : v))

const updateAppearanceSchema = z.object({
  siteName:          z.string().min(1).max(50).optional(),
  logoText:          z.string().min(1).max(50).optional(),
  primaryColor:      z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  theme:             z.enum(['dark', 'darker', 'midnight']).optional(),
  sidebarWidth:      z.enum(['compact', 'normal']).optional(),
  showNVRsInSidebar: z.boolean().optional(),
  // Nullable text fields — coerce null/undefined to '' so the DB never has ambiguous nulls
  customCss:         z.string().max(10000).nullable().optional().transform((v) => v ?? ''),
  logoUrl:           urlField,
  sidebarLogoUrl:    urlField,
  faviconUrl:        urlField,
})

const appearancePlugin: FastifyPluginAsync = async (server) => {
  // GET — public (needed for theming before login)
  server.get('/', async (_request, reply) => {
    let settings = await server.prisma.appearanceSettings.findUnique({
      where: { id: 'singleton' },
    })
    if (!settings) {
      settings = await server.prisma.appearanceSettings.create({
        data: { id: 'singleton' },
      })
    }
    // Normalize nullable fields before sending to frontend
    return reply.send({
      ...settings,
      customCss:      settings.customCss      ?? '',
      logoUrl:        settings.logoUrl        ?? '',
      sidebarLogoUrl: settings.sidebarLogoUrl ?? '',
      faviconUrl:     settings.faviconUrl     ?? '',
    })
  })

  // PUT — admin only
  server.put('/', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const data = updateAppearanceSchema.parse(request.body)

    const settings = await server.prisma.appearanceSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    })

    return reply.send({
      ...settings,
      customCss:      settings.customCss      ?? '',
      logoUrl:        settings.logoUrl        ?? '',
      sidebarLogoUrl: settings.sidebarLogoUrl ?? '',
      faviconUrl:     settings.faviconUrl     ?? '',
    })
  })
}

export default appearancePlugin
