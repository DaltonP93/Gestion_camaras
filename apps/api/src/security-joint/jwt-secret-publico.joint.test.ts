// Suite conjunta — JWT_SECRET con valor público conocido (C08) sobre el server.ts
// REAL (harness.ts / infra-doubles.ts copiados byte a byte; no se modifican).
//
//   - CHW-09 (adaptada): con cada valor PÚBLICO conocido el arranque de server.ts
//     aborta y el mensaje no lo imprime. La CHW-09 original (arranque.joint.test.ts
//     de la revisión conjunta) toma los valores de docker-compose.yml y .env.example;
//     como este cambio los quita de ahí, esta versión los toma de las fuentes
//     versionadas que los siguen citando (lib/public-secret-sources.test-helpers.ts).
//   - JWT-J02: con un secreto aleatorio arranca, el login real emite un access que
//     funciona y un access ADMIN forjado con cualquier valor público ⇒ 401.
// Ningún mensaje ni etiqueta imprime los valores: sólo su origen.
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))

import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { jointInfraAvailable, startJointServer, signHs256, type JointEnv } from './harness'
import { descubrirJwtSecretsPublicados } from '../lib/public-secret-sources.test-helpers'
import { normalizarSecreto } from '../lib/jwt-secret-policy'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

describe.skipIf(!jointInfraAvailable())('conjunta · JWT_SECRET con valor público conocido', { timeout: 120_000 }, () => {
  // Cada arranque necesita un server.ts NUEVO (su main() corre al importarlo).
  afterEach(() => { vi.resetModules() })

  const publicados = descubrirJwtSecretsPublicados(REPO_ROOT)

  it('CHW-09 (adaptada) — JWT_SECRET con cada valor público conocido ⇒ server.ts NO arranca (y el mensaje no lo imprime)', async () => {
    // compose y .env.example (hasta este cambio) y los placeholders históricos de setup.sh.
    expect(publicados.length).toBeGreaterThanOrEqual(4)
    const antes = process.env.JWT_SECRET
    for (const p of publicados) {
      // El chequeo previo (largo ≥ 32) no lo detectaba: la prueba es sobre la lista, no el largo.
      expect(p.valor.length).toBeGreaterThanOrEqual(32)
      let booted: JointEnv | null = null
      let failure: Error | null = null
      try {
        booted = await startJointServer({ label: 'jwtpub', env: { JWT_SECRET: p.valor } })
      } catch (err) {
        failure = err as Error
      }
      let impacto = ''
      if (booted) {
        try {
          const victim = await booted.createUser('admin_forjado', 'ADMIN')
          const now = Math.floor(Date.now() / 1000)
          const forged = signHs256({ sub: victim.id, username: 'admin_forjado', role: 'ADMIN', iat: now, exp: now + 300 }, p.valor)
          const r = await booted.browser('forjador').get('/api/users', { headers: { authorization: `Bearer ${forged}` } })
          impacto = ` — access ADMIN forjado ⇒ GET /api/users ${r.status}`
        } finally {
          await booted.stop()
        }
      }
      vi.resetModules()
      expect(failure?.message ?? `arrancó${impacto}`, `arranque con JWT_SECRET = ${p.etiqueta}`).toMatch(/abortó el arranque/)
      expect(failure!.message.toLowerCase().includes(normalizarSecreto(p.valor)), p.etiqueta).toBe(false)
      // El harness restaura el entorno aunque el arranque aborte.
      expect(process.env.JWT_SECRET).toBe(antes)
    }
  })

  it('JWT-J02 — secreto aleatorio ⇒ arranca; login real y /me funcionan; un access ADMIN forjado con un valor público ⇒ 401', async () => {
    const env = await startJointServer({ label: 'jwtrnd', env: { JWT_SECRET: randomBytes(64).toString('hex') } })
    try {
      const admin = await env.createUser('admin_jwt', 'ADMIN')
      const b = env.browser('jwt-aleatorio')
      await b.signIn('admin_jwt')
      expect((await b.get('/api/auth/me')).status).toBe(200)
      expect((await b.get('/api/users')).status).toBe(200)
      const now = Math.floor(Date.now() / 1000)
      for (const p of publicados) {
        const forged = signHs256({ sub: admin.id, username: 'admin_jwt', role: 'ADMIN', iat: now, exp: now + 300 }, p.valor)
        const r = await env.browser('forjador').get('/api/users', { headers: { authorization: `Bearer ${forged}` } })
        expect(r.status, p.etiqueta).toBe(401)
      }
    } finally {
      await env.stop()
    }
  })
})
