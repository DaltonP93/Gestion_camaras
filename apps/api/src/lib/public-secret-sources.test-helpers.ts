// apps/api/src/lib/public-secret-sources.test-helpers.ts
//
// Sólo para PRUEBAS (el servidor no lo usa; tsconfig excluye *.test-helpers.ts, así
// que no se compila a dist ni viaja en la imagen): descubre en archivos VERSIONADOS
// los valores públicos de secretos, para ejercitar con ellos el arranque real y el
// script de verificación previa al despliegue. Los valores se LEEN (no se duplican
// en el código) y nunca se imprimen: quien llame sólo debe mostrar `etiqueta`.
//
// Desde este cambio docker-compose.yml y .env.example ya no publican un JWT_SECRET;
// los valores que publicaron siguen citados en la auditoría versionada
// (docs/audits/AUDIT_DEVOPS.md) y en el historial git, y de ahí se toman. Además se
// barre el repositorio por si alguien publica otro ejemplo, en estas formas (ver
// valoresJwtEnTexto): `VAR=valor`, `VAR: valor`, `${VAR:-valor}`, celdas de tabla
// Markdown, claves JSON y, en código que no es de pruebas, fallbacks
// `process.env.JWT_SECRET || '…'`/`?? '…'`, literales asignados y getenv con default.
// Otras formas (prosa, valores partidos, código de pruebas) no se detectan.

import fs from 'node:fs'
import path from 'node:path'

export interface ValorPublicado {
  /** Dónde se encontró (archivo y patrón). Nunca el valor. */
  etiqueta: string
  valor: string
}

const AUDIT_DEVOPS = 'docs/audits/AUDIT_DEVOPS.md'

function leer(repoRoot: string, rel: string): string | null {
  try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8') } catch { return null }
}

/** Texto de operación/documentación y JSON. */
const EXTENSIONES_TEXTO = /\.(md|sh|ya?ml|conf|txt|example|env|json)$|(^|\/)(Makefile|Dockerfile[^/]*|\.env[^/]*)$/
/** Código fuente: un fallback `process.env.JWT_SECRET || '…'` también publica el valor. */
const EXTENSIONES_CODIGO = /\.(ts|tsx|js|mjs|cjs|py)$/
/** Código de PRUEBAS (sus secretos no son de producción; JWT-09 los cubre aparte). */
const ES_CODIGO_DE_PRUEBA = /(^|\/)(e2e|__tests__|security-joint)\/|\.(test|spec)[.-]/
const DIRECTORIOS_OMITIDOS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'playwright-report', 'test-results'])

function esBarrido(rel: string): boolean {
  if (EXTENSIONES_TEXTO.test(rel)) return true
  return EXTENSIONES_CODIGO.test(rel) && !ES_CODIGO_DE_PRUEBA.test(rel)
}

function archivosBarridos(repoRoot: string, rel = ''): string[] {
  const out: string[] = []
  let entradas: fs.Dirent[]
  try { entradas = fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true }) } catch { return out }
  for (const e of entradas) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (!DIRECTORIOS_OMITIDOS.has(e.name)) out.push(...archivosBarridos(repoRoot, r))
    } else if (e.isFile() && esBarrido(r)) {
      out.push(r)
    }
  }
  return out
}

/** Un valor "usable" (no una referencia `$…`, un `<placeholder>` ni vacío). */
function usable(v: string | undefined): v is string {
  return !!v && v.length >= 8 && !/^[$<]/.test(v) && !/[<>$]/.test(v)
}

function agregar(out: ValorPublicado[], etiqueta: string, valor: string | undefined): void {
  if (!usable(valor)) return
  if (out.some(o => o.valor === valor)) return
  out.push({ etiqueta, valor })
}

/**
 * Valores de JWT_SECRET (y del placeholder histórico de JWT_REFRESH_SECRET, que
 * setup.sh usaba como JWT) publicados en el repositorio.
 */
export function descubrirJwtSecretsPublicados(repoRoot: string): ValorPublicado[] {
  const out: ValorPublicado[] = []

  // 1. Fuentes conocidas (siguen leyéndose por si alguien reintroduce el valor).
  const compose = leer(repoRoot, 'docker-compose.yml') ?? ''
  agregar(out, 'docker-compose.yml: ${JWT_SECRET:-…}', /\$\{JWT_SECRET:-([^}]+)\}/.exec(compose)?.[1])
  const example = leer(repoRoot, '.env.example') ?? ''
  agregar(out, '.env.example: JWT_SECRET=…', /^JWT_SECRET=(.*)$/m.exec(example)?.[1]?.trim())

  // 2. Auditoría versionada que cita los valores publicados históricamente.
  const audit = leer(repoRoot, AUDIT_DEVOPS) ?? ''
  const sed = /Los `sed` buscan `([^`]+)` y `([^`]+)`/.exec(audit)
  agregar(out, `${AUDIT_DEVOPS}: placeholder histórico de setup.sh (JWT_SECRET)`, sed?.[1])
  agregar(out, `${AUDIT_DEVOPS}: placeholder histórico de setup.sh (JWT_REFRESH_SECRET)`, sed?.[2])
  agregar(out, `${AUDIT_DEVOPS}: placeholder de .env.example`, /el placeholder real es `([^`]+)`/.exec(audit)?.[1])
  agregar(out, `${AUDIT_DEVOPS}: default de docker-compose.yml`, /`JWT_SECRET` cae a `([^`]+)`/.exec(audit)?.[1])

  // 3. Barrido del repositorio (docs, scripts, infra, workflows, JSON y código que
  //    no es de pruebas): ver valoresJwtEnTexto.
  for (const rel of archivosBarridos(repoRoot)) {
    const txt = leer(repoRoot, rel)
    if (!txt || !txt.includes('JWT_')) continue
    for (const v of valoresJwtEnTexto(rel, txt)) agregar(out, v.etiqueta, v.valor)
  }
  return out
}

// Texto (docs, scripts, YAML, .env*, JSON):
//   `VAR=valor` cuenta aunque esté comentado (un ejemplo comentado también se copia);
//   `VAR: valor` (YAML) sólo fuera de comentarios, para no tomar prosa como
//   "JWT_SECRET: reemplazar si…"; celdas de tabla Markdown `| VAR | valor |` sólo si
//   la celda es un único token (no una descripción con espacios); claves JSON.
const IGUAL = /(?:^|[\s"'`|#])(?:export\s+)?JWT_(?:REFRESH_)?SECRET\s*=\s*["']?([A-Za-z0-9_\-+/.=]{8,})/g
const YAML = /(?:^|[\s"'`|])JWT_(?:REFRESH_)?SECRET\s*:\s*["']?([A-Za-z0-9_\-+/.=]{8,})/g
const INTERPOLACION = /\$\{JWT_(?:REFRESH_)?SECRET:-([^}]+)\}/g
const TABLA = /\|\s*`?JWT_(?:REFRESH_)?SECRET`?\s*\|\s*[`"']?([A-Za-z0-9_\-+/.=]{8,})[`"']?\s*\|/g
const JSON_CLAVE = /"JWT_(?:REFRESH_)?SECRET"\s*:\s*"([^"\n]{8,})"/g
// Código (y también texto: un fragmento de código en un .md publica igual):
//   `process.env.JWT_SECRET || '…'` / `?? '…'` (así se publicó el fallback histórico
//   de plugins/auth.ts); literal asignado o como valor de una clave
//   (`JWT_SECRET = '…'`, `JWT_SECRET: '…'`); getenv/environ.get con default.
const FALLBACK = /JWT_(?:REFRESH_)?SECRET\s*(?:\|\||\?\?)\s*(['"`])([^'"`\n]{8,})\1/g
const LITERAL = /(?:^|[\s{,(])["']?JWT_(?:REFRESH_)?SECRET["']?\s*[:=]\s*(['"`])([^'"`\n]{8,})\1/g
const GETENV = /JWT_(?:REFRESH_)?SECRET['"]\s*,\s*(['"])([^'"\n]{8,})\1/g

/**
 * Valores asignados a JWT_SECRET/JWT_REFRESH_SECRET en el contenido de un archivo.
 * `rel` decide los patrones (texto o código). Las etiquetas nunca llevan el valor.
 */
export function valoresJwtEnTexto(rel: string, txt: string): ValorPublicado[] {
  const out: ValorPublicado[] = []
  const codigo = EXTENSIONES_CODIGO.test(rel)
  for (const linea of txt.split('\n')) {
    if (!linea.includes('JWT_')) continue
    for (const m of linea.matchAll(FALLBACK)) agregar(out, `${rel}: fallback de JWT_SECRET en código`, m[2])
    if (codigo) {
      for (const m of linea.matchAll(LITERAL)) agregar(out, `${rel}: literal asignado a JWT_SECRET`, m[2])
      for (const m of linea.matchAll(GETENV)) agregar(out, `${rel}: default de getenv(JWT_SECRET)`, m[2])
      continue
    }
    for (const m of linea.matchAll(IGUAL)) agregar(out, `${rel}: asignación a JWT_SECRET`, m[1])
    if (!/^\s*#/.test(linea)) for (const m of linea.matchAll(YAML)) agregar(out, `${rel}: asignación a JWT_SECRET`, m[1])
    for (const m of linea.matchAll(INTERPOLACION)) agregar(out, `${rel}: default \${JWT_SECRET:-…}`, m[1])
    for (const m of linea.matchAll(TABLA)) agregar(out, `${rel}: tabla Markdown con JWT_SECRET`, m[1])
    for (const m of linea.matchAll(JSON_CLAVE)) agregar(out, `${rel}: clave JSON JWT_SECRET`, m[1])
  }
  return out
}

/** Otros secretos con valor público histórico (para el script de verificación). */
export function descubrirOtrosSecretosPublicados(repoRoot: string): Array<ValorPublicado & { variable: string }> {
  const out: Array<ValorPublicado & { variable: string }> = []
  const audit = leer(repoRoot, AUDIT_DEVOPS) ?? ''
  const pg = /`POSTGRES_PASSWORD` es `([^`]+)`/.exec(audit)?.[1]
  if (pg) out.push({ variable: 'POSTGRES_PASSWORD', etiqueta: `${AUDIT_DEVOPS}: default histórico de POSTGRES_PASSWORD`, valor: pg })
  const cred = leer(repoRoot, 'apps/api/src/services/credentials.ts') ?? ''
  const nvr = /const LEGACY_DEFAULT_KEY = '([^']+)'/.exec(cred)?.[1]
  if (nvr) out.push({ variable: 'NVR_CREDENTIAL_KEY', etiqueta: 'services/credentials.ts: clave legacy por defecto', valor: nvr })
  return out
}

/**
 * Secretos JWT que usan las PRUEBAS del repo (deben seguir siendo aceptados).
 * Literales en `*.test.ts` del API; el harness conjunto usa `joint-jwt-<hex>`.
 */
export function descubrirJwtSecretsDePruebas(apiSrcRoot: string): ValorPublicado[] {
  const out: ValorPublicado[] = []
  const patrones = [
    /JWT_SECRET\s*=\s*process\.env\.JWT_SECRET\s*\|\|\s*'([^']+)'/g,
    /fastifyJwt,\s*\{\s*secret:\s*'([^']+)'/g,
    /JWT_SECRET\s*[:=]\s*'([^']{32,})'/g,
  ]
  const recorrer = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { recorrer(p); continue }
      if (!e.name.endsWith('.test.ts')) continue
      const txt = fs.readFileSync(p, 'utf8')
      for (const re of patrones) {
        for (const m of txt.matchAll(re)) {
          if (!out.some(o => o.valor === m[1])) out.push({ etiqueta: path.relative(apiSrcRoot, p), valor: m[1] })
        }
      }
    }
  }
  recorrer(apiSrcRoot)
  return out
}
