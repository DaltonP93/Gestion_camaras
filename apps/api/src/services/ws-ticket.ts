// apps/api/src/services/ws-ticket.ts
//
// Ticket efímero de un solo uso para autenticar el WebSocket SIN poner el JWT en
// la URL. El navegador no puede fijar headers en el handshake de WebSocket, así
// que el patrón seguro es: un endpoint autenticado (Bearer JWT) emite un ticket
// opaco de vida corta; el cliente abre el WS con `?ticket=<opaco>`; el servidor
// lo canjea (get+del atómico) una sola vez. El JWT (credencial reutilizable y de
// larga vida) NUNCA aparece en la URL, ni en logs, historial o cabecera Referer.
//
// El ticket es de bajo valor: aleatorio (no adivinable), TTL de segundos y de un
// solo uso, así que aunque quede registrado en un log ya no sirve tras el connect.

import crypto from 'node:crypto'

// Cliente Redis mínimo requerido (subconjunto de ioredis).
export interface WsTicketRedis {
  set(key: string, val: string, mode: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown>
  // ioredis expone getdel; si faltara, se emula con get+del (no atómico).
  getdel?(key: string): Promise<string | null>
  get(key: string): Promise<string | null>
  del(key: string): Promise<number>
}

export interface WsTicketIdentity {
  userId: string
  username: string
}

const PREFIX = 'ws:ticket:'
export const WS_TICKET_TTL_MS = 30_000
// Formato del ticket: `wst_` + 64 hex (32 bytes). Se valida antes de tocar Redis.
const TICKET_RE = /^wst_[0-9a-f]{64}$/

/** Emite un ticket de un solo uso para el usuario dado. Devuelve el ticket opaco. */
export async function issueWsTicket(redis: WsTicketRedis, id: WsTicketIdentity): Promise<string> {
  const value = JSON.stringify({ u: id.userId, n: id.username })
  // NX evita pisar un ticket homónimo. Ante una colisión (probabilidad ~2⁻¹²⁸, es
  // decir nunca en la práctica) SET NX devuelve null y NO se almacena: en ese caso
  // se regenera en vez de devolver un ticket muerto o de otra identidad. Se acota a
  // pocos intentos para no colgar ante un Redis que niegue toda escritura.
  for (let attempt = 0; attempt < 3; attempt++) {
    const ticket = `wst_${crypto.randomBytes(32).toString('hex')}`
    const stored = await redis.set(PREFIX + ticket, value, 'PX', WS_TICKET_TTL_MS, 'NX')
    if (stored) return ticket
  }
  throw new Error('no se pudo emitir el ticket de WebSocket')
}

/**
 * Canjea el ticket (un solo uso). Devuelve la identidad o null si el ticket es
 * inválido/expirado/ya usado. Fail-closed: cualquier error o formato inválido ⇒ null.
 */
export async function consumeWsTicket(redis: WsTicketRedis, ticket: unknown): Promise<WsTicketIdentity | null> {
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null
  const key = PREFIX + ticket
  let raw: string | null = null
  try {
    // getdel = lectura + borrado atómicos ⇒ un solo uso real aun con carreras.
    if (typeof redis.getdel === 'function') {
      raw = await redis.getdel(key)
    } else {
      raw = await redis.get(key)
      if (raw != null) await redis.del(key)
    }
  } catch {
    return null
  }
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw) as { u?: unknown; n?: unknown }
    if (typeof parsed.u !== 'string' || !parsed.u) return null
    return { userId: parsed.u, username: typeof parsed.n === 'string' ? parsed.n : '' }
  } catch {
    return null
  }
}
