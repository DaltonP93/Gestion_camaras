// apps/api/src/playback-video/media/timecode.ts
//
// Franja de tiempo de los videos de prueba: cada cuadro lleva, en sus primeras 24
// filas (640 px de ancho), el instante de grabación que representa.
//
//   40 bloques de 16 px: [0] referencia blanca, [1] referencia negra,
//   [2..25] 24 bits del número de cuadro desde EPOCH_BASE, [26..29] 4 bits de
//   canal, [30..37] 8 bits de checksum, [38] blanca, [39] negra.
//
// Checksum: (101 + Σ bit_k · STRIP_WEIGHTS[k]) mod 256 sobre los 28 bits de datos
// (cuadro y canal), con un peso impar DISTINTO por bit en [3, 127]. Así cualquier
// error de lectura de 1 o 2 bloques (datos o checksum) se detecta: un bit de datos
// suma ±peso impar (≠ 0 y ≠ ±2^i salvo 2^0, excluido con peso ≥ 3) y dos pesos
// distintos menores que 128 no se cancelan. La versión anterior, (F·7 + …) mod 256,
// no veía los bits 8–23 del cuadro (7·2^b ≡ 0 mod 256): un error ahí movía el tiempo
// leído en múltiplos de 10,24 s y pasaba como cuadro válido. Pesos elegidos por
// búsqueda para minimizar los errores no detectados en ráfagas de hasta 8 bloques
// (≈ 0,3 % de esos patrones; con la fórmula anterior, ≈ 28 %). El generador
// (`generate.ts`, expresión geq) y DECODER_JS usan esta MISMA tabla.
//
// El decodificador es UN SOLO texto JavaScript (`DECODER_JS`): se inyecta tal cual
// en el navegador (addInitScript) y se evalúa en Node con `new Function`. Así el
// navegador y las pruebas leen la franja con exactamente el mismo algoritmo.

/** 2026-10-01T00:00:00Z: el cuadro 0 de la franja. Con 24 bits a 25 fps alcanza ~7,7 días. */
export const EPOCH_BASE_S = 1790812800
export const STRIP_WIDTH = 640
export const STRIP_HEIGHT = 24
export const STRIP_FPS = 25

/** Peso del checksum de cada bit de datos: [0..23] cuadro (LSB primero), [24..27] canal. */
export const STRIP_WEIGHTS: readonly number[] = [
  63, 5, 91, 119, 37, 79, 99, 9, 21, 51, 23, 11, 109, 101, 97, 49, 15, 73, 117, 107, 113, 57, 13, 29,
  83, 71, 41, 65,
]
/** Constante inicial del checksum (una franja toda negra o toda blanca no lo cumple). */
export const STRIP_CHECKSUM_BASE = 101

export type DecodeResult =
  | { ok: true; frame: number; channel: number; recMs: number }
  | { ok: false; reason: 'sin_referencias' | 'checksum' }

/** Código fuente del decodificador (función `decodeStrip(luma, width, fps)`). */
export const DECODER_JS = String.raw`
function decodeStrip(luma, width, fps) {
  fps = fps || ${STRIP_FPS}
  var k = width / ${STRIP_WIDTH}
  function block(i) {
    var s = 0, n = 0
    var cx = (i * 16 + 8) * k, cy = 12 * k
    for (var dy = -3; dy <= 3; dy++) for (var dx = -3; dx <= 3; dx++) { s += luma(Math.round(cx + dx * k), Math.round(cy + dy * k)); n++ }
    return s / n
  }
  var white = (block(0) + block(38)) / 2, black = (block(1) + block(39)) / 2
  if (white - black < 80) return { ok: false, reason: 'sin_referencias' }
  var thr = (white + black) / 2
  function bit(i) { return block(i) > thr ? 1 : 0 }
  var W = ${JSON.stringify(STRIP_WEIGHTS)}
  var F = 0, ch = 0, cs = 0, sum = ${STRIP_CHECKSUM_BASE}, b, v
  for (b = 0; b < 24; b++) { v = bit(2 + b); F += v * Math.pow(2, b); sum += v * W[b] }
  for (b = 0; b < 4; b++) { v = bit(26 + b); ch += v * Math.pow(2, b); sum += v * W[24 + b] }
  for (b = 0; b < 8; b++) cs += bit(30 + b) * Math.pow(2, b)
  if (cs !== sum % 256) return { ok: false, reason: 'checksum' }
  return { ok: true, frame: F, channel: ch, recMs: ${EPOCH_BASE_S} * 1000 + Math.round(F * 1000 / fps) }
}`

// eslint-disable-next-line no-new-func
export const decodeStrip = new Function(`${DECODER_JS}; return decodeStrip`)() as
  (luma: (x: number, y: number) => number, width: number, fps?: number) => DecodeResult

/** Decodifica un cuadro gris de STRIP_WIDTH×STRIP_HEIGHT (1 byte por píxel). */
export function decodeGrayStrip(buf: Uint8Array): DecodeResult {
  const W = STRIP_WIDTH
  const H = STRIP_HEIGHT
  return decodeStrip((x, y) => buf[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))], W)
}

/** Número de cuadro de la franja para un instante (ms) a `fps`. */
export function frameIndexFor(epochMs: number, fps = STRIP_FPS): number {
  return Math.round(((epochMs - EPOCH_BASE_S * 1000) * fps) / 1000)
}

/** Checksum de 8 bits que el generador escribe (debe coincidir con DECODER_JS). */
export function stripChecksum(frame: number, channel: number): number {
  let sum = STRIP_CHECKSUM_BASE
  for (let b = 0; b < 24; b++) sum += (Math.floor(frame / 2 ** b) % 2) * STRIP_WEIGHTS[b]
  for (let b = 0; b < 4; b++) sum += (Math.floor(channel / 2 ** b) % 2) * STRIP_WEIGHTS[24 + b]
  return sum % 256
}
