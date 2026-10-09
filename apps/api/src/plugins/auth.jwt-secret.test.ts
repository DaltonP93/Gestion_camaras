// Registro REAL del plugin de auth (el mismo que usa server.ts y varias pruebas)
// con distintos JWT_SECRET: con un valor público conocido o uno no aleatorio el
// registro debe FALLAR (y el mensaje no contiene el valor); con un secreto
// aleatorio registra, firma y verifica. Los valores públicos se leen de archivos
// versionados (lib/public-secret-sources.test-helpers.ts), nunca se imprimen.
import { describe, it, expect, afterEach } from 'vitest'
import path from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { authPlugin } from './auth'
import { descubrirJwtSecretsPublicados } from '../lib/public-secret-sources.test-helpers'
import { normalizarSecreto } from '../lib/jwt-secret-policy'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const ORIGINAL = process.env.JWT_SECRET

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = ORIGINAL
})

async function registrar(secret: string | undefined): Promise<{ app: FastifyInstance | null; error: Error | null }> {
  if (secret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = secret
  const app = Fastify({ logger: false })
  // Actor vigente (#197): cada jwtVerify consulta usuario activo + sesión viva.
  // Doble mínimo con u1/s1 vivo, para que un 401 sólo pueda venir de la firma.
  app.decorate('prisma', {
    user: { findFirst: async ({ where }: any) => (where?.id === 'u1' && where?.sessions?.some?.id === 's1' ? { role: 'ADMIN', username: 'u1' } : null) },
  } as any)
  try {
    await app.register(authPlugin)
    app.get('/privado', { preHandler: [app.authenticate] }, async () => ({ ok: true }))
    await app.ready()
    return { app, error: null }
  } catch (err) {
    await app.close().catch(() => undefined)
    return { app: null, error: err as Error }
  }
}

/** HS256 a mano: un atacante que sólo conoce el valor público. */
function firmarConValor(payload: Record<string, unknown>, secret: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const cuerpo = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`
  return `${cuerpo}.${createHmac('sha256', secret).update(cuerpo).digest('base64url')}`
}

describe('plugins/auth — JWT_SECRET al registrar', () => {
  const publicados = descubrirJwtSecretsPublicados(REPO_ROOT)

  it('AUTH-01 — cada valor público conocido ⇒ el registro falla con un mensaje que no contiene el valor', async () => {
    expect(publicados.length).toBeGreaterThanOrEqual(4)
    for (const p of publicados) {
      const { app, error } = await registrar(p.valor)
      if (app) await app.close()
      expect(error?.message ?? 'registró', p.etiqueta).toMatch(/JWT_SECRET coincide con un valor público conocido/)
      expect(error!.message.toLowerCase().includes(normalizarSecreto(p.valor)), p.etiqueta).toBe(false)
    }
  })

  it('AUTH-02 — no aleatorio (un carácter repetido, bloque repetido), corto o ausente ⇒ el registro falla', async () => {
    for (const [como, v, motivo] of [
      ['un carácter repetido', 'z'.repeat(64), /caracteres distintos/],
      ['bloque repetido', '0123456789abcdef'.repeat(4), /repetición de un bloque/],
      ['corto', randomBytes(15).toString('hex'), /menos de 32 caracteres/],
      ['ausente', undefined, /no está definido/],
    ] as Array<[string, string | undefined, RegExp]>) {
      const { app, error } = await registrar(v)
      if (app) await app.close()
      expect(error?.message ?? 'registró', como).toMatch(motivo)
      if (v) expect(error!.message.includes(v), como).toBe(false)
    }
  })

  it('AUTH-03 — secreto aleatorio ⇒ registra, firma y verifica; un access forjado con un valor público ⇒ 401', async () => {
    const { app, error } = await registrar(randomBytes(64).toString('hex'))
    expect(error).toBeNull()
    try {
      const propio = app!.jwt.sign({ sub: 'u1', username: 'u1', role: 'ADMIN', sid: 's1' } as any)
      expect((await app!.inject({ method: 'GET', url: '/privado', headers: { authorization: `Bearer ${propio}` } })).statusCode).toBe(200)
      const now = Math.floor(Date.now() / 1000)
      for (const p of publicados) {
        const forjado = firmarConValor({ sub: 'u1', username: 'u1', role: 'ADMIN', sid: 's1', iat: now, exp: now + 300 }, p.valor)
        const r = await app!.inject({ method: 'GET', url: '/privado', headers: { authorization: `Bearer ${forjado}` } })
        expect(r.statusCode, p.etiqueta).toBe(401)
      }
    } finally {
      await app!.close()
    }
  })
})
