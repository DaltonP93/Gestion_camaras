// Cola de cierres CONFIRMADOS PENDIENTES, por IDENTIDAD del objetivo.
//
// POR QUÉ EXISTE
//
// La vista daba por cerrada una sesión en cuanto emitía el DELETE. Si el
// servidor respondía 401, 500 o `ignored` —o si la red se caía— la sesión seguía
// viva y la anotación local desaparecía igual: a partir de ahí nadie sabía que
// existía y nadie volvía a intentarlo.
//
// "Que la recoja el TTL" no alcanza para el HD. El heartbeat de la grilla toca
// la sesión `main`/`main_h264` co-locada para renovar su TTL —y debe seguir
// haciéndolo mientras el usuario mira la grilla—, así que una sesión HD que
// quedó sin cerrar puede no vencer nunca mientras la pestaña siga abierta. Su
// FFmpeg se queda corriendo sin espectador.
//
// POR QUÉ LLEVA IDENTIDAD
//
// La cola guardaba sólo `cameraId + streamType`. Un retry de `exit_focus` del
// intento A, disparado tarde, podía cerrar una sesión B abierta después sobre la
// MISMA cámara/tipo —el usuario volvió a foco mientras el cierre esperaba—. La
// entrada recuerda el `startAttemptId` que se estaba cerrando; el retry lo
// declara y el backend sólo suelta ESE arrendamiento. B nunca se toca.

import type { StreamKind } from './streamTypes'
import { razonMasFuerte } from './closeReasons'

export interface PendingClose {
  cameraId: string
  streamType: StreamKind
  /** Arrendamiento que este cierre estaba soltando. NUNCA se cierra otro. */
  startAttemptId: string
  reason: string
  /** Intentos de cierre ya realizados, incluido el primero. */
  attempts: number
  /** Último desenlace observado, para diagnóstico. */
  lastOutcome?: string
}

export interface PendingCloseAdd {
  cameraId: string
  streamType: StreamKind
  startAttemptId: string
  reason: string
  lastOutcome?: string
}

export interface PendingCloseQueue {
  /** Anota un cierre sin confirmar. Idempotente por cámara+tipo+intento. */
  add(entry: PendingCloseAdd): void
  /** Lo olvida: el cierre se confirmó, o ya no hay nada que cerrar. */
  resolve(cameraId: string, streamType: StreamKind, startAttemptId: string): boolean
  /** Todo lo que sigue pendiente, en orden de alta. */
  list(): PendingClose[]
  size(): number
  has(cameraId: string, streamType: StreamKind, startAttemptId: string): boolean
  clear(): PendingClose[]
}

const clave = (cameraId: string, streamType: StreamKind, startAttemptId: string) =>
  `${cameraId}:${streamType}:${startAttemptId}`

export function createPendingCloseQueue(): PendingCloseQueue {
  const cola = new Map<string, PendingClose>()

  return {
    add(entry) {
      const k = clave(entry.cameraId, entry.streamType, entry.startAttemptId)
      const previo = cola.get(k)
      cola.set(k, {
        cameraId: entry.cameraId,
        streamType: entry.streamType,
        startAttemptId: entry.startAttemptId,
        // Se CONSERVA LA INTENCIÓN MÁS FUERTE, no la primera razón. Si un cierre
        // débil (hls_fatal_error) encoló primero y luego llega uno fuerte
        // (page_change), el reintento debe reenviar el FUERTE —si no, el retry
        // confirmaría el débil, conservaría el FFmpeg y la intención terminante
        // desaparecería (defecto P0-1 de C19)—. Débil+fuerte = fuerte, en
        // cualquier orden; dos de la misma fuerza conservan la primera.
        reason: previo ? razonMasFuerte(previo.reason, entry.reason) : entry.reason,
        attempts: (previo?.attempts ?? 0) + 1,
        lastOutcome: entry.lastOutcome,
      })
    },

    resolve(cameraId, streamType, startAttemptId) {
      return cola.delete(clave(cameraId, streamType, startAttemptId))
    },
    list() { return Array.from(cola.values()).map(x => ({ ...x })) },
    size() { return cola.size },
    has(cameraId, streamType, startAttemptId) {
      return cola.has(clave(cameraId, streamType, startAttemptId))
    },
    clear() {
      const out = Array.from(cola.values())
      cola.clear()
      return out
    },
  }
}

/**
 * ¿El desenlace de un cierre confirma que ESTE arrendamiento ya no está vivo?
 *
 * El cierre carga siempre una identidad (`expectedStartAttemptId`), así que la
 * confirmación tiene que hablar de ella. Cuenta como resuelto —dejar de
 * reintentar y quitar la anotación local del intento— sólo si:
 *
 *   · `session_closed` o `attempt_released` PARA ESTE intento (attemptId
 *     coincide): el backend soltó exactamente lo que pedimos;
 *   · `ignored` por AUSENCIA INEQUÍVOCA de la sesión objetivo (`no_session`,
 *     `already_gone`): no hay ranura que cerrar, nada que reintentar.
 *
 * `attempt_not_registered` NO confirma. Significa "hay una sesión en la ranura,
 * pero sin ESTE arrendamiento" — no que la sesión no exista. Tratarlo como
 * confirmación fue la regresión del correctivo 7: una sesión de reconcile
 * anotada con un id que el backend nunca registró (`hb:*`) respondía
 * `attempt_not_registered`, el cliente la olvidaba, y la sesión y su FFmpeg
 * quedaban vivos. Se conserva la anotación y se reintenta; con la identidad que
 * acuña el servidor el reintento termina en `session_closed`.
 *
 * Todo lo demás queda pendiente: un `session_closed`/`attempt_released` de OTRO
 * intento (no es asunto nuestro), un `ignored` por rechazo
 * (`reaffirmed_by_newer_request`, `replaced_by_newer_generation`), un error
 * HTTP, una respuesta ilegible o una red caída describen un arrendamiento que
 * puede seguir vivo.
 */
export function cierreConfirmado(
  ack: { outcome?: string; reason?: string; attemptId?: string } | null | undefined,
  expectedStartAttemptId: string,
): boolean {
  if (!ack) return false
  if (ack.outcome === 'session_closed' || ack.outcome === 'attempt_released') {
    return ack.attemptId === expectedStartAttemptId
  }
  if (ack.outcome === 'ignored') {
    // Ausencia inequívoca de la sesión objetivo, o resolución EXPLÍCITA de una
    // retención (el proceso fue adoptado por un sucesor, o ya no existe): en los
    // dos casos no hay nada más que cerrar ni reintentar.
    if (ack.reason === 'no_session' || ack.reason === 'already_gone') return true
    if (ack.reason === 'retention_adopted' || ack.reason === 'retention_gone') {
      // Una resolución de retención es por capability/identidad exacta: no
      // puede confirmar el cierre de A si el backend habló de B (o no identificó
      // ningún intento).
      return ack.attemptId === expectedStartAttemptId
    }
  }
  return false
}
