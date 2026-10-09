import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import type { PrismaClient } from '@prisma/client'
import { sendAlertEmail } from './email.provider'

// Exercise the installed Nodemailer SMTP transport, not a sendMail mock.
// Only an ephemeral loopback server is used; no external mail is sent.
const servers: Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

interface SmtpAuth { user: string; pass: string }

async function smtp(rejectRecipient = false, auth?: SmtpAuth) {
  const messages: string[] = []
  const recipients: string[] = []
  const logins: Array<{ user: string; pass: string; accepted: boolean }> = []
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    socket.write('220 localhost test SMTP\r\n')
    let buffer = ''
    let data: string[] | null = null
    socket.on('data', chunk => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data) {
          if (line === '.') {
            messages.push(data.join('\r\n'))
            data = null
            socket.write('250 accepted\r\n')
          } else data.push(line)
        } else if (/^EHLO/i.test(line)) socket.write(auth ? '250-localhost\r\n250 AUTH PLAIN\r\n' : '250 localhost\r\n')
        else if (/^HELO/i.test(line)) socket.write('250 localhost\r\n')
        else if (/^AUTH PLAIN /i.test(line)) {
          // RFC 4616: base64("authzid\0user\0pass")
          const [, user = '', pass = ''] = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString('utf8').split('\0')
          const accepted = !!auth && user === auth.user && pass === auth.pass
          logins.push({ user, pass, accepted })
          socket.write(accepted ? '235 authenticated\r\n' : '535 5.7.8 authentication failed\r\n')
        } else if (/^MAIL FROM:/i.test(line) && auth && !logins.some(l => l.accepted)) {
          socket.write('530 5.7.0 authentication required\r\n')
        }
        else if (/^RCPT TO:/i.test(line)) {
          recipients.push(line)
          socket.write(rejectRecipient ? '550 recipient rejected\r\n' : '250 recipient OK\r\n')
        } else if (line === 'DATA') {
          data = []
          socket.write('354 end with dot\r\n')
        } else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 OK\r\n')
      }
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  return { port: address.port, messages, recipients, logins }
}

function database(port: number, emailEnabled = true, credentials?: SmtpAuth) {
  return {
    alertSettings: { findUnique: async () => ({
      emailEnabled, smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false,
      smtpUser: credentials?.user ?? null, smtpPassword: credentials?.pass ?? null,
      smtpFromName: 'VisionCore', smtpFromEmail: 'alerts@example.test',
      recipientEmails: 'one@example.test, two@example.test',
    }) },
  } as unknown as PrismaClient
}

describe('email provider with the installed SMTP transport', () => {
  it('delivers the alert to every configured recipient with text and HTML', async () => {
    const test = await smtp()
    const result = await sendAlertEmail(database(test.port), {
      subject: 'Camera offline', text: 'Check the NVR.', html: '<b>Check the NVR.</b>',
    })
    expect(result.success).toBe(true)
    expect(test.recipients).toEqual(['RCPT TO:<one@example.test>', 'RCPT TO:<two@example.test>'])
    expect(test.messages).toHaveLength(1)
    expect(test.messages[0]).toContain('Subject: Camera offline')
    expect(test.messages[0]).toContain('Content-Type: multipart/alternative;')
    expect(test.messages[0]).toContain('Check the NVR.')
    expect(test.messages[0]).toContain('<b>Check the NVR.</b>')
  })

  it('preserves recipient overrides without also mailing the configured list', async () => {
    const test = await smtp()
    const result = await sendAlertEmail(database(test.port), {
      to: 'operator@example.test', subject: 'Test', html: 'Test',
    })
    expect(result).toEqual({ success: true, recipient: 'operator@example.test' })
    expect(test.recipients).toEqual(['RCPT TO:<operator@example.test>'])
  })

  it('reports a real SMTP rejection as failure and never sends DATA', async () => {
    const test = await smtp(true)
    const result = await sendAlertEmail(database(test.port), { subject: 'Test', html: 'Test' })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('EENVELOPE')
    expect(test.messages).toEqual([])
  })

  it('does not connect when email delivery is disabled', async () => {
    const test = await smtp()
    const result = await sendAlertEmail(database(test.port, false), { subject: 'Test', html: 'Test' })
    expect(result.success).toBe(false)
    expect(test.recipients).toEqual([])
    expect(test.messages).toEqual([])
    expect(sockets.size).toBe(0)
  })

  it('authenticates with the configured SMTP credentials before sending', async () => {
    const credentials = { user: 'alerts-user', pass: 'correct horse battery staple' }
    const test = await smtp(false, credentials)
    const result = await sendAlertEmail(database(test.port, true, credentials), { subject: 'Auth', html: 'Auth' })
    expect(result.success).toBe(true)
    expect(test.logins).toEqual([{ ...credentials, accepted: true }])
    expect(test.messages).toHaveLength(1)
  })

  it('reports rejected credentials as EAUTH, sends no DATA and never echoes the password', async () => {
    const test = await smtp(false, { user: 'alerts-user', pass: 'the-right-secret' })
    const wrong = { user: 'alerts-user', pass: 'a-wrong-secret-value' }
    const result = await sendAlertEmail(database(test.port, true, wrong), { subject: 'Auth', html: 'Auth' })
    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('EAUTH')
    expect(test.logins).toEqual([{ ...wrong, accepted: false }])
    expect(test.recipients).toEqual([])
    expect(test.messages).toEqual([])
    expect(result.error).not.toContain(wrong.pass)
  })
})
