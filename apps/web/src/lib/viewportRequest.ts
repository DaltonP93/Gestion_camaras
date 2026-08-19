// Ciclo de vida de una solicitud que puede resolver DESPUÉS de un cambio de
// viewport.
//
// POR QUÉ EXISTE
//
// El arranque de un stream, la entrada en foco, la readquisición de HD y el
// cambio de calidad comparten exactamente la misma forma:
//
//   1. capturar la identidad del viewport actual,
//   2. pedirle algo al backend,
//   3. y al volver, decidir si la respuesta todavía describe lo que el usuario
//      ve.
//
// El paso 3 tiene una trampa que se pagó en producción: si la respuesta llegó
// tarde, NO basta con "no aplicar". El backend ya creó la sesión, y dejarla
// viva es un FFmpeg sin espectador hasta que venza el TTL (90 s) más la poda
// (hasta 120 s más). Por eso una respuesta vieja tiene que CERRAR lo que creó.
//
// La segunda trampa es la contabilidad: `pendingStarts` es interna y hay que
// limpiarla siempre —si no, la cámara queda bloqueada para futuros arranques—,
// mientras que el estado VISIBLE (spinner, errores) pertenece al viewport
// vigente y una solicitud vieja no puede tocarlo.
//
// Escrito una sola vez acá, las cuatro rutas no pueden divergir. Es puro: las
// pruebas ejecutan la secuencia completa con promesas reales y el coordinador
// de transición real, sin DOM.

export interface ViewportRequestDeps<T> {
  /** ¿El token capturado por quien llama sigue siendo el vigente? */
  isCurrent: () => boolean
  /** La llamada al backend. */
  request: () => Promise<T>
  /** Aplica el resultado. Sólo corre si el viewport no cambió. */
  apply: (result: T) => void | Promise<void>
  /**
   * La respuesta pertenece a un viewport abandonado. Acá se cierra lo que el
   * backend haya creado. No puede tocar estado del viewport nuevo.
   */
  discard: (result: T) => void
  /** Error del viewport vigente. Un error viejo no muestra nada a nadie. */
  onError?: (error: unknown) => void | Promise<void>
  /** Contabilidad interna: corre SIEMPRE, vigente o no. */
  always?: () => void
  /** Estado visible: sólo si la solicitud sigue perteneciendo al viewport. */
  settleIfCurrent?: () => void
}

export type ViewportRequestOutcome =
  /** Vigente y exitosa: se aplicó. */
  | 'applied'
  /** Vieja y exitosa: no se aplicó nada y se cerró lo creado. */
  | 'discarded'
  /** Vigente y fallida: el error es del usuario actual. */
  | 'error'
  /** Vieja y fallida: se ignora en silencio. */
  | 'error_discarded'

export async function runViewportRequest<T>(
  deps: ViewportRequestDeps<T>,
): Promise<ViewportRequestOutcome> {
  try {
    const result = await deps.request()
    // La comprobación va DESPUÉS del await, nunca antes: el viewport pudo
    // cambiar exactamente mientras la solicitud viajaba, que es la ventana en
    // la que aparece el defecto.
    if (!deps.isCurrent()) {
      deps.discard(result)
      return 'discarded'
    }
    await deps.apply(result)
    return 'applied'
  } catch (error) {
    if (!deps.isCurrent()) return 'error_discarded'
    await deps.onError?.(error)
    return 'error'
  } finally {
    deps.always?.()
    if (deps.isCurrent()) deps.settleIfCurrent?.()
  }
}
