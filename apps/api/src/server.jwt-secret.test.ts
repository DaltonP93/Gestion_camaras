// Arranque REAL de server.ts en un proceso hijo (tsx) con JWT_SECRET de valor
// público conocido: el proceso debe TERMINAR con código 1 por la validación de
// JWT_SECRET, y ni stdout ni stderr pueden contener el valor.
//
// Aislamiento: entorno mínimo (no hereda el del runner), producción (logs JSON sin
// transporte), y todas las URLs a puertos CERRADOS de loopback: si la validación no
// abortara (código previo), el arranque fallaría contra 127.0.0.1 sin contactar
// nada externo. Los valores públicos se leen de archivos versionados y las
// aserciones sólo muestran la etiqueta de origen.
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { descubrirJwtSecretsPublicados } from './lib/public-secret-sources.test-helpers'
import { normalizarSecreto } from './lib/jwt-secret-policy'

const API_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(API_ROOT, '../..')
const TSX_BIN = path.join(API_ROOT, 'node_modules/.bin/tsx')
const TIMEOUT_MS = 60_000

interface Resultado { code: number | null; signal: NodeJS.Signals | null; salida: string; timeout: boolean }

function arrancarServer(jwtSecret: string): Promise<Resultado> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-jwt-arranque-'))
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: tmp,
    TMPDIR: tmp,
    NODE_ENV: 'production',
    JWT_SECRET: jwtSecret,
    NVR_CREDENTIAL_KEY: randomBytes(32).toString('hex'),
    API_HOST: '127.0.0.1',
    API_PORT: '0',
    DATABASE_URL: 'postgresql://nadie:nada@127.0.0.1:1/nada',
    REDIS_URL: 'redis://127.0.0.1:1',
    MEDIAMTX_URL: 'http://127.0.0.1:1',
    ANALYTICS_URL: 'http://127.0.0.1:1',
    UPLOADS_DIR: path.join(tmp, 'uploads'),
    RECORDINGS_CACHE_DIR: path.join(tmp, 'cache'),
    VOD_TEMP_DIR: path.join(tmp, 'vod'),
  }
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, ['src/server.ts'], { cwd: API_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let salida = ''
    child.stdout.on('data', (d) => { salida += d })
    child.stderr.on('data', (d) => { salida += d })
    let timeout = false
    const timer = setTimeout(() => { timeout = true; child.kill('SIGKILL') }, TIMEOUT_MS)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      fs.rmSync(tmp, { recursive: true, force: true })
      resolve({ code, signal, salida, timeout })
    })
  })
}

describe('server.ts — arranque real con JWT_SECRET público o no aleatorio', { timeout: TIMEOUT_MS * 2 }, () => {
  const publicados = descubrirJwtSecretsPublicados(REPO_ROOT)

  it('SRV-JWT-01 — cada valor público conocido ⇒ process.exit(1) por JWT_SECRET; la salida no contiene el valor', async () => {
    expect(publicados.length).toBeGreaterThanOrEqual(4)
    const resultados = await Promise.all(publicados.map(p => arrancarServer(p.valor)))
    publicados.forEach((p, i) => {
      const r = resultados[i]
      expect(r.timeout, `${p.etiqueta}: el proceso siguió vivo (no abortó)`).toBe(false)
      expect(r.code, p.etiqueta).toBe(1)
      expect(r.salida, p.etiqueta).toMatch(/\[startup\] FATAL: JWT_SECRET coincide con un valor público conocido/)
      const salida = r.salida.toLowerCase()
      expect(salida.includes(normalizarSecreto(p.valor)), `${p.etiqueta}: la salida contiene el valor`).toBe(false)
    })
  })

  it('SRV-JWT-02 — un carácter repetido (64) ⇒ process.exit(1) por variedad, sin imprimir el valor', async () => {
    const valor = 'k'.repeat(64)
    const r = await arrancarServer(valor)
    expect(r.timeout).toBe(false)
    expect(r.code).toBe(1)
    expect(r.salida).toMatch(/\[startup\] FATAL: JWT_SECRET tiene menos de 6 caracteres distintos/)
    expect(r.salida.includes(valor)).toBe(false)
  })
})
