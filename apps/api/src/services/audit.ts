// apps/api/src/services/audit.ts
import type { PrismaClient } from '@prisma/client'
import type { FastifyRequest } from 'fastify'

export async function AuditAction(
  prisma: PrismaClient,
  userId: string | null,
  action: string,
  resource: string | null,
  request?: FastifyRequest,
  detail?: object
) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        resource,
        detail: detail ? JSON.stringify(detail) : undefined,
        ipAddress: request?.ip || null,
        userAgent: request?.headers['user-agent'] || null,
      },
    })
  } catch {
    // No bloquear el flujo si falla el log
  }
}
