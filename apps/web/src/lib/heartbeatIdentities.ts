// Reconciliación de IDENTIDAD desde una respuesta de heartbeat/reconcile.
//
// POR QUÉ EXISTE
//
// El backend devuelve, por cámara, TODOS los arrendamientos vigentes de la sesión
// (`startAttemptIds`): el `srv-*` que acuñó el reconcile más cualquier `sa-*` de
// un start cuya respuesta HTTP se perdió. El cliente debe registrar CADA uno por
// su tipo efectivo para poder cerrarlos todos en una transición.
//
// Se extrae aquí, SEPARADA de la mutación visual de las páginas, por dos razones:
//
//   · una cámara en fallback (`gridStreamOverride`) no debe pisar su URL, pero SÍ
//     debe recuperar su ownership —antes el `continue` del override saltaba el
//     registro y la sesión quedaba sin identidad—;
//   · no debe hacerse como efecto lateral dentro del updater de `setStreams`.
//
// Recibe sólo los streams y un `register`: NO conoce el override, así que por
// construcción no puede saltárselo. Es pura y testeable sin DOM.

import { resolveCreatedType, type StreamInfoLike, type StreamKind } from './streamTypes'

export interface HeartbeatStreamInfo extends StreamInfoLike {
  startAttemptId?: string
  startAttemptIds?: string[]
}

/**
 * Registra la identidad REAL de cada arrendamiento de cada cámara. Nunca fabrica
 * ids: una cámara sin `startAttemptIds`/`startAttemptId` no anota nada.
 */
export function registerHeartbeatIdentities(
  streams: Record<string, HeartbeatStreamInfo>,
  register: (cameraId: string, effectiveType: StreamKind, attemptId: string) => void,
): void {
  for (const cameraId of Object.keys(streams)) {
    const info = streams[cameraId]
    const ids: string[] = info?.startAttemptIds ?? (info?.startAttemptId ? [info.startAttemptId] : [])
    for (const aid of ids) register(cameraId, resolveCreatedType(info, 'sub'), aid)
  }
}
