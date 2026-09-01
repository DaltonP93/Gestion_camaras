// Controlador ÚNICO del ciclo de vida de sesiones de stream de una vista.
//
// POR QUÉ EXISTE
//
// Las fugas y carreras de `ViewPlayerPage`/`LiveViewPage` se corrigieron una por
// una durante trece rondas: identidad de cierre, cola de pendientes, vigencia de
// grilla, alcance de carga, publicación en el commit… Cada corrección tapó UN
// handler. Pero mientras el arranque, el cierre, los timers, el heartbeat, el
// registro y la cola vivieran repartidos por las páginas, cada handler nuevo
// podía volver a abrir la clase entera de defectos.
//
// Este módulo centraliza TODO el ciclo de vida en un solo dueño. Compone los
// primitivos ya probados —`scopeGuard`, `sessionRegistry`, `pendingCloses`,
// `viewportSessionClose`, `heartbeatScheduler`, `resolveCreatedType`— detrás de
// una única frontera. Las páginas no vuelven a llamar `apiPost(start-stream)`,
// `closeStreamSession`, `closeViewSessions`, `setTimeout` de HLS ni a tocar el
// registro/cola a mano: todo pasa por acá. Una guarda AST lo verifica.
//
// EL INVARIANTE
//
// Toda sesión —grilla normal, re-arranque HLS, fullscreen, cambio de calidad,
// foco y reconcile/heartbeat— se registra con
// `cameraId + effectiveStreamType + startAttemptId REAL + ownerScope`, y todo
// cierre viaja con esa identidad exacta. Un cierre de A nunca toca B.
//
// LA MÁQUINA DE ESTADOS
//
//   ACTIVE(A) → TRANSITIONING → ACTIVE(B) | ERROR(B) | DISPOSED
//
// `beginTransition()` publica un scope nuevo (invalida el anterior en el acto),
// aborta las requests del scope viejo, detiene su heartbeat, cancela sus timers,
// toma una instantánea de los intentos de A y los cierra por identidad. Lo no
// confirmado queda en la cola con reintento SÓLO-CIERRE (nunca un heartbeat que
// mantenga viva A). El heartbeat de B arranca sólo cuando B es el scope vigente.
//
// Es PURO y con dependencias inyectables (fetch, cierre, timers, heartbeat): se
// prueba entero sin DOM.

import { createScopeGuard, type ScopeGuard } from './scopeGuard'
import { createSessionRegistry, type SessionRegistry, type SessionEntry } from './sessionRegistry'
import { createPendingCloseQueue, cierreConfirmado, type PendingCloseQueue } from './pendingCloses'
import { resolveCreatedType, type StreamInfoLike, type StreamKind } from './streamTypes'
import { newStartAttemptId } from './startAttempt'
import { STALE_RESPONSE, esCierreFuerte } from './closeReasons'
import {
  closeOneSession, closeStaleStart, closeTrackedSessions, closeExactAttempt,
  retryPendingCloses, forgetStoppedSubSessions,
  type CloseFn, type CloseAck, type StaleCloseResult, type TrackedCloseResult,
} from './viewportSessionClose'
import {
  createHeartbeatScheduler, type HeartbeatScheduler, type HeartbeatTimers,
} from './heartbeatScheduler'

/** De dónde nació el arranque. Sólo para diagnóstico y para las pruebas. */
export type SessionSource =
  | 'grid' | 'grid_hls_restart' | 'fullscreen' | 'fullscreen_hls'
  | 'quality' | 'focus' | 'reconcile'

/** Temporizadores inyectables: en producción `window`, en pruebas falsos. */
export interface ControllerTimers extends HeartbeatTimers {
  setTimeout: (fn: () => void, ms: number) => any
  clearTimeout: (id: any) => void
}

const realTimers: ControllerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
}

export type StartStreamFn = (
  cameraId: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<StreamInfoLike & { startAttemptId?: string }>

export interface ControllerDeps {
  viewId: string
  /** Emite el POST de arranque. El controlador agrega viewId + startAttemptId. */
  startStream: StartStreamFn
  /** Cierre por identidad (DELETE con expectedStartAttemptId). */
  close: CloseFn
  /** Cierre de TODA la vista (sólo descarga/desmontaje real sin sucesor). */
  closeView: (viewId: string) => Promise<unknown> | unknown
  timers?: ControllerTimers
  /** Cadencia del retry SÓLO-CIERRE (ms). Default 5000. */
  closeRetryMs?: number
  log?: (msg: string) => void
}

export interface StartInput {
  source: SessionSource
  cameraId: string
  /** Tipo pedido; el efectivo sale de la respuesta (`resolveCreatedType`). */
  requested: StreamKind
  /** Scope capturado por el llamador ANTES de programar el arranque. */
  scope: symbol
  /** Cuerpo extra del POST (p. ej. `{ streamType: 'main' }`). */
  body?: Record<string, unknown>
}

export interface StartResult {
  info: StreamInfoLike & { startAttemptId?: string }
  effectiveType: StreamKind
  startAttemptId: string
}

export interface CloseInput {
  cameraId: string
  streamType: StreamKind
  reason: string
  onUnconfirmed?: (attemptId: string, outcome?: string, status?: number) => void
}

export interface HeartbeatBinding<T> {
  intervalMs: number
  isHidden: () => boolean
  /**
   * Scope al que pertenece este heartbeat. Se verifica ANTES de enviar y ANTES
   * de aplicar el resultado: un latido de A tras la transición no sale ni se
   * aplica. Default: el scope vigente al atar.
   */
  scope?: symbol
  /** Envío real del heartbeat; el controlador sólo lo llama con el scope vigente. */
  send: (signal: AbortSignal) => Promise<T>
  /** Se aplica el resultado SÓLO si el scope sigue vigente. */
  onResult?: (result: T) => void
}

export interface ViewportSessionController {
  // ─── scope ───
  /** Publica un scope nuevo (invalida el anterior) y lo devuelve. */
  publishScope(): symbol
  currentScope(): symbol
  isCurrent(scope: symbol): boolean

  // ─── transición atómica ───
  /**
   * ACTIVE(A) → TRANSITIONING. Publica el scope nuevo, aborta requests viejas,
   * detiene el heartbeat, cancela timers y —con la instantánea de A— cierra sus
   * sesiones por identidad. Devuelve el scope NUEVO que el llamador debe usar.
   *
   * Es la ÚNICA entrada fuerte de transición para las páginas (cambio de ruta,
   * página, layout, desmontaje lógico): `publishScope` no debe usarse desde una
   * página, porque publica sin cerrar A —el defecto que dejaba A vivo—.
   */
  beginTransition(reason: string): symbol
  /** Alias explícito de `beginTransition`. */
  transitionTo(reason: string): symbol
  /** Cierra por identidad EXACTA cada entrada dada (una por attempt) + arranca el retry. */
  closeExactEntries(entries: SessionEntry[], reason: string): void
  /** Arranca el retry SÓLO-CIERRE si hay pendientes y no corre ya. */
  ensureCloseRetryLoop(): void
  stopCloseRetryLoop(): void

  // ─── arranque ───
  /** Arranca una sesión. Devuelve null si el scope dejó de ser vigente (descartada). */
  start(input: StartInput): Promise<StartResult | null>
  /**
   * POST de arranque CRUDO (dueño del `apiPost start-stream`). No comprueba scope
   * ni registra: lo usa un orquestador propio (LiveViewPage, con su transición)
   * que decide él mismo la vigencia y cuándo registrar/descartar. Devuelve la
   * respuesta y el intento REAL que la creó.
   */
  startRaw(cameraId: string, body?: Record<string, unknown>): Promise<{ info: StreamInfoLike & { startAttemptId?: string }; startAttemptId: string }>
  /** Anota una sesión ya iniciada por su tipo efectivo + intento REAL. */
  registerStarted(cameraId: string, effectiveType: StreamKind, startAttemptId: string): boolean
  /** Anota una sesión nacida en reconcile/heartbeat con su identidad `srv-*` REAL. */
  registerReconciled(cameraId: string, effectiveType: StreamKind, startAttemptId: string): boolean
  /** Olvida las anotaciones `sub` de las cámaras que el reconcile detuvo. */
  forgetStoppedSubs(stoppedIds: readonly string[]): Array<{ cameraId: string; streamType: StreamKind }>

  // ─── cierre ───
  /** Cierre deliberado por identidad de una ranura (todos sus arrendamientos). */
  close(input: CloseInput): Promise<boolean>
  /** Cierra los tipos HD de una cámara (fullscreen/foco). */
  closeHd(cameraId: string, reason: string): Promise<void>
  /** Descarta por identidad una respuesta tardía (con cola). */
  closeStale(input: {
    cameraId: string; info: StreamInfoLike | null | undefined; requested: StreamKind
    startAttemptId: string
    onClose?: (r: {
      cameraId: string; created: StreamKind; startAttemptId: string
      confirmed: boolean
      outcome?: 'ignored' | 'attempt_released' | 'session_closed'
      status?: number
    }) => void
  }): Promise<StaleCloseResult>
  /** Cierre en lote por cámara (transición de viewport), con identidad y cola. */
  closeTracked(cameraIds: readonly string[], reason: string, onClose?: (r: TrackedCloseResult) => void): Promise<TrackedCloseResult[]>
  /** Reintento SÓLO-CIERRE de lo que quedó pendiente. Nunca arranca ni renueva nada. */
  retryCloses(): Promise<{ resueltos: number; siguenPendientes: number }>
  /**
   * ABANDONA el lifecycle por completo: ejecuta los hooks de dispose (detiene el
   * scheduler adoptado de LiveView e invalida su viewportWork), invalida el scope
   * (una respuesta tardía ya no puede registrar ni aplicar), aborta lo en vuelo,
   * cancela timers, detiene heartbeat y retry, y cierra TODA la vista con
   * keepalive. Es la ÚNICA política de bfcache: se llama en cualquier `pagehide`
   * (real o persistido) y en el desmontaje. Marca la vista como abandonada.
   */
  disposeView(): void
  /** ¿La vista ya fue abandonada? Un `pageshow.persisted` sólo recarga si sí. */
  isAbandoned(): boolean

  // ─── timers HLS ───
  /** Programa un re-arranque HLS registrado y atado a un scope. Reemplaza el previo de esa clave. */
  scheduleHlsRestart(key: string, scope: symbol, delayMs: number, run: () => void): void
  /** Cancela timers: todos, o los de una clave. */
  cancelTimers(key?: string): void

  // ─── heartbeat ───
  bindHeartbeat<T>(binding: HeartbeatBinding<T>): void
  startHeartbeat(): void
  stopHeartbeat(): void
  handleVisibilityChange(): void
  /** Fuerza un latido inmediato (respeta scope/visibilidad). */
  beatNow(): Promise<void>

  // ─── adopción de maquinaria de orquestación ───
  /**
   * OWNERSHIP dentro del controlador de una pieza de orquestación que la página
   * antes creaba y guardaba en su propio `useRef` (viewportTransition,
   * viewportWork). La página ya no la posee: la crea una vez a través de acá y el
   * controlador la retiene, de modo que no haya un «segundo lifecycle» en la
   * página. No reescribe la pieza —mueve su dueño—.
   */
  adopt<T>(key: string, factory: () => T): T
  adopted<T>(key: string): T | undefined
  /**
   * Registra un hook de dispose de la maquinaria adoptada. Lo EJECUTA el
   * controlador en `disposeView` —así el dispose de la transición/heartbeat de la
   * página lo gobierna el controlador, no la página—.
   */
  onDispose(cb: () => void): void

  // ─── lectura (pruebas/diagnóstico) ───
  registry(): SessionRegistry
  pending(): PendingCloseQueue
  snapshot(): SessionEntry[]
  inflightCount(): number
  timerCount(): number
}

export function createViewportSessionController(deps: ControllerDeps): ViewportSessionController {
  const timers = deps.timers ?? realTimers
  const scope: ScopeGuard = createScopeGuard()
  const registry = createSessionRegistry()
  const pending = createPendingCloseQueue()

  /** Requests en vuelo, cada una atada al scope en que nació. */
  const inflight = new Map<AbortController, symbol>()
  /** Timers HLS registrados, por clave, atados a un scope. */
  const hlsTimers = new Map<string, { id: any; scope: symbol }>()

  let heartbeat: HeartbeatScheduler<unknown> | null = null
  /** Reintento SÓLO-CIERRE de pendientes durante TRANSITIONING/ERROR(B). */
  let closeRetryTimer: any = null
  const closeRetryMs = deps.closeRetryMs ?? 5_000
  /** Single-flight del reintento: nunca dos DELETE simultáneos del mismo intento. */
  let retryEnCurso = false
  /** La vista fue abandonada (dispose/bfcache): un pageshow persistido recarga. */
  let abandoned = false
  /** Piezas de orquestación adoptadas (viewportWork, viewportTransition, …). */
  const adoptados = new Map<string, unknown>()
  /** Hooks de dispose que registró la página; el controlador los ejecuta. */
  const disposeHooks = new Set<() => void>()

  const log = (m: string) => deps.log?.(m)

  // Las requests de ARRANQUE nunca se abortan en una transición: abortar el
  // cliente no deshace la sesión que el servidor ya pudo crear, y perderíamos su
  // identidad —quedaría un FFmpeg huérfano—. En su lugar se dejan resolver y el
  // chequeo de scope POST-respuesta las descarta por identidad (cierre exacto).
  // El AbortController sólo se usa en `disposeView`, donde `closeView` por vista
  // es el respaldo. El heartbeat, en cambio, SÍ se aborta al transicionar: es
  // idempotente y no crea sesiones (lo hace `heartbeatScheduler.stop`).

  // COORDINADOR SINGLE-FLIGHT POR IDENTIDAD EXACTA (cameraId+tipo+intento).
  //
  // `retryEnCurso` sólo serializaba `retryCloses`; no impedía que un retry y un
  // cierre exacto/close/closeTracked/closeStale mandaran a la vez el MISMO DELETE.
  // La carrera confirmada: el retry libera A (attempt_released); el cierre
  // simultáneo recibe `attempt_not_registered` y re-encola A —una entrada
  // huérfana que nunca cierra—. Acá TODOS los caminos comparten una sola
  // operación por clave: la primera gana, las concurrentes reciben su misma
  // promesa, y una identidad ya confirmada jamás vuelve a emitir DELETE ni a
  // encolarse.
  // La FUERZA DE INTENCIÓN importa tanto como la identidad. Un cierre CONSERVADOR
  // (razón fuera de `MATAN_FFMPEG`: hls_fatal_error, grid_retry, quality_switch,
  // restart_stream) puede confirmar y borrar la sesión conservando el FFmpeg; un
  // cierre TERMINANTE posterior de la MISMA identidad debe seguir saliendo, para
  // que el backend escale y mate el proceso huérfano. Por eso el coordinador
  // recuerda la fuerza YA satisfecha, no un booleano: una confirmación débil NO
  // suprime un cierre fuerte (concurrente o posterior).
  type Fuerza = 'weak' | 'strong'
  const fuerzaDe = (reason: string): Fuerza => esCierreFuerte(reason) ? 'strong' : 'weak'
  const closeInFlight = new Map<string, Promise<CloseAck>>()   // clave incluye la fuerza
  const closeConfirmed = new Map<string, Fuerza>()             // clave = identidad; valor = fuerza satisfecha
  const claveIdentidad = (c: string, t: StreamKind, e?: string) => `${c}:${t}:${e ?? '∅'}`
  // REGISTRO DE PROCESOS RETENIDOS (cliente). Cuando un cierre CONSERVADOR
  // confirma el `session_closed` del último lease conservando el FFmpeg, el
  // backend devuelve un `retentionToken`: A sale del registro activo pero entra
  // ACÁ, para que una transición/dispose posterior emita un cierre TERMINANTE con
  // ese token y escale el proceso huérfano. Sin esto, `beginTransition` sacaría un
  // snapshot vacío y el FFmpeg quedaría vivo (defecto P0-2 de C19).
  interface RetainedEntry { cameraId: string; streamType: StreamKind; startAttemptId: string; ownerScope: symbol; retentionToken: string }
  const retained = new Map<string, RetainedEntry>()
  const closeCoord: CloseFn = (cameraId, streamType, reason, viewId, expected) => {
    const idK = claveIdentidad(cameraId, streamType, expected)
    const fuerza = fuerzaDe(reason)
    // El ACK puede llegar después de publicar otro scope. La retención pertenece
    // al scope que POSEÍA la identidad al emitir el cierre, no al vigente cuando
    // la promesa se resuelve.
    const ownerScope = expected
      ? registry.snapshot().find(e =>
          e.cameraId === cameraId && e.streamType === streamType &&
          e.startAttemptId === expected)?.ownerScope ??
        retained.get(idK)?.ownerScope ?? scope.current()
      : scope.current()
    // Ya satisfecho con fuerza IGUAL o MAYOR: ningún DELETE nuevo. `already_gone`
    // cuenta como confirmado, así que el llamador NO re-encola. Un cierre fuerte
    // NO se suprime por una confirmación débil.
    const yaSatisfecho = closeConfirmed.get(idK)
    if (yaSatisfecho === 'strong' || (yaSatisfecho === 'weak' && fuerza === 'weak')) {
      return { emitted: true, status: 200, outcome: 'ignored', reason: 'already_gone', attemptId: expected }
    }
    // Single-flight por identidad+fuerza: dos cierres de la misma fuerza comparten
    // el DELETE; un fuerte y un débil son operaciones distintas (efecto distinto
    // sobre el FFmpeg) y no se deduplican entre sí.
    const flK = `${idK}:${fuerza}`
    const enVuelo = closeInFlight.get(flK)
    if (enVuelo) return enVuelo
    // Si hay una retención para esta identidad, el DELETE lleva su token para
    // escalar el proceso conservado.
    const tokenEscalada = retained.get(idK)?.retentionToken
    const p = Promise.resolve(deps.close(cameraId, streamType, reason, viewId, expected, tokenEscalada))
      .then((ack): CloseAck => {
        // `void` (keepalive en descarga, sin respuesta) → no confirmado.
        const a: CloseAck = ack ?? { emitted: false }
        if (expected && cierreConfirmado(a, expected)) {
          const prev = closeConfirmed.get(idK)
          if (prev !== 'strong') closeConfirmed.set(idK, fuerza)   // conserva la fuerza mayor
        }
        // Retención: si el backend conservó el FFmpeg, se anota; si lo terminó,
        // adoptó o ya no existe, se resuelve. `attempt_not_registered` NO resuelve.
        if (expected && a.retentionToken) {
          retained.set(idK, { cameraId, streamType, startAttemptId: expected, ownerScope, retentionToken: a.retentionToken })
        }
        if (a.killedFfmpeg === true || a.reason === 'retention_adopted' || a.reason === 'retention_gone') {
          retained.delete(idK)
        } else if (expected && fuerza === 'strong' && cierreConfirmado(a, expected) && !a.retentionToken) {
          // La ausencia exacta también resuelve una retención que pudo vencer o
          // ser limpiada en el servidor entre reintentos.
          retained.delete(idK)
        }
        return a
      })
      .finally(() => closeInFlight.delete(flK))
    closeInFlight.set(flK, p)
    return p
  }
  /** Entradas retenidas (procesos conservados) de un scope dado, como SessionEntry. */
  const retenidasDeScope = (s: symbol): SessionEntry[] =>
    Array.from(retained.values())
      .filter(r => r.ownerScope === s)
      .map(r => ({ cameraId: r.cameraId, streamType: r.streamType, startAttemptId: r.startAttemptId, ownerScope: r.ownerScope }))

  // TRATAMIENTO POSTERIOR A CUALQUIER CIERRE, en un solo sitio: si algo quedó en
  // la cola (500/red/ignored no confirmatorio), se arranca el retry SÓLO-CIERRE.
  // Da igual de qué cierre venga —discardStale, close, closeStale, closeHd,
  // closeTracked, closeExactEntries—: todos pasan por acá al asentar.
  const trasCierre = async <T>(p: Promise<T>): Promise<T> => {
    try { return await p } finally { ctrl.ensureCloseRetryLoop() }
  }

  /** Descarta por IDENTIDAD una respuesta que llegó fuera de scope. */
  const discardStale = (cameraId: string, info: StreamInfoLike | null | undefined, requested: StreamKind, startAttemptId: string) =>
    trasCierre(closeStaleStart({
      cameraId, info, requested, startAttemptId,
      viewId: deps.viewId, close: closeCoord, registry, pending,
    }))

  const ctrl: ViewportSessionController = {
    publishScope() {
      return scope.publish()
    },
    currentScope() { return scope.current() },
    isCurrent(s) { return scope.isCurrent(s) },

    beginTransition(reason) {
      // 1. Instantánea del scope ABANDONADO (el vigente ahora). Sólo se cerrarán
      //    SUS entradas por identidad exacta; una B de otro scope es intocable.
      const abandonado = scope.current()
      // Se incluyen las entradas ACTIVAS y las RETENIDAS del scope abandonado: un
      // proceso conservado por un cierre débil se escala ahora con un cierre
      // fuerte, en vez de quedar vivo hasta el TTL.
      const aCerrar = [
        ...registry.snapshot().filter(e => e.ownerScope === abandonado),
        ...retenidasDeScope(abandonado),
      ]
      // 2. Publicar scope nuevo → invalida el anterior EN EL ACTO. Las requests
      //    de arranque en vuelo de A no se abortan: se descartarán por identidad
      //    al resolver (chequeo POST-respuesta), sin dejar sesión huérfana.
      const nuevo = scope.publish()
      // 3. ANTES de cualquier carga de B: cancelar timers de A y DETENER su
      //    heartbeat (aborta su request en vuelo). A no puede volver a latir ni
      //    renovar sus cámaras.
      ctrl.cancelTimers()
      ctrl.stopHeartbeat()
      // 4. Cerrar cada entrada de A por identidad EXACTA (un cierre por attempt,
      //    no `closeOneSession` que recorrería toda la ranura y tocaría una B).
      ctrl.closeExactEntries(aCerrar, reason)
      return nuevo
    },
    transitionTo(reason) { return ctrl.beginTransition(reason) },

    closeExactEntries(entries, reason) {
      const cierres = entries.map(e => closeExactAttempt({
        cameraId: e.cameraId, streamType: e.streamType, startAttemptId: e.startAttemptId,
        reason, viewId: deps.viewId, registry, pending, close: closeCoord,
        onClose: ({ resuelto, outcome, status }) => {
          if (!resuelto) log(`close_unconfirmed cameraId=${e.cameraId} type=${e.streamType} attempt=${e.startAttemptId} reason=${reason} outcome=${outcome ?? 'unknown'} status=${status ?? 'n/a'}`)
        },
      }))
      // Cuando los cierres asentaron: lo no confirmado quedó en la cola, y el
      // retry SÓLO-CIERRE la vacía sin depender del heartbeat de B (que aún no
      // existe). Se arranca DESPUÉS del await para que `pending` ya refleje los
      // fallos (si se armara antes, la cola estaría vacía y no arrancaría).
      void Promise.allSettled(cierres).then(() => ctrl.ensureCloseRetryLoop())
    },

    ensureCloseRetryLoop() {
      // Se activa SIEMPRE que haya pendientes, venga el cierre de donde venga.
      if (closeRetryTimer !== null || pending.size() === 0) return
      closeRetryTimer = timers.setInterval(() => {
        void ctrl.retryCloses().then(r => {
          if (r.siguenPendientes === 0) ctrl.stopCloseRetryLoop()
        })
      }, closeRetryMs)
    },
    stopCloseRetryLoop() {
      if (closeRetryTimer !== null) { timers.clearInterval(closeRetryTimer); closeRetryTimer = null }
    },

    async start(input) {
      const startAttemptId = newStartAttemptId()
      // Vigencia ANTES del POST: si el scope ya cambió, ni se emite.
      if (!scope.isCurrent(input.scope)) return null
      const ac = new AbortController()
      inflight.set(ac, input.scope)
      let info: StreamInfoLike & { startAttemptId?: string }
      try {
        info = await deps.startStream(
          input.cameraId,
          { ...(input.body ?? {}), viewId: deps.viewId, startAttemptId },
          ac.signal,
        )
      } finally {
        inflight.delete(ac)
      }
      const effectiveType = resolveCreatedType(info, input.requested)
      // Vigencia DESPUÉS de la respuesta: pudo cambiar el scope mientras viajaba.
      if (!scope.isCurrent(input.scope)) {
        await discardStale(input.cameraId, info, input.requested, startAttemptId)
        return null
      }
      // Se anota con el scope que la creó: una transición cerrará sólo las de su
      // scope abandonado.
      registry.add({ cameraId: input.cameraId, streamType: effectiveType, startAttemptId, ownerScope: input.scope })
      return { info, effectiveType, startAttemptId }
    },

    async startRaw(cameraId, body) {
      const startAttemptId = newStartAttemptId()
      const ac = new AbortController()
      inflight.set(ac, scope.current())
      try {
        const info = await deps.startStream(
          cameraId, { ...(body ?? {}), viewId: deps.viewId, startAttemptId }, ac.signal,
        )
        return { info, startAttemptId }
      } finally {
        inflight.delete(ac)
      }
    },

    registerStarted(cameraId, effectiveType, startAttemptId) {
      if (!startAttemptId) return false
      registry.add({ cameraId, streamType: effectiveType, startAttemptId, ownerScope: scope.current() })
      return true
    },

    registerReconciled(cameraId, effectiveType, startAttemptId) {
      // Sólo con identidad REAL acuñada por el servidor (`srv-*`); nunca sintética.
      if (!startAttemptId) return false
      registry.add({ cameraId, streamType: effectiveType, startAttemptId, ownerScope: scope.current() })
      return true
    },

    forgetStoppedSubs(stoppedIds) {
      return forgetStoppedSubSessions(registry, stoppedIds)
    },

    close(input) {
      return trasCierre(closeOneSession({
        cameraId: input.cameraId, streamType: input.streamType, reason: input.reason,
        viewId: deps.viewId, registry, pending, close: closeCoord,
        onClose: ({ startAttemptId, resuelto, outcome, status }) => {
          if (!resuelto) input.onUnconfirmed?.(startAttemptId, outcome, status)
        },
      }))
    },

    async closeHd(cameraId, reason) {
      for (const streamType of ['main', 'main_h264'] as const) {
        await ctrl.close({ cameraId, streamType, reason })
      }
    },

    closeStale(input) {
      return trasCierre(closeStaleStart({
        cameraId: input.cameraId, info: input.info, requested: input.requested,
        startAttemptId: input.startAttemptId, viewId: deps.viewId,
        close: closeCoord, registry, pending, onClose: input.onClose,
      }))
    },

    closeTracked(cameraIds, reason, onClose) {
      // Además de las sesiones ACTIVAS, se escalan las RETENIDAS de esas cámaras
      // (procesos conservados por un cierre débil previo): un cambio de viewport
      // que abandona la cámara debe terminar también su FFmpeg huérfano.
      const set = new Set(cameraIds)
      const retenidas = Array.from(retained.values())
        .filter(r => set.has(r.cameraId))
        .map(r => ({ cameraId: r.cameraId, streamType: r.streamType, startAttemptId: r.startAttemptId, ownerScope: r.ownerScope }))
      if (retenidas.length > 0) ctrl.closeExactEntries(retenidas, reason)
      return trasCierre(closeTrackedSessions({
        cameraIds, registry, reason, viewId: deps.viewId,
        pending, close: closeCoord, onClose,
      }))
    },

    async retryCloses() {
      // SINGLE-FLIGHT: si ya hay un reintento en curso, no se lanza otro —así
      // nunca salen dos DELETE simultáneos para el mismo `startAttemptId`—.
      if (retryEnCurso) return { resueltos: 0, siguenPendientes: pending.size() }
      if (pending.size() === 0) return { resueltos: 0, siguenPendientes: 0 }
      retryEnCurso = true
      try {
        return await retryPendingCloses({
          pending, registry, viewId: deps.viewId, close: closeCoord,
          onRetry: ({ cameraId, streamType, attempts, resuelto }) =>
            log(`close_retry cameraId=${cameraId} type=${streamType} attempts=${attempts} resuelto=${resuelto}`),
        })
      } finally {
        retryEnCurso = false
      }
    },

    onDispose(cb) { disposeHooks.add(cb) },

    disposeView() {
      abandoned = true
      // Se abandona TODO. El CONTROLADOR maneja el dispose de la maquinaria
      // adoptada (los hooks que registró la página: invalidar viewportWork,
      // detener su heartbeat), no la página por su cuenta.
      for (const cb of disposeHooks) { try { cb() } catch { /* un hook no rompe el resto */ } }
      // Invalidar el scope: una respuesta de arranque tardía verá su scope
      // capturado como no vigente y se auto-descartará; nada nuevo se registra.
      scope.publish()
      for (const [ac] of inflight) ac.abort()
      inflight.clear()
      ctrl.cancelTimers()
      ctrl.stopHeartbeat()
      ctrl.stopCloseRetryLoop()
      closeInFlight.clear()
      closeConfirmed.clear()
      // Las retenciones de esta vista las finaliza el backend en `closeView`
      // (`cleanupUserSessions(viewId)` → `finalizeRetentionsForView`, defecto
      // P0-4): un dispose no puede dejar FFmpeg conservado vivo hasta el TTL. El
      // registro local se limpia porque la vista entera se abandona.
      retained.clear()
      void deps.closeView(deps.viewId)
    },
    isAbandoned() { return abandoned },

    scheduleHlsRestart(key, s, delayMs, run) {
      const prev = hlsTimers.get(key)
      if (prev) timers.clearTimeout(prev.id)
      const id = timers.setTimeout(() => {
        hlsTimers.delete(key)
        // Vigencia al disparar: un timer del scope viejo no arranca nada.
        if (!scope.isCurrent(s)) return
        run()
      }, delayMs)
      hlsTimers.set(key, { id, scope: s })
    },

    cancelTimers(key) {
      if (key) {
        const t = hlsTimers.get(key)
        if (t) { timers.clearTimeout(t.id); hlsTimers.delete(key) }
        return
      }
      for (const [, t] of hlsTimers) timers.clearTimeout(t.id)
      hlsTimers.clear()
    },

    bindHeartbeat(binding) {
      const boundScope = binding.scope ?? scope.current()
      heartbeat?.stop()
      heartbeat = createHeartbeatScheduler<unknown>({
        intervalMs: binding.intervalMs,
        isHidden: binding.isHidden,
        timers,
        // ANTES de enviar: si el scope de este heartbeat ya no es vigente (hubo
        // transición), no se emite ningún latido con cámaras de A.
        send: (signal) => scope.isCurrent(boundScope)
          ? binding.send(signal)
          : Promise.resolve(undefined as unknown),
        onResult: (result) => {
          // ANTES de aplicar: una respuesta de A que llegó tarde no toca slots B.
          if (!scope.isCurrent(boundScope)) return
          binding.onResult?.(result as any)
          // Reintento SÓLO-CIERRE, enganchado a la cadencia visible-only. Nunca
          // arranca ni renueva: sólo insiste en cerrar lo pendiente.
          void ctrl.retryCloses()
        },
      })
    },
    startHeartbeat() { heartbeat?.start() },
    stopHeartbeat() { heartbeat?.stop() },
    handleVisibilityChange() { heartbeat?.handleVisibilityChange() },
    async beatNow() { await heartbeat?.runNow() },

    adopt(key, factory) {
      if (!adoptados.has(key)) adoptados.set(key, factory())
      return adoptados.get(key) as any
    },
    adopted(key) { return adoptados.get(key) as any },

    registry() { return registry },
    pending() { return pending },
    snapshot() { return registry.snapshot() },
    inflightCount() { return inflight.size },
    timerCount() { return hlsTimers.size },
  }

  return ctrl
}
