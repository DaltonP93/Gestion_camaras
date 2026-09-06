// apps/api/src/services/media/test-host-guard.ts
//
// Guard EJECUTABLE para los harnesses de integración: sólo se permite apuntar a
// destinos DESCARTABLES locales/CI (loopback). No basta con el NOMBRE de la
// variable — un `REDIS_TEST_URL`/`DATABASE_URL_TEST` podría apuntar a un servidor
// remoto o de producción, y los harnesses ejecutan operaciones DESTRUCTIVAS
// (FLUSHDB en Redis; CREATE/DROP SCHEMA CASCADE en Postgres). Este guard FALLA
// ANTES de conectar o escribir si el host no es loopback.

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

/**
 * Exige que `rawUrl` apunte a un destino de test DESCARTABLE local/CI (loopback).
 * Lanza (fail-closed) ante cualquier host no-loopback o URL inválida — ANTES de que
 * el llamador conecte o escriba. `kind` etiqueta el origen para el mensaje.
 */
export function assertDisposableLocalHost(rawUrl: string, kind: string): void {
  const host = hostOf(rawUrl)
  if (host === null) {
    throw new Error(`${kind}: URL de test inválida — rechazada antes de conectar.`)
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `${kind}: destino de test NO local ('${host}'). Los harnesses ejecutan ` +
      `operaciones destructivas (FLUSHDB / DROP SCHEMA CASCADE) y SÓLO admiten ` +
      `destinos descartables locales/CI (loopback: localhost/127.0.0.1/::1). ` +
      `Rechazado ANTES de conectar o escribir.`,
    )
  }
}

/** Para tests del propio guard: hosts loopback aceptados. */
export const LOOPBACK_TEST_HOSTS = LOOPBACK_HOSTS
