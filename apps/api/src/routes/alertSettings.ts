// apps/api/src/routes/alertSettings.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import nodemailer from 'nodemailer'

const settingsSchema = z.object({
  emailEnabled: z.boolean().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpFromEmail: z.string().optional(),
  smtpFromName: z.string().optional(),
  recipientEmails: z.string().optional(),
  alertTypes: z.record(z.boolean()).optional(),
  minSeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
})

const alertSettingsRoutes: FastifyPluginAsync = async (server) => {
  // GET /api/alerts/settings/deliveries
  server.get('/settings/deliveries', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const { page = '0', limit = '50' } = request.query as Record<string, string>
    const skip = Number(page) * Number(limit)
    const [deliveries, total] = await Promise.all([
      server.prisma.notificationDelivery.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      server.prisma.notificationDelivery.count(),
    ])
    return reply.send({ deliveries, total, page: Number(page), limit: Number(limit) })
  })

  // GET /api/alerts/settings
  server.get('/settings', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (_request, reply) => {
    const settings = await server.prisma.alertSettings.findUnique({
      where: { id: 'singleton' },
    })
    if (!settings) {
      return reply.status(404).send({ message: 'Configuración no encontrada' })
    }
    // Hide password in response
    return reply.send({ ...settings, smtpPassword: settings.smtpPassword ? '••••••••' : '' })
  })

  // PUT /api/alerts/settings
  server.put('/settings', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const data = settingsSchema.parse(request.body)

    // If smtpPassword is the masked placeholder, don't overwrite
    const updateData: Record<string, unknown> = { ...data }
    if (data.smtpPassword === '••••••••') {
      delete updateData.smtpPassword
    }

    const settings = await server.prisma.alertSettings.upsert({
      where: { id: 'singleton' },
      update: updateData,
      create: { id: 'singleton', ...updateData } as any,
    })

    return reply.send({ ...settings, smtpPassword: settings.smtpPassword ? '••••••••' : '' })
  })

  // POST /api/alerts/settings/test-email
  server.post('/settings/test-email', {
    preHandler: [server.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const settings = await server.prisma.alertSettings.findUnique({ where: { id: 'singleton' } })
    if (!settings || !settings.smtpHost || !settings.smtpFromEmail) {
      return reply.status(400).send({ message: 'Configura el servidor SMTP primero' })
    }

    const { testEmail } = request.body as { testEmail?: string }
    const recipients = testEmail || settings.recipientEmails
    if (!recipients) {
      return reply.status(400).send({ message: 'Ingresa un email de destino' })
    }

    // Derive the correct TLS mode from the configured port.
    // Port 465 → implicit TLS (secure:true).
    // Port 587 → STARTTLS (secure:false, requireTLS:true) — smtpSecure=true is often
    //   set by users expecting "TLS" but this is the STARTTLS variant, not SSL-wrap.
    // Other ports → follow smtpSecure as set.
    const port = settings.smtpPort || 587
    const useImplicitTLS = port === 465 || (port !== 587 && settings.smtpSecure)
    const transportOptions: any = {
      host:    settings.smtpHost,
      port,
      secure:  useImplicitTLS,
      auth:    settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPassword } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout:   8_000,
      socketTimeout:     15_000,
    }
    if (!useImplicitTLS && port === 587) {
      transportOptions.requireTLS = true   // force STARTTLS upgrade on port 587
    }

    server.log.info(
      `[smtp] test_email host=${settings.smtpHost} port=${port}` +
      ` secure=${useImplicitTLS} requireTLS=${transportOptions.requireTLS ?? false}` +
      ` user=${settings.smtpUser || '(none)'} to=${recipients}`
    )

    try {
      const transporter = nodemailer.createTransport(transportOptions)

      await transporter.sendMail({
        from:    `"${settings.smtpFromName}" <${settings.smtpFromEmail}>`,
        to:      recipients,
        subject: '✅ VisionCore — Prueba de configuración de correo',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2 style="color:#e51d1d">VisionCore VMS</h2>
            <p>Este es un email de prueba para verificar la configuración SMTP.</p>
            <p style="color:#666">Si recibes este mensaje, las notificaciones por correo están correctamente configuradas.</p>
            <hr/>
            <p style="font-size:12px;color:#999">Enviado desde VisionCore · ${new Date().toLocaleString('es-PY')}</p>
          </div>
        `,
      })

      return reply.send({ success: true, message: `Email enviado a ${recipients}` })
    } catch (err: any) {
      const msg  = (err.message || '') as string
      const code: string =
        (msg.includes('getaddrinfo') || msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || msg.includes('EAI_NONAME'))
          ? 'DNS_FAIL'
        : (msg.includes('EAUTH') || msg.includes('535') || msg.includes('534') || msg.includes('Invalid login') || msg.includes('Username and Password'))
          ? 'AUTH_FAIL'
        : (msg.includes('ECONNREFUSED') || msg.includes('connect ETIMEDOUT') || msg.includes('ESOCKETTIMEDOUT'))
          ? 'CONNECT_TIMEOUT'
        : (msg.includes('TLS') || msg.includes('SSL') || msg.includes('wrong version') || msg.includes('certificate'))
          ? 'TLS_FAIL'
        : 'UNKNOWN'

      server.log.error(`[smtp] test_email_failed host=${settings.smtpHost} port=${port} code=${code} err=${msg}`)
      return reply.status(500).send({ message: `Error al enviar: ${msg}`, code })
    }
  })
}

export default alertSettingsRoutes
