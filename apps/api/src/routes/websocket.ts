// apps/api/src/routes/websocket.ts
import type { FastifyPluginAsync } from 'fastify'
import type { WebSocket } from 'ws'
import { consumeWsTicket } from '../services/ws-ticket'

// Mapa global de conexiones WebSocket por userId
export const wsClients = new Map<string, Set<WebSocket>>()

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
    if (!identity) {
      ws.close(4001, 'Unauthorized')
      return
    }

    const userId = identity.userId

    if (!wsClients.has(userId)) {
      wsClients.set(userId, new Set())
    }
    wsClients.get(userId)!.add(ws)

    server.log.info(`WS conectado: usuario ${identity.username}`)

    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }))
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
