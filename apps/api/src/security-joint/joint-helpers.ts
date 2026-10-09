// apps/api/src/security-joint/joint-helpers.ts
//
// Utilidades de PRUEBA de la suite conjunta extendida (#187, #191, #192, #193). No
// es una prueba: lo importan los `*.joint.test.ts` nuevos (y playback/defectos para
// la espera de auditoría). harness.ts e infra-doubles.ts quedan congelados; esto
// sólo los usa. Sin vitest (lo compila `tsc`).

import { JOINT_PASSWORD, type JointEnv, type SimBrowser, type JointResponse } from './harness'

// ─── Esperas sin tiempos fijos ────────────────────────────────────────────────

/**
 * Sondea hasta que `done(valor)` o vence el plazo, y DEVUELVE el último valor
 * observado (no lanza): la aserción la hace la prueba, con el valor real en el
 * reporte. Para efectos que el código hace "en segundo plano" a propósito (p. ej.
 * la auditoría VIEW_RECORDING, que recordings.ts no espera): exigir el efecto sin
 * depender de cuánto tarda bajo carga.
 */
export async function settle<T>(
  probe: () => T | Promise<T>, done: (v: T) => boolean, timeoutMs = 10_000, intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (done(v) || Date.now() > deadline) return v
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

/** Filas de auditoría (action, resource) de un usuario, esperando las que se escriben sin await. */
export async function auditRowsEventually(
  env: JointEnv, userId: string, expected: Array<{ action: string; resource: string | null }>, timeoutMs = 10_000,
): Promise<Array<{ action: string; resource: string | null }>> {
  const has = (rows: Array<{ action: string; resource: string | null }>) =>
    expected.every(e => rows.some(r => r.action === e.action && r.resource === e.resource))
  return settle(
    () => env.prisma.auditLog.findMany({ where: { userId }, select: { action: true, resource: true } }),
    has, timeoutMs,
  )
}

// ─── Tokens NO-access emitidos por las rutas reales (#190) ────────────────────

export interface NonAccessTokens {
  tempToken2fa: string
  enrollToken: string
  stepUpToken: string
  refreshToken: string
}

/**
 * tempToken (login con 2FA), enrollToken (política MFA forzosa sólo durante ese
 * login), step-up y refresh del navegador `elevated` (ADMIN ya logueado). Todo
 * por las rutas reales; crea dos usuarios OPERATOR propios con el prefijo dado.
 */
export async function obtainNonAccessTokens(env: JointEnv, elevated: SimBrowser, prefix: string): Promise<NonAccessTokens> {
  const mfa = await env.createMfaUser(`${prefix}_mfa_tok`, 'OPERATOR')
  const l1 = await env.browser(`${prefix}-temp`).login(mfa.username)
  if (l1.status !== 200 || !l1.json().requiresTwoFactor) throw new Error(`tempToken ${prefix}: ${l1.status}`)
  const enrol = await env.createUser(`${prefix}_enrol_tok`, 'OPERATOR', { forceMfaEnrollment: true })
  await env.setSecurity({ mfaRequired: true, mfaGracePeriodLogins: 0 })
  let enrollToken = ''
  try {
    const l2 = await env.browser(`${prefix}-enrol`).login(enrol.username)
    if (!l2.json().requiresMfaEnrollment) throw new Error(`enrollToken ${prefix}: ${l2.status}`)
    enrollToken = l2.json().enrollToken
  } finally {
    await env.setSecurity({ mfaRequired: false })
  }
  const su = await elevated.post('/api/auth/step-up', { password: JOINT_PASSWORD })
  if (su.status !== 200) throw new Error(`step-up ${prefix}: ${su.status}`)
  const refreshToken = elevated.refreshToken
  if (!refreshToken) throw new Error(`refresh ${prefix}: sin cookie`)
  return { tempToken2fa: l1.json().tempToken, enrollToken, stepUpToken: su.json().stepUpToken, refreshToken }
}

export type TokenVia = 'bearer' | 'cookie'

/**
 * Ejecuta `send` con cada token no-access por Bearer y por cookie (navegador limpio
 * del atacante, que manda Origin como un fetch same-origin) y devuelve las que NO
 * respondieron 401, con su descripción.
 */
export async function nonAccessFailures(
  env: JointEnv, tokens: NonAccessTokens,
  send: (b: SimBrowser, headers: Record<string, string> | undefined) => Promise<JointResponse>,
  label: string,
): Promise<string[]> {
  const failures: string[] = []
  for (const [kind, token] of Object.entries(tokens)) {
    for (const via of ['bearer', 'cookie'] as const) {
      const b = env.browser(`atk-${label}-${kind}-${via}`)
      if (via === 'cookie') b.plantCookie('access_token', token)
      const r = await send(b, via === 'bearer' ? { authorization: `Bearer ${token}` } : undefined)
      if (r.status !== 401) failures.push(`${label} ${kind}/${via} ⇒ ${r.status}`)
    }
  }
  return failures
}

// ─── Búsqueda de secretos a cualquier profundidad ─────────────────────────────

/**
 * Rutas JSON (claves y valores, a cualquier profundidad) donde aparece alguno de
 * los `needles` (en claro o url-encoded). Para "no sale X en ninguna forma".
 */
export function findSecrets(value: unknown, needles: Array<string | null | undefined>): string[] {
  const forms = [...new Set(needles.filter((n): n is string => !!n && n.length >= 3)
    .flatMap(n => [n, encodeURIComponent(n)]))]
  const hits: string[] = []
  const visit = (v: unknown, at: string) => {
    if (v === null || v === undefined) return
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v)
      for (const f of forms) if (s.includes(f)) hits.push(`${at} ⊃ «${f}»`)
      return
    }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${at}[${i}]`)); return }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        for (const f of forms) if (k.includes(f)) hits.push(`${at}.{clave ${k}} ⊃ «${f}»`)
        visit(x, `${at}.${k}`)
      }
    }
  }
  visit(value, '$')
  return hits
}

/** Formas en que una IPv4 puede filtrarse: literal y enmascarada `a.b.x.x`. */
export function ipLeakForms(ip: string): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip)
  return m ? [ip, `${m[1]}.${m[2]}.x.x`] : [ip]
}

/** JSON de la respuesta, o el texto si no es JSON (para buscar secretos igual). */
export function bodyOf(r: JointResponse): unknown {
  try { return r.json() } catch { return r.text }
}

// ─── Multipart (como FormData del navegador) ──────────────────────────────────

export interface FilePart { field: string; filename: string; contentType: string; data: Buffer }

export function multipartBody(parts: FilePart[]): { body: Buffer; contentType: string } {
  const boundary = `----VisionCoreJoint${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  for (const p of parts) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.field}"; filename="${p.filename}"\r\n` +
      `Content-Type: ${p.contentType}\r\n\r\n`,
    ))
    chunks.push(p.data, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** PNG real de 1×1 (firma + IHDR + IDAT + IEND válidos). */
export const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64',
)
