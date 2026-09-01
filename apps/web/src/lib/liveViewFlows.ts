// Flujos de vista en vivo que cruzan al menos un `await`.
//
// POR QUÉ EXISTEN ACÁ Y NO EN LA PÁGINA
//
// La revisión posterior a #160 encontró cuatro operaciones que sobreviven a un
// cambio de viewport porque deciden después de esperar:
//
//   · el reinicio manual — POST y, al volver, programar el arranque;
//   · la salida de foco — dos esperas y, al volver, remontar y arrancar todo;
//   · la readquisición de HD — trata "descartado" como si fuera un fallo real
//     y aplica su plan de repliegue sobre el viewport nuevo;
//   · el límite de streams — libera sesiones y, al volver, reintenta.
//
// Todas vivían dentro de `LiveViewPage`, enredadas con estado de React, así que
// lo único que se podía comprobar de ellas era el texto del archivo. Acá son
// funciones puras con dependencias inyectadas: las pruebas ejecutan la
// secuencia real —con el coordinador de transición real— y ven exactamente qué
// se llamó y qué no.
//
// Regla común: la vigencia se captura al ABRIR la operación y se comprueba
// después de CADA espera. Ninguna vuelve a preguntar cuál es el token vigente,
// porque hacerlo después de un await es cómo una operación vieja renace dentro
// del viewport nuevo.

import type { GuardedOperation } from './guardedOperation'

// ─── 1 · reinicio manual ─────────────────────────────────────────────────────

export interface RestartStreamFlowDeps {
  op: GuardedOperation
  /** Limpieza local previa (sesión, pendientes, streams, errores, remonte). */
  resetLocal: () => void
  /** POST /cameras/:id/restart-stream. */
  restart: () => Promise<void>
  /**
   * Programa el arranque diferido CON la vigencia de esta operación. No puede
   * capturarla por su cuenta: para cuando corre, el viewport pudo cambiar.
   */
  scheduleStart: () => void
  onDiscard?: () => void
}

export type RestartStreamOutcome = 'scheduled' | 'discarded'

export async function restartStreamFlow(
  d: RestartStreamFlowDeps,
): Promise<RestartStreamOutcome> {
  d.resetLocal()
  await d.restart()
  if (!d.op.isCurrent()) {
    // El POST pudo tardar más que el cambio de NVR. Programar acá arrancaría
    // una cámara del viewport anterior dentro del nuevo.
    d.onDiscard?.()
    return 'discarded'
  }
  d.scheduleStart()
  return 'scheduled'
}

// ─── 2 · salida de foco ──────────────────────────────────────────────────────

export interface ExitFocusFlowDeps {
  op: GuardedOperation
  /** Baja el foco en el estado local. Corre siempre: es la intención del usuario. */
  clearFocus: () => void
  /** Cierra main y main_h264 de la cámara que estaba en foco. */
  closeFocusSessions: () => void
  /** Espera a que el estado se asiente antes de tocar los players. */
  settleMs: number
  /** Espera entre destruir las instancias HLS viejas y arrancar de nuevo. */
  remountMs: number
  bumpPlayerKeys: () => void
  startVisibleStreams: () => void
  onDiscard?: (stage: 'settle' | 'remount') => void
}

export type ExitFocusOutcome = 'restarted' | 'discarded_settle' | 'discarded_remount'

export async function exitFocusFlow(d: ExitFocusFlowDeps): Promise<ExitFocusOutcome> {
  d.clearFocus()
  d.closeFocusSessions()

  if (!await d.op.sleep(d.settleMs)) {
    // Ni siquiera se remonta: los players del viewport nuevo no son los de esta
    // operación, y remontarlos tira sus instancias HLS recién creadas.
    d.onDiscard?.('settle')
    return 'discarded_settle'
  }
  d.bumpPlayerKeys()

  if (!await d.op.sleep(d.remountMs)) {
    d.onDiscard?.('remount')
    return 'discarded_remount'
  }
  d.startVisibleStreams()
  return 'restarted'
}

// ─── 3 · readquisición de HD ─────────────────────────────────────────────────

/**
 * Desenlace de entrar en foco. `superseded` es un tercer estado de pleno
 * derecho: no es un éxito, pero tampoco un fallo del que haya que reponerse.
 * Mientras se devolvía como un error sintético `UNKNOWN/viewport_changed`, la
 * readquisición lo trataba como fallo real y aplicaba su repliegue sobre un
 * viewport que no era el suyo.
 */
export type EnterFocusOutcome<Info, Err> =
  | { status: 'ok'; info: Info; actualType: 'sub' | 'main' | 'main_h264' }
  | { status: 'error'; error: Err }
  | { status: 'superseded' }

export interface HdReacquireFlowDeps<Info, Err> {
  enterFocus: () => Promise<EnterFocusOutcome<Info, Err>>
  /** Plan de repliegue. Sólo se consulta ante un fallo REAL. */
  planFallback: (errorCode: string) => {
    showErrorOverlay: boolean
    clearStreamInfo: boolean
    streamType: 'sub' | 'main' | 'main_h264'
    remountPlayer: boolean
  }
  errorCodeOf: (error: Err) => string
  clearFocusError: () => void
  clearFocusInfo: () => void
  setFocusType: (t: 'sub' | 'main' | 'main_h264') => void
  remountPlayer: () => void
  onSuperseded?: () => void
  onFailure?: (code: string) => void
}

export type HdReacquireOutcome = 'ok' | 'fell_back' | 'superseded'

export async function hdReacquireFlow<Info, Err>(
  d: HdReacquireFlowDeps<Info, Err>,
): Promise<HdReacquireOutcome> {
  const result = await d.enterFocus()

  if (result.status === 'superseded') {
    // Cero efectos: ni overlay, ni tipo, ni info, ni remonte. El viewport nuevo
    // ya tiene su propio ciclo de foco y este intento no le pertenece.
    d.onSuperseded?.()
    return 'superseded'
  }
  if (result.status === 'ok') return 'ok'

  const code = d.errorCodeOf(result.error)
  d.onFailure?.(code)
  const plan = d.planFallback(code)
  if (!plan.showErrorOverlay) d.clearFocusError()
  if (plan.clearStreamInfo) d.clearFocusInfo()
  d.setFocusType(plan.streamType)
  if (plan.remountPlayer) d.remountPlayer()
  return 'fell_back'
}

// ─── 4 · límite de streams alcanzado ─────────────────────────────────────────

export interface LimitHitFlowDeps {
  /** Vigencia heredada del `loadStream` que chocó con el límite. */
  op: GuardedOperation
  /** Sesiones activas que ya no se ven: son las que se pueden liberar. */
  nonVisible: () => string[]
  stopSessions: (ids: string[]) => Promise<void>
  /** Quita del estado los streams liberados. */
  forgetStreams: (ids: string[]) => void
  clearBackoff: () => void
  clearPendingStart: () => void
  /** Reintento del arranque, con la MISMA vigencia. */
  retry: () => Promise<void>
  applyBackoff: () => void
  showLimitError: () => void
  onDiscard?: (stage: 'after_stop') => void
}

export type LimitHitOutcome = 'retried' | 'backoff' | 'discarded'

export async function limitHitFlow(d: LimitHitFlowDeps): Promise<LimitHitOutcome> {
  const liberables = d.nonVisible()

  if (liberables.length === 0) {
    // Nada que liberar. El backoff y el error pertenecen a la cámara del
    // viewport vigente; si ya no lo es, no se muestra nada.
    if (!d.op.isCurrent()) { d.onDiscard?.('after_stop'); return 'discarded' }
    d.applyBackoff()
    d.showLimitError()
    return 'backoff'
  }

  await d.stopSessions(liberables)
  if (!d.op.isCurrent()) {
    // El cierre pudo cruzarse con un cambio de viewport. Nada de lo que sigue
    // —olvidar streams, limpiar el enfriamiento, reintentar— pertenece ya a
    // esta operación, y el reintento arrancaría una cámara que no se ve.
    d.onDiscard?.('after_stop')
    return 'discarded'
  }
  d.forgetStreams(liberables)
  d.clearBackoff()
  d.clearPendingStart()
  await d.retry()
  return 'retried'
}
