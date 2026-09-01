// Camino ÚNICO de cierre de sesiones de la vista en vivo.
//
// POR QUÉ EXISTE
//
// Había cuatro cierres distintos y cada uno adivinaba el tipo a su manera:
// `stopSessions` cerraba todo como `'sub'`; el descarte de grilla, como
// `overrideType ?? 'sub'`; los de foco y calidad, derivando el tipo de la
// respuesta con su propia expresión; la ruta de error HLS, con
// `gridStreamOverride ?? 'sub'`. Con el backend redirigiendo `sub` → `main` o
// `main_h264`, todas fallaban en el mismo sentido: se pedía cerrar un tipo que
// no existía y la sesión real —con su FFmpeg— quedaba viva.
//
// Y quedaba una segunda mitad, peor: resolver bien el TIPO no alcanza, porque
// el tipo no identifica la SOLICITUD. Dos intentos distintos aterrizan en la
// misma ranura `(user, view, cámara, tipo)` cuando el backend redirige, y el
// descarte del viejo cerraba la sesión del nuevo. Por eso todo cierre por
// respuesta tardía viaja con su `startAttemptId` y el backend lo compara antes
// de tocar nada.

import { resolveCreatedType, type StreamInfoLike, type StreamKind } from './streamTypes'
import type { SessionRegistry } from './sessionRegistry'
import { STALE_RESPONSE } from './closeReasons'
import { cierreConfirmado, type PendingCloseQueue } from './pendingCloses'

/**
 * Desenlace declarado por el servidor. `undefined` significa que no se pudo
 * leer —401, 500, red caída, descarga de la página—, y eso NO es confirmación.
 */
export interface CloseAck {
  emitted: boolean
  status?: number
  outcome?: 'ignored' | 'attempt_released' | 'session_closed'
  /** Por qué se ignoró: distingue "no había nada" de "me lo rechazaron". */
  reason?: string
  attemptId?: string
  remainingAttempts?: number
  /** Si además se terminó el FFmpeg de verdad. */
  killedFfmpeg?: boolean
  /** Token de retención del proceso conservado (cierre conservador). */
  retentionToken?: string
}

export type CloseFn = (
  cameraId: string,
  streamType: StreamKind,
  reason: string,
  viewId: string,
  /** Sólo para cierres por respuesta tardía. */
  expectedStartAttemptId?: string,
  /** Token de retención, para escalar (matar) un proceso conservado. */
  retentionToken?: string,
) => Promise<CloseAck> | CloseAck | void

export interface CloseTrackedDeps {
  cameraIds: readonly string[]
  registry: SessionRegistry
  reason: string
  viewId: string
  close: CloseFn
  /**
   * Cola de cierres sin confirmar. Lo que el servidor no confirmó NO se olvida:
   * se anota acá para reintentarlo.
   */
  pending?: PendingCloseQueue
  onClose?: (info: TrackedCloseResult) => void
}

export interface ClosedRef { streamType: StreamKind; startAttemptId: string }

export interface TrackedCloseResult {
  cameraId: string
  /** Todo lo que se intentó cerrar (cámara ya expandida a arrendamientos). */
  targets: ClosedRef[]
  /** Arrendamientos cuyo cierre confirmó el servidor (o que ya no existían). */
  confirmadas: ClosedRef[]
  /** Arrendamientos sin cierre confirmado: siguen anotados y se reintentan. */
  pendientes: ClosedRef[]
}

/**
 * Cierra TODAS las sesiones registradas de las cámaras dadas, cada una con su
 * tipo real Y su identidad de arrendamiento.
 *
 * Una cámara puede tener dos sesiones vivas a la vez —el `sub` de la grilla y
 * el `main`/`main_h264` del foco—, y una ranura puede tener más de un
 * arrendamiento: se recorre entrada por entrada.
 *
 * LLEVA IDENTIDAD. Es un cierre deliberado (transición, salida de foco,
 * desmontaje), pero eso no lo autoriza a cerrar "lo que haya": un retry tardío
 * podría toparse con una sesión B abierta después sobre la misma cámara/tipo.
 * Cada cierre declara el `startAttemptId` que estaba soltando, y el backend
 * suelta sólo ése.
 *
 * SÓLO SE OLVIDA LO CONFIRMADO. Antes se hacía `registry.forget(cameraId)`
 * pasara lo que pasara con la petición: un 500, una red caída o un `ignored` del
 * backend borraban igual la anotación de una sesión que seguía viva, y ya nadie
 * volvía a intentarlo. Para el HD eso ni siquiera lo recogía el TTL, porque el
 * heartbeat de la grilla renueva su vencimiento mientras la pestaña siga
 * abierta.
 */
export async function closeTrackedSessions(d: CloseTrackedDeps): Promise<TrackedCloseResult[]> {
  const objetivos = d.cameraIds
    .map(cameraId => ({ cameraId, entries: d.registry.entriesOf(cameraId) }))
    .filter(x => x.entries.length > 0)

  if (objetivos.length === 0) return []

  const acks = await Promise.all(
    objetivos.map(async ({ cameraId, entries }) => ({
      cameraId,
      resultados: await Promise.all(entries.map(async e => {
        try {
          return {
            ref: { streamType: e.streamType, startAttemptId: e.startAttemptId },
            ack: await Promise.resolve(
              // El `startAttemptId` viaja como `expectedStartAttemptId`: el
              // backend suelta sólo este arrendamiento, nunca el de otra sesión.
              d.close(cameraId, e.streamType, d.reason, d.viewId, e.startAttemptId),
            ),
          }
        } catch {
          // Una excepción es exactamente lo contrario de una confirmación.
          return { ref: { streamType: e.streamType, startAttemptId: e.startAttemptId }, ack: undefined }
        }
      })),
    })),
  )

  const salida: TrackedCloseResult[] = acks.map(({ cameraId, resultados }) => {
    const confirmadas: ClosedRef[] = []
    const pendientes: ClosedRef[] = []
    for (const { ref, ack } of resultados) {
      if (cierreConfirmado(ack ?? undefined, ref.startAttemptId)) {
        confirmadas.push(ref)
        // SÓLO la identidad confirmada: si mientras el request esperaba se
        // registró una B en la misma ranura, `removeType` amplio la borraría.
        d.registry.removeAttempt(cameraId, ref.streamType, ref.startAttemptId)
        d.pending?.resolve(cameraId, ref.streamType, ref.startAttemptId)
      } else {
        pendientes.push(ref)
        // La anotación se CONSERVA y además se encola: la interfaz ya no está
        // en foco, así que la cola es lo único que recuerda que hay que cerrar.
        d.pending?.add({
          cameraId, streamType: ref.streamType, startAttemptId: ref.startAttemptId,
          reason: d.reason,
          lastOutcome: ack?.outcome ?? (ack?.status ? `http_${ack.status}` : 'no_ack'),
        })
      }
    }
    return { cameraId, targets: [...confirmadas, ...pendientes], confirmadas, pendientes }
  })

  salida.forEach(x => d.onClose?.(x))
  return salida
}

export interface RetryPendingDeps {
  pending: PendingCloseQueue
  registry: SessionRegistry
  viewId: string
  close: CloseFn
  onRetry?: (info: {
    cameraId: string; streamType: StreamKind; startAttemptId: string
    attempts: number; resuelto: boolean
  }) => void
}

/**
 * Reintenta los cierres que quedaron sin confirmar.
 *
 * Se llama desde la cadencia del heartbeat: es el único reloj que la vista ya
 * tiene y que sólo late con la pestaña visible, así que no genera tráfico con
 * el usuario ausente. Cada reintento reenvía la MISMA identidad que la cola
 * recuerda; el backend suelta sólo ese arrendamiento, así que un retry viejo
 * jamás cierra una sesión nueva sobre la misma cámara/tipo. Lo confirmado limpia
 * su anotación local y sale de la cola; el resto sigue esperando.
 */
export async function retryPendingCloses(d: RetryPendingDeps): Promise<{
  resueltos: number; siguenPendientes: number
}> {
  const cola = d.pending.list()
  if (cola.length === 0) return { resueltos: 0, siguenPendientes: 0 }

  let resueltos = 0
  for (const p of cola) {
    let ack: CloseAck | void
    try {
      ack = await Promise.resolve(
        d.close(p.cameraId, p.streamType, p.reason, d.viewId, p.startAttemptId),
      )
    } catch {
      ack = undefined
    }
    const ok = cierreConfirmado(ack ?? undefined, p.startAttemptId)
    if (ok) {
      resueltos++
      d.pending.resolve(p.cameraId, p.streamType, p.startAttemptId)
      // Sólo la identidad confirmada: nunca `removeType`, que se llevaría una B
      // registrada después sobre la misma ranura.
      d.registry.removeAttempt(p.cameraId, p.streamType, p.startAttemptId)
    } else {
      d.pending.add({
        cameraId: p.cameraId, streamType: p.streamType, startAttemptId: p.startAttemptId,
        reason: p.reason,
        lastOutcome: ack?.outcome ?? (ack?.status ? `http_${ack.status}` : 'no_ack'),
      })
    }
    d.onRetry?.({
      cameraId: p.cameraId, streamType: p.streamType, startAttemptId: p.startAttemptId,
      attempts: p.attempts + 1, resuelto: ok,
    })
  }
  return { resueltos, siguenPendientes: d.pending.size() }
}

export interface CloseOneDeps {
  cameraId: string
  streamType: StreamKind
  reason: string
  viewId: string
  registry: SessionRegistry
  pending?: PendingCloseQueue
  close: CloseFn
  onClose?: (info: {
    startAttemptId: string; resuelto: boolean; outcome?: string; status?: number
  }) => void
}

/**
 * Cierre deliberado de UNA ranura concreta —salir de foco, volver a baja
 * calidad—, arrendamiento por arrendamiento y con identidad.
 *
 * Existía como `void closeStreamSession(...)` seguido de `removeType(...)`: se
 * descartaba la promesa y se borraba la anotación sin mirar el resultado; y aun
 * cuando pasó a mirar el resultado, `removeType` era amplio —se llevaba una B
 * registrada mientras el request esperaba—. Ahora recorre las identidades que la
 * vista conoce, cierra cada una declarándola, y sólo quita la que el servidor
 * confirmó. Lo no confirmado queda en la cola para reintentar.
 *
 * Devuelve true si TODOS los arrendamientos de la ranura quedaron resueltos.
 */
export async function closeOneSession(d: CloseOneDeps): Promise<boolean> {
  const attempts = d.registry.attemptsOf(d.cameraId, d.streamType)
  if (attempts.length === 0) return true   // nada que la vista sepa que hay que cerrar

  let todosResueltos = true
  for (const startAttemptId of attempts) {
    let ack: CloseAck | void
    try {
      ack = await Promise.resolve(
        d.close(d.cameraId, d.streamType, d.reason, d.viewId, startAttemptId),
      )
    } catch {
      ack = undefined
    }
    const resuelto = cierreConfirmado(ack ?? undefined, startAttemptId)
    if (resuelto) {
      d.registry.removeAttempt(d.cameraId, d.streamType, startAttemptId)
      d.pending?.resolve(d.cameraId, d.streamType, startAttemptId)
    } else {
      todosResueltos = false
      d.pending?.add({
        cameraId: d.cameraId, streamType: d.streamType, startAttemptId, reason: d.reason,
        lastOutcome: ack?.outcome ?? (ack?.status ? `http_${ack.status}` : 'no_ack'),
      })
    }
    d.onClose?.({
      startAttemptId, resuelto,
      outcome: ack && typeof ack === 'object' ? ack.outcome : undefined,
      status: ack && typeof ack === 'object' ? ack.status : undefined,
    })
  }
  return todosResueltos
}

export interface CloseExactDeps {
  cameraId: string
  streamType: StreamKind
  /** EL arrendamiento exacto a soltar. Se cierra sólo éste, jamás otro de la ranura. */
  startAttemptId: string
  reason: string
  viewId: string
  registry: SessionRegistry
  pending?: PendingCloseQueue
  close: CloseFn
  onClose?: (info: {
    resuelto: boolean; outcome?: string; status?: number
  }) => void
}

/**
 * Cierra UN arrendamiento EXACTO por identidad —un `cameraId + tipo +
 * startAttemptId`—, no toda la ranura.
 *
 * Es lo que necesita una transición que ya tiene la instantánea de lo que había:
 * `closeOneSession` recorre TODOS los arrendamientos del tipo, así que llamarlo
 * una vez por entrada de la instantánea cerraría de más (una B registrada
 * después sobre la misma ranura). Acá se declara el intento y el backend suelta
 * sólo ése. Sólo se olvida lo confirmado; lo demás queda en la cola.
 */
export async function closeExactAttempt(d: CloseExactDeps): Promise<boolean> {
  let ack: CloseAck | void
  try {
    ack = await Promise.resolve(
      d.close(d.cameraId, d.streamType, d.reason, d.viewId, d.startAttemptId),
    )
  } catch {
    ack = undefined
  }
  const resuelto = cierreConfirmado(ack ?? undefined, d.startAttemptId)
  if (resuelto) {
    d.registry.removeAttempt(d.cameraId, d.streamType, d.startAttemptId)
    d.pending?.resolve(d.cameraId, d.streamType, d.startAttemptId)
  } else {
    d.pending?.add({
      cameraId: d.cameraId, streamType: d.streamType, startAttemptId: d.startAttemptId,
      reason: d.reason,
      lastOutcome: ack?.outcome ?? (ack?.status ? `http_${ack.status}` : 'no_ack'),
    })
  }
  d.onClose?.({
    resuelto,
    outcome: ack && typeof ack === 'object' ? ack.outcome : undefined,
    status: ack && typeof ack === 'object' ? ack.status : undefined,
  })
  return resuelto
}

/**
 * Aplica los `stoppedIds` de un heartbeat al registro.
 *
 * `reconcileView` SÓLO detiene sesiones `sub`: la lista que recorre —las
 * cámaras que el view tenía y ya no ve— se alimenta exclusivamente de arranques
 * de ese tipo, y las de `main`/`main_h264` tienen ciclo de vida explícito.
 *
 * Olvidar la cámara entera —lo que se hacía— borraba de la vista la anotación
 * de un HD concurrente que seguía vivo en el backend. Nadie volvía a cerrarlo y
 * su FFmpeg se quedaba hasta el TTL.
 *
 * Devuelve las entradas realmente quitadas.
 */
export function forgetStoppedSubSessions(
  registry: SessionRegistry,
  stoppedIds: readonly string[],
): Array<{ cameraId: string; streamType: StreamKind }> {
  const quitadas: Array<{ cameraId: string; streamType: StreamKind }> = []
  for (const cameraId of stoppedIds) {
    for (const quitada of registry.removeType(cameraId, 'sub')) {
      quitadas.push({ cameraId, streamType: quitada.streamType })
    }
  }
  return quitadas
}

export interface CloseStaleDeps {
  cameraId: string
  /** Respuesta REAL del backend: de ahí sale el tipo que de verdad se creó. */
  info: StreamInfoLike | null | undefined
  /** Lo que se pidió, sólo como último recurso de la resolución. */
  requested: StreamKind
  /**
   * Intento que originó ESTA solicitud. Viaja al backend como
   * `expectedStartAttemptId`: si la sesión vigente pertenece a otro intento, el
   * cierre es un no-op total del otro lado.
   */
  startAttemptId: string
  viewId: string
  close: CloseFn
  /**
   * Cola de cierres sin confirmar. OBLIGATORIA: un descarte por respuesta tardía
   * cuyo DELETE devuelve 500/401/red/cuerpo ilegible/`ignored` no confirmatorio
   * describe una sesión que puede seguir viva. Sin encolarlo, esa sesión se
   * pierde —en ViewPlayer ni siquiera estaba registrada— y sólo la recogería el
   * TTL, que para el HD el heartbeat de grilla renueva. Se exige en la firma
   * para que ningún llamador nuevo pueda volver a olvidarse.
   */
  pending: PendingCloseQueue
  /**
   * Registro de sesiones de la vista. La entrada se quita DESPUÉS de saber que
   * se cerró, y sólo si sigue siendo de este intento: quitarla antes borraba la
   * anotación de la sesión vigente de otra solicitud.
   */
  registry?: SessionRegistry
  onClose?: (info: {
    cameraId: string; created: StreamKind; startAttemptId: string
    confirmed: boolean; outcome?: CloseAck['outcome']; status?: number
  }) => void
}

export interface StaleCloseResult {
  created: StreamKind
  /** Desenlace declarado por el servidor, si se pudo leer. */
  outcome?: CloseAck['outcome']
  /** Estado HTTP, si hubo respuesta. */
  status?: number
  /**
   * El SERVIDOR confirmó haber soltado o cerrado exactamente este
   * arrendamiento. No es "la petición salió".
   */
  confirmed: boolean
  /** Se quitó la entrada del registro (confirmado y de este intento). */
  registryEntryRemoved: boolean
  /**
   * Se anotó en la cola de pendientes para reintentar. Es lo contrario de
   * `confirmed`: o se confirmó y se limpió, o quedó pendiente.
   */
  enqueued: boolean
}

/**
 * Cierra la sesión que creó una respuesta que llegó tarde.
 *
 * Dos cosas la distinguen de un cierre normal:
 *
 *   · la razón es `stale_response` —`viewport_changed` no está en el conjunto
 *     del backend que autoriza matar FFmpeg, y el proceso quedaba vivo—;
 *   · lleva `expectedStartAttemptId`, así que si la ranura ya pertenece a otra
 *     solicitud el backend no borra la sesión, no avanza la marca de cierre y
 *     no mata ningún proceso.
 */
export async function closeStaleStart(d: CloseStaleDeps): Promise<StaleCloseResult> {
  const created = resolveCreatedType(d.info, d.requested)

  // El cierre no puede romper el descarte: una excepción es exactamente lo
  // contrario de una confirmación, igual que en `closeOneSession`.
  let ack: CloseAck | void
  try {
    ack = await Promise.resolve(
      d.close(d.cameraId, created, STALE_RESPONSE, d.viewId, d.startAttemptId),
    )
  } catch {
    ack = undefined
  }

  // CONFIRMACIÓN: EL MISMO contrato que la cola de pendientes, no una copia.
  //
  // `cierreConfirmado` es la única definición de "este arrendamiento ya no está
  // vivo", y la comparte con `closeOneSession`/`retryPendingCloses`. Duplicar la
  // regla acá —lo que se hacía— la dejaba desincronizada: la versión local sólo
  // aceptaba `attempt_released`/`session_closed` de ESTE intento y trataba un
  // `ignored/no_session` como NO confirmado, así que reencolaba para siempre un
  // cierre de una sesión que el backend ya declaró inexistente. Ahora:
  //
  //   · `session_closed`/`attempt_released` de ESTE intento → confirmado;
  //   · `ignored` por ausencia inequívoca (`no_session`/`already_gone`) →
  //     confirmado: no hay ranura que cerrar, nada que reintentar;
  //   · `attempt_not_registered`, un `session_closed` sin `attemptId`, un 401/
  //     500, un cuerpo ilegible o una red caída → NO confirman: se reintenta.
  const outcome = ack && typeof ack === 'object' ? ack.outcome : undefined
  const status  = ack && typeof ack === 'object' ? ack.status  : undefined
  const confirmed = cierreConfirmado(ack ?? undefined, d.startAttemptId)

  const registryEntryRemoved = confirmed
    ? (d.registry?.removeAttempt(d.cameraId, created, d.startAttemptId) ?? false)
    : false

  // LO NO CONFIRMADO NO SE OLVIDA. En un descarte de ViewPlayer la sesión ni
  // siquiera llegó a registrarse, así que la cola es la ÚNICA memoria de que
  // hay algo que cerrar. Se encola por IDENTIDAD —tipo efectivo + intento— para
  // que el reintento suelte exactamente este arrendamiento y jamás una sesión B
  // que haya ocupado la ranura después. No se registra el intento a mano sólo
  // para poder reintentarlo: la fuente correcta es la cola.
  let enqueued = false
  if (!confirmed) {
    d.pending.add({
      cameraId: d.cameraId, streamType: created, startAttemptId: d.startAttemptId,
      reason: STALE_RESPONSE,
      lastOutcome: outcome ?? (status ? `http_${status}` : 'no_ack'),
    })
    enqueued = true
  } else {
    // Confirmado: si por un retry anterior ya había una anotación en la cola,
    // se limpia. Idempotente.
    d.pending.resolve(d.cameraId, created, d.startAttemptId)
  }

  d.onClose?.({
    cameraId: d.cameraId, created, startAttemptId: d.startAttemptId,
    confirmed, outcome, status,
  })
  return { created, outcome, status, confirmed, registryEntryRemoved, enqueued }
}
