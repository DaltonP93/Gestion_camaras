// Vigencia PUBLICADA en el commit, no en el cleanup pasivo.
//
// POR QUÉ EXISTE
//
// La generación de carga vivía en un ref que sólo se invalidaba en el cleanup de
// un `useEffect` —una fase PASIVA, posterior a la pintura—. Entre el commit de la
// ruta nueva (B ya renderizada) y ese cleanup puede correr una continuación de
// Promise de la vieja (A): su microtarea se despacha antes de la fase pasiva, así
// que todavía pasaba `isCurrent()` y aplicaba estado de A sobre B.
//
// La corrección: publicar el scope nuevo SÍNCRONAMENTE en el commit
// (`useLayoutEffect`, que corre dentro del mismo task del commit, antes de que se
// despache ninguna continuación). Publicar uno nuevo invalida al anterior de
// inmediato: una identidad capturada por A deja de ser vigente en cuanto B monta,
// sin depender de que corra el cleanup de A.
//
// La identidad es un `symbol` único por publicación: la comparación es de
// IDENTIDAD EXACTA, no de valor —dos publicaciones nunca colisionan, ni siquiera
// tras un remonte del mismo `id`—.

export interface ScopeGuard {
  /** Publica un scope NUEVO, lo deja vigente y devuelve su identidad. */
  publish(): symbol
  /** La identidad vigente en este momento. */
  current(): symbol
  /** ¿Esta identidad sigue siendo la vigente? */
  isCurrent(scope: symbol): boolean
  /** Invalida ESTA identidad si sigue vigente (cleanup); si ya la reemplazaron, no hace nada. */
  invalidate(scope: symbol): void
}

export function createScopeGuard(): ScopeGuard {
  let vigente = Symbol('scope')
  return {
    publish() {
      // Publicar uno nuevo invalida al anterior en el acto: cualquier identidad
      // capturada antes deja de coincidir.
      vigente = Symbol('scope')
      return vigente
    },
    current() { return vigente },
    isCurrent(scope) { return vigente === scope },
    invalidate(scope) {
      // Sólo si sigue siendo la vigente: si ya la reemplazó una publicación
      // posterior, invalidar acá borraría por error la identidad nueva.
      if (vigente === scope) vigente = Symbol('invalidated')
    },
  }
}
