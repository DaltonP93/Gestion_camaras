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
  /** Efectos, todos inyectados para poder observarlos en las pruebas. */
  applyHeartbeat: (result: T) => void
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
  /** Pestaña oculta: cero efectos, cero red. */
  | { status: 'hidden' }
  /** Todas las cámaras estaban en su ventana de enfriamiento: sólo remontes. */
  | { status: 'throttled'; remounted: string[] }
  /** No hay cámaras visibles a las que reconciliar. */
  | { status: 'no_visible' }
  /** Ya había un heartbeat en vuelo: no se solapa, se deja para el siguiente. */
  | { status: 'busy' }
  /** Se abortó por ocultarse mientras viajaba: sin efectos ni fallback. */
  | { status: 'aborted' }
  /** 401: el interceptor decide; no se toca el estado de las cámaras. */
  | { status: 'auth' }
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
  if (deps.isHidden()) return { status: 'hidden' }

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
  toRestart.forEach(id => { deps.lastRestartAt[id] = now })

  if (visibleIds.length === 0) return { status: 'no_visible' }

  const outcome = await deps.runHeartbeat()

  // Ocultada, abortada o solapada: NINGÚN efecto. Ni estado, ni remontes, ni
  // fallback, ni arranques de stream. Es el punto exacto del hallazgo.
  if (outcome.status === 'hidden' || outcome.status === 'aborted') return { status: 'aborted' }
  if (outcome.status === 'busy') return { status: 'busy' }

  if (outcome.status === 'error') {
    if (deps.isAuthError(outcome.error)) return { status: 'auth' }
    // Una falla de red mientras la pestaña se ocultaba tampoco puede dejar un
    // temporizador que arranque streams más tarde.
    if (deps.isHidden()) return { status: 'aborted' }
    deps.scheduleReload(toRestart)
    return { status: 'failed', scheduled: toRestart }
  }

  // Última relectura antes de tocar el estado visible.
  if (deps.isHidden()) return { status: 'aborted' }

  deps.applyHeartbeat(outcome.result)
  // Las que el backend reinició ya las remonta `applyHeartbeat`. Las que siguen
  // vivas en el servidor no aparecen en `startedIds` y quedarían atascadas con
  // su cookie vencida: a ésas se las remonta acá.
  const started = deps.startedIdsOf(outcome.result)
  const notFreshlyStarted = toRestart.filter(id => !started.includes(id))
  if (notFreshlyStarted.length > 0) deps.bumpPlayerKeys(notFreshlyStarted)

  return { status: 'reconciled', remounted: notFreshlyStarted }
}
