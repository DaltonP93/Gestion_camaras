// Decisión PURA de "H.265/HEVC no compatible" — extraída para poder testearla sin DOM
// (mismo patrón que hlsRetryPolicy.ts).
//
// EL BUG (P1): la UI mostraba "H.265 no compatible" en cuanto `streamCodec` contenía
// hevc/h265, aunque el fallo real fuera un HTTP 404/500, un timeout, MediaMTX no listo
// o un manifest temporal. Un stream HEVC perfectamente reproducible (o que aún se está
// preparando) NO debe rotularse como incompatible.
//
// REGLA: sólo se declara incompatibilidad cuando hay una señal REAL y confiable:
//   - el error clasificado es CODEC_UNSUPPORTED;
//   - hls.js reportó manifestIncompatibleCodecsError o bufferIncompatibleCodecsError;
//   - o una comprobación explícita del navegador (MediaSource) confirma que el códec
//     no es reproducible.
// El nombre/valor de `streamCodec` por sí solo NUNCA activa esta rama.

/** Detalles de hls.js que sí prueban incompatibilidad de códec (no un fallo de red). */
export const INCOMPATIBLE_CODEC_HLS_DETAILS = [
  'manifestIncompatibleCodecsError',
  'bufferIncompatibleCodecsError',
] as const

export interface CodecUnsupportedInput {
  /** Tipo de stream en reproducción. Sólo el principal ('main') puede ser HEVC nativo. */
  streamType?: string | null
  /** Código de error ya clasificado por el reproductor (p.ej. 'CODEC_UNSUPPORTED', 'MEDIAMTX_NOT_READY'). */
  errorCode?: string | null
  /** `data.details` crudo de hls.js, si está disponible (permite decidir sin depender de la clasificación). */
  hlsErrorDetail?: string | null
  /**
   * Resultado de una comprobación explícita y confiable de incompatibilidad
   * (p.ej. `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') === false`).
   * `undefined`/`null` = no se comprobó; sólo `true` fuerza la incompatibilidad.
   */
  explicitIncompatible?: boolean | null
}

/**
 * ¿Debe mostrarse el overlay "H.265/HEVC no compatible"?
 * Devuelve true SÓLO ante una señal real de incompatibilidad de códec.
 * Nunca por el mero hecho de que el stream sea HEVC.
 */
export function shouldShowCodecUnsupported(input: CodecUnsupportedInput): boolean {
  // Sólo el flujo principal puede requerir H.265→H.264; sub y main_h264 ya son H.264.
  if (input.streamType !== 'main') return false

  if (input.errorCode === 'CODEC_UNSUPPORTED') return true

  const detail = input.hlsErrorDetail || ''
  if ((INCOMPATIBLE_CODEC_HLS_DETAILS as readonly string[]).includes(detail)) return true

  if (input.explicitIncompatible === true) return true

  return false
}
