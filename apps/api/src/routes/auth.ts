// apps/api/src/routes/auth.ts
import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { z } from 'zod'
import { AuditAction } from '../services/audit'
import {
  generateTotpSecret, verifyTotpToken, getTotpQrCodeUri,
  generateBackupCodes, hashBackupCodes, verifyBackupCode,
  parseDeviceName, checkPasswordPolicy, checkPasswordHistory, addToPasswordHistory,
  resolveFeaturePermissions,
} from '../services/totp'

const ACCESS_TOKEN_TTL_MS  = 60 * 60 * 1000            // 1 hora
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 7 días
const TWO_FA_TOKEN_TTL_MS  = 5 * 60 * 1000             // 5 minutos
const MAX_FAILED_ATTEMPTS  = 5
const LOCKOUT_DURATION_MS  = 15 * 60 * 1000            // 15 minutos

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

const twoFaVerifySchema = z.object({
  tempToken: z.string().min(1),
  code:      z.string().min(6).max(8),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8),
})

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

// ─── Select del usuario para /me ─────────────────────────────
const userMeSelect = {
  id: true, username: true, fullName: true, email: true,
  role: true, active: true, avatarUrl: true, phone: true,
  createdAt: true, twoFactorEnabled: true, forcePasswordChange: true,
  permissions: { include: { nvr: true, camera: true } },
  featurePermissions: true,
}

export const authRoutes: FastifyPluginAsync = async (server) => {

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/login
  // ──────────────────────────────────────────────────────────
  server.post('/login', {
    config: { rateLimit: { max: 8, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = loginSchema.parse(request.body)

    const user = await server.prisma.user.findUnique({
      where: { username: body.username },
    })

    if (!user || !user.active) {
      await AuditAction(server.prisma, null, 'AUTH_FAILED', body.username, request, {
        reason: !user ? 'user_not_found' : 'user_inactive',
      })
      return reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Credenciales inválidas' })
    }

    // Account lockout check
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
      await AuditAction(server.prisma, user.id, 'AUTH_FAILED', user.id, request, { reason: 'account_locked' })
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: `Cuenta bloqueada. Intenta en ${remaining} minutos.`,
        code: 'ACCOUNT_LOCKED',
      })
    }

    const passwordValid = await bcrypt.compare(body.password, user.passwordHash)
    if (!passwordValid) {
      const attempts = user.failedLoginAttempts + 1
      const lockout = attempts >= MAX_FAILED_ATTEMPTS
        ? { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) }
        : {}

      await server.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: attempts, ...lockout },
      })

      await AuditAction(server.prisma, user.id, 'AUTH_FAILED', user.id, request, {
        reason: 'wrong_password',
        attempt: attempts,
      })

      if (lockout.lockedUntil) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: `Demasiados intentos. Cuenta bloqueada por ${LOCKOUT_DURATION_MS / 60000} minutos.`,
          code: 'ACCOUNT_LOCKED',
        })
      }

      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: `Credenciales inválidas (${MAX_FAILED_ATTEMPTS - attempts} intentos restantes)`,
      })
    }

    // Reset failed attempts on successful password
    await server.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    })

    // 2FA required?
    if (user.twoFactorEnabled) {
      const tempToken = (server.jwt as any).sign(
        { sub: user.id, step: '2fa' },
        { expiresIn: '5m' }
      )
      await AuditAction(server.prisma, user.id, 'LOGIN_2FA_REQUIRED', user.id, request)
      return reply.send({ requiresTwoFactor: true, tempToken })
    }

    return completeLogin(server, request, reply, user)
  })

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/2fa/verify — complete 2FA login
  // ──────────────────────────────────────────────────────────
  server.post('/2fa/verify', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const { tempToken, code } = twoFaVerifySchema.parse(request.body)

    let payload: any
    try {
      payload = server.jwt.verify(tempToken)
    } catch {
      return reply.status(401).send({ message: 'Token temporal inválido o expirado' })
    }

    if (payload.step !== '2fa') {
      return reply.status(400).send({ message: 'Token no válido para 2FA' })
    }

    const user = await server.prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user || !user.active || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return reply.status(401).send({ message: 'No autorizado' })
    }

    // Check TOTP code
    const totpValid = verifyTotpToken(user.twoFactorSecret, code)

    if (!totpValid) {
      // Try backup code (8-char hex)
      if (code.length === 8 && user.twoFactorBackupCodes) {
        try {
          const hashes: string[] = JSON.parse(user.twoFactorBackupCodes)
          const idx = await verifyBackupCode(code, hashes)
          if (idx >= 0) {
            hashes.splice(idx, 1)
            await server.prisma.user.update({
              where: { id: user.id },
              data: { twoFactorBackupCodes: JSON.stringify(hashes) },
            })
            await AuditAction(server.prisma, user.id, 'LOGIN_BACKUP_CODE_USED', user.id, request, {
              codesRemaining: hashes.length,
            })
            return completeLogin(server, request, reply, user)
          }
        } catch {}
      }

      await AuditAction(server.prisma, user.id, 'AUTH_2FA_FAILED', user.id, request)
      return reply.status(401).send({ message: 'Código 2FA incorrecto' })
    }

    return completeLogin(server, request, reply, user)
  })

  // ──────────────────────────────────────────────────────────
  // GET /api/auth/2fa/setup — get QR code for enrollment
  // ──────────────────────────────────────────────────────────
  server.get('/2fa/setup', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const user = await server.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: { id: true, username: true, twoFactorEnabled: true },
    })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })
    if (user.twoFactorEnabled) {
      return reply.status(400).send({ message: '2FA ya está habilitado' })
    }

    const secret = generateTotpSecret()
    const qrCodeUri = await getTotpQrCodeUri(secret, user.username)

    // Store pending secret (not yet active until verified)
    await server.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: secret },
    })

    return reply.send({ secret, qrCodeUri })
  })

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/2fa/enable — verify first code + activate
  // ──────────────────────────────────────────────────────────
  server.post('/2fa/enable', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { code } = z.object({ code: z.string().min(6).max(6) }).parse(request.body)

    const user = await server.prisma.user.findUnique({ where: { id: request.user.sub } })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })
    if (user.twoFactorEnabled) return reply.status(400).send({ message: '2FA ya está habilitado' })
    if (!user.twoFactorSecret) {
      return reply.status(400).send({ message: 'Inicia configuración con GET /2fa/setup' })
    }

    if (!verifyTotpToken(user.twoFactorSecret, code)) {
      return reply.status(400).send({ message: 'Código incorrecto' })
    }

    const plainCodes = generateBackupCodes()
    const hashedCodes = await hashBackupCodes(plainCodes)

    await server.prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorBackupCodes: JSON.stringify(hashedCodes),
      },
    })

    await AuditAction(server.prisma, user.id, 'TWO_FA_ENABLED', user.id, request)
    return reply.send({ message: '2FA habilitado', backupCodes: plainCodes })
  })

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/2fa/disable — disable 2FA
  // ──────────────────────────────────────────────────────────
  server.post('/2fa/disable', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { code, password } = z.object({
      code:     z.string().min(6).max(6),
      password: z.string().min(1),
    }).parse(request.body)

    const user = await server.prisma.user.findUnique({ where: { id: request.user.sub } })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })
    if (!user.twoFactorEnabled) return reply.status(400).send({ message: '2FA no está habilitado' })

    const passwordValid = await bcrypt.compare(password, user.passwordHash)
    if (!passwordValid) return reply.status(400).send({ message: 'Contraseña incorrecta' })

    if (!verifyTotpToken(user.twoFactorSecret!, code)) {
      return reply.status(400).send({ message: 'Código 2FA incorrecto' })
    }

    await server.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null },
    })

    await AuditAction(server.prisma, user.id, 'TWO_FA_DISABLED', user.id, request)
    return reply.send({ message: '2FA deshabilitado' })
  })

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/2fa/backup-codes/regenerate
  // ──────────────────────────────────────────────────────────
  server.post('/2fa/backup-codes/regenerate', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { code } = z.object({ code: z.string().min(6).max(6) }).parse(request.body)

    const user = await server.prisma.user.findUnique({ where: { id: request.user.sub } })
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return reply.status(400).send({ message: '2FA no está habilitado' })
    }

    if (!verifyTotpToken(user.twoFactorSecret, code)) {
      return reply.status(400).send({ message: 'Código 2FA incorrecto' })
    }

    const plainCodes = generateBackupCodes()
    const hashedCodes = await hashBackupCodes(plainCodes)

    await server.prisma.user.update({
      where: { id: user.id },
      data: { twoFactorBackupCodes: JSON.stringify(hashedCodes) },
    })

    await AuditAction(server.prisma, user.id, 'BACKUP_CODES_REGENERATED', user.id, request)
    return reply.send({ backupCodes: plainCodes })
  })

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/change-password
  // ──────────────────────────────────────────────────────────
  server.post('/change-password', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(request.body)

    const user = await server.prisma.user.findUnique({ where: { id: request.user.sub } })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })

    const valid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!valid) return reply.status(400).send({ message: 'Contraseña actual incorrecta' })

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
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        passwordHistory: newHistory,
        passwordChangedAt: new Date(),
        forcePasswordChange: false,
      },
    })

    // Invalidate all sessions (force re-login)
    await server.prisma.session.deleteMany({ where: { userId: user.id } })

    await AuditAction(server.prisma, user.id, 'PASSWORD_CHANGED', user.id, request)
    return reply.send({ message: 'Contraseña actualizada. Inicia sesión nuevamente.' })
  })

  // ──────────────────────────────────────────────────────────
  // GET /api/auth/sessions
  // ──────────────────────────────────────────────────────────
  server.get('/sessions', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const sessions = await server.prisma.session.findMany({
      where: { userId: request.user.sub },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, userAgent: true, ipAddress: true, deviceName: true,
        createdAt: true, expiresAt: true, lastUsedAt: true,
      },
    })
    return reply.send(sessions)
  })

  // ──────────────────────────────────────────────────────────
  // DELETE /api/auth/sessions/:sessionId — revoke a session
  // ──────────────────────────────────────────────────────────
  server.delete('/sessions/:sessionId', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string }

    const session = await server.prisma.session.findFirst({
      where: { id: sessionId, userId: request.user.sub },
    })
    if (!session) return reply.status(404).send({ message: 'Sesión no encontrada' })

    await server.prisma.session.delete({ where: { id: sessionId } })
    await AuditAction(server.prisma, request.user.sub, 'SESSION_REVOKED', sessionId, request)
    return reply.send({ message: 'Sesión cerrada' })
  })

  // ──────────────────────────────────────────────────────────
  // DELETE /api/auth/sessions — revoke all other sessions
  // ──────────────────────────────────────────────────────────
  server.delete('/sessions', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(request.body ?? {})
    const currentHash = refreshToken ? hashToken(refreshToken) : null

    const where: any = { userId: request.user.sub }
    if (currentHash) where.refreshToken = { not: currentHash }

    const { count } = await server.prisma.session.deleteMany({ where })
    await AuditAction(server.prisma, request.user.sub, 'ALL_SESSIONS_REVOKED', null, request, { count })
    return reply.send({ message: `${count} sesiones cerradas` })
  })

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/refresh
  // ──────────────────────────────────────────────────────────
  server.post('/refresh', async (request, reply) => {
    const { refreshToken } = refreshSchema.parse(request.body)

    const session = await server.prisma.session.findUnique({
      where: { refreshToken: hashToken(refreshToken) },
      include: { user: true },
    })

    if (!session || session.expiresAt < new Date() || !session.user.active) {
      return reply.status(401).send({
        statusCode: 401, error: 'Unauthorized', message: 'Refresh token inválido o expirado',
      })
    }

    await server.prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    })

    const payload = { sub: session.user.id, username: session.user.username, role: session.user.role }
    const newAccessToken = server.jwt.sign(payload)
    return reply.send({ accessToken: newAccessToken })
  })

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/logout
  // ──────────────────────────────────────────────────────────
  server.post('/logout', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const { refreshToken } = refreshSchema.parse(request.body)
    await server.prisma.session.deleteMany({
      where: { refreshToken: hashToken(refreshToken) },
    })
    await AuditAction(server.prisma, request.user.sub, 'LOGOUT', null, request)
    return reply.send({ message: 'Sesión cerrada' })
  })

  // ──────────────────────────────────────────────────────────
  // GET /api/auth/me
  // ──────────────────────────────────────────────────────────
  server.get('/me', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const user = await server.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: userMeSelect,
    })
    if (!user) return reply.status(404).send({ message: 'Usuario no encontrado' })

    const { featurePermissions, ...rest } = user as any
    return reply.send({
      ...rest,
      featurePermissions: resolveFeaturePermissions(user.role, featurePermissions),
    })
  })
}

// ─── Shared login completion ──────────────────────────────────

async function completeLogin(server: any, request: any, reply: any, user: any) {
  const payload = { sub: user.id, username: user.username, role: user.role }

  const accessToken = server.jwt.sign(payload)
  const refreshToken = server.jwt.sign(payload, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  })

  await server.prisma.session.create({
    data: {
      userId:      user.id,
      refreshToken: hashToken(refreshToken),
      userAgent:   request.headers['user-agent'] || null,
      ipAddress:   request.ip,
      deviceName:  parseDeviceName(request.headers['user-agent']),
      lastUsedAt:  new Date(),
      expiresAt:   new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  })

  await AuditAction(server.prisma, user.id, 'LOGIN', null, request)

  return reply.send({
    accessToken,
    refreshToken,
    user: {
      id: user.id, username: user.username,
      fullName: user.fullName, email: user.email, role: user.role,
    },
  })
}
