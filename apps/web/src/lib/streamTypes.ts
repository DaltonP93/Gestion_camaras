// Tipo de stream REALMENTE creado por el backend.
//
// POR QUÉ NO ALCANZA CON EL TIPO PEDIDO
//
// El backend redirige en más casos de los que el frontend suponía:
//
//   · `main` → `main_h264` cuando el principal es HEVC y hay transcodificación;
//   · `sub`  → `main`      cuando el substream es HEVC y el principal es H.264,
//                          y también con `streamHealthStatus=USING_MAIN_STREAM`;
//   · `sub`  → `main_h264` cuando el substream es HEVC y no hay main H.264.
//
// Es decir: pedir `sub` NO garantiza que la sesión creada sea `sub`. Cerrar el
// tipo pedido en vez del creado no cierra nada — la sesión sigue viva, y si es
// `main_h264` su FFmpeg sigue corriendo sin espectador hasta el TTL.
//
// ORDEN DE RESOLUCIÓN
//
// 1. `info.streamType` — el backend ya publica el tipo efectivo en la respuesta
//    de start-stream (lo deriva él mismo del streamPath). Es la fuente directa.
// 2. `streamPath` terminado en `_main_h264`.
// 3. `streamPath` terminado en `_main`.
// 4. `transcoded === true` — bandera heredada, sólo distingue transcodificado.
// 5. El tipo pedido, como último recurso.
//
// Los pasos 2–5 existen porque una respuesta puede venir de un backend anterior
// —o de una ruta que no rellene todos los campos—, y adivinar mal acá es
// exactamente lo que deja procesos huérfanos.

export type StreamKind = 'sub' | 'main' | 'main_h264'

export interface StreamInfoLike {
  streamType?: string | null
  transcoded?: boolean
  streamPath?: string | null
}

const KINDS: readonly string[] = ['sub', 'main', 'main_h264']

export function isStreamKind(value: unknown): value is StreamKind {
  return typeof value === 'string' && KINDS.includes(value)
}

export function resolveCreatedType(
  info: StreamInfoLike | null | undefined,
  requested: StreamKind,
): StreamKind {
  if (!info) return requested
  // 1 · el tipo efectivo declarado por el backend.
  if (isStreamKind(info.streamType)) return info.streamType
  // 2 y 3 · el sufijo del path, del más específico al más general. Con los
  // sufijos actuales no se solapan —`_main_h264` no termina en `_main`—, así
  // que el orden no cambia el resultado hoy; se respeta igual porque es el que
  // fija el contrato, y un sufijo futuro sí podría solaparse.
  const path = info.streamPath ?? ''
  if (path.endsWith('_main_h264')) return 'main_h264'
  if (path.endsWith('_main')) return 'main'
  // 4 · bandera heredada.
  if (info.transcoded === true) return 'main_h264'
  // 5 · sin nada mejor, lo pedido.
  return requested
}
