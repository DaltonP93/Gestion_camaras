// apps/api/src/services/onvif/ws-security.test.ts
//
// WS-Security UsernameToken: digest determinista (vector conocido) con nonce y
// reloj fijos, y no-filtración de la contraseña en claro en el header.

import { describe, it, expect } from 'vitest'
import { buildUsernameToken, computePasswordDigest } from './ws-security'

// Vector conocido (KAT). Digest = Base64(SHA1(nonceBytes + created + password)).
const NONCE_B64 = 'LKqI6G/AikKCQrN0zqZFlg=='
const CREATED = '2026-09-03T12:00:00Z'
const PASSWORD = 'test-onvif-pass'
const EXPECTED_DIGEST = 'NZvsNaKvrQjwBXkITt1gDRoksI0='

describe('computePasswordDigest', () => {
  it('reproduce el vector conocido con nonce/created/password fijos', () => {
    const nonce = Buffer.from(NONCE_B64, 'base64')
    expect(computePasswordDigest(nonce, CREATED, PASSWORD)).toBe(EXPECTED_DIGEST)
  })

  it('cambia si cambia el nonce (no es constante)', () => {
    const a = computePasswordDigest(Buffer.from('aaaa', 'utf8'), CREATED, PASSWORD)
    const b = computePasswordDigest(Buffer.from('bbbb', 'utf8'), CREATED, PASSWORD)
    expect(a).not.toBe(b)
  })
})

describe('buildUsernameToken', () => {
  it('genera header WSSE determinista con nonce/created inyectados', () => {
    const { headerXml, usernameToken } = buildUsernameToken({
      username: 'admin',
      password: PASSWORD,
      nonce: Buffer.from(NONCE_B64, 'base64'),
      created: CREATED,
    })
    expect(usernameToken.digest).toBe(EXPECTED_DIGEST)
    expect(usernameToken.nonceB64).toBe(NONCE_B64)
    expect(headerXml).toContain('<wsse:Security')
    expect(headerXml).toContain('<wsse:Username>admin</wsse:Username>')
    expect(headerXml).toContain(`<wsse:Password Type="`)
    expect(headerXml).toContain(EXPECTED_DIGEST)
    expect(headerXml).toContain(`>${NONCE_B64}</wsse:Nonce>`)
    expect(headerXml).toContain(`<wsu:Created>${CREATED}</wsu:Created>`)
  })

  it('NUNCA incluye la contraseña en claro en el header', () => {
    const { headerXml } = buildUsernameToken({
      username: 'admin',
      password: PASSWORD,
      nonce: Buffer.from(NONCE_B64, 'base64'),
      created: CREATED,
    })
    expect(headerXml).not.toContain(PASSWORD)
  })

  it('usa providers inyectables cuando no se dan nonce/created', () => {
    const { usernameToken } = buildUsernameToken({
      username: 'u',
      password: 'p',
      nonceProvider: () => Buffer.from('fixed-nonce'),
      clock: () => CREATED,
    })
    expect(usernameToken.created).toBe(CREATED)
    expect(usernameToken.digest).toBe(computePasswordDigest(Buffer.from('fixed-nonce'), CREATED, 'p'))
  })

  it('escapa metacaracteres XML en el username', () => {
    const { headerXml } = buildUsernameToken({
      username: 'a<b>&"',
      password: 'p',
      nonce: Buffer.from('n'),
      created: CREATED,
    })
    expect(headerXml).toContain('a&lt;b&gt;&amp;&quot;')
  })
})
