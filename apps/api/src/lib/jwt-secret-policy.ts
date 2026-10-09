// apps/api/src/lib/jwt-secret-policy.ts
//
// Política de JWT_SECRET al arrancar (grupo C08 de la revisión conjunta).
//
// Por qué: el access es un JWT HS256 `{sub, username, role}`. Quien conozca
// JWT_SECRET firma un access ADMIN válido sin pasar por el login. Hasta este cambio
// sólo se exigía presencia y largo ≥ 32, y los valores PUBLICADOS en el repositorio
// (el default de docker-compose.yml, el placeholder de .env.example y los
// placeholders históricos de setup.sh) pasaban ese chequeo.
//
// Reglas — si alguna falla, el arranque ABORTA (server.ts y el registro del plugin
// de auth, ver plugins/auth.ts):
//   1. Definido y con al menos 32 caracteres (como antes).
//   2. NO coincide con un valor público conocido. Se compara el SHA-256 del valor
//      normalizado (sin espacios en los extremos y ASCII en minúsculas) contra la
//      lista embebida de abajo. Este archivo y los mensajes NUNCA contienen ni
//      imprimen el valor: sólo hashes y una etiqueta de origen.
//   3. Heurísticas mínimas contra placeholders obvios, con umbrales elegidos para
//      no rechazar secretos reales (ver MIN_CARACTERES_DISTINTOS y esRepeticionDeBloque).
//
// La MISMA lista vive en scripts/check-public-secrets.sh (verificación previa al
// despliegue, sin Node). Una prueba de CI exige que ambas coincidan.

import { createHash } from 'node:crypto'

/** Largo mínimo (sin cambios respecto del chequeo anterior). */
export const MIN_LARGO_JWT_SECRET = 32

/**
 * Menos de 6 caracteres distintos ⇒ no es aleatorio (`aaaa…`, `abab…`, `0101…`).
 * Umbral elegido para no rechazar secretos reales. Probabilidad de que un valor
 * aleatorio uniforme tenga ≤ 5 caracteres distintos (cálculo exacto):
 *   - 32 caracteres hex:                ≈ 3·10⁻¹³
 *   - 32 dígitos decimales (peor caso): ≈ 6·10⁻⁸
 *   - `openssl rand -hex 32` / `-hex 64` (64/128 hex), base64: < 10⁻²⁸
 * Con 8 el peor caso decimal subiría a ≈ 3·10⁻², por eso no se usa un umbral mayor.
 */
export const MIN_CARACTERES_DISTINTOS = 6

export type OrigenValorPublico =
  | 'repo'      // publicado en archivos versionados de este repositorio (compose, .env.example, setup.sh, código)
  | 'historial' // publicado en el historial git de este repositorio (ya no está en archivos vigentes)
  | 'generico'  // placeholder genérico difundido (plantillas, tutoriales, jwt.io): MEJOR ESFUERZO

export interface ValorPublicoConocido {
  /** SHA-256 hex del valor normalizado (ver `normalizarSecreto`). */
  sha256: string
  origen: OrigenValorPublico
  /** Dónde se publicó (descripción; nunca el valor). */
  descripcion: string
  /** Sólo origen 'historial': `<commit>:<ruta>` donde se publicó (las pruebas lo releen con git si el commit está). */
  fuenteGit?: string
}

/**
 * Valores públicos conocidos, SÓLO como SHA-256 del valor normalizado. Los de
 * origen 'repo' se pueden recalcular desde archivos versionados (las pruebas lo
 * hacen: docs/audits/AUDIT_DEVOPS.md los cita y el historial git los conserva); los
 * de origen 'historial', desde `fuenteGit` cuando el clon tiene ese commit.
 * Los 'generico' son de MEJOR ESFUERZO: casi todos miden menos de 32 (el largo ya los
 * rechaza; sirven al script para las otras variables) y la lista no cubre todos los
 * placeholders ≥ 32 de terceros. Frente a esos, la defensa son el largo, la variedad
 * y la repetición; generar el valor con openssl rand -hex 64 es lo que lo garantiza.
 * Agregar aquí Y en scripts/check-public-secrets.sh (la prueba de CI lo exige).
 */
export const VALORES_PUBLICOS_SHA256: readonly ValorPublicoConocido[] = Object.freeze([
  // ── Publicados en este repositorio ──
  { sha256: '81ad539721bdd169e7b2014bb14b4a566b7eb36d5249becd7ca7f8c6f6e0633f', origen: 'repo', descripcion: 'docker-compose.yml: default de JWT_SECRET (hasta este cambio)' },
  { sha256: 'd48b2ecaad4a6cee65f4e797b44062aa51f9fab958ada261342d5b10cab6310e', origen: 'repo', descripcion: '.env.example: placeholder de JWT_SECRET (hasta este cambio)' },
  { sha256: '6f6d5f7844d0760753f77e25a2ce548daf261dca5c85a087ffa0c7652604a892', origen: 'repo', descripcion: '.env.example/setup.sh históricos: placeholder de JWT_SECRET' },
  { sha256: '35e88ff857167e480396bf91314f4c6560c447897e0f760a3b30f1aa2763d040', origen: 'repo', descripcion: '.env.example/setup.sh históricos: placeholder de JWT_REFRESH_SECRET' },
  { sha256: 'f8e08116a2d738c30170416054635fe1a865bb49fdc0a7fbad01a326280ac044', origen: 'repo', descripcion: 'docker-compose.yml histórico: default de POSTGRES_PASSWORD' },
  { sha256: '1a428d83c1cf283ec3f705cede27410fc869ade1f5d88820eddd414a5ac4b6fa', origen: 'repo', descripcion: 'services/credentials.ts: clave legacy por defecto de credenciales NVR' },
  // ── Publicados en el historial git (ya no en archivos vigentes) ──
  { sha256: '156da39eb9b650474b01d9836ea8af3fc0121c6274755840eceb9768ea7c108a', origen: 'historial', fuenteGit: '618ba6c:apps/api/src/plugins/auth.ts', descripcion: 'plugins/auth.ts (618ba6c, 2026-04-29; quitado en a0ef351): fallback de firma de JWT_SECRET cuando faltaba la variable' },
  // ── Placeholders genéricos difundidos (descripción sin el literal) ──
  { sha256: '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: 'fb86fb757d1241d512865070e05ccb5d17dfaa11a4b2ca04b89bacad17530ad4', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: 'e2186dbdb1bb4193608605e84f33208765b5693b55edd4f730a719a100eeea6f', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: 'e88040e7d0052eeb5dcf0fd834e4835ff329b275e6a9889058e8d16c38da9514', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: 'f7d838701b86c5dfb57bf95fbc5ce6df204cfc9f15ad6cdb39fd22f8776e47b6', origen: 'generico', descripcion: 'placeholder del depurador público de JWT (HS256, < 32)' },
  { sha256: '5906f93b26ee80461424a3efe65f89731e50c3228035db85a81439f9ba00a572', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: '048af2438891a89a3536ac09cc96ccbd34a1714e88cf8fdb63e6186dcc3ff89d', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: 'f75778f7425be4db0369d09af37a6c2b9a83dea0e53e7bd57412e4b060e607f7', origen: 'generico', descripcion: 'placeholder genérico corto (< 32: también lo rechaza el largo; útil para el script)' },
  { sha256: '1453cea2dc3799e9026e42b3e465e455256d5a149582e4c5b92d4c8d604731a2', origen: 'generico', descripcion: 'placeholder ≥ 32 de plantillas de terceros (pasaba el chequeo de largo)' },
])

const HASHES_PUBLICOS: ReadonlySet<string> = new Set(VALORES_PUBLICOS_SHA256.map(v => v.sha256))

/**
 * Normalización para comparar: sin espacios ASCII en los extremos y ASCII en
 * minúsculas. Idéntica a la del script (`LC_ALL=C`, `[:space:]`, `tr A-Z a-z`).
 */
export function normalizarSecreto(valor: string): string {
  return valor.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '').replace(/[A-Z]/g, c => c.toLowerCase())
}

/** SHA-256 hex del valor normalizado. */
export function sha256Normalizado(valor: string): string {
  return createHash('sha256').update(normalizarSecreto(valor), 'utf8').digest('hex')
}

/** ¿El valor coincide (por hash) con un valor público conocido? */
export function coincideConValorPublico(valor: string): boolean {
  return HASHES_PUBLICOS.has(sha256Normalizado(valor))
}

/**
 * ¿El valor es la repetición de un bloque de, como mucho, la mitad de su largo?
 * (`changeme…changeme`, `0123456789abcdef0123456789abcdef`). Para un valor
 * aleatorio de n caracteres sobre m símbolos la probabilidad es ≤ 2·m^(−n/2):
 * con 32 dígitos decimales, ≈ 2·10⁻¹⁶.
 */
export function esRepeticionDeBloque(valor: string): boolean {
  const n = valor.length
  for (let p = 1; p <= Math.floor(n / 2); p++) {
    if (valor.slice(p) === valor.slice(0, n - p)) return true
  }
  return false
}

export type MotivoRechazoJwtSecret = 'ausente' | 'corto' | 'publico' | 'poca_variedad' | 'repetitivo'

export interface RechazoJwtSecret {
  motivo: MotivoRechazoJwtSecret
  /** Mensaje para el log/excepción. Nunca contiene el valor. */
  mensaje: string
}

const COMO_GENERAR = 'Generá uno nuevo con: openssl rand -hex 64'
const ROTACION = 'Cambiar JWT_SECRET invalida todas las sesiones (los usuarios vuelven a iniciar sesión).'

/**
 * Evalúa JWT_SECRET. `null` = aceptable. El mensaje describe el motivo sin
 * incluir el valor ni su hash.
 */
export function evaluarJwtSecret(valor: string | undefined): RechazoJwtSecret | null {
  if (valor === undefined || normalizarSecreto(valor) === '') {
    return { motivo: 'ausente', mensaje: `JWT_SECRET no está definido. ${COMO_GENERAR}` }
  }
  if (coincideConValorPublico(valor)) {
    return {
      motivo: 'publico',
      mensaje:
        'JWT_SECRET coincide con un valor público conocido (default o ejemplo publicado en el ' +
        'repositorio, o placeholder difundido): con él cualquiera puede firmar un access válido. ' +
        `${COMO_GENERAR}. ${ROTACION}`,
    }
  }
  if (valor.length < MIN_LARGO_JWT_SECRET) {
    return { motivo: 'corto', mensaje: `JWT_SECRET tiene menos de ${MIN_LARGO_JWT_SECRET} caracteres. ${COMO_GENERAR}` }
  }
  if (new Set(valor).size < MIN_CARACTERES_DISTINTOS) {
    return {
      motivo: 'poca_variedad',
      mensaje: `JWT_SECRET tiene menos de ${MIN_CARACTERES_DISTINTOS} caracteres distintos: no es un secreto aleatorio. ${COMO_GENERAR}`,
    }
  }
  if (esRepeticionDeBloque(valor)) {
    return {
      motivo: 'repetitivo',
      mensaje: `JWT_SECRET es la repetición de un bloque corto: no es un secreto aleatorio. ${COMO_GENERAR}`,
    }
  }
  return null
}

/** Lanza si JWT_SECRET no es aceptable (mensaje sin el valor). */
export function assertJwtSecretAceptable(valor: string | undefined): string {
  const rechazo = evaluarJwtSecret(valor)
  if (rechazo) throw new Error(rechazo.mensaje)
  return valor as string
}
