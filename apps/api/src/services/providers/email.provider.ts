// Email provider — reutiliza configuración SMTP de AlertSettings
import nodemailer from 'nodemailer'
import type { PrismaClient } from '@prisma/client'

export interface EmailPayload {
  subject: string
  html: string
  text?: string
  to?: string // override destinatarios
}

export interface EmailResult {
  success: boolean
  recipient: string
  error?: string
}

export async function sendAlertEmail(prisma: PrismaClient, payload: EmailPayload): Promise<EmailResult> {
  const settings = await prisma.alertSettings.findUnique({ where: { id: 'singleton' } })

  if (!settings) return { success: false, recipient: '', error: 'Configuración SMTP no encontrada' }
  if (!settings.emailEnabled) return { success: false, recipient: '', error: 'Email deshabilitado en configuración' }
  if (!settings.smtpHost || !settings.smtpFromEmail) return { success: false, recipient: '', error: 'SMTP incompleto' }

  const recipient = payload.to || settings.recipientEmails
  if (!recipient) return { success: false, recipient: '', error: 'Sin destinatarios configurados' }

  try {
    const transporter = nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpSecure,
      auth: settings.smtpUser
        ? { user: settings.smtpUser, pass: settings.smtpPassword }
        : undefined,
    })

    await transporter.sendMail({
      from: `"${settings.smtpFromName || 'VisionCore'}" <${settings.smtpFromEmail}>`,
      to: recipient,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    })

    return { success: true, recipient }
  } catch (err: any) {
    return { success: false, recipient, error: err.message || 'Error desconocido al enviar email' }
  }
}
