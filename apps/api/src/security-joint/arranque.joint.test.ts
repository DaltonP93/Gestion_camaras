// Suite conjunta de seguridad — arranque y configuración de server.ts (#190 × #182).
//
// Cada prueba arranca su PROPIO server.ts real (módulos reiniciados entre arranques)
// con una configuración de entorno distinta:
//   - CHW-10 (verde): con NODE_ENV=production y sin COOKIE_SECURE, las cookies de
//     sesión salen con Secure además de HttpOnly y SameSite=Strict.
//   - CHW-09 (JWT_SECRET con valor público conocido) se corrigió en #196 y su prueba
//     adaptada vive en jwt-secret-publico.joint.test.ts (los valores ya no están en
//     docker-compose.yml ni en .env.example; se leen de la lista del API y del historial).
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))

import { jointInfraAvailable, startJointServer } from './harness'

describe.skipIf(!jointInfraAvailable())('conjunta · arranque y configuración de server.ts', { timeout: 90_000 }, () => {
  // Cada arranque necesita un server.ts NUEVO (su main() corre al importarlo).
  afterEach(() => { vi.resetModules() })

  it('CHW-10 — NODE_ENV=production sin COOKIE_SECURE ⇒ access y refresh con Secure, HttpOnly y SameSite=Strict (también al borrarlas)', async () => {
    const env = await startJointServer({ label: 'arrprod', env: { NODE_ENV: 'production' } })
    try {
      expect(process.env.COOKIE_SECURE).toBeUndefined()
      await env.createUser('admin_arr', 'ADMIN')
      const b = env.browser('arranque-prod')
      const login = await b.login('admin_arr')
      expect(login.status).toBe(200)
      for (const name of ['access_token', 'refresh_token']) {
        expect(login.setCookies.find(c => c.name === name), name).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' })
      }
      const out = await b.post('/api/auth/logout', {})
      expect(out.status).toBe(200)
      for (const c of out.setCookies) expect(c.secure, `borrado de ${c.name}`).toBe(true)
    } finally {
      await env.stop()
    }
  })
})
