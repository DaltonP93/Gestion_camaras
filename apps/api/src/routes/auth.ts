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
import { getSecuritySettings } from '../services/security-settings'
import { sessionsToPrune, accessTokenTtl, decideMfaGate } from '../services/security-policy'

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 7 días
const TWO_FA_TOKEN_TTL_MS  = 5 * 60 * 1000             // 5 minutos
// Lockout/política de contraseña: ahora configurables vía SecuritySettings.

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

    const sec = await getSecuritySettings(server.prisma)
    const maxAttempts = sec.lockoutMaxAttempts
    const lockoutMs = sec.lockoutDurationMinutes * 60_000

    const passwordValid = await bcrypt.compare(body.password, user.passwordHash)
    if (!passwordValid) {
      const attempts = user.failedLoginAttempts + 1
      const lockout = attempts >= maxAttempts
        ? { lockedUntil: new Date(Date.now() + lockoutMs) }
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
          message: `Demasiados intentos. Cuenta bloqueada por ${sec.lockoutDurationMinutes} minutos.`,
          code: 'ACCOUNT_LOCKED',
        })
      }

      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: `Credenciales inválidas (${Math.max(0, maxAttempts - attempts)} intentos restantes)`,
      })
    }

    // Reset failed attempts on successful password
    await server.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    })

    // ── Compuerta MFA (fase 4b) ──
    // Decide entre: desafío 2FA (usuario ya enrolado), login de gracia (política
    // activa, aún con inicios de cortesía), enrolamiento forzoso (gracia agotada) o
    // login normal (sin política).
    const gate = decideMfaGate({
      mfaRequired: sec.mfaRequired,
      userHasMfa: user.twoFactorEnabled,
      graceLoginsUsed: user.mfaGraceLoginsUsed,
      gracePeriodLogins: sec.mfaGracePeriodLogins,
    })

    if (gate.action === 'challenge') {
      const tempToken = (server.jwt as any).sign(
        { sub: user.id, step: '2fa' },
        { expiresIn: '5m' }
      )
      await AuditAction(server.prisma, user.id, 'LOGIN_2FA_REQUIRED', user.id, request)
      return reply.send({ requiresTwoFactor: true, tempToken })
    }

    if (gate.action === 'enroll') {
      // Sin acceso normal hasta completar el segundo factor: token de enrolamiento
      // de alcance limitado (sólo /mfa/enroll/*), NO un access token.
      const enrollToken = (server.jwt as any).sign(
        { sub: user.id, step: 'mfa-enroll' },
        { expiresIn: '15m' }
      )
      await AuditAction(server.prisma, user.id, 'MFA_ENROLLMENT_REQUIRED', user.id, request)
      return reply.send({ requiresMfaEnrollment: true, enrollToken })
    }

    if (gate.action === 'grace') {
      await server.prisma.user.update({
        where: { id: user.id },
        data: { mfaGraceLoginsUsed: { increment: 1 } },
      })
      await AuditAction(server.prisma, user.id, 'MFA_GRACE_LOGIN', user.id, request, { graceRemaining: gate.graceRemaining })
      return completeLogin(server, request, reply, user, { mustEnrollMfa: true, mfaGraceRemaining: gate.graceRemaining })
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
        mfaGraceLoginsUsed: 0,
      },
    })

    await AuditAction(server.prisma, user.id, 'TWO_FA_ENABLED', user.id, request)
    return reply.send({ message: '2FA habilitado', backupCodes: plainCodes })
  })

  // ──────────────────────────────────────────────────────────
  // Enrolamiento forzoso de MFA (fase 4b) — con enrollToken de alcance limitado
  // que emite el login cuando la política exige MFA y la gracia está agotada.
  // ──────────────────────────────────────────────────────────
  const verifyEnrollToken = (raw: string): { sub: string } | null => {
    try {
      const p: any = server.jwt.verify(raw)
      return p && p.step === 'mfa-enroll' ? { sub: p.sub } : null
    } catch { return null }
  }

  // POST /api/auth/mfa/enroll/start — genera secreto + QR (no activa aún)
  server.post('/mfa/enroll/start', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { enrollToken } = z.object({ enrollToken: z.string().min(1) }).parse(request.body)
    const claims = verifyEnrollToken(enrollToken)
    if (!claims) return reply.status(401).send({ message: 'Token de enrolamiento inválido o expirado' })

    const user = await server.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, username: true, active: true, twoFactorEnabled: true },
    })
    if (!user || !user.active) return reply.status(401).send({ message: 'No autorizado' })
    if (user.twoFactorEnabled) return reply.status(400).send({ message: '2FA ya está habilitado' })

    const secret = generateTotpSecret()
    const qrCodeUri = await getTotpQrCodeUri(secret, user.username)
    await server.prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret } })
    return reply.send({ secret, qrCodeUri })
  })

  // POST /api/auth/mfa/enroll/complete — verifica código, activa 2FA y emite tokens
  server.post('/mfa/enroll/complete', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { enrollToken, code } = z.object({
      enrollToken: z.string().min(1),
      code:        z.string().min(6).max(6),
    }).parse(request.body)
    const claims = verifyEnrollToken(enrollToken)
    if (!claims) return reply.status(401).send({ message: 'Token de enrolamiento inválido o expirado' })

    const user = await server.prisma.user.findUnique({ where: { id: claims.sub } })
    if (!user || !user.active) return reply.status(401).send({ message: 'No autorizado' })
    if (user.twoFactorEnabled) return reply.status(400).send({ message: '2FA ya está habilitado' })
    if (!user.twoFactorSecret) return reply.status(400).send({ message: 'Inicia el enrolamiento primero' })
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
        mfaGraceLoginsUsed: 0,
      },
    })

    await AuditAction(server.prisma, user.id, 'MFA_ENROLLED', user.id, request, { forced: true })
    return completeLogin(server, request, reply, user, { backupCodes: plainCodes, mfaEnrolled: true })
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

    const sec = await getSecuritySettings(server.prisma)
    const policy = checkPasswordPolicy(newPassword, { minLength: sec.passwordMinLength, requireStrong: sec.requireStrongPassword })
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
    const sec = await getSecuritySettings(server.prisma)
    const newAccessToken = server.jwt.sign(payload, { expiresIn: accessTokenTtl(sec.sessionTimeoutMinutes) })
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
  // POST /api/auth/forgot-password
  // ──────────────────────────────────────────────────────────
  server.post('/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(request.body)

    const GENERIC_MSG = { message: 'Si el correo existe, se enviaron instrucciones.' }

    const user = await server.prisma.user.findFirst({ where: { email, active: true } })
    if (!user) return reply.send(GENERIC_MSG) // Don't reveal existence

    // Rate-limit: only one active token per user
    if (user.passwordResetExpiry && user.passwordResetExpiry > new Date()) {
      return reply.send(GENERIC_MSG) // Silently ignore duplicate requests
    }

    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiry = new Date(Date.now() + 30 * 60 * 1000) // 30 minutes

    await server.prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: tokenHash, passwordResetExpiry: expiry },
    })

    // Get SMTP config from DB
    const alertSettings = await server.prisma.alertSettings.findUnique({ where: { id: 'singleton' } })

    if (alertSettings?.emailEnabled && alertSettings.smtpHost) {
      const appUrl = process.env.APP_URL || 'http://localhost:4000'
      const resetLink = `${appUrl}/reset-password?token=${rawToken}`

      const nodemailer = await import('nodemailer')
      const transporter = nodemailer.default.createTransport({
        host: alertSettings.smtpHost,
        port: alertSettings.smtpPort,
        secure: alertSettings.smtpSecure,
        auth: alertSettings.smtpUser ? { user: alertSettings.smtpUser, pass: alertSettings.smtpPassword } : undefined,
      })

      const siteName = (await server.prisma.appearanceSettings.findUnique({ where: { id: 'singleton' } }))?.siteName ?? 'VisionCore'

      const html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;padding:0;background:#1e2130;font-family:Arial,sans-serif">
          <div style="max-width:520px;margin:40px auto;background:#2a2e42;border-radius:16px;overflow:hidden;border:1px solid #3d4260">
            <div style="background:#e51d1d;padding:24px;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">${siteName}</h1>
              <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px">Sistema de gestión NVR</p>
            </div>
            <div style="padding:32px 40px">
              <h2 style="color:#e5e7eb;font-size:18px;margin:0 0 12px">Restablecer contraseña</h2>
              <p style="color:#9ca3af;font-size:14px;line-height:1.6;margin:0 0 24px">
                Hola <strong style="color:#e5e7eb">${user.fullName || user.username}</strong>,<br><br>
                Recibimos una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el botón de abajo para continuar.
              </p>
              <div style="text-align:center;margin:0 0 24px">
                <a href="${resetLink}" style="display:inline-block;background:#e51d1d;color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:14px;font-weight:600">
                  Restablecer contraseña
                </a>
              </div>
              <p style="color:#6b7280;font-size:12px;text-align:center;margin:0 0 8px">
                Este enlace expira en <strong>30 minutos</strong>.
              </p>
              <p style="color:#6b7280;font-size:12px;text-align:center;margin:0">
                Si no solicitaste este cambio, ignora este correo.
              </p>
              <hr style="border:none;border-top:1px solid #3d4260;margin:24px 0">
              <p style="color:#4b5563;font-size:11px;text-align:center;margin:0">
                ${siteName} · No respondas a este correo
              </p>
            </div>
          </div>
        </body>
        </html>
      `

      await transporter.sendMail({
        from: `"${alertSettings.smtpFromName || siteName}" <${alertSettings.smtpFromEmail}>`,
        to: user.email,
        subject: `Restablece tu contraseña - ${siteName}`,
        html,
      }).catch((err: any) => server.log.warn(`[forgot-password] email error: ${err.message}`))
    }

    await AuditAction(server.prisma, user.id, 'PASSWORD_RESET_REQUESTED', user.id, request)
    return reply.send(GENERIC_MSG)
  })

  // ──────────────────────────────────────────────────────────
  // POST /api/auth/reset-password
  // ──────────────────────────────────────────────────────────
  server.post('/reset-password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { token, newPassword } = z.object({
      token:       z.string().min(1),
      // Sólo el piso absoluto soportado (8). El mínimo REAL lo impone la política
      // configurada (evaluatePasswordPolicy) más abajo — así el ajuste persistido es
      // autoritativo también en el reset (review Codex #129).
      newPassword: z.string().min(8),
    }).parse(request.body)

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    const user = await server.prisma.user.findFirst({
      where: {
        passwordResetToken: tokenHash,
        passwordResetExpiry: { gt: new Date() },
        active: true,
      },
    })

    if (!user) {
      return reply.status(400).send({ message: 'Enlace inválido o expirado' })
    }

    const sec = await getSecuritySettings(server.prisma)
    const policy = checkPasswordPolicy(newPassword, { minLength: sec.passwordMinLength, requireStrong: sec.requireStrongPassword })
    if (!policy.valid) {
      return reply.status(400).send({ message: 'Contraseña no cumple los requisitos', errors: policy.errors })
    }

    const reused = await checkPasswordHistory(newPassword, user.passwordHistory ?? null)
    if (reused) {
      return reply.status(400).send({ message: 'No puedes reutilizar una contraseña reciente' })
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
        passwordResetToken: null,
        passwordResetExpiry: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    })

    // Invalidate all sessions
    await server.prisma.session.deleteMany({ where: { userId: user.id } })

    await AuditAction(server.prisma, user.id, 'PASSWORD_RESET_COMPLETED', user.id, request)
    return reply.send({ message: 'Contraseña restablecida correctamente. Inicia sesión.' })
  })

  // ──────────────────────────────────────────────────────────
  // GET /api/auth/me
  // ──────────────────────────────────────────────────────────
  server.get('/me', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    try {
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
    } catch (err) {
      server.log.error({ err, userId: request.user?.sub }, '[auth/me] error al consultar perfil — verifica que la migración 0012 fue aplicada (ALTER TABLE user_feature_permissions ADD COLUMN IF NOT EXISTS canDownloadRecordings ...)')
      return reply.status(500).send({ message: 'Error interno al cargar el perfil de usuario' })
    }
  })
}

// ─── Shared login completion ──────────────────────────────────

async function completeLogin(server: any, request: any, reply: any, user: any, extra: Record<string, unknown> = {}) {
  const payload = { sub: user.id, username: user.username, role: user.role }
  const sec = await getSecuritySettings(server.prisma)

  // TTL del access token = timeout de sesión configurado (hace REAL el ajuste que
  // antes sólo vivía en la UI). El refresh conserva su ventana larga.
  const accessToken = server.jwt.sign(payload, { expiresIn: accessTokenTtl(sec.sessionTimeoutMinutes) })
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

  // Límite de sesiones concurrentes: revocar las MÁS ANTIGUAS que excedan el máximo.
  const userSessions = await server.prisma.session.findMany({
    where: { userId: user.id },
    select: { id: true, lastUsedAt: true, createdAt: true },
  })
  const prune = sessionsToPrune(userSessions, sec.maxSessions)
  if (prune.length > 0) {
    await server.prisma.session.deleteMany({ where: { id: { in: prune } } })
    await AuditAction(server.prisma, user.id, 'SESSION_PRUNED_MAX', null, request, { revoked: prune.length, maxSessions: sec.maxSessions })
  }

  await AuditAction(server.prisma, user.id, 'LOGIN', null, request)

  return reply.send({
    accessToken,
    refreshToken,
    user: {
      id: user.id, username: user.username,
      fullName: user.fullName, email: user.email, role: user.role,
    },
    ...extra,
  })
}
