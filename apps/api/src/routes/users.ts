// apps/api/src/routes/users.ts
import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { AuditAction } from '../services/audit'

const createUserSchema = z.object({
  username: z.string().min(3).max(50),
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1).max(100),
  role: z.enum(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR']),
})

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  fullName: z.string().min(1).max(100).optional(),
  role: z.enum(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR']).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).optional(),
})

const permissionSchema = z.object({
  nvrId: z.string().optional(),
  cameraId: z.string().optional(),
  canView: z.boolean().default(true),
  canPlayback: z.boolean().default(false),
  canPtz: z.boolean().default(false),
})

export const userRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/users — Listar usuarios (solo ADMIN)
  server.get('/', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const users = await server.prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        role: true,
        active: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { permissions: true, sessions: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return reply.send(users)
  })

  // GET /api/users/:id — Detalle de usuario
  server.get('/:id', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const user = await server.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        role: true,
        active: true,
        createdAt: true,
        permissions: {
          include: {
            nvr: { select: { id: true, name: true } },
            camera: { select: { id: true, name: true, channel: true } },
          },
        },
        sessions: {
          select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    })

    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })

    return reply.send(user)
  })

  // POST /api/users — Crear usuario (solo ADMIN)
  server.post('/', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const data = createUserSchema.parse(request.body)

    const exists = await server.prisma.user.findFirst({
      where: { OR: [{ username: data.username }, { email: data.email }] },
    })

    if (exists) {
      return reply.status(409).send({ message: 'Username o email ya en uso' })
    }

    const passwordHash = await bcrypt.hash(data.password, 12)

    const user = await server.prisma.user.create({
      data: {
        ...data,
        password: undefined,
        passwordHash,
      },
      select: {
        id: true,
        username: true,
        email: true,
        fullName: true,
        role: true,
        active: true,
        createdAt: true,
      },
    })

    await AuditAction(server.prisma, request.user.sub, 'USER_CREATED', user.id, request, {
      newUser: user.username,
      role: user.role,
    })

    return reply.status(201).send(user)
  })

  // PUT /api/users/:id — Actualizar usuario (solo ADMIN)
  server.put('/:id', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = updateUserSchema.parse(request.body)

    const updateData: any = { ...data }

    if (data.password) {
      updateData.passwordHash = await bcrypt.hash(data.password, 12)
      delete updateData.password
    }

    const user = await server.prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true, username: true, email: true, fullName: true, role: true, active: true,
      },
    })

    await AuditAction(server.prisma, request.user.sub, 'USER_UPDATED', id, request)

    return reply.send(user)
  })

  // DELETE /api/users/:id — Eliminar usuario (solo ADMIN)
  server.delete('/:id', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    if (id === request.user.sub) {
      return reply.status(400).send({ message: 'No puedes eliminar tu propio usuario' })
    }

    await server.prisma.user.delete({ where: { id } })
    await AuditAction(server.prisma, request.user.sub, 'USER_DELETED', id, request)

    return reply.send({ message: 'Usuario eliminado' })
  })

  // POST /api/users/:id/permissions — Asignar permisos (solo ADMIN)
  server.post('/:id/permissions', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const permissions = z.array(permissionSchema).parse(request.body)

    // Eliminar permisos existentes y recrear
    await server.prisma.userPermission.deleteMany({ where: { userId: id } })

    const created = await server.prisma.userPermission.createMany({
      data: permissions.map((p) => ({
        userId: id,
        nvrId: p.nvrId || null,
        cameraId: p.cameraId || null,
        canView: p.canView,
        canPlayback: p.canPlayback,
        canPtz: p.canPtz,
      })),
    })

    await AuditAction(server.prisma, request.user.sub, 'PERMISSIONS_UPDATED', id, request, {
      permissionsCount: created.count,
    })

    return reply.send({ message: 'Permisos actualizados', count: created.count })
  })

  // GET /api/users/activity — Log de actividad general (solo ADMIN)
  server.get('/audit/activity', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { page = '1', limit = '50', userId } = request.query as {
      page?: string; limit?: string; userId?: string
    }

    const logs = await server.prisma.auditLog.findMany({
      where: userId ? { userId } : {},
      include: { user: { select: { username: true, fullName: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
    })

    return reply.send(logs)
  })
}
