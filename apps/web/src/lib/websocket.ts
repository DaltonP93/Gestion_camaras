// src/lib/websocket.ts
import { useAlertStore } from '@/stores/alertStore'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 2000

export function connectWebSocket() {
  const wsBase = window.location.origin.replace(/^http/, 'ws')
  // La cookie httpOnly 'at' se envía automáticamente en el upgrade WS (mismo origen)
  const url = `${wsBase}/ws/alerts`

  try {
    ws = new WebSocket(url)

    ws.onopen = () => {
      reconnectDelay = 2000
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'ping') {
          ws?.send(JSON.stringify({ type: 'pong' }))
          return
        }
        if (msg.type === 'alert' && msg.alert) {
          useAlertStore.getState().addAlert(msg.alert)
        }
      } catch {
        // Ignorar mensajes mal formados
      }
    }

    ws.onclose = (event) => {
      // 4001 = unauthorized — no reconectar
      if (event.code === 4001) return
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  } catch {
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
    connectWebSocket()
  }, reconnectDelay)
}

export function disconnectWebSocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  ws?.close()
  ws = null
}
