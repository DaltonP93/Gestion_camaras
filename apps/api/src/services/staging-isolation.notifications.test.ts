// Notificaciones externas bajo aislamiento: el despacho no llama a los proveedores
// y deja trazas 'skipped'; los proveedores REALES tampoco abren conexiones (email:
// servidor SMTP loopback que cuenta conexiones; webhooks: espía de axios.post).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'

const axiosPost = vi.hoisted(() => vi.fn())
vi.mock('axios', async (orig) => {
  const actual: any = await orig()
  return { ...actual, default: { ...actual.default, post: axiosPost }, post: axiosPost }
})

import { sendAlertNotification } from './notification.service'
import { sendAlertEmail } from './providers/email.provider'
import { sendToChannel } from './providers/channel.provider'

const ENV_KEYS = ['STAGING_ISOLATION', 'OUTBOUND_NOTIFICATIONS_ENABLED'] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  axiosPost.mockReset()
})

async function countingSmtp() {
  let connections = 0
  const server: Server = createServer(socket => { connections++; socket.end('421 test\r\n') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port as number
  return { port, connections: () => connections, close: () => new Promise<void>(r => server.close(() => r())) }
}

function prismaWith(settings: Record<string, any>) {
  const deliveries: any[] = []
  return {
    deliveries,
    alertSettings: { findUnique: vi.fn(async () => settings) },
    nVR: { findUnique: vi.fn(async () => ({ name: 'NVR' })) },
    camera: { findUnique: vi.fn(async () => ({ name: 'Cam' })) },
    notificationDelivery: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { const row = { id: `d${deliveries.length}`, ...data }; deliveries.push(row); return row }),
      update: vi.fn(async () => ({})),
    },
  } as any
}

describe('sendAlertNotification con STAGING_ISOLATION=true', () => {
  it('registra cada canal habilitado como skipped y no contacta SMTP ni webhooks', async () => {
    process.env.STAGING_ISOLATION = 'true'
    const smtp = await countingSmtp()
    const prisma = prismaWith({
      id: 'singleton', minSeverity: 'LOW', alertTypes: { CAMERA_OFFLINE: true },
      emailEnabled: true, recipientEmails: 'ops@example.test', smtpHost: '127.0.0.1', smtpPort: smtp.port,
      smtpSecure: false, smtpUser: null, smtpPassword: null, smtpFromEmail: 'a@example.test', smtpFromName: 'VC',
      slackEnabled: true, slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
      teamsEnabled: true, teamsWebhookUrl: 'https://example.webhook.office.com/x',
      webhookEnabled: true, webhookUrl: 'https://hooks.example.test/x',
    })
    await sendAlertNotification(prisma, { id: 'a1', type: 'CAMERA_OFFLINE', severity: 'HIGH', message: 'x', nvrId: 'n1', cameraId: 'c1' } as any)
    expect(smtp.connections()).toBe(0)
    expect(axiosPost).not.toHaveBeenCalled()
    expect(prisma.deliveries.map((d: any) => [d.channel, d.status, d.errorCode])).toEqual([
      ['email', 'skipped', 'OUTBOUND_DISABLED'],
      ['slack', 'skipped', 'OUTBOUND_DISABLED'],
      ['teams', 'skipped', 'OUTBOUND_DISABLED'],
      ['webhook', 'skipped', 'OUTBOUND_DISABLED'],
    ])
    await smtp.close()
  })
})

describe('proveedores reales (defensa en profundidad)', () => {
  it('sendAlertEmail no abre conexión SMTP con OUTBOUND_NOTIFICATIONS_ENABLED=false', async () => {
    process.env.OUTBOUND_NOTIFICATIONS_ENABLED = 'false'
    const smtp = await countingSmtp()
    const prisma = prismaWith({ emailEnabled: true, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpFromEmail: 'a@example.test', recipientEmails: 'b@example.test' })
    const r = await sendAlertEmail(prisma, { subject: 's', html: 'h' })
    expect(r).toMatchObject({ success: false, errorCode: 'OUTBOUND_DISABLED' })
    expect(prisma.alertSettings.findUnique).not.toHaveBeenCalled()
    expect(smtp.connections()).toBe(0)
    await smtp.close()
  })

  it('sendToChannel no hace POST con STAGING_ISOLATION=true', async () => {
    process.env.STAGING_ISOLATION = 'true'
    const r = await sendToChannel('webhook', 'https://hooks.example.test/x', { type: 'X', severity: 'HIGH', message: 'm', nvrId: null, cameraId: null, nvrName: null, cameraName: null })
    expect(r).toMatchObject({ success: false, errorCode: 'OUTBOUND_DISABLED' })
    expect(axiosPost).not.toHaveBeenCalled()
  })

  it('contraste: sin aislamiento el proveedor de email sí conecta al SMTP', async () => {
    const smtp = await countingSmtp()
    const prisma = prismaWith({ emailEnabled: true, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecure: false, smtpFromEmail: 'a@example.test', recipientEmails: 'b@example.test' })
    const r = await sendAlertEmail(prisma, { subject: 's', html: 'h' })
    expect(r.success).toBe(false) // el servidor de prueba responde 421
    expect(smtp.connections()).toBe(1)
    await smtp.close()
  })
})
