// src/lib/hdSessionTtl.ts
//
// TTL EFECTIVO de la sesión HD, tal como lo resuelve el backend.
//
// El frontend NO puede suponer 90 s: `STREAM_HD_IDLE_TIMEOUT` es configurable y
// el servidor además lo normaliza y lo acota (un 5 corre como 15). Si la UI
// asumiera 90 s, con un TTL efectivo mayor pediría HD sin necesidad, y con uno
// menor dejaría la tarjeta sin reanudar. El valor llega en
// `GET /api/live-view/capabilities` ya normalizado; acá sólo se valida que sea
// utilizable (revisión de #146).

/** Forma parcial de la respuesta de capacidades que nos interesa. */
export interface CapabilitiesTtl {
  streamIdleTimeoutMs?: number
  streamHdIdleTimeoutMs?: number
}

/**
 * PURA. Devuelve el TTL de HD a usar. Sólo acepta un número finito y positivo;
 * cualquier otra cosa (campo ausente por backend anterior, cero, negativo, NaN
 * o una cadena) cae al default documentado.
 */
export function resolveHdSessionTtlMs(caps: CapabilitiesTtl, fallbackMs: number): number {
  const v = caps?.streamHdIdleTimeoutMs
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallbackMs
  return v
}

/** Mismo criterio para el TTL estándar. */
export function resolveStandardSessionTtlMs(caps: CapabilitiesTtl, fallbackMs: number): number {
  const v = caps?.streamIdleTimeoutMs
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fallbackMs
  return v
}
