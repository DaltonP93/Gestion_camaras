// Carga de los ajustes de seguridad (singleton) con defaults seguros.
import type { PrismaClient } from '@prisma/client'
import { DEFAULT_SECURITY_SETTINGS, type SecuritySettingsShape } from './security-policy'

// Devuelve los ajustes persistidos, o los defaults si aún no existe la fila. NUNCA
// lanza: si la tabla/consulta falla, se cae a los defaults seguros (mín. 12, etc.).
export async function getSecuritySettings(prisma: PrismaClient): Promise<SecuritySettingsShape> {
  try {
    const row = await prisma.securitySettings.findUnique({ where: { id: 'singleton' } })
    if (!row) return { ...DEFAULT_SECURITY_SETTINGS }
    return {
      passwordMinLength:      row.passwordMinLength,
      requireStrongPassword:  row.requireStrongPassword,
      sessionTimeoutMinutes:  row.sessionTimeoutMinutes,
      maxSessions:            row.maxSessions,
      lockoutMaxAttempts:     row.lockoutMaxAttempts,
      lockoutDurationMinutes: row.lockoutDurationMinutes,
      mfaRequired:            row.mfaRequired,
      mfaGracePeriodLogins:   row.mfaGracePeriodLogins,
    }
  } catch {
    return { ...DEFAULT_SECURITY_SETTINGS }
  }
}
