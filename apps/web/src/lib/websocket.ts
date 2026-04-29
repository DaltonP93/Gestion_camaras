// src/lib/websocket.ts
import { useAlertStore } from '@/stores/alertStore'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 2000

export function connectWebSocket() {
  const token = localStorage.getItem('accessToken')
  if (!token) return

  const wsBase = import.meta.env.VITE_WS_URL || window.location.origin.replace('http', 'ws')
  const url = `${wsBase}/ws/alerts`

  try {
    ws = new WebSocket(url)

    ws.onopen = () => {
      console.log('[WS] Conectado al servidor de alertas')
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

    ws.onclose = () => {
      console.log('[WS] Desconectado, reconectando en', reconnectDelay, 'ms')
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  } catch (err) {
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
