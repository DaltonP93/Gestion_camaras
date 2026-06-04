// apps/api/src/routes/profile.ts
import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { z } from 'zod'
import { checkPasswordPolicy, checkPasswordHistory, addToPasswordHistory } from '../services/totp'

const updateProfileSchema = z.object({
  fullName: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional().nullable(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})

const profileRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/profile — own profile with avatar
  server.get('/', { preHandler: [server.authenticate] }, async (request, reply) => {
    const user = await server.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: {
        id: true, username: true, fullName: true, email: true,
        role: true, active: true, avatarUrl: true, phone: true, createdAt: true,
      },
    })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })
    return reply.send(user)
  })

  // PUT /api/profile — update own data
  server.put('/', { preHandler: [server.authenticate] }, async (request, reply) => {
    const data = updateProfileSchema.parse(request.body)

    // Check email uniqueness if changing
    if (data.email) {
      const existing = await server.prisma.user.findFirst({
        where: { email: data.email, NOT: { id: request.user.sub } },
      })
      if (existing) {
        return reply.status(409).send({ message: 'Ese email ya está en uso' })
      }
    }

    const user = await server.prisma.user.update({
      where: { id: request.user.sub },
      data: { ...data },
      select: {
        id: true, username: true, fullName: true, email: true,
        role: true, active: true, avatarUrl: true, phone: true,
      },
    })
    return reply.send(user)
  })

  // PUT /api/profile/password — change own password
  server.put('/password', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(request.body)

    const user = await server.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: { id: true, passwordHash: true, passwordHistory: true },
    })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })

    const valid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!valid) {
      return reply.status(400).send({ message: 'Contraseña actual incorrecta' })
    }

    const policy = checkPasswordPolicy(newPassword)
    if (!policy.valid) {
      return reply.status(400).send({ message: 'Contraseña no cumple la política', errors: policy.errors })
    }

    const reused = await checkPasswordHistory(newPassword, user.passwordHistory ?? null)
    if (reused) {
      return reply.status(400).send({ message: 'No puedes reutilizar una de tus últimas 5 contraseñas' })
    }

    const newHash = await bcrypt.hash(newPassword, 12)
    const newHistory = await addToPasswordHistory(newHash, user.passwordHistory ?? null)

    await server.prisma.user.update({
      where: { id: request.user.sub },
      data: {
        passwordHash: newHash,
        passwordHistory: newHistory,
        passwordChangedAt: new Date(),
        forcePasswordChange: false,
      },
    })

    await server.prisma.session.deleteMany({ where: { userId: request.user.sub } })
    return reply.send({ message: 'Contraseña actualizada. Inicia sesión nuevamente.' })
  })

  // POST /api/profile/avatar — upload profile photo (multipart)
  server.post('/avatar', { preHandler: [server.authenticate] }, async (request, reply) => {
    const data = await request.file()
    if (!data) {
      return reply.status(400).send({ message: 'No se recibió ningún archivo' })
    }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedMimes.includes(data.mimetype)) {
      return reply.status(400).send({ message: 'Formato no permitido. Solo JPG, PNG o WebP.' })
    }

    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    }
    const ext = extMap[data.mimetype]
    const filename = `${request.user.sub}-${Date.now()}.${ext}`

    const uploadsDir = process.env.UPLOADS_DIR || '/app/uploads'
    const avatarsDir = path.join(uploadsDir, 'avatars')
    fs.mkdirSync(avatarsDir, { recursive: true })

    const filePath = path.join(avatarsDir, filename)
    await pipeline(data.file, fs.createWriteStream(filePath))

    // Delete old avatar file if it exists on disk
    const currentUser = await server.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: { avatarUrl: true },
    })
    if (currentUser?.avatarUrl && currentUser.avatarUrl.startsWith('/uploads/avatars/')) {
      const oldFile = path.join(uploadsDir, currentUser.avatarUrl.replace('/uploads/', ''))
      try { fs.unlinkSync(oldFile) } catch { /* ignore if already gone */ }
    }

    const avatarUrl = `/uploads/avatars/${filename}`
    await server.prisma.user.update({
      where: { id: request.user.sub },
      data: { avatarUrl },
    })

    return reply.send({ avatarUrl })
  })
}

export default profileRoutes
