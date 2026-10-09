// Política de JWT_SECRET (C08): valores públicos conocidos por hash + heurísticas
// mínimas. Los valores públicos se LEEN de archivos versionados (no se duplican
// aquí) y ningún mensaje ni etiqueta de prueba los imprime.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  VALORES_PUBLICOS_SHA256, MIN_CARACTERES_DISTINTOS, MIN_LARGO_JWT_SECRET,
  evaluarJwtSecret, assertJwtSecretAceptable, coincideConValorPublico,
  esRepeticionDeBloque, normalizarSecreto, sha256Normalizado,
} from './jwt-secret-policy'
import { descubrirJwtSecretsPublicados, descubrirJwtSecretsDePruebas, valoresJwtEnTexto } from './public-secret-sources.test-helpers'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const API_SRC = path.resolve(__dirname, '..')

/** Variantes que siguen siendo "el mismo" valor público para un operador. */
function variantes(v: string): Array<[string, string]> {
  return [
    ['tal cual', v],
    ['en mayúsculas', v.toUpperCase()],
    ['con espacios en los extremos', `  ${v}\t`],
  ]
}

/** El mensaje no contiene el valor (ni en minúsculas ni en mayúsculas) ni su hash. */
function expectSinValor(mensaje: string, valor: string): void {
  const m = mensaje.toLowerCase()
  expect(m.includes(normalizarSecreto(valor))).toBe(false)
  expect(m.includes(sha256Normalizado(valor))).toBe(false)
}

describe('JWT_SECRET — valores públicos conocidos (lista por SHA-256)', () => {
  const publicados = descubrirJwtSecretsPublicados(REPO_ROOT)

  it('JWT-01 — los valores publicados en el repo están TODOS en la lista embebida (y la lista no tiene entradas JWT del repo sin respaldo)', () => {
    // compose (hasta este cambio), .env.example (hasta este cambio) y los dos
    // placeholders históricos de setup.sh, citados en docs/audits/AUDIT_DEVOPS.md.
    expect(publicados.length, publicados.map(p => p.etiqueta).join(' | ')).toBeGreaterThanOrEqual(4)
    const descubiertos = new Set(publicados.map(p => sha256Normalizado(p.valor)))
    const listaJwtRepo = new Set(VALORES_PUBLICOS_SHA256.filter(v => v.origen === 'repo' && /JWT/.test(v.descripcion)).map(v => v.sha256))
    for (const p of publicados) expect(listaJwtRepo.has(sha256Normalizado(p.valor)), `falta en la lista: ${p.etiqueta}`).toBe(true)
    for (const h of listaJwtRepo) expect(descubiertos.has(h), `entrada sin fuente versionada: ${VALORES_PUBLICOS_SHA256.find(v => v.sha256 === h)?.descripcion}`).toBe(true)
  })

  it('JWT-02 — cada valor publicado (y sus variantes de mayúsculas/espacios) se RECHAZA como público, con un mensaje que no lo contiene', () => {
    for (const p of publicados) {
      // El chequeo previo (presencia + largo ≥ 32) los dejaba pasar.
      expect(p.valor.length, p.etiqueta).toBeGreaterThanOrEqual(MIN_LARGO_JWT_SECRET)
      for (const [como, v] of variantes(p.valor)) {
        const r = evaluarJwtSecret(v)
        expect(r?.motivo, `${p.etiqueta} (${como})`).toBe('publico')
        expectSinValor(r!.mensaje, p.valor)
        let lanzado: Error | null = null
        try { assertJwtSecretAceptable(v) } catch (err) { lanzado = err as Error }
        expect(lanzado?.message, `${p.etiqueta} (${como})`).toMatch(/valor público conocido/)
        expectSinValor(lanzado!.message, p.valor)
      }
    }
  })

  // Publicaciones que sólo quedan en el historial git (no en archivos vigentes).
  // Agregar aquí cada `<commit>:<ruta>` que haya publicado un JWT_SECRET.
  const FUENTES_HISTORICAS = ['618ba6c:apps/api/src/plugins/auth.ts']
  const gitShow = (fuente: string): string | null => {
    try { return execFileSync('git', ['-C', REPO_ROOT, 'show', fuente], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
  }
  const historicas = FUENTES_HISTORICAS.map(f => ({ fuente: f, txt: gitShow(f) }))

  it('JWT-10a — cada entrada de origen "historial" declara una fuente git conocida', () => {
    const declaradas = VALORES_PUBLICOS_SHA256.filter(v => v.origen === 'historial')
    expect(declaradas.length).toBeGreaterThanOrEqual(1)
    for (const v of declaradas) expect(FUENTES_HISTORICAS, v.descripcion).toContain(v.fuenteGit)
  })

  // Un clon superficial (CI: fetch-depth 1) no tiene esos commits: la prueba se omite
  // y la cobertura queda en la lista (SCR-01 exige que el script tenga los mismos hashes).
  it.skipIf(historicas.some(h => h.txt === null))('JWT-10b — los valores publicados en el historial git (fallback de plugins/auth.ts) se RECHAZAN como públicos', () => {
    for (const { fuente, txt } of historicas) {
      const valores = valoresJwtEnTexto(fuente.slice(fuente.indexOf(':') + 1), txt!)
      expect(valores.length, fuente).toBeGreaterThanOrEqual(1)
      for (const p of valores) {
        expect(p.valor.length, fuente).toBeGreaterThanOrEqual(MIN_LARGO_JWT_SECRET)
        for (const [como, v] of variantes(p.valor)) {
          const r = evaluarJwtSecret(v)
          expect(r?.motivo, `${fuente} (${como})`).toBe('publico')
          expectSinValor(r!.mensaje, p.valor)
        }
        const entrada = VALORES_PUBLICOS_SHA256.find(e => e.sha256 === sha256Normalizado(p.valor))
        expect(entrada?.origen, fuente).toBe('historial')
        expect(entrada?.fuenteGit, fuente).toBe(fuente)
      }
    }
  })

  it('JWT-11 — el barrido detecta ejemplos nuevos en tablas Markdown, JSON y código que no es de pruebas (y no toma prosa ni pruebas)', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-barrido-'))
    try {
      const v = () => randomBytes(20).toString('hex')
      const casos: Array<[string, (x: string) => string, boolean]> = [
        ['docs/tabla.md', x => `| \`JWT_SECRET\` | \`${x}\` |`, true],
        ['docs/tabla-sin-backticks.md', x => `| JWT_SECRET | ${x} |`, true],
        ['config/env.json', x => `{"env":{"JWT_SECRET":"${x}"}}`, true],
        ['docs/fragmento.md', x => `    secret: process.env.JWT_SECRET || '${x}',`, true],
        ['apps/api/src/plugins/otro.ts', x => `  secret: process.env.JWT_SECRET || '${x}',`, true],
        ['apps/api/src/cfg.ts', x => `const s = process.env.JWT_SECRET ?? "${x}"`, true],
        ['apps/api/src/cfg2.ts', x => `export const cfg = { JWT_SECRET: '${x}' }`, true],
        ['tools/firmar.py', x => `os.environ.get("JWT_SECRET", "${x}")`, true],
        ['docs/export.md', x => `export JWT_SECRET="${x}"`, true],
        // No son publicaciones: código de pruebas, referencias, prosa y descripciones.
        ['apps/api/src/algo.test.ts', x => `process.env.JWT_SECRET || '${x}'`, false],
        ['apps/api/src/ref.ts', () => 'const JWT_SECRET = process.env.JWT_SECRET', false],
        ['apps/api/src/coment.ts', () => '// JWT_SECRET: presencia, largo y heurísticas', false],
        ['docs/desc.md', () => '| `JWT_SECRET` | Clave JWT (obligatoria, mín. 32 chars) | `openssl rand -hex 64` |', false],
      ]
      const esperados = new Map<string, string>()
      const prohibidos = new Map<string, string>()
      for (const [rel, linea, publica] of casos) {
        const x = v()
        fs.mkdirSync(path.join(raiz, path.dirname(rel)), { recursive: true })
        fs.writeFileSync(path.join(raiz, rel), `# x\n${linea(x)}\n`)
        ;(publica ? esperados : prohibidos).set(x, rel)
      }
      const hallados = new Set(descubrirJwtSecretsPublicados(raiz).map(p => p.valor))
      for (const [x, rel] of esperados) expect(hallados.has(x), `no detectó ${rel}`).toBe(true)
      for (const [x, rel] of prohibidos) expect(hallados.has(x), `tomó como publicación ${rel}`).toBe(false)
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true })
    }
  })

  it('JWT-12 — los helpers de prueba (*.test-helpers.ts, que recorren el repo) no se compilan a dist ni viajan en la imagen', () => {
    const tsc = path.resolve(__dirname, '../../node_modules/typescript/bin/tsc')
    const lista = execFileSync(process.execPath, [tsc, '-p', path.resolve(__dirname, '../../tsconfig.json'), '--listFilesOnly'], { encoding: 'utf8' })
      .split('\n').filter(l => l.includes('/src/'))
    expect(lista.some(l => l.endsWith('/src/server.ts'))).toBe(true)
    expect(lista.filter(l => /\.test(-helpers)?\.ts$|public-secret-sources/.test(l))).toEqual([])
  }, 60_000)

  it('JWT-03 — lista embebida bien formada; ni el código ni las descripciones contienen un valor publicado', () => {
    const hashes = VALORES_PUBLICOS_SHA256.map(v => v.sha256)
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(hashes).size).toBe(hashes.length)
    for (const v of VALORES_PUBLICOS_SHA256) expect(v.descripcion.trim().length).toBeGreaterThan(0)
    const fuente = fs.readFileSync(path.join(__dirname, 'jwt-secret-policy.ts'), 'utf8').toLowerCase()
    for (const p of publicados) expect(fuente.includes(normalizarSecreto(p.valor)), p.etiqueta).toBe(false)
  })
})

describe('JWT_SECRET — presencia, largo y heurísticas mínimas', { timeout: 30_000 }, () => {
  const hex = (bytes: number) => randomBytes(bytes).toString('hex')

  it('JWT-04 — ausente, vacío o sólo espacios ⇒ "ausente"; menos de 32 caracteres ⇒ "corto"', () => {
    for (const v of [undefined, '', '   ', '\t\n']) expect(evaluarJwtSecret(v)?.motivo).toBe('ausente')
    const corto = hex(15) // 30 caracteres aleatorios
    expect(evaluarJwtSecret(corto)?.motivo).toBe('corto')
    expectSinValor(evaluarJwtSecret(corto)!.mensaje, corto)
  })

  it(`JWT-05 — un solo carácter repetido o menos de ${MIN_CARACTERES_DISTINTOS} caracteres distintos ⇒ "poca_variedad"`, () => {
    for (const v of ['a'.repeat(64), 'x'.repeat(32), '0'.repeat(127) + '1', 'ab'.repeat(16) + 'c', 'abcde'.repeat(7) + 'aa']) {
      const r = evaluarJwtSecret(v)
      expect(r?.motivo, `largo ${v.length}`).toBe('poca_variedad')
      expectSinValor(r!.mensaje, v)
    }
  })

  it('JWT-06 — exactamente el umbral de caracteres distintos y sin repetición de bloque ⇒ aceptado (el umbral no es más estricto de lo documentado)', () => {
    // 64 caracteres al azar sobre un alfabeto de exactamente MIN_CARACTERES_DISTINTOS símbolos.
    // Intentos acotados: si el umbral cambiara de forma que no exista candidato, la
    // prueba falla en vez de quedar en un bucle infinito.
    const alfabeto = 'qwertyuiop'.slice(0, MIN_CARACTERES_DISTINTOS)
    let v: string | null = null
    for (let i = 0; i < 1000 && v === null; i++) {
      const c = Array.from(randomBytes(64), b => alfabeto[b % alfabeto.length]).join('')
      if (new Set(c).size === MIN_CARACTERES_DISTINTOS && !esRepeticionDeBloque(c)) v = c
    }
    expect(v, 'no se pudo construir un candidato en el umbral').not.toBeNull()
    expect(evaluarJwtSecret(v!)).toBeNull()
  })

  it('JWT-07 — repetición de un bloque corto ⇒ "repetitivo" (aunque tenga variedad y largo)', () => {
    const bloque16 = '0123456789abcdef'
    // Bloque de 10 caracteres hex con variedad suficiente (intentos acotados).
    let bloqueAzar = hex(5)
    for (let i = 0; i < 1000 && new Set(bloqueAzar).size < MIN_CARACTERES_DISTINTOS; i++) bloqueAzar = hex(5)
    for (const v of [bloque16.repeat(2), bloqueAzar.repeat(4), bloqueAzar.repeat(4) + bloqueAzar.slice(0, 3), 'Cambiá-Esto!'.repeat(3)]) {
      expect(new Set(v).size).toBeGreaterThanOrEqual(MIN_CARACTERES_DISTINTOS)
      const r = evaluarJwtSecret(v)
      expect(r?.motivo, `largo ${v.length}`).toBe('repetitivo')
      expectSinValor(r!.mensaje, v)
    }
    // No es repetición: el bloque más corto que lo genera supera la mitad del largo.
    expect(esRepeticionDeBloque('abcdefghijklmnopqrstuvwxyz' + 'abcdef')).toBe(false)
  })

  it('JWT-08 — secretos reales: openssl rand -hex 32/64, base64, base64url y el formato del harness conjunto ⇒ siempre aceptados', () => {
    for (let i = 0; i < 300; i++) {
      for (const v of [hex(32), hex(64), randomBytes(32).toString('base64'), randomBytes(48).toString('base64url'), `joint-jwt-${hex(32)}`, hex(16)]) {
        const r = evaluarJwtSecret(v)
        expect(r, r?.motivo).toBeNull()
        expect(coincideConValorPublico(v)).toBe(false)
      }
    }
  })

  it('JWT-09 — los secretos que usan las pruebas del repo siguen siendo válidos', () => {
    const dePruebas = descubrirJwtSecretsDePruebas(API_SRC)
    expect(dePruebas.length).toBeGreaterThanOrEqual(2)
    for (const s of dePruebas) expect(evaluarJwtSecret(s.valor), s.etiqueta).toBeNull()
  })
})
