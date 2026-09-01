// Identidad de una OPERACIÓN LÓGICA de arranque de stream.
//
// POR QUÉ HACE FALTA UNA IDENTIDAD MÁS
//
// El cierre de una respuesta tardía ya resuelve bien el tipo efectivo, pero no
// identifica QUÉ solicitud creó la sesión que pretende cerrar. Con el backend
// redirigiendo, dos solicitudes distintas terminan en la misma identidad:
//
//   A pide `main`  → el backend la redirige y crea `main_h264`
//   B pide `main_h264` para la misma cámara y vista → queda vigente
//   B responde primero, registra y aplica
//   A responde tarde y su descarte cierra… `(userId, viewId, cameraId, main_h264)`
//
// Esa cuádrupla es exactamente la de B. El DELETE de A llega con un ticket
// NUEVO —posterior al de B—, así que las defensas por watermark y por
// `lastOwnerRequestSeq` lo dejan pasar: borra la sesión vigente de B y mata su
// FFmpeg. El usuario ve la cámara caerse sola.
//
// El `startAttemptId` cierra ese hueco: identifica el intento, no la ranura.
// Nace ANTES del POST, viaja con él, el backend lo guarda como propietario de
// la sesión efectiva, y el cierre por respuesta tardía lo declara como
// `expectedStartAttemptId`. Si no coincide con el de la sesión vigente, el
// cierre no hace absolutamente nada.
//
// DEBE SOBREVIVIR AL REINTENTO POR 401: el interceptor de axios reenvía la
// MISMA configuración tras renovar el JWT, así que el cuerpo —y con él el
// identificador— es el mismo. Por eso se genera acá, una sola vez por operación
// lógica, y no dentro de la capa de transporte.

/** Identificador de un intento de arranque. Opaco: sólo se compara. */
export type StartAttemptId = string

let contador = 0

/**
 * Genera un identificador único para UNA operación lógica de arranque.
 *
 * Se llama una vez por operación —grilla, foco/HD, cambio de calidad—, nunca
 * por petición HTTP: un reintento del interceptor forma parte de la misma
 * operación y tiene que conservar el identificador.
 */
export function newStartAttemptId(): StartAttemptId {
  contador += 1
  const base = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  // El contador local desempata dos llamadas dentro del mismo milisegundo en el
  // camino de reserva, donde `Math.random` podría —remotamente— repetirse.
  return `sa-${base}-${contador}`
}

/** Longitud máxima aceptada por el API. Se comparte para no divergir. */
export const START_ATTEMPT_ID_MAX = 128

/**
 * Forma válida de un identificador. El API aplica la MISMA regla: caracteres
 * seguros para viajar en una query de DELETE sin escapar sorpresas, y una cota
 * de longitud para que no pueda usarse como vector de crecimiento de memoria.
 */
export const START_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

export function isValidStartAttemptId(value: unknown): value is StartAttemptId {
  return typeof value === 'string' && START_ATTEMPT_ID_PATTERN.test(value)
}
