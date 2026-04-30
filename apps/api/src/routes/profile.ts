// apps/api/src/routes/profile.ts
import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { z } from 'zod'

const updateProfileSchema = z.object({
  fullName: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional().nullable(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})

const avatarSchema = z.object({
  avatarUrl: z.string().max(500_000).nullable(), // base64 data URL, ~375KB image
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

    const user = await server.prisma.user.findUnique({ where: { id: request.user.sub } })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })

    const valid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!valid) {
      return reply.status(400).send({ message: 'Contraseña actual incorrecta' })
    }

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await server.prisma.user.update({
      where: { id: request.user.sub },
      data: { passwordHash },
    })

    // Invalidate all other sessions
    await server.prisma.session.deleteMany({
      where: { userId: request.user.sub },
    })

    return reply.send({ message: 'Contraseña actualizada. Inicia sesión nuevamente.' })
  })

  // PUT /api/profile/avatar — update profile photo
  server.put('/avatar', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { avatarUrl } = avatarSchema.parse(request.body)

    await server.prisma.user.update({
      where: { id: request.user.sub },
      data: { avatarUrl },
    })

    return reply.send({ message: 'Foto actualizada' })
  })
}

export default profileRoutes
