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
  errorCode?: string   // código SMTP/Node (p.ej. EAUTH, ECONNECTION, ETIMEDOUT)
}

// Derive the correct TLS mode from the configured port — same logic as the
// test-email endpoint. Port 465 → implicit TLS (secure:true). Port 587 →
// STARTTLS (secure:false + requireTLS) even if the user toggled "TLS/SSL",
// because SSL-wrapping a STARTTLS port produces OpenSSL "wrong version number"
// (error:0A00...) on every delivery.
function buildTransportOptions(settings: {
  smtpHost: string | null
  smtpPort: number | null
  smtpSecure: boolean
  smtpUser: string | null
  smtpPassword: string | null
}, overrideSecure?: boolean) {
  const port = settings.smtpPort || 587
  const useImplicitTLS = overrideSecure ?? (port === 465 || (port !== 587 && settings.smtpSecure))
  const options: any = {
    host:    settings.smtpHost,
    port,
    secure:  useImplicitTLS,
    auth:    settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPassword } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout:   8_000,
    socketTimeout:     15_000,
  }
  if (!useImplicitTLS && port === 587) {
    options.requireTLS = true
  }
  return options
}

function isTlsMismatchError(err: any): boolean {
  const msg = (err?.message || '') as string
  return msg.includes('wrong version number') || msg.includes('0A00010B') ||
         msg.includes('ssl3_get_record') || /error:0A00/.test(msg)
}

export async function sendAlertEmail(prisma: PrismaClient, payload: EmailPayload): Promise<EmailResult> {
  const settings = await prisma.alertSettings.findUnique({ where: { id: 'singleton' } })

  if (!settings) return { success: false, recipient: '', error: 'Configuración SMTP no encontrada' }
  if (!settings.emailEnabled) return { success: false, recipient: '', error: 'Email deshabilitado en configuración' }
  if (!settings.smtpHost || !settings.smtpFromEmail) return { success: false, recipient: '', error: 'SMTP incompleto' }

  const recipient = payload.to || settings.recipientEmails
  if (!recipient) return { success: false, recipient: '', error: 'Sin destinatarios configurados' }

  const mail = {
    from: `"${settings.smtpFromName || 'VisionCore'}" <${settings.smtpFromEmail}>`,
    to: recipient,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  }

  try {
    const transporter = nodemailer.createTransport(buildTransportOptions(settings))
    await transporter.sendMail(mail)
    return { success: true, recipient }
  } catch (err: any) {
    // TLS-mode mismatch → retry once with the opposite secure setting so a
    // mis-toggled UI switch doesn't permanently break alert delivery.
    if (isTlsMismatchError(err)) {
      try {
        const port = settings.smtpPort || 587
        const firstSecure = port === 465 || (port !== 587 && settings.smtpSecure)
        const transporter = nodemailer.createTransport(buildTransportOptions(settings, !firstSecure))
        await transporter.sendMail(mail)
        return { success: true, recipient }
      } catch (retryErr: any) {
        return { success: false, recipient, error: retryErr.message || 'Error desconocido al enviar email', errorCode: retryErr.code }
      }
    }
    return { success: false, recipient, error: err.message || 'Error desconocido al enviar email', errorCode: err.code }
  }
}
