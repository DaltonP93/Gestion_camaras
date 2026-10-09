// apps/api/src/routes/websocket.ts
import type { FastifyPluginAsync } from 'fastify'
import type { WebSocket } from 'ws'
import { consumeWsTicket } from '../services/ws-ticket'
import { loadCurrentActor } from '../services/current-actor'

// Mapa global de conexiones WebSocket por userId
export const wsClients = new Map<string, Set<WebSocket>>()

// Sesión de cada conexión (la del access que pidió el ticket), para revalidar el
// ACTOR VIGENTE al canjear y en cada ping.
const wsSessions = new WeakMap<WebSocket, { userId: string; sid: string }>()

type WsActorState = 'current' | 'revoked' | 'unavailable'

/** ¿Sigue vigente el actor (usuario activo + sesión viva)? Nunca lanza. */
async function wsActorState(prisma: any, userId: string, sid: string): Promise<WsActorState> {
  try {
    const r = await loadCurrentActor(prisma, { sub: userId, sid })
    return r.ok ? 'current' : 'revoked'
  } catch {
    return 'unavailable'
  }
}

/**
 * Revalida el actor de una conexión registrada: si el usuario ya no está activo o
 * su sesión se cerró (logout en otro proceso, `DELETE /auth/sessions[/:id]`,
 * poda por máximo de sesiones, vencimiento), cierra con 4003. Con la base caída
 * no cierra (no se corta la señalización por un problema transitorio).
 */
async function revalidateWsConnection(prisma: any, ws: WebSocket): Promise<boolean> {
  const id = wsSessions.get(ws)
  if (!id) return true
  if ((await wsActorState(prisma, id.userId, id.sid)) !== 'revoked') return true
  try { ws.close(4003, 'revoked') } catch { /* noop */ }
  // Baja inmediata del mapa (como closeUserConnections): sin esperar el 'close'.
  const set = wsClients.get(id.userId)
  set?.delete(ws)
  if (set?.size === 0) wsClients.delete(id.userId)
  return false
}

/**
 * Revalida TODAS las conexiones de este proceso (lo mismo que hace el ping de cada
 * una cada 30 s). Devuelve cuántas cerró. Expuesta para pruebas y diagnóstico.
 */
export async function revalidateWsConnections(prisma: any): Promise<number> {
  let closed = 0
  for (const clients of [...wsClients.values()]) {
    for (const ws of [...clients]) {
      if (!(await revalidateWsConnection(prisma, ws))) closed++
    }
  }
  return closed
}

export function broadcastAlert(payload: object) {
  const message = JSON.stringify(payload)
  wsClients.forEach((clients) => {
    clients.forEach((ws) => {
      if (ws.readyState === 1) ws.send(message)
    })
  })
}

// Broadcast de alerta CON scope de cámara (RBAC / DEV14).
//
// El WS SÍ lleva identidad por conexión: wsClients está indexado por userId (lo
// estampa el handler tras verificar el JWT). Esto permite filtrar por destinatario.
//
//   - Alerta de SISTEMA/NVR (sin cameraId) ⇒ visible para todos ⇒ broadcast global.
//   - Alerta de una cámara concreta ⇒ sólo se envía a: ADMIN (cualquiera) y a los
//     usuarios con canView sobre esa cámara. Los demás no reciben el mensaje.
//
// Limitación conocida: el filtro se resuelve entre las conexiones VIVAS al momento
// del broadcast; si un permiso cambia mientras hay una conexión abierta, el efecto
// se aplica en el siguiente broadcast (no se cierran conexiones existentes). No hay
// salas/tópicos por cámara en el WS actual; se filtra por userId, que es lo más
// acotado posible sin rediseñar el protocolo. Nunca degrada a broadcast global ante
// una cámara concreta: si la consulta de permisos falla, no se emite a no-admins.
export async function broadcastAlertScoped(
  prisma: any,
  cameraId: string | null | undefined,
  payload: object,
) {
  // Sin cámara → alerta de sistema/NVR, visible para todos.
  if (cameraId == null) {
    broadcastAlert(payload)
    return
  }

  const connectedIds = [...wsClients.keys()]
  if (connectedIds.length === 0) return

  // ADMIN siempre; no-admins sólo con canView sobre esta cámara.
  const [admins, perms] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: connectedIds }, role: 'ADMIN' },
      select: { id: true },
    }),
    prisma.userPermission.findMany({
      where: { userId: { in: connectedIds }, cameraId, canView: true },
      select: { userId: true },
    }),
  ])

  const allowed = new Set<string>()
  for (const a of admins as Array<{ id: string }>) allowed.add(a.id)
  for (const p of perms as Array<{ userId: string }>) allowed.add(p.userId)
  if (allowed.size === 0) return

  const message = JSON.stringify(payload)
  for (const uid of allowed) {
    const clients = wsClients.get(uid)
    if (!clients) continue
    clients.forEach((ws) => {
      if (ws.readyState === 1) ws.send(message)
    })
  }
}

export function broadcastToUser(userId: string, payload: object) {
  const clients = wsClients.get(userId)
  if (!clients) return
  const message = JSON.stringify(payload)
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(message)
  })
}

/**
 * Cierra TODAS las conexiones WebSocket de un usuario EN ESTE PROCESO (revocación
 * de permisos / logout / desactivación). Idempotente: elimina la entrada de
 * wsClients. Código 4003 = "revoked" (el cliente no debe reconectar sin re-login).
 * El cierre cross-proceso lo coordina ws-revoke-bus vía Redis pub/sub.
 * Devuelve cuántos sockets se cerraron (para logs/tests).
 */
export function closeUserConnections(userId: string, code = 4003, reason = 'revoked'): number {
  const clients = wsClients.get(userId)
  if (!clients) return 0
  let n = 0
  clients.forEach((ws) => {
    try { ws.close(code, reason); n++ } catch { /* noop */ }
  })
  wsClients.delete(userId)
  return n
}

/**
 * Cierra (4003) sólo las conexiones de UNA sesión (`sid`) del usuario EN ESTE
 * PROCESO: el logout de un dispositivo no corta el WS de otro dispositivo del mismo
 * usuario cuya sesión sigue viva. El cierre cross-proceso lo coordina ws-revoke-bus.
 * Devuelve cuántos sockets se cerraron.
 */
export function closeSessionConnections(userId: string, sid: string, code = 4003, reason = 'revoked'): number {
  const clients = wsClients.get(userId)
  if (!clients) return 0
  let n = 0
  for (const ws of [...clients]) {
    if (wsSessions.get(ws)?.sid !== sid) continue
    try { ws.close(code, reason); n++ } catch { /* noop */ }
    clients.delete(ws)
  }
  if (clients.size === 0) wsClients.delete(userId)
  return n
}

export const wsHandler: FastifyPluginAsync = async (server) => {
  server.get('/alerts', {
    websocket: true,
  }, async (socket: WebSocket, request) => {
    const ws = socket

    // Autenticación por TICKET de un solo uso (no por JWT en la URL): el cliente
    // obtiene el ticket vía POST /api/auth/ws-ticket (Bearer) y lo canjea aquí.
    // El JWT nunca viaja en la URL del WebSocket (invariante #6: nada sensible en
    // logs/URL). El ticket se consume atómicamente (getdel) ⇒ un solo uso.
    const { ticket } = request.query as { ticket?: string }

    const identity = await consumeWsTicket(server.redis, ticket)
    if (!identity || !identity.sid) {
      // Sin ticket válido, o ticket sin sesión (emitido antes de ligar el WS a la sesión).
      ws.close(4001, 'Unauthorized')
      return
    }
    const userId = identity.userId
    const sid = identity.sid

    // ACTOR VIGENTE al canjear (CHW-07): el ticket pudo emitirse antes de desactivar
    // al usuario o de cerrar su sesión. Se verifica ANTES de registrar la conexión
    // (no recibe nada sin validar) y otra vez DESPUÉS: una revocación confirmada entre
    // ambos pasos ya no encuentra la conexión en wsClients para cerrarla.
    const before = await wsActorState(server.prisma, userId, sid)
    if (before !== 'current') {
      ws.close(before === 'revoked' ? 4003 : 1011, before === 'revoked' ? 'revoked' : 'unavailable')
      return
    }

    if (!wsClients.has(userId)) {
      wsClients.set(userId, new Set())
    }
    wsClients.get(userId)!.add(ws)
    wsSessions.set(ws, { userId, sid })
    // Revocada entre ambos pasos, o el cliente cerró durante las esperas (el
    // listener de 'close' todavía no está puesto): desregistrar y salir.
    if (!(await revalidateWsConnection(server.prisma, ws)) || ws.readyState !== 1) {
      const set = wsClients.get(userId)
      set?.delete(ws)
      if (set?.size === 0) wsClients.delete(userId)
      return
    }

    server.log.info(`WS conectado: usuario ${identity.username}`)

    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }))
        // Revocaciones por sesión que no pasan por revokeUserWs (cierre de una
        // sesión propia, poda, vencimiento): se cortan en el siguiente ping.
        void revalidateWsConnection(server.prisma, ws)
      }
    }, 30000)

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'pong') return
        if (msg.type === 'subscribe' && msg.cameras) {
          ws.send(JSON.stringify({ type: 'subscribed', cameras: msg.cameras }))
        }
      } catch {
        // Ignorar mensajes mal formados
      }
    })

    ws.on('close', () => {
      clearInterval(pingInterval)
      wsClients.get(userId)?.delete(ws)
      if (wsClients.get(userId)?.size === 0) {
        wsClients.delete(userId)
      }
      server.log.info(`WS desconectado: usuario ${identity.username}`)
    })

    ws.on('error', (err: Error) => {
      server.log.error(`WS error: ${err.message}`)
    })
  })
}
