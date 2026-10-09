// scripts/check-public-secrets.sh — verificación previa al despliegue. Se ejecuta el
// script REAL con archivos .env temporales y con el entorno del proceso; nunca
// contra un .env real. Los valores públicos se leen de archivos versionados y las
// aserciones verifican que la salida NO los contiene.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { VALORES_PUBLICOS_SHA256, evaluarJwtSecret, normalizarSecreto } from './jwt-secret-policy'
import { descubrirJwtSecretsPublicados, descubrirOtrosSecretosPublicados } from './public-secret-sources.test-helpers'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-public-secrets.sh')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-public-secrets-'))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

let seq = 0
function envFile(contenido: string): string {
  const f = path.join(TMP, `caso-${++seq}.env`)
  fs.writeFileSync(f, contenido, { mode: 0o600 })
  return f
}

interface Corrida { status: number | null; salida: string }
function correr(args: string[], extraEnv: Record<string, string> = {}): Corrida {
  // Entorno mínimo: ningún secreto del runner se filtra a la corrida.
  const r = spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...extraEnv },
    encoding: 'utf8',
  })
  return { status: r.status, salida: `${r.stdout}${r.stderr}` }
}

const APTO = (v: 'sí' | 'no') => new RegExp(`^JWT_SECRET: apto para el arranque del API .*: ${v}$`, 'm')

function expectSinValor(salida: string, valor: string, etiqueta: string): void {
  const s = salida.toLowerCase()
  expect(s.includes(normalizarSecreto(valor)), `${etiqueta}: la salida contiene el valor`).toBe(false)
}

const hex = (n: number) => randomBytes(n).toString('hex')

// Cada caso lanza bash: margen amplio para runners cargados (en reposo, ~1 s por caso).
describe('scripts/check-public-secrets.sh', { timeout: 60_000 }, () => {
  const publicados = descubrirJwtSecretsPublicados(REPO_ROOT)
  const otros = descubrirOtrosSecretosPublicados(REPO_ROOT)

  it('SCR-01 — la lista de hashes del script es EXACTAMENTE la del API', () => {
    const txt = fs.readFileSync(SCRIPT, 'utf8')
    const bloque = /HASHES_PUBLICOS="([^"]*)"/.exec(txt)?.[1] ?? ''
    const delScript = bloque.split(/\s+/).filter(Boolean)
    for (const h of delScript) expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect([...delScript].sort()).toEqual(VALORES_PUBLICOS_SHA256.map(v => v.sha256).sort())
  })

  it('SCR-02 — JWT_SECRET con cada valor público (tal cual, en mayúsculas, con espacios o entre comillas) ⇒ "sí", exit 1 y sin imprimir el valor', () => {
    expect(publicados.length).toBeGreaterThanOrEqual(4)
    for (const p of publicados) {
      for (const linea of [
        `JWT_SECRET=${p.valor}`, `JWT_SECRET=${p.valor.toUpperCase()}`, `export JWT_SECRET= ${p.valor}  # copiado`,
        `JWT_SECRET="${p.valor}"`, `JWT_SECRET='${p.valor}'\r`,
        // Comillas Y comentario (docker compose entrega el valor de adentro).
        `JWT_SECRET="${p.valor}" # copiado de la doc`, `JWT_SECRET='${p.valor}'  # ejemplo`, `export JWT_SECRET = "${p.valor}"# x`,
        // Sintaxis YAML que compose también acepta en el .env.
        `JWT_SECRET: ${p.valor}`,
      ]) {
        const r = correr(['--env-file', envFile(`# otro\n${linea}\nNVR_CREDENTIAL_KEY=${hex(32)}\n`)])
        expect(r.status, p.etiqueta).toBe(1)
        expect(r.salida, p.etiqueta).toMatch(/^JWT_SECRET: coincide con un valor público: sí$/m)
        expect(r.salida, p.etiqueta).toMatch(/^JWT_SECRET: apto para el arranque del API .*: no$/m)
        expect(r.salida, p.etiqueta).toMatch(/^NVR_CREDENTIAL_KEY: coincide con un valor público: no$/m)
        expectSinValor(r.salida, p.valor, p.etiqueta)
      }
    }
  })

  it('SCR-03 — otras variables con valor público (POSTGRES_PASSWORD, clave legacy de NVR, JWT_REFRESH_SECRET histórico) ⇒ "sí" con su remediación, NO bloquean (exit 0); con --strict ⇒ exit 1', () => {
    expect(otros.map(o => o.variable).sort()).toEqual(['NVR_CREDENTIAL_KEY', 'POSTGRES_PASSWORD'])
    const refresh = publicados.find(p => /JWT_REFRESH_SECRET/.test(p.etiqueta))
    expect(refresh, 'placeholder histórico de JWT_REFRESH_SECRET').toBeDefined()
    // Remediación por variable: nunca "reemplazala con openssl" para las que cortan el servicio.
    const remediacion: Record<string, RegExp> = {
      POSTGRES_PASSWORD: /^POSTGRES_PASSWORD: qué hacer: NO la cambies sólo en \.env: .*initdb.*ALTER USER.*autorización\.$/m,
      NVR_CREDENTIAL_KEY: /^NVR_CREDENTIAL_KEY: qué hacer: NO la cambies sólo en \.env: .*ilegibles.*re-cifrarlas.*autorización\.$/m,
      JWT_REFRESH_SECRET: /^JWT_REFRESH_SECRET: qué hacer: el API no la usa .*eliminá la línea del \.env\.$/m,
    }
    const casos = [...otros, { variable: 'JWT_REFRESH_SECRET', etiqueta: refresh!.etiqueta, valor: refresh!.valor }]
    for (const o of casos) {
      const archivo = envFile(`JWT_SECRET=${hex(64)}\n${o.variable}=${o.valor}\n`)
      const r = correr(['--env-file', archivo])
      expect(r.status, o.etiqueta).toBe(0)
      expect(r.salida, o.etiqueta).toMatch(new RegExp(`^${o.variable}: coincide con un valor público: sí$`, 'm'))
      expect(r.salida, o.etiqueta).toMatch(remediacion[o.variable])
      expect(r.salida, o.etiqueta).not.toMatch(new RegExp(`^${o.variable}: qué hacer: .*openssl rand -hex 64`, 'm'))
      expect(r.salida, o.etiqueta).toMatch(/^JWT_SECRET: coincide con un valor público: no$/m)
      expect(r.salida, o.etiqueta).toMatch(APTO('sí'))
      expect(r.salida, o.etiqueta).toMatch(/^Resultado: OK para el arranque del API, con avisos/m)
      expectSinValor(r.salida, o.valor, o.etiqueta)
      const estricto = correr(['--env-file', archivo, '--strict'])
      expect(estricto.status, `${o.etiqueta} --strict`).toBe(1)
      expect(estricto.salida).toMatch(/^Resultado: BLOQUEANTE \(--strict\)/m)
      expectSinValor(estricto.salida, o.valor, o.etiqueta)
    }
  })

  it('SCR-04 — secretos aleatorios ⇒ todo "no", JWT apto, exit 0 y sin imprimir valores', () => {
    const valores = { JWT_SECRET: hex(64), NVR_CREDENTIAL_KEY: hex(32), POSTGRES_PASSWORD: hex(32), ANALYTICS_SECRET: hex(32), METRICS_TOKEN: hex(16) }
    const r = correr(['--env-file', envFile(Object.entries(valores).map(([k, v]) => `${k}=${v}`).join('\n'))])
    expect(r.status).toBe(0)
    for (const k of Object.keys(valores)) expect(r.salida).toMatch(new RegExp(`^${k}: coincide con un valor público: no$`, 'm'))
    expect(r.salida).toMatch(/^JWT_SECRET: apto para el arranque del API .*: sí$/m)
    expect(r.salida).toMatch(/^SMTP_PASS: no definida$/m)
    for (const v of Object.values(valores)) expectSinValor(r.salida, v, 'aleatorio')
  })

  it('SCR-05 — --process-env: lee el entorno y PISA al archivo (como la interpolación de docker compose)', () => {
    const publico = publicados[0]
    const soloEnv = correr(['--process-env'], { JWT_SECRET: publico.valor })
    expect(soloEnv.status).toBe(1)
    expect(soloEnv.salida).toMatch(/^JWT_SECRET: coincide con un valor público: sí$/m)
    expectSinValor(soloEnv.salida, publico.valor, publico.etiqueta)
    // Archivo con valor público, entorno con uno aleatorio ⇒ manda el entorno.
    const archivo = envFile(`JWT_SECRET=${publico.valor}\n`)
    expect(correr(['--env-file', archivo, '--process-env'], { JWT_SECRET: hex(64) }).status).toBe(0)
    // Y al revés: el entorno con valor público ⇒ bloquea aunque el archivo esté bien.
    const bien = envFile(`JWT_SECRET=${hex(64)}\n`)
    expect(correr(['--env-file', bien, '--process-env'], { JWT_SECRET: publico.valor }).status).toBe(1)
  })

  it('SCR-06 — JWT_SECRET ausente/vacío ⇒ exit 1; "apto" coincide con la política del API', () => {
    for (const contenido of ['', 'JWT_SECRET=\n', 'JWT_SECRET=   \n', 'OTRA=1\n']) {
      const r = correr(['--env-file', envFile(contenido)])
      expect(r.status).toBe(1)
      expect(r.salida).toMatch(/^JWT_SECRET: no definida \(obligatoria/m)
    }
    let seis = ''
    do { seis = Array.from(randomBytes(64), b => 'qwerty'[b % 6]).join('') } while (new Set(seis).size !== 6)
    const casos = [
      'z'.repeat(64), '0123456789abcdef'.repeat(3), 'abcde'.repeat(8), hex(15), hex(16), hex(64), seis, `joint-jwt-${hex(32)}`,
      // Poca variedad SIN repetición de bloque: sólo la regla de variedad los rechaza.
      '0'.repeat(63) + '1', 'ab'.repeat(16) + 'c',
    ]
    for (const v of casos) {
      const r = correr(['--env-file', envFile(`JWT_SECRET=${v}\n`)])
      const aptoApi = evaluarJwtSecret(v) === null
      expect(r.salida, `largo ${v.length}`).toMatch(new RegExp(`^JWT_SECRET: apto para el arranque del API .*: ${aptoApi ? 'sí' : 'no'}$`, 'm'))
      expect(r.status, `largo ${v.length}`).toBe(aptoApi ? 0 : 1)
      expectSinValor(r.salida, v, `largo ${v.length}`)
    }
  })

  it('SCR-07 — no ejecuta el .env (sin source) y falla con 2 ante uso inválido o archivo ilegible', () => {
    const marca = path.join(TMP, 'no-debe-existir')
    const r = correr(['--env-file', envFile(`JWT_SECRET=$(touch ${marca})\nPOSTGRES_PASSWORD=\`touch ${marca}\`\n`)])
    expect(fs.existsSync(marca)).toBe(false)
    // Se leyó como texto, sin ejecutarlo: `$` ⇒ no verificable (compose interpolaría).
    expect(r.status).toBe(1)
    expect(r.salida).toMatch(/^JWT_SECRET: no verificable \(\$ sin comillas/m)
    expect(r.salida).toMatch(/^POSTGRES_PASSWORD: coincide con un valor público: no$/m)
    expect(correr([]).status).toBe(2)
    expect(correr(['--env-file']).status).toBe(2)
    expect(correr(['--env-file', path.join(TMP, 'no-existe.env')]).status).toBe(2)
    expect(correr(['--otra']).status).toBe(2)
  })

  // Líneas que el script NO lee igual que docker compose ⇒ "no verificable" y bloquea
  // (fail-closed), y líneas que sí ⇒ mismo veredicto que el API sobre lo que compose entrega.
  const lineasParser = (P: string, R: string): { noVerificables: string[]; verificables: string[] } => ({
    noVerificables: [
      `JWT_SECRET="${P}\\n"`,                              // escape: compose entrega P + salto de línea
      `JWT_SECRET="${P}\n"`,                               // comillas dobles multilínea
      `OTRA=${P}\nJWT_SECRET=\${OTRA}`,                    // interpolación
      `OTRA=${P}\nJWT_SECRET="\${OTRA}"`,
      `OTRA=${P}\nJWT_SECRET=$OTRA`,
      `JWT_SECRET="${P}"zz`,                               // texto tras la comilla de cierre
      `JWT_SECRET=${P}\t# c`,                              // tabulación antes de # (compose no corta)
      `JWT_SECRET=${P}\nOTRA="a\nJWT_SECRET=${R}\n"`,      // multilínea ajena que "oculta" otra definición
    ],
    verificables: [
      `JWT_SECRET="${R}" # ok`, `JWT_SECRET='${R}'  # ok`, `JWT_SECRET=${R} # ok`, `JWT_SECRET: ${R}`,
      `JWT_SECRET='${R}$x'`,                               // comillas simples: `$` literal (compose no interpola)
      `JWT_SECRET=${R}#pegado`,                            // sin espacio antes de #: es parte del valor
      `JWT_SECRET="${P}" # copiado`, `JWT_SECRET: ${P}`,
    ],
  })

  it('SCR-08 — lo que no lee igual que docker compose (escapes, multilínea, $, texto tras la comilla, tab antes de #) ⇒ "no verificable", exit 1, sin imprimir valores; el entorno lo pisa', () => {
    const P = publicados[0].valor
    const R = hex(40)
    const { noVerificables, verificables } = lineasParser(P, R)
    for (const [i, contenido] of noVerificables.entries()) {
      const r = correr(['--env-file', envFile(`${contenido}\n`)])
      expect(r.status, `no verificable #${i}`).toBe(1)
      expect(r.salida, `no verificable #${i}`).toMatch(/^JWT_SECRET: no verificable \(/m)
      expect(r.salida, `no verificable #${i}`).not.toMatch(APTO('sí'))
      expectSinValor(r.salida, P, `no verificable #${i}`)
      expectSinValor(r.salida, R, `no verificable #${i}`)
    }
    for (const [i, contenido] of verificables.entries()) {
      const r = correr(['--env-file', envFile(`${contenido}\n`)])
      expect(r.salida, `verificable #${i}`).not.toMatch(/no verificable/)
      expect(r.salida, `verificable #${i}`).toMatch(/^JWT_SECRET: coincide con un valor público: (sí|no)$/m)
      expectSinValor(r.salida, P, `verificable #${i}`)
      expectSinValor(r.salida, R, `verificable #${i}`)
    }
    // --process-env pisa al archivo: un JWT_SECRET del entorno es verificable aunque el .env no lo sea.
    const multilinea = envFile(`JWT_SECRET=${P}\nOTRA="a\nb"\n`)
    expect(correr(['--env-file', multilinea]).status).toBe(1)
    expect(correr(['--env-file', multilinea, '--process-env'], { JWT_SECRET: hex(64) }).status).toBe(0)
  })

  it('SCR-09 — JWT_SECRET no ASCII ⇒ "no verificable" y exit 1 (el API cuenta caracteres; el script, bytes)', () => {
    // 16 letras acentuadas distintas (ficticias): 16 caracteres, 32 bytes en UTF-8.
    const acentos = Array.from({ length: 16 }, (_, i) => String.fromCharCode(0xe0 + i)).join('')
    expect(Buffer.byteLength(acentos, 'utf8')).toBe(32)
    expect(evaluarJwtSecret(acentos)?.motivo).toBe('corto')
    const largo = acentos + hex(32)
    expect(evaluarJwtSecret(largo)).toBeNull() // el API lo aceptaría, pero el script no puede asegurarlo
    for (const v of [acentos, largo]) {
      const r = correr(['--env-file', envFile(`JWT_SECRET=${v}\n`)])
      expect(r.status, `largo ${v.length}`).toBe(1)
      expect(r.salida).toMatch(/^JWT_SECRET: apto para el arranque del API .*: no verificable \(caracteres no ASCII/m)
      expect(r.salida.includes(v)).toBe(false)
    }
  })

  const composeDisponible = (() => {
    try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 20_000 }); return true } catch { return false }
  })()

  // Sólo `docker compose config` (interpola y valida; no contacta al daemon ni crea nada).
  it.skipIf(!composeDisponible)('SCR-10 — paridad con docker compose: el script nunca da OK si el valor que compose le entrega al API es rechazado; si es verificable, el veredicto coincide', () => {
    const yml = path.join(TMP, 'paridad-compose.yml')
    fs.writeFileSync(yml, 'services:\n  api:\n    image: busybox\n    environment:\n      JWT_SECRET: ${JWT_SECRET:?falta}\n')
    const P = publicados[0].valor
    const R = hex(40)
    const { noVerificables, verificables } = lineasParser(P, R)
    let comparadas = 0
    for (const [i, contenido] of [...noVerificables, ...verificables].entries()) {
      const f = envFile(`${contenido}\n`)
      let entregado: string | null
      try {
        const j = JSON.parse(execFileSync('docker', ['compose', '-p', 'paridad', '-f', yml, '--env-file', f, 'config', '--format', 'json'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? TMP },
        }))
        entregado = String(j.services.api.environment.JWT_SECRET).replace(/\$\$/g, '$') // config escapa `$`
      } catch { entregado = null } // compose aborta: no hay arranque posible
      if (entregado === null) continue
      comparadas++
      const aceptaApi = evaluarJwtSecret(entregado) === null
      const r = correr(['--env-file', f])
      if (r.status === 0) expect(aceptaApi, `#${i}: el script dio OK con un valor que el API rechaza`).toBe(true)
      if (!aceptaApi) expect(r.status, `#${i}`).toBe(1)
      if (!/no verificable/.test(r.salida)) expect(r.status === 0, `#${i}: veredicto distinto del API`).toBe(aceptaApi)
    }
    expect(comparadas).toBeGreaterThanOrEqual(10)
  })
})

// setup.sh con un `docker` FALSO (responde a las verificaciones y corta en el primer
// build con exit 97): nunca construye ni levanta nada, y el directorio temporal no
// tiene docker-compose.yml.
describe('setup.sh — JWT_SECRET al seguir el README (cp .env.example .env)', { timeout: 60_000 }, () => {
  const publicados = descubrirJwtSecretsPublicados(REPO_ROOT)

  function prepararSetup(env: string): string {
    const dir = fs.mkdtempSync(path.join(TMP, 'setup-'))
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.copyFileSync(path.join(REPO_ROOT, 'setup.sh'), path.join(dir, 'setup.sh'))
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/check-public-secrets.sh'))
    fs.copyFileSync(path.join(REPO_ROOT, '.env.example'), path.join(dir, '.env.example'))
    fs.writeFileSync(path.join(dir, '.env'), env, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'bin/docker'), [
      '#!/bin/sh',
      'echo "$*" >> "$LLAMADAS"',
      'case "$1 $2" in',
      '  "--version "*) echo "Docker version 27.0.0, build falso"; exit 0 ;;',
      '  "compose version") exit 0 ;;',
      'esac',
      'exit 97',
      '',
    ].join('\n'), { mode: 0o755 })
    return dir
  }
  function correrSetup(dir: string): { status: number | null; salida: string; llamadas: string } {
    const llamadas = path.join(dir, 'llamadas.txt')
    const r = spawnSync('bash', ['setup.sh'], {
      cwd: dir, input: '', encoding: 'utf8',
      env: { PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, LLAMADAS: llamadas, HOME: dir },
    })
    return { status: r.status, salida: `${r.stdout}${r.stderr}`, llamadas: fs.existsSync(llamadas) ? fs.readFileSync(llamadas, 'utf8') : '' }
  }
  const jwtDel = (dir: string) => /^JWT_SECRET=(.*)$/m.exec(fs.readFileSync(path.join(dir, '.env'), 'utf8'))?.[1]

  it('SETUP-01 — .env copiado de .env.example (JWT_SECRET vacío) ⇒ setup.sh lo genera, la verificación pasa y sigue al build', () => {
    const dir = prepararSetup(fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8'))
    const r = correrSetup(dir)
    const jwt = jwtDel(dir)
    expect(evaluarJwtSecret(jwt), 'JWT_SECRET generado').toBeNull()
    expect(r.salida).toMatch(APTO('sí'))
    expect(r.llamadas).toMatch(/^compose build/m)
    expect(r.status).toBe(97)
    expectSinValor(r.salida, jwt!, 'JWT_SECRET generado')
  })

  it('SETUP-02 — nunca pisa un JWT_SECRET existente: con uno válido sigue; con uno público aborta ANTES del build', () => {
    const propio = hex(64)
    const dir = prepararSetup(`JWT_SECRET=${propio}\n`)
    const r = correrSetup(dir)
    expect(jwtDel(dir) === propio).toBe(true)
    expect(r.status).toBe(97)
    expectSinValor(r.salida, propio, 'propio')
    const pub = publicados[0]
    const dir2 = prepararSetup(`JWT_SECRET=${pub.valor}\n`)
    const r2 = correrSetup(dir2)
    expect(jwtDel(dir2) === pub.valor).toBe(true)
    expect(r2.status).toBe(1)
    expect(r2.llamadas).not.toMatch(/compose build/)
    expectSinValor(r2.salida, pub.valor, pub.etiqueta)
  })
})
