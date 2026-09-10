// apps/api/src/services/media/test-host-guard.ts
//
// Guard EJECUTABLE para los harnesses de integración. Los harnesses ejecutan
// operaciones DESTRUCTIVAS (FLUSHDB en Redis; CREATE/DROP SCHEMA CASCADE en
// Postgres), así que NO basta con el NOMBRE de la variable NI con que el host sea
// loopback: `localhost` puede ser una instancia normal o un túnel a producción.
//
// Se exigen DOS condiciones, y se FALLA (fail-closed) ANTES de conectar/escribir:
//   1. host loopback (localhost / 127.0.0.1 / ::1), y
//   2. una SEÑAL EXPLÍCITA de que ese destino es efímero/descartable autorizado
//      (una env dedicada = '1'). En CI se setea junto al `services:`; en dev el
//      harness que levanta su PROPIA instancia por corrida no necesita señal.
//
// Los mensajes de error NUNCA incluyen el host, IP ni credenciales (invariante #6).

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** Extrae el hostname de una URL de conexión (redis:// o postgresql://). */
function hostOf(rawUrl: string): string | null {
  try {
    const h = new URL(rawUrl).hostname.trim().toLowerCase()
    return h.replace(/^\[/, '').replace(/\]$/, '') // desbracketea IPv6
  } catch {
    return null
  }
}

/** ¿El destino es loopback? (sin exponer el host). */
export function isLoopbackUrl(rawUrl: string): boolean {
  const h = hostOf(rawUrl)
  return h !== null && LOOPBACK_HOSTS.has(h)
}

/**
 * Exige que `rawUrl` sea loopback. Lanza (fail-closed) ante host no-loopback o URL
 * inválida — ANTES de conectar/escribir. El mensaje NO incluye el host.
 */
export function assertDisposableLocalHost(rawUrl: string, kind: string): void {
  const host = hostOf(rawUrl)
  if (host === null) {
    throw new Error(`${kind}: URL de test inválida — rechazada antes de conectar.`)
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `${kind}: destino de test NO loopback. Los harnesses ejecutan operaciones ` +
      `destructivas y sólo admiten loopback (localhost/127.0.0.1/::1). Rechazado ` +
      `ANTES de conectar o escribir. (host omitido del mensaje por invariante #6)`,
    )
  }
}

/**
 * Autorización COMPLETA para una operación DESTRUCTIVA sobre un destino de test:
 * loopback (assertDisposableLocalHost) + señal explícita `<disposableEnvVar>=1`.
 * Sin la señal explícita se NIEGA: loopback por sí solo no prueba que la instancia
 * sea descartable (podría ser real o un túnel). El mensaje no incluye el host.
 */
export function assertDestructiveTestAllowed(rawUrl: string, kind: string, disposableEnvVar: string): void {
  assertDisposableLocalHost(rawUrl, kind)
  if (process.env[disposableEnvVar] !== '1') {
    throw new Error(
      `${kind}: operación destructiva (FLUSHDB / DROP SCHEMA) NO autorizada. ` +
      `Loopback por sí solo no prueba que el destino sea descartable. Definí ` +
      `${disposableEnvVar}=1 SÓLO si apunta a una instancia efímera/desechable.`,
    )
  }
}

/** Para tests del propio guard: hosts loopback aceptados. */
export const LOOPBACK_TEST_HOSTS = LOOPBACK_HOSTS
