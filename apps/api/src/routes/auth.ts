// apps/api/src/routes/auth.ts
import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { z } from 'zod'
import { AuditAction } from '../services/audit'

const IS_PROD = process.env.NODE_ENV === 'production'
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000           // 1 hora
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 días

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex')

function setCookies(reply: any, accessToken: string, refreshToken: string) {
  const cookieBase = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: IS_PROD,
    path: '/',
  }
  reply.setCookie('at', accessToken, { ...cookieBase, maxAge: ACCESS_TOKEN_TTL_MS / 1000 })
  reply.setCookie('rt', refreshToken, { ...cookieBase, maxAge: REFRESH_TOKEN_TTL_MS / 1000 })
}

export const authRoutes: FastifyPluginAsync = async (server) => {
  // POST /api/auth/login (rate limit estricto: brute force protection — por IP)
  server.post('/login', {
    config: {
      rateLimit: {
        max: 8,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const body = loginSchema.parse(request.body)

    const user = await server.prisma.user.findUnique({
      where: { username: body.username },
    })

    if (!user || !user.active) {
      await AuditAction(server.prisma, null, 'AUTH_FAILED', body.username, request)
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Credenciales inválidas',
      })
    }

    const passwordValid = await bcrypt.compare(body.password, user.passwordHash)
    if (!passwordValid) {
      await AuditAction(server.prisma, null, 'AUTH_FAILED', body.username, request)
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Credenciales inválidas',
      })
    }

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    }

    const accessToken = server.jwt.sign(payload)
    const refreshToken = server.jwt.sign(payload, {
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    })

    // Guardar sesión en DB (refresh token guardado como SHA-256)
    await server.prisma.session.create({
      data: {
        userId: user.id,
        refreshToken: hashToken(refreshToken),
        userAgent: request.headers['user-agent'] || null,
        ipAddress: request.ip,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    })

    await AuditAction(server.prisma, user.id, 'LOGIN', null, request)

    setCookies(reply, accessToken, refreshToken)

    return reply.send({
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    })
  })

  // POST /api/auth/refresh — renueva access token usando cookie rt
  server.post('/refresh', async (request, reply) => {
    const refreshToken = (request.cookies as any)?.rt

    if (!refreshToken) {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Refresh token inválido o expirado',
      })
    }

    const session = await server.prisma.session.findUnique({
      where: { refreshToken: hashToken(refreshToken) },
      include: { user: true },
    })

    if (!session || session.expiresAt < new Date() || !session.user.active) {
      reply.clearCookie('at', { path: '/' })
      reply.clearCookie('rt', { path: '/' })
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Refresh token inválido o expirado',
      })
    }

    const payload = {
      sub: session.user.id,
      username: session.user.username,
      role: session.user.role,
    }

    const newAccessToken = server.jwt.sign(payload)
    reply.setCookie('at', newAccessToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: IS_PROD,
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_MS / 1000,
    })

    return reply.send({ ok: true })
  })

  // POST /api/auth/logout
  server.post('/logout', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const refreshToken = (request.cookies as any)?.rt

    if (refreshToken) {
      await server.prisma.session.deleteMany({
        where: { refreshToken: hashToken(refreshToken) },
      })
    }

    reply.clearCookie('at', { path: '/' })
    reply.clearCookie('rt', { path: '/' })

    await AuditAction(server.prisma, request.user.sub, 'LOGOUT', null, request)

    return reply.send({ message: 'Sesión cerrada' })
  })

  // GET /api/auth/me
  server.get('/me', {
    preHandler: [server.authenticate],
  }, async (request, reply) => {
    const user = await server.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        role: true,
        active: true,
        avatarUrl: true,
        phone: true,
        createdAt: true,
        permissions: {
          include: { nvr: true, camera: true },
        },
      },
    })

    if (!user) {
      return reply.status(404).send({ message: 'Usuario no encontrado' })
    }

    return reply.send(user)
  })
}
