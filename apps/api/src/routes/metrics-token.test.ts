// apps/api/src/routes/metrics-token.test.ts
//
// #9 — /metrics compara el token de forma timing-safe. La ruta usa
// `timingSafeEqualHex(sha256Hex(provided), sha256Hex(METRICS_TOKEN))`: verificamos
// que ese patrón acepta el token correcto, rechaza el incorrecto y no lanza ni
// filtra por longitud (sha256 hex siempre 64 chars).
import { describe, it, expect } from 'vitest'
import { timingSafeEqualHex, sha256Hex } from '../services/media/media-grants'

function metricsTokenMatches(provided: string, token: string): boolean {
  return timingSafeEqualHex(sha256Hex(provided), sha256Hex(token))
}

describe('/metrics token — comparación timing-safe (#9)', () => {
  it('acepta el token correcto', () => {
    expect(metricsTokenMatches('s3cr3t-token', 's3cr3t-token')).toBe(true)
  })

  it('rechaza un token incorrecto de la misma longitud', () => {
    expect(metricsTokenMatches('aaaaaaaaaaaa', 'bbbbbbbbbbbb')).toBe(false)
  })

  it('rechaza tokens de distinta longitud sin lanzar (longitudes normalizadas)', () => {
    expect(metricsTokenMatches('short', 'a-much-longer-token-value')).toBe(false)
    expect(metricsTokenMatches('a-much-longer-token-value', 'short')).toBe(false)
  })

  it('provided vacío no coincide con un token no vacío', () => {
    expect(metricsTokenMatches('', 'real-token')).toBe(false)
  })

  it('el hash intermedio siempre mide 64 chars (no filtra longitud del token)', () => {
    expect(sha256Hex('x')).toHaveLength(64)
    expect(sha256Hex('token-de-longitud-arbitraria-1234567890')).toHaveLength(64)
  })
})
