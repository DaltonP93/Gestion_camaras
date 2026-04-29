// apps/api/src/routes/websocket.ts
import type { FastifyPluginAsync } from 'fastify'
import type { WebSocket } from 'ws'

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

export function broadcastToUser(userId: string, payload: object) {
  const clients = wsClients.get(userId)
  if (!clients) return
  const message = JSON.stringify(payload)
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(message)
  })
}

export const wsHandler: FastifyPluginAsync = async (server) => {
  server.get('/alerts', {
    websocket: true,
    preHandler: [server.authenticate],
  }, (connection, request) => {
    const userId = request.user.sub
    const ws = connection.socket

    // Registrar cliente
    if (!wsClients.has(userId)) {
      wsClients.set(userId, new Set())
    }
    wsClients.get(userId)!.add(ws)

    server.log.info(`WS conectado: usuario ${request.user.username}`)

    // Enviar ping cada 30s para mantener conexión
    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }))
      }
    }, 30000)

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'pong') return

        // Suscribir a updates de cámaras específicas
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
      server.log.info(`WS desconectado: usuario ${request.user.username}`)
    })

    ws.on('error', (err) => {
      server.log.error(`WS error: ${err.message}`)
    })
  })
}
