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
 * Desenlace del cierre TAL COMO LO DECLARA EL SERVIDOR.
 *
 * `emitted` sólo dice que la petición salió. Es lo único que se sabía antes, y
 * tratarlo como confirmación era un error: un 401, un 500 o un `ignored` del
 * backend salen igual de "emitidos", y el cliente borraba su anotación local de
 * una sesión que seguía viva. `outcome` es lo que de verdad pasó.
 */
export type CloseOutcome = 'ignored' | 'attempt_released' | 'session_closed'

export interface CloseResult {
  /** La petición se pudo emitir (hubo token y `fetch` no lanzó). */
  emitted: boolean
  /** Código HTTP, si llegó respuesta. */
  status?: number
  /** Desenlace declarado por el servidor. `undefined` = no se pudo leer. */
  outcome?: CloseOutcome
  /**
   * Por qué se ignoró. Distingue "no había nada que cerrar" —y entonces no hay
   * nada que reintentar— de "el servidor lo rechazó", que sí exige reintento.
   */
  reason?: string
  /** Arrendamiento que el servidor dice haber procesado. */
  attemptId?: string
  /** Arrendamientos que siguen sosteniendo la sesión. */
  remainingAttempts?: number
  /** Si además se terminó el FFmpeg (sólo `true` si la instancia murió de verdad). */
  killedFfmpeg?: boolean
  /** Token de retención del proceso conservado, para escalarlo (matarlo) después. */
  retentionToken?: string
}

/**
 * `fetch` con `keepalive` que nunca lanza: un cierre no puede romper el
 * desmontaje de un componente ni el handler de `pagehide`.
 *
 * NO interpreta el resultado. Devuelve lo que el servidor declaró cuando se
 * pudo leer, y nada cuando no —descarga de la página, red caída, cuerpo
 * ilegible—. Quien decide qué hacer con eso es el llamador: para un cierre
 * deliberado alcanza con haberlo emitido; para un descarte por respuesta tardía
 * hace falta la confirmación explícita.
 */
export async function closeWithKeepalive(
  path: string,
  body?: Record<string, unknown>,
): Promise<CloseResult> {
  const token = readAccessToken()
  if (!token) return { emitted: false }
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (body) headers['Content-Type'] = 'application/json'
    const res = await fetch(`${BASE_URL}/api${path}`, {
      method: 'DELETE',
      keepalive: true,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    // 401, 403, 5xx: la petición salió, pero NO hubo cierre. Se informa el
    // estado y ningún desenlace, que es lo que impide darlo por confirmado.
    if (!res.ok) return { emitted: true, status: res.status }
    try {
      const body: any = await res.json()
      const outcome: CloseOutcome | undefined =
        body?.outcome === 'ignored' || body?.outcome === 'attempt_released' ||
        body?.outcome === 'session_closed' ? body.outcome : undefined
      return {
        emitted: true, status: res.status, outcome,
        reason: typeof body?.reason === 'string' ? body.reason : undefined,
        attemptId: typeof body?.attemptId === 'string' ? body.attemptId : undefined,
        remainingAttempts: typeof body?.remainingAttempts === 'number' ? body.remainingAttempts : undefined,
        killedFfmpeg: typeof body?.killedFfmpeg === 'boolean' ? body.killedFfmpeg : undefined,
        retentionToken: typeof body?.retentionToken === 'string' ? body.retentionToken : undefined,
      }
    } catch {
      // Cuerpo ilegible (la página se está descargando, respuesta vacía…).
      // Emitido, sin confirmación.
      return { emitted: true, status: res.status }
    }
  } catch {
    // Sin reintento: si falló durante la descarga, el TTL del servidor cierra.
    return { emitted: false }
  }
}

export type StreamKind = 'sub' | 'main' | 'main_h264'

/**
 * Cierra UNA sesión de cámara. Idempotente del lado del servidor.
 *
 * `viewId` identifica la PESTAÑA dueña y es OBLIGATORIO: sin él el backend sólo
 * puede resolver la pertenencia cuando es inequívoca, y con dos pestañas del
 * mismo usuario sobre la misma cámara ignora el cierre en vez de adivinar —
 * dejando sesiones obsoletas consumiendo cupo hasta el TTL. Se exige en la
 * firma para que ningún llamador pueda volver a omitirlo (revisión de #147).
 */
export function closeStreamSession(
  cameraId: string,
  streamType: StreamKind,
  reason: string,
  viewId: string,
  /**
   * Intento de arranque que creó la sesión que se quiere cerrar. Obligatorio en
   * la práctica para `reason=stale_response`: sin él el backend rechaza el
   * cierre, porque una respuesta tardía no puede pedir que se borre "la sesión
   * que haya" en esa ranura — puede ser la de otra solicitud vigente.
   */
  expectedStartAttemptId?: string,
  /**
   * Token de retención de un cierre conservador previo: acompaña a un cierre
   * TERMINANTE para escalar (matar) el FFmpeg huérfano de esa identidad exacta.
   */
  retentionToken?: string,
): Promise<CloseResult> {
  const qs = new URLSearchParams({ streamType, reason })
  if (viewId) qs.set('viewId', viewId)
  if (expectedStartAttemptId) qs.set('expectedStartAttemptId', expectedStartAttemptId)
  // El token es una capability: nunca va en la URL (access logs/historial).
  // Un cuerpo JSON pequeño es compatible con fetch keepalive.
  return closeWithKeepalive(
    `/cameras/${encodeURIComponent(cameraId)}/stream?${qs}`,
    retentionToken ? { retentionToken } : undefined,
  )
}

/** Cierra TODAS las sesiones de un view (pestaña). Idempotente. */
export function closeViewSessions(viewId: string): Promise<CloseResult> {
  const qs = new URLSearchParams({ viewId })
  return closeWithKeepalive(`/cameras/my-sessions?${qs}`)
}
