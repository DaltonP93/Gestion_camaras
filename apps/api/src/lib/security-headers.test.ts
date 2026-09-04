// Verifica que la CSP endurecida (lib/security-headers.ts) produce el header
// esperado vía @fastify/helmet — el mismo plugin/config que usa server.ts.
import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import { cspDirectives } from './security-headers'

// Parsea "a b; c d" -> { a: ['b'], c: ['d'] } con nombres de directiva normalizados.
function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const name = tokens[0].toLowerCase()
    out[name] = tokens.slice(1)
  }
  return out
}

let csp: Record<string, string[]>

beforeAll(async () => {
  const app: FastifyInstance = Fastify()
  await app.register(helmet, {
    contentSecurityPolicy: { directives: cspDirectives },
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
  app.get('/__ping', async () => ({ ok: true }))
  await app.ready()
  const res = await app.inject({ method: 'GET', url: '/__ping' })
  const header = res.headers['content-security-policy']
  expect(typeof header).toBe('string')
  csp = parseCsp(header as string)
  await app.close()
})

describe('CSP endurecida', () => {
  it('emite el header Content-Security-Policy', () => {
    expect(csp['default-src']).toEqual(["'self'"])
  })

  it('script-src NO permite unsafe-inline (endurecido) y sí self', () => {
    expect(csp['script-src']).toContain("'self'")
    expect(csp['script-src']).not.toContain("'unsafe-inline'")
    expect(csp['script-src']).not.toContain("'unsafe-eval'")
  })

  it('script-src-attr bloquea manejadores inline (none)', () => {
    expect(csp['script-src-attr']).toEqual(["'none'"])
  })

  it('style-src base no lleva unsafe-inline', () => {
    expect(csp['style-src']).toEqual(["'self'"])
  })

  it("style-src-attr conserva 'unsafe-inline' para el atributo style= de React", () => {
    expect(csp['style-src-attr']).toContain("'unsafe-inline'")
  })

  it("style-src-elem conserva 'unsafe-inline' para el <style> dinámico de apariencia", () => {
    expect(csp['style-src-elem']).toContain("'self'")
    expect(csp['style-src-elem']).toContain("'unsafe-inline'")
  })

  it('conserva las demás directivas sin cambios funcionales', () => {
    expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:'])
    expect(csp['media-src']).toEqual(["'self'", 'blob:'])
    expect(csp['connect-src']).toEqual(["'self'", 'ws:', 'wss:'])
    expect(csp['frame-ancestors']).toEqual(["'self'"])
  })
})
