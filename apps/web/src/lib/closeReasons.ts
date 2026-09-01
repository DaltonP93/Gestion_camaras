// Razones de cierre: contrato con el backend.
//
// POR QUÉ IMPORTA CADA LETRA
//
// El backend mantiene `TRANSCODE_KILL_REASONS`: sólo con una de esas razones
// termina el FFmpeg de una sesión `main_h264`. Con cualquier otra, la sesión se
// borra pero el proceso queda vivo a propósito, para que un reintento pueda
// reutilizarlo.
//
// El frontend estaba enviando `viewport_changed` para las respuestas tardías, y
// el conjunto del backend contiene `viewport_change`. Una letra de diferencia y
// el resultado es un FFmpeg sin espectador: la sesión desaparece —así que nadie
// la va a reutilizar— pero el proceso sigue corriendo hasta que lo recoja la
// poda por inactividad.
//
// Acá viven las razones que el frontend emite, separadas por lo que ESPERA del
// backend. La prueba de contrato del API lee este archivo y comprueba, una por
// una, que cada razón de `MATAN_FFMPEG` esté en `TRANSCODE_KILL_REASONS` y que
// ninguna de `CONSERVAN_FFMPEG` lo esté. Si cualquiera de los dos lados cambia
// una cadena, esa prueba falla.

/**
 * Cierre de una respuesta que llegó tarde: pertenece a un viewport, un foco o
 * una selección de calidad que ya no existe. Nadie la va a reutilizar, así que
 * el proceso tiene que morir con ella.
 *
 * Es una razón PROPIA, distinta de `viewport_change`: aquélla describe el
 * cierre ordenado de la vista anterior; ésta, una sesión que nació huérfana.
 * Distinguirlas es lo que permite leer en los logs cuál de los dos caminos dejó
 * trabajo sin dueño.
 */
export const STALE_RESPONSE = 'stale_response'

/** Cierre de las sesiones de la vista que se abandona en una transición. */
export const VIEWPORT_CHANGE = 'viewport_change'

/**
 * Salida de pantalla completa en `ViewPlayerPage`: el HD que se estaba mirando
 * ya no tiene espectador, así que su FFmpeg tiene que morir con la sesión. Es
 * una razón PROPIA de esa página, distinta de `exit_focus` de la grilla en
 * vivo, para poder leer en los logs cuál de los dos caminos cerró el HD.
 */
export const EXIT_FULLSCREEN = 'exit_fullscreen'

/** Razones que el frontend emite y que DEBEN terminar el FFmpeg. */
export const MATAN_FFMPEG = [
  STALE_RESPONSE,
  VIEWPORT_CHANGE,
  EXIT_FULLSCREEN,
  'exit_focus',
  'switch_to_sub',
  'stop_all',
  'nvr_change',
  'page_change',
  'layout_change',
] as const

/**
 * Razones que el frontend emite y que NO deben terminar el FFmpeg: son fallos
 * transitorios o reintentos, y el próximo arranque reutiliza el proceso vivo.
 */
export const CONSERVAN_FFMPEG = [
  'hls_fatal_error',
  'grid_retry',
  'quality_switch',
  // Reinicio manual de una cámara: el endpoint `/restart-stream` ya reinicia el
  // FFmpeg por su cuenta. El cierre que lo acompaña sólo suelta el arrendamiento
  // por identidad; si además matara el proceso habría una carrera de doble
  // kill+respawn con el propio restart.
  'restart_stream',
] as const

export type CloseReason = (typeof MATAN_FFMPEG)[number] | (typeof CONSERVAN_FFMPEG)[number]

/**
 * Clasificación ÚNICA de fuerza de intención (no duplicar la lista en otros
 * módulos). Un cierre FUERTE (terminante) autoriza matar el FFmpeg; uno DÉBIL
 * (conservador) lo conserva para reutilización. `stale_response` es fuerte
 * —una sesión huérfana debe morir con su proceso—.
 */
export function esCierreFuerte(reason: string): boolean {
  return (MATAN_FFMPEG as readonly string[]).includes(reason)
}

/** La razón MÁS FUERTE entre dos: débil + fuerte = fuerte, sin importar el orden. */
export function razonMasFuerte(a: string, b: string): string {
  if (esCierreFuerte(b) && !esCierreFuerte(a)) return b
  return a
}
