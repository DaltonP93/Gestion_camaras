// apps/api/src/routes/appearance.ts
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import {
  canManageAppearance,
  isBlockedSvgUpload,
  BLOCKED_SVG_CODE,
  isAllowedUploadMime,
  resolveUploadAsset,
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

    // Partes ya validadas. El disco y la DB se tocan recién cuando TODAS pasaron:
    // antes, un rechazo en la 2.ª parte llegaba con el archivo previo de la 1.ª ya
    // borrado y la DB apuntando a él (branding roto).
    const accepted: Array<{ dbKey: string; fileName: string; buf: Buffer }> = []

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
      if (!isAllowedUploadMime(part.mimetype)) {
        await part.toBuffer()
        return reply.status(400).send({ message: `Tipo de archivo no permitido: ${part.mimetype}` })
      }

      const buf = await part.toBuffer()
      if (buf.length === 0) continue

      // Anti-XSS almacenado: la extensión guardada se DERIVA del tipo de imagen
      // detectado por FIRMA MÁGICA, nunca del nombre del cliente ni del MIME
      // declarado. Un .html/.js/.xml con un Content-Type de imagen falso no
      // coincide con ninguna firma raster ⇒ se rechaza, y @fastify/static nunca
      // lo serviría con Content-Type ejecutable en el mismo origen. Una imagen
      // real rotulada con otro MIME permitido (PNG llamado .ico) se acepta con
      // su extensión REAL. (Repro aislada con Chromium: ver PR.)
      const asset = resolveUploadAsset(part.mimetype, buf)
      if (!asset.ok) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          code: 'UNSAFE_UPLOAD_CONTENT',
          message: 'El contenido del archivo no coincide con una imagen PNG/JPG/WEBP/ICO válida',
        })
      }
      const dbKey = fieldToDbKey[part.fieldname]
      // Si dos campos apuntan a la misma columna (favicon/faviconUrl), gana el último.
      const prevIdx = accepted.findIndex((a) => a.dbKey === dbKey)
      if (prevIdx >= 0) accepted.splice(prevIdx, 1)
      accepted.push({ dbKey, fileName: `${part.fieldname}_${Date.now()}${asset.ext}`, buf })
    }

    if (accepted.length === 0) {
      return reply.status(400).send({ message: 'No se recibieron archivos válidos' })
    }

    // Load current settings to know previous file paths
    const current = await server.prisma.appearanceSettings.findUnique({ where: { id: 'singleton' } })

    // Orden: escribir los nuevos → actualizar la DB → borrar los anteriores. Así
    // la DB nunca apunta a un archivo inexistente, ni siquiera si el upsert falla.
    const updates: Record<string, string> = {}
    for (const a of accepted) {
      fs.writeFileSync(path.join(brandingDir, a.fileName), a.buf)
      // Save as relative path — frontend resolves to full URL using resolveAssetUrl
      updates[a.dbKey] = `/uploads/branding/${a.fileName}`
    }

    const settings = await server.prisma.appearanceSettings.upsert({
      where:  { id: 'singleton' },
      create: { id: 'singleton', ...updates },
      update: updates,
    })

    // Delete previous file for each updated field if it's a local upload
    for (const [dbKey, newUrl] of Object.entries(updates)) {
      const prevUrl: string | null = (current as any)?.[dbKey] ?? null
      if (prevUrl && prevUrl !== newUrl && (prevUrl.startsWith('/uploads/branding/') || prevUrl.includes('/uploads/branding/'))) {
        const prevFile = path.join(brandingDir, path.basename(prevUrl))
        try { fs.unlinkSync(prevFile) } catch {}
      }
    }

    return reply.send(toPublishableAppearance(settings as any))
  })
}

export default appearancePlugin
