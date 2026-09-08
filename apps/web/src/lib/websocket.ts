// src/lib/websocket.ts
import { useAlertStore } from '@/stores/alertStore'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 2000

export async function connectWebSocket() {
  const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')
  if (!token) return

  // Autenticación por TICKET: el JWT ya NO viaja en la URL del WebSocket (quedaba
  // en logs/historial/Referer). Se pide un ticket efímero de un solo uso al backend
  // (con el Bearer en el header) y se abre el WS con ese ticket opaco.
  let ticket: string
  try {
    const res = await fetch(`${window.location.origin}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    // 401 = sesión inválida/expirada: no reconectar en bucle (se reconectará tras
    // el próximo login/refresh). Otro error: reintentar con backoff.
    if (!res.ok) {
      if (res.status !== 401) scheduleReconnect()
      return
    }
    ticket = (await res.json())?.ticket
    if (!ticket) { scheduleReconnect(); return }
  } catch {
    scheduleReconnect()
    return
  }

  const wsBase = window.location.origin.replace(/^http/, 'ws')
  const url = `${wsBase}/ws/alerts?ticket=${encodeURIComponent(ticket)}`

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
        // Resolución empujada por el servidor (p.ej. cámara recuperó señal):
        // baja el contador de la campana en vivo, sin recargar.
        if (msg.type === 'alert_resolved' && msg.alertId) {
          useAlertStore.getState().resolveById(msg.alertId)
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
