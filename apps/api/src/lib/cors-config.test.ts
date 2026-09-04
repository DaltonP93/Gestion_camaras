import { describe, it, expect } from 'vitest'
import { resolveCorsOptions, isLocalhostOrigin, type CorsOriginResolver } from './cors-config'

// Helper: ejecuta la función-origin y devuelve el booleano de permiso.
function allows(origin: CorsOriginResolver, value: string | undefined): boolean {
  if (typeof origin !== 'function') throw new Error('origin no es función')
  let result: boolean | undefined
  origin(value, (_err, allow) => { result = allow })
  if (result === undefined) throw new Error('callback no invocado')
  return result
}

describe('resolveCorsOptions — CORS_ORIGINS definido (comportamiento histórico exacto)', () => {
  it('un solo origin → lista con ese origin + credentials true', () => {
    const opts = resolveCorsOptions('https://camaras.example.com')
    expect(opts.origin).toEqual(['https://camaras.example.com'])
    expect(opts.credentials).toBe(true)
  })

  it('múltiples origins con espacios → lista trimmeada', () => {
    const opts = resolveCorsOptions('https://a.example.com, https://b.example.com')
    expect(opts.origin).toEqual(['https://a.example.com', 'https://b.example.com'])
    expect(opts.credentials).toBe(true)
  })

  it('valor sólo con comas/espacios → lista vacía (igual que hoy, NO cae a localhost)', () => {
    const opts = resolveCorsOptions(' , , ')
    // Truthy string → se parsea; [] es truthy → se devuelve la lista vacía, que
    // en @fastify/cors bloquea todo origin cruzado. Comportamiento idéntico al previo.
    expect(Array.isArray(opts.origin)).toBe(true)
    expect(opts.origin).toEqual([])
    expect(opts.credentials).toBe(true)
  })

  it('NO reintroduce reflexión: con allowlist el origin es un array, nunca una función', () => {
    const opts = resolveCorsOptions('https://camaras.example.com')
    expect(typeof opts.origin).not.toBe('function')
  })
})

describe('resolveCorsOptions — CORS_ORIGINS ausente/vacío (endurecido)', () => {
  it('undefined → función de origin (no true) + credentials true', () => {
    const opts = resolveCorsOptions(undefined)
    expect(typeof opts.origin).toBe('function')
    expect(opts.credentials).toBe(true)
    // Regresión clave: ya NO es `origin: true` (que reflejaba cualquier origin).
    expect(opts.origin).not.toBe(true as unknown as CorsOriginResolver)
  })

  it('string vacío → misma función de origin endurecida', () => {
    const opts = resolveCorsOptions('')
    expect(typeof opts.origin).toBe('function')
  })

  it('permite localhost en cualquier puerto (dev usable)', () => {
    const opts = resolveCorsOptions(undefined)
    expect(allows(opts.origin, 'http://localhost:3000')).toBe(true)
    expect(allows(opts.origin, 'http://localhost:5173')).toBe(true)
    expect(allows(opts.origin, 'https://localhost')).toBe(true)
    expect(allows(opts.origin, 'http://127.0.0.1:4000')).toBe(true)
    expect(allows(opts.origin, 'http://[::1]:8080')).toBe(true)
  })

  it('permite requests sin cabecera Origin (same-origin / curl / health checks)', () => {
    const opts = resolveCorsOptions(undefined)
    expect(allows(opts.origin, undefined)).toBe(true)
  })

  it('NIEGA orígenes arbitrarios cruzados (no reflexión con credenciales)', () => {
    const opts = resolveCorsOptions(undefined)
    expect(allows(opts.origin, 'https://evil.example.com')).toBe(false)
    expect(allows(opts.origin, 'http://attacker.test')).toBe(false)
    // Trucos de subdominio/prefijo no deben colar.
    expect(allows(opts.origin, 'https://localhost.evil.com')).toBe(false)
    expect(allows(opts.origin, 'http://127.0.0.1.evil.com')).toBe(false)
    expect(allows(opts.origin, 'https://notlocalhost')).toBe(false)
  })
})

describe('isLocalhostOrigin', () => {
  it('reconoce localhost/127.0.0.1/[::1] con y sin puerto', () => {
    expect(isLocalhostOrigin('http://localhost')).toBe(true)
    expect(isLocalhostOrigin('http://localhost:3000')).toBe(true)
    expect(isLocalhostOrigin('https://127.0.0.1:4000')).toBe(true)
    expect(isLocalhostOrigin('http://[::1]:8080')).toBe(true)
  })
  it('rechaza hosts que sólo contienen localhost como substring', () => {
    expect(isLocalhostOrigin('https://localhost.evil.com')).toBe(false)
    expect(isLocalhostOrigin('http://127.0.0.1.evil.com')).toBe(false)
    expect(isLocalhostOrigin('http://mylocalhost')).toBe(false)
    expect(isLocalhostOrigin('ftp://localhost')).toBe(false)
  })
})
