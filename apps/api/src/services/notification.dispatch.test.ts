import { describe, it, expect, vi, beforeEach } from 'vitest'

// Se mockean ambos proveedores para observar el despacho sin salir a la red.
vi.mock('./providers/email.provider', () => ({ sendAlertEmail: vi.fn() }))
vi.mock('./providers/channel.provider', async (orig) => {
  const actual = await (orig as any)()
  return { ...actual, sendToChannel: vi.fn() }
})

import { sendAlertNotification } from './notification.service'
import { sendAlertEmail } from './providers/email.provider'
import { sendToChannel } from './providers/channel.provider'

const email = sendAlertEmail as unknown as ReturnType<typeof vi.fn>
const channel = sendToChannel as unknown as ReturnType<typeof vi.fn>

/** Prisma falso mínimo. `deliveries` acumula las filas creadas para inspección. */
function makePrisma(settings: Record<string, any> | null) {
  const deliveries: any[] = []
  return {
    deliveries,
    alertSettings: { findUnique: vi.fn().mockResolvedValue(settings) },
    nVR: { findUnique: vi.fn().mockResolvedValue({ name: 'NVR Norte' }) },
    camera: { findUnique: vi.fn().mockResolvedValue({ name: 'Cam Puerta' }) },
    notificationDelivery: {
      findFirst: vi.fn().mockResolvedValue(null), // sin envío reciente ⇒ no dedup
      create: vi.fn().mockImplementation(({ data }: any) => {
        const row = { id: `d${deliveries.length + 1}`, ...data }
        deliveries.push(row)
        return Promise.resolve(row)
      }),
      update: vi.fn().mockImplementation(({ where, data }: any) => {
        const row = deliveries.find((d) => d.id === where.id)
        if (row) Object.assign(row, data)
        return Promise.resolve(row)
      }),
    },
  } as any
}

const ALERT = {
  id: 'a1', type: 'CAMERA_OFFLINE', severity: 'HIGH',
  message: 'Sin señal', nvrId: 'n1', cameraId: 'c1',
}

const BASE_SETTINGS = {
  id: 'singleton', emailEnabled: false, recipientEmails: 'x@y.com',
  minSeverity: 'HIGH',
  alertTypes: { CAMERA_OFFLINE: true },
  slackEnabled: false, slackWebhookUrl: '',
  teamsEnabled: false, teamsWebhookUrl: '',
  webhookEnabled: false, webhookUrl: '',
}

beforeEach(() => { email.mockReset(); channel.mockReset() })

describe('sendAlertNotification — canales de webhook', () => {
  it('despacha a los canales habilitados aunque el email esté deshabilitado', async () => {
    channel.mockResolvedValue({ success: true, status: 200 })
    const prisma = makePrisma({
      ...BASE_SETTINGS,
      slackEnabled: true, slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x',
      webhookEnabled: true, webhookUrl: 'https://ejemplo.com/hook',
    })
    await sendAlertNotification(prisma, ALERT as any)

    expect(email).not.toHaveBeenCalled()
    expect(channel).toHaveBeenCalledTimes(2)
    const kinds = channel.mock.calls.map((c) => c[0]).sort()
    expect(kinds).toEqual(['slack', 'webhook'])
    // El historial nunca guarda la URL completa (lleva token).
    const recips = prisma.deliveries.map((d: any) => d.recipient)
    expect(recips.every((r: string) => !r.includes('/services/'))).toBe(true)
    expect(prisma.deliveries.find((d: any) => d.channel === 'slack')?.status).toBe('sent')
  })

  it('no despacha canales deshabilitados ni con URL vacía', async () => {
    const prisma = makePrisma({ ...BASE_SETTINGS, slackEnabled: true, slackWebhookUrl: '' })
    await sendAlertNotification(prisma, ALERT as any)
    expect(channel).not.toHaveBeenCalled()
  })

  it('respeta el gate de severidad mínima (no despacha nada)', async () => {
    const prisma = makePrisma({
      ...BASE_SETTINGS, minSeverity: 'CRITICAL',
      webhookEnabled: true, webhookUrl: 'https://ejemplo.com/hook',
    })
    await sendAlertNotification(prisma, ALERT as any) // HIGH < CRITICAL
    expect(channel).not.toHaveBeenCalled()
    expect(email).not.toHaveBeenCalled()
  })

  it('respeta el gate de tipo deshabilitado', async () => {
    const prisma = makePrisma({
      ...BASE_SETTINGS, alertTypes: { CAMERA_OFFLINE: false },
      webhookEnabled: true, webhookUrl: 'https://ejemplo.com/hook',
    })
    await sendAlertNotification(prisma, ALERT as any)
    expect(channel).not.toHaveBeenCalled()
  })

  it('un fallo de canal se registra como failed sin abortar los demás', async () => {
    channel
      .mockResolvedValueOnce({ success: false, error: 'HTTP 500', errorCode: 'HTTP_500' }) // slack
      .mockResolvedValueOnce({ success: true, status: 200 })                                // webhook
    const prisma = makePrisma({
      ...BASE_SETTINGS,
      slackEnabled: true, slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x',
      webhookEnabled: true, webhookUrl: 'https://ejemplo.com/hook',
    })
    await sendAlertNotification(prisma, ALERT as any)
    expect(channel).toHaveBeenCalledTimes(2)
    expect(prisma.deliveries.find((d: any) => d.channel === 'slack')?.status).toBe('failed')
    expect(prisma.deliveries.find((d: any) => d.channel === 'webhook')?.status).toBe('sent')
  })

  it('no hace nada si no existe la fila de settings', async () => {
    const prisma = makePrisma(null)
    await sendAlertNotification(prisma, ALERT as any)
    expect(channel).not.toHaveBeenCalled()
    expect(email).not.toHaveBeenCalled()
  })
})
