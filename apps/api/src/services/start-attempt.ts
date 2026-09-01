// Validación del intento de arranque declarado por el cliente.
//
// El `startAttemptId` es lo único que distingue dos solicitudes de arranque que
// aterrizan en la misma ranura `(user, view, cámara, tipo)` cuando el backend
// redirige `main` → `main_h264`. Viaja en el cuerpo del POST de arranque y en la
// query del DELETE de cierre.
//
// Dos motivos para validarlo y no aceptarlo tal cual:
//
//   · viaja en una query de DELETE, así que se restringe a caracteres que no
//     obliguen a escapar nada;
//   · se guarda en el mapa de sesiones en memoria, así que una longitud sin cota
//     sería un vector de crecimiento.
//
// La MISMA regla vive en `apps/web/src/lib/startAttempt.ts` y la compara la
// prueba de contrato: si un lado la cambia, el otro deja de aceptar lo que el
// primero emite y las sesiones se quedarían sin dueño.

export const START_ATTEMPT_ID_MAX = 128
export const START_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

/**
 * Devuelve el identificador si es válido, o `undefined`.
 *
 * Un valor mal formado NO rechaza la petición de arranque: el arranque es
 * legítimo y el único efecto de quedarse sin intento es que ningún cierre por
 * respuesta tardía podrá cerrar esa sesión —el TTL sigue cubriéndola—. En el
 * cierre, en cambio, la ausencia sí lo invalida entero, y de eso se ocupa
 * `decideStaleClose`.
 */
export function readStartAttemptId(value: unknown): string | undefined {
  return typeof value === 'string' && START_ATTEMPT_ID_PATTERN.test(value) ? value : undefined
}
