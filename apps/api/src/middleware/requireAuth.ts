// apps/api/src/middleware/requireAuth.ts
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { Role } from '@prisma/client'
import type { JWTPayload } from '../plugins/auth'

// Middleware para verificar que el usuario tiene permiso sobre un NVR específico
export async function requireNVRAccess(
  request: FastifyRequest & { user: JWTPayload },
  reply: FastifyReply,
  nvrId: string
) {
  const user = request.user

  // Admin y Supervisor tienen acceso a todo
  if (['ADMIN', 'SUPERVISOR'].includes(user.role)) return true

  const server = (request.server as any)
  const perm = await server.prisma.userPermission.findFirst({
    where: { userId: user.sub, nvrId, canView: true },
  })

  if (!perm) {
    reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Sin acceso a este NVR',
    })
    return false
  }

  return true
}

// Middleware para verificar permiso sobre una cámara específica
export async function requireCameraAccess(
  request: FastifyRequest & { user: JWTPayload },
  reply: FastifyReply,
  cameraId: string,
  permission: 'canView' | 'canPlayback' | 'canPtz' = 'canView'
) {
  const user = request.user

  if (['ADMIN', 'SUPERVISOR'].includes(user.role)) return true

  const server = (request.server as any)
  const perm = await server.prisma.userPermission.findFirst({
    where: { userId: user.sub, cameraId, [permission]: true },
  })

  if (!perm) {
    reply.status(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: `Sin permiso "${permission}" para esta cámara`,
    })
    return false
  }

  return true
}
