// Decisión de calidad de stream en la vista en vivo (PR B). PURA y testeable.
//
// Política adaptativa: las grillas (2×2/3×3/4×4) usan el SUBSTREAM; el 1×1 y el foco
// (deep-link ?focus=1 o pantalla completa) usan el PRINCIPAL. El backend redirige main→
// main_h264 cuando el principal es HEVC y hay transcodificación; si el principal es HEVC
// y NO hay transcodificación, se cae al substream con aviso (no hay upscale del sub).

export type LiveStreamType = 'sub' | 'main' | 'main_h264'

export interface QualityDecision {
  // Lo que se solicita al backend. Para HEVC con transcode se pide 'main' y el backend
  // responde con main_h264 (no se fuerza main_h264 desde el cliente).
  streamType: LiveStreamType
  profile: 'grid' | 'focus'
  // true cuando el principal no es reproducible en web (HEVC sin transcode): el llamador
  // debe usar el substream y avisar al usuario.
  fallbackToSub: boolean
}

export interface QualityInput {
  layout: number            // 1 | 4 | 9 | 16 (celdas)
  focus: boolean            // foco explícito (deep-link o pantalla completa)
  mainCodecIsHevc: boolean  // el principal está en H.265/HEVC
  transcodeEnabled: boolean // FFmpeg disponible + transcodificación habilitada
}

const SUB: QualityDecision = { streamType: 'sub', profile: 'grid', fallbackToSub: false }

export function decideStreamRequest(input: QualityInput): QualityDecision {
  const wantsMain = input.focus || input.layout === 1
  if (!wantsMain) return SUB   // grillas 2×2/3×3/4×4 → sub

  // Se desea calidad principal.
  if (input.mainCodecIsHevc && !input.transcodeEnabled) {
    // HEVC sin transcodificación: el navegador no reproduce H.265 → substream + aviso.
    return { streamType: 'sub', profile: 'grid', fallbackToSub: true }
  }
  // H.264 principal → main directo (sin FFmpeg). HEVC + transcode → se pide main y el
  // backend redirige a main_h264. En ambos casos, perfil de foco (alta calidad).
  return { streamType: 'main', profile: 'focus', fallbackToSub: false }
}

// ¿La celda debe reproducir en calidad principal según el layout/foco actual?
export function wantsMainQuality(layout: number, focus: boolean): boolean {
  return focus || layout === 1
}
