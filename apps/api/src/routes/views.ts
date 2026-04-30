// apps/api/src/routes/views.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

const cameraSlotSchema = z.object({
  slotIndex: z.number().int().min(0),
  cameraId: z.string().nullable().optional(),
  size: z.enum(['normal', 'large']).default('normal'),
})

const createViewSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  layout: z.enum(['1x1', '2x2', '3x3', '4x4', 'featured', 'custom']).default('3x3'),
  cameraSlots: z.array(cameraSlotSchema),
  slideshowEnabled: z.boolean().default(false),
  slideshowInterval: z.number().int().min(5).max(300).default(10),
  isPublic: z.boolean().default(false),
  accessUserIds: z.array(z.string()).optional(),
})

const updateViewSchema = createViewSchema.partial()

const viewsPlugin: FastifyPluginAsync = async (server) => {
  // List views accessible by current user
  server.get('/', { preHandler: [server.authenticate] }, async (request, reply) => {
    const userId = request.user.sub
    const role = request.user.role

    const views = await server.prisma.cameraView.findMany({
      where: role === 'ADMIN' ? undefined : {
        OR: [
          { isPublic: true },
          { createdById: userId },
          { access: { some: { userId } } },
        ],
      },
      include: {
        access: { select: { userId: true, user: { select: { fullName: true, username: true } } } },
        _count: { select: { access: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })

    return reply.send(views)
  })

  // Get single view
  server.get('/:id', { preHandler: [server.authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user.sub
    const role = request.user.role

    const view = await server.prisma.cameraView.findUnique({
      where: { id },
      include: {
        access: { select: { userId: true, user: { select: { fullName: true, username: true } } } },
      },
    })

    if (!view) return reply.status(404).send({ message: 'Vista no encontrada' })

    const hasAccess =
      role === 'ADMIN' ||
      view.isPublic ||
      view.createdById === userId ||
      view.access.some((a: { userId: string }) => a.userId === userId)

    if (!hasAccess) return reply.status(403).send({ message: 'Sin acceso a esta vista' })

    return reply.send(view)
  })

  // Create view (ADMIN, SUPERVISOR)
  server.post('/', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const data = createViewSchema.parse(request.body)
    const userId = request.user.sub

    const view = await server.prisma.cameraView.create({
      data: {
        name: data.name,
        description: data.description,
        layout: data.layout,
        cameraSlots: data.cameraSlots,
        slideshowEnabled: data.slideshowEnabled,
        slideshowInterval: data.slideshowInterval,
        isPublic: data.isPublic,
        createdById: userId,
        access: data.accessUserIds?.length
          ? { create: data.accessUserIds.map((uid) => ({ userId: uid })) }
          : undefined,
      },
      include: {
        access: { select: { userId: true } },
      },
    })

    return reply.status(201).send(view)
  })

  // Update view
  server.put('/:id', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = updateViewSchema.parse(request.body)
    const userId = request.user.sub
    const role = request.user.role

    const existing = await server.prisma.cameraView.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ message: 'Vista no encontrada' })
    if (role !== 'ADMIN' && existing.createdById !== userId) {
      return reply.status(403).send({ message: 'Solo puedes editar tus propias vistas' })
    }

    const { accessUserIds, ...rest } = data

    const view = await server.prisma.cameraView.update({
      where: { id },
      data: {
        ...rest,
        cameraSlots: rest.cameraSlots as any,
        ...(accessUserIds !== undefined && {
          access: {
            deleteMany: {},
            create: accessUserIds.map((uid) => ({ userId: uid })),
          },
        }),
      },
      include: {
        access: { select: { userId: true, user: { select: { fullName: true, username: true } } } },
      },
    })

    return reply.send(view)
  })

  // Delete view
  server.delete('/:id', { preHandler: [server.authorize(['ADMIN', 'SUPERVISOR'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = request.user.sub
    const role = request.user.role

    const existing = await server.prisma.cameraView.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ message: 'Vista no encontrada' })
    if (role !== 'ADMIN' && existing.createdById !== userId) {
      return reply.status(403).send({ message: 'Solo puedes eliminar tus propias vistas' })
    }

    await server.prisma.cameraView.delete({ where: { id } })
    return reply.status(204).send()
  })
}

export default viewsPlugin
