// apps/api/src/routes/appearance.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'

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
  // POST /appearance/upload — multipart file upload for branding assets
  server.post('/upload', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const ALLOWED_MIMES = new Set([
      'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
      'image/x-icon', 'image/vnd.microsoft.icon',
    ])

    const uploadsDir = process.env.UPLOADS_DIR || '/app/uploads'
    const brandingDir = path.join(uploadsDir, 'branding')

    const FIELD_NAMES = new Set(['favicon', 'sidebarLogo', 'loginLogo', 'headerLogo', 'logoUrl', 'sidebarLogoUrl', 'faviconUrl'])
    const fieldToDbKey: Record<string, string> = {
      favicon: 'faviconUrl',
      faviconUrl: 'faviconUrl',
      sidebarLogo: 'sidebarLogoUrl',
      sidebarLogoUrl: 'sidebarLogoUrl',
      loginLogo: 'logoUrl',
      headerLogo: 'logoUrl',
      logoUrl: 'logoUrl',
    }

    const updates: Record<string, string> = {}

    // Load current settings to know previous file paths
    const current = await server.prisma.appearanceSettings.findUnique({ where: { id: 'singleton' } })

    const parts = request.parts()
    for await (const part of parts) {
      if (part.type !== 'file') continue
      if (!FIELD_NAMES.has(part.fieldname)) {
        await part.toBuffer() // drain
        continue
      }
      if (!ALLOWED_MIMES.has(part.mimetype)) {
        await part.toBuffer()
        return reply.status(400).send({ message: `Tipo de archivo no permitido: ${part.mimetype}` })
      }

      const buf = await part.toBuffer()
      if (buf.length === 0) continue

      // Sanitize filename, generate unique name
      const ext = path.extname(part.filename || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 5) || '.png'
      const uniqueName = `${part.fieldname}_${Date.now()}${ext}`
      const destPath = path.join(brandingDir, uniqueName)

      // Delete previous file for this field if it's a local upload
      const dbKey = fieldToDbKey[part.fieldname]
      const prevUrl: string | null = (current as any)?.[dbKey] ?? null
      if (prevUrl && (prevUrl.startsWith('/uploads/branding/') || prevUrl.includes('/uploads/branding/'))) {
        const prevFile = path.join(brandingDir, path.basename(prevUrl))
        try { fs.unlinkSync(prevFile) } catch {}
      }

      fs.writeFileSync(destPath, buf)
      // Save as relative path — frontend resolves to full URL using resolveAssetUrl
      updates[dbKey] = `/uploads/branding/${uniqueName}`
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ message: 'No se recibieron archivos válidos' })
    }

    const settings = await server.prisma.appearanceSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...updates },
      update: updates,
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
