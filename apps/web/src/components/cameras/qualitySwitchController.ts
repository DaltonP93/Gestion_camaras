// Single-flight / mutex del cambio de calidad por cámara — lógica PURA (P1).
//
// EL PROBLEMA: clics rápidos en Baja/Alta/Trans (o reintentos) disparaban un POST
// start-stream por cada clic, saturando el backend y provocando procesos FFmpeg de más
// y respuestas fuera de orden que "pisaban" la última selección del usuario.
//
// SOLUCIÓN: por cameraId se mantiene una secuencia monótona y una selección pendiente.
//   - clic del MISMO tipo mientras hay uno pendiente → se ignora;
//   - clic de OTRO tipo → supersede: nueva secuencia; la respuesta de la selección
//     anterior queda invalidada (es una respuesta tardía y se descarta);
//   - sólo la respuesta cuya secuencia siga siendo la última (`isCurrent`) se aplica.
// La UI además deshabilita los botones mientras hay una solicitud en vuelo.

export interface QualitySwitchState {
  /** Última secuencia emitida para esta cámara (monótona). */
  latestSeq: number
  /** Selección en vuelo, o null si no hay ninguna. */
  pending: { quality: string; seq: number } | null
}

export type QualitySwitchDecision =
  | { action: 'proceed'; seq: number }
  | { action: 'ignore'; reason: 'same-pending' }

export function initialState(): QualitySwitchState {
  return { latestSeq: 0, pending: null }
}

/** Decisión PURA ante un clic. Devuelve el nuevo estado y la acción a tomar. */
export function decideRequest(
  state: QualitySwitchState,
  quality: string,
): { state: QualitySwitchState; decision: QualitySwitchDecision } {
  // Mismo tipo que el pendiente → ignorar (evita POST duplicado idéntico).
  if (state.pending && state.pending.quality === quality) {
    return { state, decision: { action: 'ignore', reason: 'same-pending' } }
  }
  // Otro tipo (o nada pendiente) → supersede con nueva secuencia.
  const seq = state.latestSeq + 1
  return {
    state: { latestSeq: seq, pending: { quality, seq } },
    decision: { action: 'proceed', seq },
  }
}

/** ¿La respuesta de `seq` sigue siendo la selección vigente? (descarta respuestas tardías) */
export function isCurrent(state: QualitySwitchState, seq: number): boolean {
  return seq === state.latestSeq
}

/** Limpia el pendiente si `seq` era el vigente (la solicitud se resolvió). */
export function settle(state: QualitySwitchState, seq: number): QualitySwitchState {
  if (state.pending && state.pending.seq === seq && seq === state.latestSeq) {
    return { ...state, pending: null }
  }
  return state
}

/**
 * Controlador con estado por cámara, construido sobre las funciones puras de arriba.
 * Instanciar uno por componente (useRef) para no filtrar estado entre montajes.
 */
export function createQualitySwitchController() {
  const byCamera = new Map<string, QualitySwitchState>()
  const get = (id: string) => byCamera.get(id) ?? initialState()

  return {
    /** Registra un clic. Devuelve la decisión (proceed+seq | ignore). */
    request(cameraId: string, quality: string): QualitySwitchDecision {
      const { state, decision } = decideRequest(get(cameraId), quality)
      byCamera.set(cameraId, state)
      return decision
    },
    /** ¿La respuesta de `seq` sigue vigente para esa cámara? */
    isCurrent(cameraId: string, seq: number): boolean {
      return isCurrent(get(cameraId), seq)
    },
    /** Marca la solicitud `seq` como resuelta (limpia el pendiente si era el vigente). */
    settle(cameraId: string, seq: number): void {
      byCamera.set(cameraId, settle(get(cameraId), seq))
    },
    /** ¿Hay una solicitud en vuelo para esa cámara? (para deshabilitar botones) */
    isPending(cameraId: string): boolean {
      return get(cameraId).pending !== null
    },
    /** Tipo de calidad de la solicitud en vuelo, o null. */
    pendingQuality(cameraId: string): string | null {
      return get(cameraId).pending?.quality ?? null
    },
  }
}

export type QualitySwitchController = ReturnType<typeof createQualitySwitchController>
