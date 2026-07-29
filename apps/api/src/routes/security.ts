// apps/api/src/routes/security.ts
// Ajustes de seguridad persistidos (P0). Reemplaza el "guardado" falso de la UI:
// GET/PUT reales con validación y auditoría. La política de contraseña (mín. 12),
// el timeout de sesión, las sesiones concurrentes y el lockout se aplican en auth.ts
// leyendo estos valores. La política MFA (mfaRequired) se persiste aquí; su
// enforcement llega en la fase siguiente.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AuditAction } from '../services/audit'
import { getSecuritySettings } from '../services/security-settings'
import { SECURITY_LIMITS, DEFAULT_SECURITY_SETTINGS } from '../services/security-policy'

const L = SECURITY_LIMITS

const settingsSchema = z.object({
  passwordMinLength:      z.number().int().min(L.passwordMinLength.min).max(L.passwordMinLength.max),
  requireStrongPassword:  z.boolean(),
  sessionTimeoutMinutes:  z.number().int().min(L.sessionTimeoutMinutes.min).max(L.sessionTimeoutMinutes.max),
  maxSessions:            z.number().int().min(L.maxSessions.min).max(L.maxSessions.max),
  lockoutMaxAttempts:     z.number().int().min(L.lockoutMaxAttempts.min).max(L.lockoutMaxAttempts.max),
  lockoutDurationMinutes: z.number().int().min(L.lockoutDurationMinutes.min).max(L.lockoutDurationMinutes.max),
  mfaRequired:            z.boolean(),
  mfaGracePeriodLogins:   z.number().int().min(L.mfaGracePeriodLogins.min).max(L.mfaGracePeriodLogins.max),
}).partial()

export const securityRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/security/settings — ADMIN
  server.get('/settings', { preHandler: [server.authorize(['ADMIN'])] }, async (_req, reply) => {
    const settings = await getSecuritySettings(server.prisma)
    return reply.send(settings)
  })

  // PUT /api/security/settings — ADMIN (persistencia REAL + auditoría)
  server.put('/settings', { preHandler: [server.authorize(['ADMIN'])] }, async (request, reply) => {
    const data = settingsSchema.parse(request.body)
    const before = await getSecuritySettings(server.prisma)

    const merged = { ...DEFAULT_SECURITY_SETTINGS, ...before, ...data }
    const saved = await server.prisma.securitySettings.upsert({
      where: { id: 'singleton' },
      update: { ...data, updatedBy: request.user.sub },
      create: { id: 'singleton', ...merged, updatedBy: request.user.sub } as any,
    })

    await AuditAction(server.prisma, request.user.sub, 'SECURITY_SETTINGS_UPDATED', 'singleton', request, {
      changed: Object.keys(data),
    })

    return reply.send({
      passwordMinLength:      saved.passwordMinLength,
      requireStrongPassword:  saved.requireStrongPassword,
      sessionTimeoutMinutes:  saved.sessionTimeoutMinutes,
      maxSessions:            saved.maxSessions,
      lockoutMaxAttempts:     saved.lockoutMaxAttempts,
      lockoutDurationMinutes: saved.lockoutDurationMinutes,
      mfaRequired:            saved.mfaRequired,
      mfaGracePeriodLogins:   saved.mfaGracePeriodLogins,
    })
  })
}
