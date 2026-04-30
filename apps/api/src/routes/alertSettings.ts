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

    try {
      const transporter = nodemailer.createTransport({
        host: settings.smtpHost,
        port: settings.smtpPort,
        secure: settings.smtpSecure,
        auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPassword } : undefined,
      })

      await transporter.sendMail({
        from: `"${settings.smtpFromName}" <${settings.smtpFromEmail}>`,
        to: recipients,
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
      return reply.status(500).send({ message: `Error al enviar: ${err.message}` })
    }
  })
}

export default alertSettingsRoutes
