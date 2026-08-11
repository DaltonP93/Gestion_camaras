// src/lib/sessionClose.ts
//
// Cierre de sesiones de streaming que SOBREVIVE a la descarga de la página.
//
// EL PROBLEMA: al cerrar la pestaña, navegar fuera o desmontar la vista, el
// navegador aborta las peticiones XHR/fetch pendientes. El cierre disparado en
// `pagehide` o en el cleanup de React se perdía, y la sesión quedaba viva en el
// servidor hasta vencer el TTL. Mientras tanto contaba como demanda real para
// el monitor de pipeline.
//
// POR QUÉ NO `navigator.sendBeacon`: sendBeacon no permite fijar encabezados,
// así que no puede enviar `Authorization: Bearer …`. Las alternativas serían
// poner el token en la URL (queda en logs de nginx y en el historial) o montar
// una cookie ad-hoc: ambas empeoran la seguridad para resolver un problema que
// `fetch(..., { keepalive: true })` resuelve sin ceder nada.
//
// El TTL del servidor sigue siendo la GARANTÍA FINAL: esto es una optimización
// para liberar antes, nunca la única vía de cierre.

const BASE_URL = import.meta.env.VITE_API_URL || ''

/** Mismo origen del token que usa el interceptor de axios. */
function readAccessToken(): string | null {
  try {
    return localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')
  } catch {
    return null   // storage bloqueado (modo privado estricto)
  }
}

/**
 * `fetch` con `keepalive` que nunca lanza: un cierre no puede romper el
 * desmontaje de un componente ni el handler de `pagehide`.
 *
 * Devuelve true si la petición se pudo emitir. No espera la respuesta cuando la
 * página se está descargando — el servidor la procesa igual.
 */
export async function closeWithKeepalive(path: string): Promise<boolean> {
  const token = readAccessToken()
  if (!token) return false
  try {
    await fetch(`${BASE_URL}/api${path}`, {
      method: 'DELETE',
      keepalive: true,
      headers: { Authorization: `Bearer ${token}` },
    })
    return true
  } catch {
    // Sin reintento: si falló durante la descarga, el TTL del servidor cierra.
    return false
  }
}

export type StreamKind = 'sub' | 'main' | 'main_h264'

/** Cierra UNA sesión de cámara. Idempotente del lado del servidor. */
export function closeStreamSession(
  cameraId: string,
  streamType: StreamKind,
  reason: string,
): Promise<boolean> {
  const qs = new URLSearchParams({ streamType, reason })
  return closeWithKeepalive(`/cameras/${encodeURIComponent(cameraId)}/stream?${qs}`)
}

/** Cierra TODAS las sesiones de un view (pestaña). Idempotente. */
export function closeViewSessions(viewId: string): Promise<boolean> {
  const qs = new URLSearchParams({ viewId })
  return closeWithKeepalive(`/cameras/my-sessions?${qs}`)
}
