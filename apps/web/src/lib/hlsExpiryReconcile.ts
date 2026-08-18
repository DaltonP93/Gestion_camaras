// Reconciliación de sesiones HLS expiradas (401 de MediaMTX), como función pura.
//
// POR QUÉ EXISTE
//
// Esta ruta era la grieta que quedó abierta en #156: hablaba con la API por su
// cuenta —sin señal de cancelación, sin releer la visibilidad después del
// `await`— y su `catch` programaba un `loadStream` con `setTimeout` aunque la
// pestaña ya estuviera oculta. La garantía "todo heartbeat se cancela al
// ocultarse" no era cierta mientras esta función existiera aparte.
//
// Ahora no habla con la API: recibe `runHeartbeat`, que es la operación
// cancelable del programador. Así el cerrojo de "uno a la vez", la guarda de
// visibilidad y la señal de aborto son exactamente los mismos que usan el
// latido periódico y el de regreso — no hay una segunda copia que se
// desincronice.
//
// Al estar toda la decisión acá, con dependencias inyectadas, cada desenlace se
// prueba sin DOM ni relojes reales.

import type { HeartbeatOutcome } from './heartbeatScheduler'

/** Ventana mínima entre reinicios de la MISMA cámara. */
export const RESTART_COOLDOWN_MS = 30_000

export interface HlsExpiryDeps<T> {
  isHidden: () => boolean
  now: () => number
  /** Marcas de último reinicio por cámara. Se MUTA: es el estado del llamador. */
  lastRestartAt: Record<string, number>
  restartCooldownMs?: number
  /** Operación cancelable del programador. Nunca lanza. */
  runHeartbeat: () => Promise<HeartbeatOutcome<T>>
  /**
   * Efectos, todos inyectados para poder observarlos en las pruebas.
   *
   * `applyHeartbeat` ya NO está acá: lo aplica el programador, una sola vez por
   * solicitud, porque dos rutas pueden compartir la misma respuesta.
   */
  bumpPlayerKeys: (ids: string[]) => void
  clearLoading: (ids: string[]) => void
  /** Fallback por cámara cuando la reconciliación falla estando visible. */
  scheduleReload: (ids: string[]) => void
  startedIdsOf: (result: T) => string[]
  isAuthError: (error: unknown) => boolean
}

export type HlsExpiryOutcome =
  /** No había nada encolado. */
  | { status: 'empty' }
  /**
   * Pestaña oculta: cero efectos, cero red. Las cámaras se devuelven para que
   * el llamador las conserve hasta el regreso.
   */
  | { status: 'hidden'; pending: string[] }
  /** Todas las cámaras estaban en su ventana de enfriamiento: sólo remontes. */
  | { status: 'throttled'; remounted: string[] }
  /** No hay cámaras visibles a las que reconciliar. */
  | { status: 'no_visible'; pending: string[] }
  /**
   * Se abortó por ocultarse mientras viajaba. `pending` devuelve las cámaras
   * que NO se recuperaron para que el llamador las conserve: perderlas dejaba
   * el player cargando para siempre, porque hls.js no vuelve a emitir el 401.
   */
  | { status: 'aborted'; pending: string[] }
  /** 401: el interceptor decide; no se toca el estado de las cámaras. */
  | { status: 'auth'; pending: string[] }
  /** Falló estando visible: se programó el fallback por cámara. */
  | { status: 'failed'; scheduled: string[] }
  | { status: 'reconciled'; remounted: string[] }

export async function reconcileHlsExpiry<T>(
  expiredIds: string[],
  visibleIds: string[],
  deps: HlsExpiryDeps<T>,
): Promise<HlsExpiryOutcome> {
  if (expiredIds.length === 0) return { status: 'empty' }
  // Con la pestaña oculta no se reconcilia nada: hls.js sigue cargando en
  // segundo plano y sus 401 encolaban acá un heartbeat cada ~30 s.
  if (deps.isHidden()) return { status: 'hidden', pending: expiredIds }

  const cooldown = deps.restartCooldownMs ?? RESTART_COOLDOWN_MS
  const now = deps.now()
  const toRestart = expiredIds.filter(id => (now - (deps.lastRestartAt[id] ?? 0)) >= cooldown)
  const tooRecent = expiredIds.filter(id => (now - (deps.lastRestartAt[id] ?? 0)) < cooldown)

  // Demasiado reciente para reiniciar por heartbeat: se remonta el player para
  // que hls.js rehaga su cookie contra la fuente que sigue viva. Es local, no
  // toca la red.
  if (tooRecent.length > 0) {
    deps.bumpPlayerKeys(tooRecent)
    deps.clearLoading(tooRecent)
  }

  if (toRestart.length === 0) return { status: 'throttled', remounted: tooRecent }
  if (visibleIds.length === 0) return { status: 'no_visible', pending: toRestart }

  // `runHeartbeat` se UNE al heartbeat en vuelo si lo hay, así que nunca
  // devuelve "ocupado": o trae un resultado, o informa que se abortó.
  const outcome = await deps.runHeartbeat()

  // Abortada u oculta: NINGÚN efecto —ni estado, ni remontes, ni fallback, ni
  // arranques— y las cámaras vuelven al llamador para que las reintente.
  if (outcome.status === 'hidden' || outcome.status === 'aborted' || outcome.status === 'busy') {
    return { status: 'aborted', pending: toRestart }
  }

  if (outcome.status === 'error') {
    if (deps.isAuthError(outcome.error)) return { status: 'auth', pending: toRestart }
    // Una falla de red mientras la pestaña se ocultaba tampoco puede dejar un
    // temporizador que arranque streams más tarde.
    if (deps.isHidden()) return { status: 'aborted', pending: toRestart }
    // Intento REAL: recién acá se registra, porque hay un fallback programado.
    toRestart.forEach(id => { deps.lastRestartAt[id] = now })
    deps.scheduleReload(toRestart)
    return { status: 'failed', scheduled: toRestart }
  }

  // Última relectura antes de tocar el estado visible.
  if (deps.isHidden()) return { status: 'aborted', pending: toRestart }

  // Intento REAL y exitoso: se registra el reinicio. Marcarlo antes —como hacía
  // la versión anterior— consumía la ventana de enfriamiento aunque la
  // reconciliación no hubiera ocurrido, y el reintento posterior quedaba
  // bloqueado 30 s sin que nadie hubiera recuperado nada.
  toRestart.forEach(id => { deps.lastRestartAt[id] = now })

  // La respuesta ya la aplicó el programador. Acá sólo se decide qué players
  // remontar: los que el backend NO reinició siguen vivos en el servidor y
  // quedarían atascados con su cookie vencida.
  const started = deps.startedIdsOf(outcome.result)
  const notFreshlyStarted = toRestart.filter(id => !started.includes(id))
  if (notFreshlyStarted.length > 0) deps.bumpPlayerKeys(notFreshlyStarted)

  return { status: 'reconciled', remounted: notFreshlyStarted }
}

/**
 * Expiraciones acumuladas mientras la pestaña estuvo oculta.
 *
 * No se envía nada mientras está oculta, pero los cameraId sí se conservan: al
 * volver, el heartbeat de regreso reconcilia y las que el backend haya
 * reiniciado llegan en `startedIds`. Las que NO llegan es porque su sesión
 * seguía viva en el servidor —regreso antes del TTL—: ésas necesitan un
 * remonte para renovar la cookie HLS, o el player se queda cargando (revisión
 * de #157).
 *
 * Devuelve exactamente las que hay que remontar; el llamador consume y limpia
 * el conjunto una sola vez.
 */
export function decideHiddenExpiryRemounts(
  pending: readonly string[],
  startedIds: readonly string[],
  visibleIds: readonly string[],
): string[] {
  const visibles = new Set(visibleIds)
  const reiniciadas = new Set(startedIds)
  // Deduplicado por cameraId y limitado a lo que sigue en pantalla: una cámara
  // que ya no se muestra no se remonta.
  return Array.from(new Set(pending)).filter(id => visibles.has(id) && !reiniciadas.has(id))
}

export interface ExpiryRecovery {
  /** Players de la grilla a remontar. */
  remount: string[]
  /**
   * Cámara en foco a recuperar: hay que limpiar su `focusStreamError` y
   * remontarla. `null` si no había foco pendiente o si ya no está en foco.
   */
  focus: string | null
}

/**
 * Decisión completa de recuperación con el resultado de UN heartbeat.
 *
 * El foco se recupera igual antes y después del TTL: si el backend lo reinició
 * llega en `startedIds`, y si no, su sesión seguía viva y basta con remontar
 * para renovar la cookie. En los dos casos hay que quitar el "Reconectando…",
 * o la tarjeta queda trabada con un error que ya no describe nada — que es lo
 * que pasaba al volver antes del TTL, porque `decideHdReacquire` sólo actúa
 * pasado el TTL (revisión de #157).
 */
export function decideExpiryRecovery(input: {
  pending: readonly string[]
  pendingFocus: string | null
  startedIds: readonly string[]
  visibleIds: readonly string[]
  currentFocus: string | null
}): ExpiryRecovery {
  const remount = decideHiddenExpiryRemounts(input.pending, input.startedIds, input.visibleIds)
  const focus = input.pendingFocus && input.pendingFocus === input.currentFocus
    ? input.pendingFocus
    : null
  // El foco se remonta por su propia vía, no dos veces.
  return { remount: remount.filter(id => id !== focus), focus }
}
