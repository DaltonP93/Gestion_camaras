import { describe, it, expect } from 'vitest'
import { isCsrfSafe, requestHasAuthCookie } from './csrf'
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth-cookies'

const base = { host: 'vms.example.com', hasAuthCookie: true, corsOriginsEnv: 'https://vms.example.com' }

describe('isCsrfSafe', () => {
  it('métodos no mutantes (GET/HEAD/OPTIONS) siempre pasan', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isCsrfSafe({ ...base, method, origin: 'https://evil.com' })).toBe(true)
    }
  })

  it('mutación SIN cookie de auth pasa (Bearer / servicio→servicio no aplica)', () => {
    expect(isCsrfSafe({ method: 'POST', hasAuthCookie: false, origin: 'https://evil.com', host: 'vms.example.com' })).toBe(true)
  })

  it('mutación con cookie + Origin same-origin (por Host) pasa', () => {
    expect(isCsrfSafe({ ...base, corsOriginsEnv: undefined, method: 'POST', origin: 'https://vms.example.com' })).toBe(true)
    expect(isCsrfSafe({ ...base, corsOriginsEnv: undefined, method: 'POST', origin: 'http://vms.example.com' })).toBe(true)
  })

  it('mutación con cookie + Origin en la allowlist CORS pasa', () => {
    expect(isCsrfSafe({ ...base, host: 'interno', method: 'DELETE', origin: 'https://vms.example.com' })).toBe(true)
  })

  it('mutación con cookie + Origin cruzado se BLOQUEA', () => {
    expect(isCsrfSafe({ ...base, method: 'POST', origin: 'https://evil.com' })).toBe(false)
    expect(isCsrfSafe({ ...base, method: 'PUT', origin: 'https://vms.example.com.evil.com' })).toBe(false)
  })

  it('mutación con cookie SIN Origin ni Referer se BLOQUEA (sospechosa)', () => {
    expect(isCsrfSafe({ ...base, method: 'POST', origin: undefined, referer: undefined })).toBe(false)
  })

  it('cae al Referer cuando no hay Origin', () => {
    expect(isCsrfSafe({ ...base, method: 'POST', origin: undefined, referer: 'https://vms.example.com/app/x' })).toBe(true)
    expect(isCsrfSafe({ ...base, method: 'POST', origin: undefined, referer: 'https://evil.com/x' })).toBe(false)
  })

  it('sin CORS_ORIGINS (dev), localhost es válido; otro origen no', () => {
    expect(isCsrfSafe({ method: 'POST', hasAuthCookie: true, host: 'x', corsOriginsEnv: undefined, origin: 'http://localhost:5173' })).toBe(true)
    expect(isCsrfSafe({ method: 'POST', hasAuthCookie: true, host: 'x', corsOriginsEnv: undefined, origin: 'https://evil.com' })).toBe(false)
  })

  it('Origin malformado se BLOQUEA', () => {
    expect(isCsrfSafe({ ...base, method: 'POST', origin: 'no-es-una-url' })).toBe(false)
  })
})

describe('requestHasAuthCookie', () => {
  it('detecta access_token o refresh_token', () => {
    expect(requestHasAuthCookie({ [ACCESS_COOKIE]: 'x' })).toBe(true)
    expect(requestHasAuthCookie({ [REFRESH_COOKIE]: 'y' })).toBe(true)
    expect(requestHasAuthCookie({ otra: 'z' })).toBe(false)
    expect(requestHasAuthCookie(undefined)).toBe(false)
    expect(requestHasAuthCookie({})).toBe(false)
  })
})
