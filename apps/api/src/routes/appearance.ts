// apps/api/src/routes/appearance.ts
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import {
  canManageAppearance,
  isBlockedSvgUpload,
  BLOCKED_SVG_CODE,
  normalizeUploadUrl,
  toPublishableAppearance,
} from '../services/appearance-policy'

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)

// Accept empty string or valid URL; coerce null/'' to null for storage
const urlField = z
  .union([z.string().url().max(2048), z.literal('')])
  .nullable()
  .optional()
  .transform((v) => (!v ? null : v))

// Campo de color V2: hex o null (null ⇒ el motor lo deriva del tema).
const colorField = hexColor.nullable().optional()

const updateAppearanceSchema = z.object({
  siteName:          z.string().min(1).max(50).optional(),
  logoText:          z.string().min(1).max(50).optional(),
  // legacy
  primaryColor:      hexColor.optional(),
  accentColor:       hexColor.optional(),
  theme:             z.enum(['dark', 'darker', 'midnight']).optional(),
  sidebarWidth:      z.enum(['compact', 'normal', 'wide']).optional(),
  showNVRsInSidebar: z.boolean().optional(),
  // Nullable text fields — coerce null/undefined to '' so the DB never has ambiguous nulls
  customCss:         z.string().max(10000).nullable().optional().transform((v) => v ?? ''),
  logoUrl:           urlField,
  sidebarLogoUrl:    urlField,
  faviconUrl:        urlField,
  // ── V2 tokens ──
  themeMode:         z.enum(['light', 'dark', 'darker', 'midnight', 'system']).nullable().optional(),
  fontFamily:        z.string().max(200).nullable().optional(),
  fontScale:         z.number().min(0.75).max(1.5).nullable().optional(),
  density:           z.enum(['compact', 'normal', 'comfortable']).nullable().optional(),
  borderRadius:      z.enum(['none', 'sm', 'md', 'lg', 'xl']).nullable().optional(),
  shadowLevel:       z.enum(['none', 'sm', 'md', 'lg']).nullable().optional(),
  componentHeight:   z.number().int().min(24).max(64).nullable().optional(),
  backgroundColor:    colorField,
  surfaceColor:       colorField,
  surfaceRaisedColor: colorField,
  borderColor:        colorField,
  textPrimaryColor:   colorField,
  textSecondaryColor: colorField,
  textMutedColor:     colorField,
  successColor:       colorField,
  warningColor:       colorField,
  dangerColor:        colorField,
  informationColor:   colorField,
  offlineColor:       colorField,
  recordingColor:     colorField,
  analyticsColor:     colorField,
})

const appearancePlugin: FastifyPluginAsync = async (server) => {
  // preHandler: exige ADMIN o el permiso de feature canManageAppearance.
  // Reemplaza el authorize(['ADMIN']) para no acoplar la gestión de apariencia
  // exclusivamente al rol ADMIN.
  const requireAppearanceManage = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({
        statusCode: 401, error: 'Unauthorized', message: 'Token inválido o expirado',
      })
    }
    const user = request.user as { sub: string; role: string }
    // ADMIN: atajo sin consultar la DB.
    if (user.role === 'ADMIN') return
    const fp = await server.prisma.userFeaturePermissions.findUnique({
      where: { userId: user.sub },
    })
    if (!canManageAppearance(user.role, fp as any)) {
      return reply.status(403).send({
        statusCode: 403, error: 'Forbidden',
        message: 'No tienes permisos para administrar la apariencia',
      })
    }
  }

  // GET — público (necesario para tematizar antes del login).
  // Devuelve SÓLO la proyección publicable (whitelist), nunca campos internos.
  server.get('/', async (_request, reply) => {
    let settings = await server.prisma.appearanceSettings.findUnique({
      where: { id: 'singleton' },
    })
    if (!settings) {
      settings = await server.prisma.appearanceSettings.create({
        data: { id: 'singleton' },
      })
    }

    // Persistir de vuelta las URLs normalizadas si cambiaron (idempotente).
    const logoUrl        = normalizeUploadUrl(settings.logoUrl)
    const sidebarLogoUrl = normalizeUploadUrl(settings.sidebarLogoUrl)
    const faviconUrl     = normalizeUploadUrl(settings.faviconUrl)
    const urlUpdates: Record<string, string> = {}
    if (settings.logoUrl        && settings.logoUrl        !== logoUrl)        urlUpdates.logoUrl        = logoUrl
    if (settings.sidebarLogoUrl && settings.sidebarLogoUrl !== sidebarLogoUrl) urlUpdates.sidebarLogoUrl = sidebarLogoUrl
    if (settings.faviconUrl     && settings.faviconUrl     !== faviconUrl)     urlUpdates.faviconUrl     = faviconUrl
    if (Object.keys(urlUpdates).length > 0) {
      server.prisma.appearanceSettings.update({ where: { id: 'singleton' }, data: urlUpdates })
        .catch((e: any) => server.log.warn({ err: e }, '[appearance] failed to persist normalized URLs'))
    }

    return reply.send(toPublishableAppearance(settings as any))
  })

  // PUT — requiere gestión de apariencia (ADMIN o canManageAppearance).
  server.put('/', { preHandler: [requireAppearanceManage] }, async (request, reply) => {
    const data = updateAppearanceSchema.parse(request.body)

    const settings = await server.prisma.appearanceSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    })

    return reply.send(toPublishableAppearance(settings as any))
  })

  // POST /appearance/upload — carga multipart de assets de branding.
  server.post('/upload', { preHandler: [requireAppearanceManage] }, async (request, reply) => {
    const ALLOWED_MIMES = new Set([
      'image/png', 'image/jpeg', 'image/webp',
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
      // Bloqueo temporal de SVG (hasta sanitización real en PR 1b). No borra
      // los SVG ya configurados; sólo rechaza cargas nuevas inseguras.
      if (isBlockedSvgUpload(part.mimetype, part.filename)) {
        await part.toBuffer()
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          code: BLOCKED_SVG_CODE,
          message: 'La carga de SVG está deshabilitada temporalmente por seguridad. Usá PNG, JPG, WEBP o ICO.',
        })
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

    return reply.send(toPublishableAppearance(settings as any))
  })
}

export default appearancePlugin
