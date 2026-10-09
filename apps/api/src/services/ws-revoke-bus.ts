// apps/api/src/services/ws-revoke-bus.ts
//
// Cierre de WebSockets cross-worker al revocar (P3). wsClients es un mapa POR PROCESO,
// así que revocar permisos / cerrar sesión / desactivar a un usuario sólo cerraba sus
// WS en el proceso que atendió la petición. Con varias instancias/procesos, las
// conexiones vivas en OTROS procesos seguían recibiendo mensajes.
//
// Solución: un canal Redis pub/sub. Al revocar se publica el userId; cada proceso
// (incluido el que publica) está suscripto y cierra las conexiones de ese usuario.
// Además se cierra LOCALMENTE de inmediato, para que el corte no dependa de Redis
// (en el despliegue mono-proceso actual funciona aunque Redis esté caído).
//
// Best-effort: publicar nunca lanza (la parte durable de la revocación es el plano
// de media-grants; esto es el cierre de la señalización de alertas por WS).

import type { FastifyInstance } from 'fastify'
import { closeUserConnections, closeSessionConnections } from '../routes/websocket'

export const WS_REVOKE_CHANNEL = 'ws:revoke'
// Cierre de los WS de UNA sesión (logout de un dispositivo). Canal aparte, con
// mensaje JSON {u, s}: un proceso con la versión anterior no lo escucha (no cierra
// de más); sus conexiones de esa sesión las corta igual el ping de este cambio.
export const WS_REVOKE_SESSION_CHANNEL = 'ws:revoke:session'

/** Cliente Redis mínimo para pub/sub (subconjunto de ioredis). */
interface PubRedis { publish(channel: string, message: string): Promise<unknown> }

/**
 * Revoca los WS de un usuario: cierre LOCAL inmediato + publicación para el resto
 * de procesos. Nunca lanza. Devuelve cuántos se cerraron localmente.
 */
export async function revokeUserWs(server: FastifyInstance, userId: string): Promise<number> {
  const localClosed = closeUserConnections(userId)
  try {
    const redis = (server as any).redis as PubRedis | undefined
    if (redis) await redis.publish(WS_REVOKE_CHANNEL, userId)
  } catch (err: any) {
    server.log.warn(`[ws-revoke] publish falló (cierre local ya aplicado): ${err?.code || err?.message || 'unknown'}`)
  }
  return localClosed
}

/**
 * Revoca los WS de UNA sesión (`sid`) del usuario: cierre LOCAL inmediato +
 * publicación para el resto de procesos. Los WS de sus otras sesiones siguen.
 * Nunca lanza. Devuelve cuántos se cerraron localmente.
 */
export async function revokeSessionWs(server: FastifyInstance, userId: string, sid: string): Promise<number> {
  const localClosed = closeSessionConnections(userId, sid)
  try {
    const redis = (server as any).redis as PubRedis | undefined
    if (redis) await redis.publish(WS_REVOKE_SESSION_CHANNEL, JSON.stringify({ u: userId, s: sid }))
  } catch (err: any) {
    server.log.warn(`[ws-revoke] publish falló (cierre local ya aplicado): ${err?.code || err?.message || 'unknown'}`)
  }
  return localClosed
}

/**
 * Arranca el suscriptor del canal de revocación. Usa una conexión DEDICADA
 * (Redis exige un cliente aparte para SUBSCRIBE). Al recibir un userId, cierra sus
 * conexiones en ESTE proceso. Devuelve el suscriptor (o null si no hay Redis) para
 * poder cerrarlo en el shutdown. Nunca lanza.
 */
export function startWsRevokeSubscriber(server: FastifyInstance): { quit: () => void } | null {
  const base = (server as any).redis
  if (!base || typeof base.duplicate !== 'function') {
    server.log.warn('[ws-revoke] sin Redis: el cierre de WS por revocación será SOLO local (mono-proceso)')
    return null
  }
  const sub = base.duplicate()
  sub.on('error', (err: any) => {
    server.log.warn(`[ws-revoke] subscriber redis error: ${err?.code || err?.message || 'unknown'}`)
  })
  sub.on('message', (channel: string, message: string) => {
    if (!message) return
    if (channel === WS_REVOKE_SESSION_CHANNEL) {
      let id: { u?: unknown; s?: unknown } | null = null
      try { id = JSON.parse(message) } catch { /* mensaje malformado: se ignora */ }
      if (typeof id?.u !== 'string' || typeof id?.s !== 'string') return
      const n = closeSessionConnections(id.u, id.s)
      if (n > 0) server.log.info(`[ws-revoke] cerrado(s) ${n} WS de una sesión de ${id.u.slice(0, 8)} por revocación`)
      return
    }
    if (channel !== WS_REVOKE_CHANNEL) return
    const n = closeUserConnections(message)
    if (n > 0) server.log.info(`[ws-revoke] cerrado(s) ${n} WS de ${message.slice(0, 8)} por revocación`)
  })
  for (const channel of [WS_REVOKE_CHANNEL, WS_REVOKE_SESSION_CHANNEL]) {
    sub.subscribe(channel).catch((err: any) => {
      server.log.warn(`[ws-revoke] subscribe falló: ${err?.code || err?.message || 'unknown'}`)
    })
  }
  server.addHook('onClose', async () => { try { await sub.quit() } catch { /* noop */ } })
  return sub
}
