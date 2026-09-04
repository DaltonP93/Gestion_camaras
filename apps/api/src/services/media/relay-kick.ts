// apps/api/src/services/media/relay-kick.ts
//
// A1 · F0 — revoke→kick (SÓLO detrás de NATIVE_MEDIA_RELAY_ENABLED; inerte OFF).
//
// Una conexión de medios es LARGA: revocar un grant (logout / cambio de permiso /
// cierre de vista / de sesión) no basta con negar futuras validaciones — hay que
// CORTAR la conexión activa en MediaMTX (kick del reader por su `id`). Este módulo
// es la parte PURA y determinista de ese cableado: dada una revocación y los
// bindings conexión↔grant vivos, calcula QUÉ connectionIds hay que expulsar. El
// I/O real (llamar a la API de runtime de MediaMTX) queda tras `MediaMtxKicker`,
// una interfaz inyectable que NO se ejercita en F0 (no hay MediaMTX vivo).
//
// No contiene secretos, credenciales ni URIs.

import type { ConnectionBinding } from './contracts'

/** Evento de revocación que dispara un kick. */
export type RevokeKickEvent =
  // Logout / cambio de permisos ⇒ bump de epoch del usuario: cae TODO lo suyo.
  | { kind: 'user'; userId: string }
  // Revocación por vista o por sesión ⇒ se conocen los grantIds afectados.
  | { kind: 'grants'; grantIds: string[] }

/**
 * PURA: dado el evento y los bindings vivos, devuelve los connectionIds a expulsar
 * (sin duplicados, orden estable de primera aparición).
 */
export function connectionsToKick(event: RevokeKickEvent, bindings: ConnectionBinding[]): string[] {
  const match = event.kind === 'user'
    ? (b: ConnectionBinding) => b.userId === event.userId
    : ((): (b: ConnectionBinding) => boolean => { const set = new Set(event.grantIds); return (b) => set.has(b.grantId) })()
  const seen = new Set<string>()
  const out: string[] = []
  for (const b of bindings) {
    if (match(b) && !seen.has(b.connectionId)) { seen.add(b.connectionId); out.push(b.connectionId) }
  }
  return out
}

/** I/O real de expulsión (API de runtime de MediaMTX). Inyectable; NO ejercitado en F0. */
export interface MediaMtxKicker {
  kick(connectionId: string): Promise<void>
}

/** Kicker inerte por defecto (F0 y flag OFF): no hay MediaMTX vivo que expulsar. */
export const noopKicker: MediaMtxKicker = { async kick() { /* no-op */ } }

/**
 * Expulsa best-effort cada connectionId; un fallo individual no aborta el resto.
 * Devuelve cuántas expulsiones se intentaron con éxito.
 */
export async function performKick(kicker: MediaMtxKicker, connectionIds: string[]): Promise<number> {
  let ok = 0
  for (const id of connectionIds) {
    try { await kicker.kick(id); ok++ } catch { /* best-effort: el TTL corto y la negación de re-validación cierran igual */ }
  }
  return ok
}
