// apps/api/src/routes/users.ts
import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { AuditAction } from '../services/audit'
import { checkPasswordPolicy, addToPasswordHistory, resolveFeaturePermissions } from '../services/totp'

const createUserSchema = z.object({
  username: z.string().min(3).max(50),
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1).max(100),
  role: z.enum(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR']),
})

const updateUserSchema = z.object({
  email:              z.string().email().optional(),
  fullName:           z.string().min(1).max(100).optional(),
  role:               z.enum(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR']).optional(),
  active:             z.boolean().optional(),
  password:           z.string().min(8).optional(),
  forcePasswordChange: z.boolean().optional(),
})

const permissionSchema = z.object({
  nvrId:          z.string().optional(),
  cameraId:       z.string().optional(),
  canView:        z.boolean().default(true),
  canPlayback:    z.boolean().default(false),
  canPtz:         z.boolean().default(false),
  canHighQuality: z.boolean().default(false),
})

const featurePermSchema = z.object({
  canViewDashboard:    z.boolean().optional(),
  canViewLive:         z.boolean().optional(),
  canViewRecordings:   z.boolean().optional(),
  canViewAlerts:       z.boolean().optional(),
  canViewDiagnostics:  z.boolean().optional(),
  canManageNVRs:       z.boolean().optional(),
  canManageCameras:    z.boolean().optional(),
  canManageUsers:      z.boolean().optional(),
  canManageAppearance: z.boolean().optional(),
  canResolveAlerts:    z.boolean().optional(),
  canRestartStreams:    z.boolean().optional(),
  canTranscode:        z.boolean().optional(),
})

export const userRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/users/audit/activity — Log de actividad (registrado antes de /:id)
  server.get('/audit/activity', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { page = '1', limit = '50', userId } = request.query as {
      page?: string; limit?: string; userId?: string
    }

    const where = userId ? { userId } : {}
    const skip = (parseInt(page) - 1) * parseInt(limit)
    const take = parseInt(limit)

    const [logs, total] = await Promise.all([
      server.prisma.auditLog.findMany({
        where,
        include: { user: { select: { username: true, fullName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      server.prisma.auditLog.count({ where }),
    ])

    return reply.send({ logs, total })
  })

  // GET /api/users — Listar usuarios (solo ADMIN)
  server.get('/', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const users = await server.prisma.user.findMany({
      select: {
        id: true, username: true, email: true, fullName: true,
        role: true, active: true, createdAt: true, updatedAt: true,
        twoFactorEnabled: true, forcePasswordChange: true,
        lockedUntil: true, failedLoginAttempts: true,
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
        id: true, username: true, email: true, fullName: true,
        role: true, active: true, createdAt: true,
        twoFactorEnabled: true, forcePasswordChange: true,
        lockedUntil: true, failedLoginAttempts: true, passwordChangedAt: true,
        permissions: {
          include: {
            nvr:    { select: { id: true, name: true } },
            camera: { select: { id: true, name: true, channel: true } },
          },
        },
        featurePermissions: true,
        sessions: {
          select: {
            id: true, userAgent: true, ipAddress: true, deviceName: true,
            createdAt: true, expiresAt: true, lastUsedAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    })

    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })

    const { featurePermissions, ...rest } = user as any
    return reply.send({
      ...rest,
      featurePermissions: resolveFeaturePermissions(user.role, featurePermissions),
    })

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
    const { password: _, ...userData } = data

    const user = await server.prisma.user.create({
      data: {
        ...userData,
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
      const policy = checkPasswordPolicy(data.password)
      if (!policy.valid) {
        return reply.status(400).send({ message: 'Contraseña no cumple la política', errors: policy.errors })
      }
      const newHash = await bcrypt.hash(data.password, 12)
      const existing = await server.prisma.user.findUnique({ where: { id }, select: { passwordHistory: true } })
      updateData.passwordHash = newHash
      updateData.passwordHistory = await addToPasswordHistory(newHash, existing?.passwordHistory ?? null)
      updateData.passwordChangedAt = new Date()
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
        userId:         id,
        nvrId:          p.nvrId || null,
        cameraId:       p.cameraId || null,
        canView:        p.canView,
        canPlayback:    p.canPlayback,
        canPtz:         p.canPtz,
        canHighQuality: p.canHighQuality,
      })),
    })

    await AuditAction(server.prisma, request.user.sub, 'PERMISSIONS_UPDATED', id, request, {
      permissionsCount: created.count,
    })

    return reply.send({ message: 'Permisos actualizados', count: created.count })
  })

  // POST /api/users/:id/feature-permissions — Permisos de funcionalidades
  server.post('/:id/feature-permissions', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = featurePermSchema.parse(request.body)

    const user = await server.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })

    await server.prisma.userFeaturePermissions.upsert({
      where:  { userId: id },
      create: { userId: id, ...data },
      update: data,
    })

    await AuditAction(server.prisma, request.user.sub, 'FEATURE_PERMISSIONS_UPDATED', id, request)
    return reply.send({ message: 'Permisos de funcionalidades actualizados' })
  })

  // POST /api/users/:id/reset-2fa — Admin resetea 2FA
  server.post('/:id/reset-2fa', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    if (id === request.user.sub) {
      return reply.status(400).send({ message: 'Usa el panel de seguridad para gestionar tu propio 2FA' })
    }

    await server.prisma.user.update({
      where: { id },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null },
    })

    await AuditAction(server.prisma, request.user.sub, 'TWO_FA_RESET_BY_ADMIN', id, request)
    return reply.send({ message: '2FA del usuario ha sido deshabilitado' })
  })

  // POST /api/users/:id/unlock — Desbloquear cuenta
  server.post('/:id/unlock', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    await server.prisma.user.update({
      where: { id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    })

    await AuditAction(server.prisma, request.user.sub, 'USER_UNLOCKED', id, request)
    return reply.send({ message: 'Cuenta desbloqueada' })
  })

  // GET /api/users/:id/sessions — Sesiones activas (admin)
  server.get('/:id/sessions', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const sessions = await server.prisma.session.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, userAgent: true, ipAddress: true, deviceName: true,
        createdAt: true, expiresAt: true, lastUsedAt: true,
      },
    })
    return reply.send(sessions)
  })

  // DELETE /api/users/:id/sessions — Revocar todas las sesiones (admin)
  server.delete('/:id/sessions', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { count } = await server.prisma.session.deleteMany({ where: { userId: id } })
    await AuditAction(server.prisma, request.user.sub, 'USER_SESSIONS_REVOKED', id, request, { count })
    return reply.send({ message: `${count} sesiones revocadas` })
  })

}
