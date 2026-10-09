// Suite conjunta de seguridad — arranque y configuración de server.ts (#190 × #182).
//
// Cada prueba arranca su PROPIO server.ts real (módulos reiniciados entre arranques)
// con una configuración de entorno distinta:
//   - CHW-10 (verde): con NODE_ENV=production y sin COOKIE_SECURE, las cookies de
//     sesión salen con Secure además de HttpOnly y SameSite=Strict.
//   - CHW-09 (DEFECTO): con un JWT_SECRET de valor PÚBLICO (el default de
//     docker-compose.yml o el placeholder de .env.example) el arranque debería
//     abortar; hoy sólo se valida presencia y largo ≥ 32. Con #190 un
//     `{sub, role:'ADMIN'}` firmado con ese valor ES un access válido.
// Los valores conocidos se LEEN de los archivos versionados (no se duplican aquí) y
// ningún mensaje los imprime. No se lee ningún .env real.
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../jobs/healthWorker', async () => (await import('./infra-doubles')).healthWorkerDouble())
vi.mock('../jobs/syncWorker', async () => (await import('./infra-doubles')).syncWorkerDouble())
vi.mock('../services/stream-reregister', async () => (await import('./infra-doubles')).reregisterDouble())
vi.mock('../services/stream', async (orig) => (await import('./infra-doubles')).streamModuleDouble(await orig() as any))
vi.mock('../services/hikvision', async (orig) => (await import('./infra-doubles')).hikvisionModuleDouble(await orig() as any))
vi.mock('../services/rtsp-probe', async (orig) => (await import('./infra-doubles')).rtspProbeModuleDouble(await orig() as any))
vi.mock('../services/credentials', async (orig) => (await import('./infra-doubles')).credentialsModuleDouble(await orig() as any))
vi.mock('child_process', async (orig) => (await import('./infra-doubles')).childProcessModuleDouble(await orig() as any))

import fs from 'node:fs'
import path from 'node:path'
import { jointInfraAvailable, startJointServer, signHs256, type JointEnv } from './harness'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

/** Valores de JWT_SECRET publicados en el repo (default de compose y placeholder de .env.example). */
function knownJwtSecrets(): Array<[string, string]> {
  const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8')
  const example = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8')
  const fromCompose = /JWT_SECRET:\s*\$\{JWT_SECRET:-([^}]+)\}/.exec(compose)?.[1]
  const fromExample = /^JWT_SECRET=(.+)$/m.exec(example)?.[1]?.trim()
  const out: Array<[string, string]> = []
  if (fromCompose) out.push(['default de docker-compose.yml', fromCompose])
  if (fromExample) out.push(['placeholder de .env.example', fromExample])
  return out
}

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

  // DEFECTO conocido (previo): corre sólo con RUN_KNOWN_DEFECTS=1, ver defectos-conocidos.joint.test.ts.
  it.runIf(process.env.RUN_KNOWN_DEFECTS === '1')('CHW-09 — JWT_SECRET con un valor público conocido ⇒ server.ts NO arranca (y el mensaje no lo imprime)', async () => {
    const known = knownJwtSecrets()
    expect(known.length).toBe(2)
    for (const [label, value] of known) {
      // El chequeo vigente (largo ≥ 32) no lo detecta: la prueba es sobre la lista, no el largo.
      expect(value.length).toBeGreaterThanOrEqual(32)
      let booted: JointEnv | null = null
      let failure: Error | null = null
      try {
        booted = await startJointServer({ label: 'arrjwt', env: { JWT_SECRET: value } })
      } catch (err) {
        failure = err as Error
      }
      // Si arrancó, se mide el impacto (sin afirmarlo como correcto): un access ADMIN
      // forjado SÓLO con el valor público, sin pasar por ninguna ruta de login.
      let impact = ''
      if (booted) {
        try {
          const victim = await booted.createUser('admin_forjado', 'ADMIN')
          const now = Math.floor(Date.now() / 1000)
          const forged = signHs256({ sub: victim.id, username: 'admin_forjado', role: 'ADMIN', iat: now, exp: now + 300 }, value)
          const r = await booted.browser('forjador').get('/api/users', { headers: { authorization: `Bearer ${forged}` } })
          impact = ` — access ADMIN forjado con ese valor ⇒ GET /api/users ${r.status}`
        } finally {
          await booted.stop()
        }
      }
      vi.resetModules()
      // DEFECTO: server.ts sólo exige presencia y largo; un valor publicado en el repo
      // permite forjar `{sub, role:'ADMIN'}`, que con #190 es un access válido.
      expect.soft(failure?.message ?? `arrancó${impact}`, `arranque con JWT_SECRET = ${label}`).toMatch(/abortó el arranque/)
      if (failure) expect(failure.message).not.toContain(value)
    }
  })
})
