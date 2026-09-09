// src/lib/websocket.ts
import { useAlertStore } from '@/stores/alertStore'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 2000
// Evita conexiones concurrentes: connectWebSocket es async y se invoca desde varios
// lugares (login/2FA/enroll/loadUser + reconexión). Sin guarda, dos invocaciones
// solapadas pedirían dos tickets y abrirían dos sockets, dejando uno huérfano.
let connecting = false

export async function connectWebSocket() {
  if (connecting) return
  // Ya hay un socket vivo o en curso ⇒ no abrir otro.
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return

  // Autenticación por TICKET: el JWT ya NO viaja en la URL del WebSocket (quedaba
  // en logs/historial/Referer). Se pide un ticket efímero de un solo uso al backend
  // (autenticado por la cookie HttpOnly, vía credentials:'include') y se abre el WS
  // con ese ticket opaco. Sin token en JS: si no hay sesión, el POST responde 401.
  connecting = true
  let ticket: string
  try {
    const res = await fetch(`${window.location.origin}/api/auth/ws-ticket`, {
      method: 'POST',
      credentials: 'include',
    })
    // 401 = sesión inválida/expirada: no reconectar en bucle (se reconectará tras
    // el próximo login/refresh). Otro error: reintentar con backoff.
    if (!res.ok) {
      connecting = false
      if (res.status !== 401) scheduleReconnect()
      return
    }
    ticket = (await res.json())?.ticket
    if (!ticket) { connecting = false; scheduleReconnect(); return }
  } catch {
    connecting = false
    scheduleReconnect()
    return
  }

  const wsBase = window.location.origin.replace(/^http/, 'ws')
  const url = `${wsBase}/ws/alerts?ticket=${encodeURIComponent(ticket)}`

  // Cerrar cualquier socket previo no-vivo antes de reasignar (evita huérfanos).
  if (ws) { try { ws.close() } catch { /* noop */ } ws = null }

  try {
    ws = new WebSocket(url)
    connecting = false

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
      // 4001 = unauthorized · 4003 = revocado (permisos/logout/desactivación):
      // no reconectar — el reintento sólo re-crearía el socket hasta que expire el
      // JWT. La reconexión legítima ocurre tras un nuevo login/refresh.
      if (event.code === 4001 || event.code === 4003) return
      scheduleReconnect()
    }

    ws.onerror = () => {
      ws?.close()
    }
  } catch {
    connecting = false
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
  connecting = false
  ws?.close()
  ws = null
}
