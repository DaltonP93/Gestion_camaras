// Política de reintentos de HLS (pura y testeable, sin depender de hls.js/DOM).
//
// Motivación: un 500 del substream normal suele ser MediaMTX iniciando la fuente
// (transitorio), no un fallo definitivo. Antes se fallaba de inmediato (0
// reintentos) y eso disparaba un fallback innecesario a main_h264. Esta política
// concede una ventana de preparación con backoff antes de declarar el fallo.

export const NORMAL_500_BACKOFF = [1000, 2000, 4000, 6000, 8000] as const

export interface HlsRetryDecision {
  shouldRetry: boolean
  delayMs: number
  maxRetries: number
  // true cuando conviene mostrar un overlay "Preparando stream…" en vez de error rojo
  preparing: boolean
}

/**
 * Decide si reintentar la carga HLS ante un error de red.
 * @param statusCode  código HTTP del error (500/404/…), o undefined
 * @param isTranscoded  stream main_h264 (transcodificado) vs substream normal
 * @param retryCount  reintentos ya realizados (0-based)
 */
export function hlsRetryDecision(
  statusCode: number | undefined,
  isTranscoded: boolean,
  retryCount: number,
): HlsRetryDecision {
  const is500 = statusCode === 500
  const is404 = statusCode === 404

  const maxRetries = is500
    ? (isTranscoded ? 40 : NORMAL_500_BACKOFF.length)   // substream normal: 5 (antes 0)
    : is404
      ? (isTranscoded ? 20 : 1)
      : 5

  if (retryCount >= maxRetries) {
    return { shouldRetry: false, delayMs: 0, maxRetries, preparing: false }
  }

  const delayMs = is500 && isTranscoded ? 800
    : is500 ? NORMAL_500_BACKOFF[Math.min(retryCount, NORMAL_500_BACKOFF.length - 1)]
    : is404 && isTranscoded ? 1000
    : is404 ? 4000
    : 3000 * (retryCount + 1)

  // Durante un 500 (transitorio) mostramos "preparando", no error
  const preparing = is500
  return { shouldRetry: true, delayMs, maxRetries, preparing }
}
