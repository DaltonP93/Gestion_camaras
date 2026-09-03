// apps/web/src/lib/nativePlaybackSelect.ts
//
// Selección de reproducción en el cliente (C22, Hito 2). Puro y sin DOM para ser
// testeable. Traduce la decisión explícita del servidor a una acción del player
// y — crítico — DESCARTA decisiones tardías cuyo scope ya no corresponde al
// viewport actual (una respuesta vieja no puede aplicar video de otra cámara).

export type LivePlaybackDecision =
  | 'native_hevc' | 'native_h264' | 'server_h264' | 'substream' | 'unavailable'

export type LiveClientTransport = 'hls' | 'whep' | 'rtsps'

export interface ServerDecision {
  decision: LivePlaybackDecision
  transport: LiveClientTransport | null
  waiting: boolean
  cameraId: string
  viewId: string | null
}

export interface ViewportScope {
  cameraId: string
  viewId: string | null
}

export type PlaybackAction = 'native' | 'server' | 'substream' | 'none'

export interface ApplyResult {
  apply: boolean
  action: PlaybackAction
  waiting: boolean
  ignoredReason?: 'STALE_SCOPE' | 'UNAVAILABLE'
}

/**
 * Aplica (o descarta) una decisión del servidor contra el viewport actual.
 * - Si la decisión es de otra cámara/vista que la actual ⇒ se descarta (stale).
 * - `unavailable` no se aplica.
 * - El resto mapea a la acción del player, preservando `waiting`.
 */
export function applyPlaybackDecision(current: ViewportScope, d: ServerDecision): ApplyResult {
  if (d.cameraId !== current.cameraId) {
    return { apply: false, action: 'none', waiting: false, ignoredReason: 'STALE_SCOPE' }
  }
  if (d.viewId && current.viewId && d.viewId !== current.viewId) {
    return { apply: false, action: 'none', waiting: false, ignoredReason: 'STALE_SCOPE' }
  }
  switch (d.decision) {
    case 'native_hevc':
    case 'native_h264':
      return { apply: true, action: 'native', waiting: false }
    case 'server_h264':
      return { apply: true, action: 'server', waiting: d.waiting }
    case 'substream':
      return { apply: true, action: 'substream', waiting: d.waiting }
    case 'unavailable':
    default:
      return { apply: false, action: 'none', waiting: false, ignoredReason: 'UNAVAILABLE' }
  }
}

// ─── construcción del payload de negociación ────────────────────────
export type LiveClientRuntime = 'web' | 'windows' | 'android' | 'ios'
export type LiveClientCodec = 'h264' | 'hevc'

export interface DeviceProbe {
  runtime: LiveClientRuntime
  /** El dispositivo decodifica H.264 por hardware. */
  hwH264: boolean
  /** El dispositivo decodifica HEVC por hardware. */
  hwHevc: boolean
  transports: LiveClientTransport[]
  maxHardwareDecoders?: number
}

export interface ClientCapabilitiesPayload {
  runtime: LiveClientRuntime
  codecs: LiveClientCodec[]
  hardwareDecodedCodecs: LiveClientCodec[]
  transports: LiveClientTransport[]
  maxHardwareDecoders?: number
  cameraId?: string
  viewId?: string
}

/**
 * Construye el cuerpo para POST /api/live-view/client-capabilities. `codecs`
 * declara lo que se puede reproducir (H.264 siempre, más HEVC si hay hw);
 * `hardwareDecodedCodecs` sólo lo acelerado por hardware.
 */
export function buildClientCapabilities(
  probe: DeviceProbe,
  scope?: { cameraId?: string; viewId?: string },
): ClientCapabilitiesPayload {
  const hw: LiveClientCodec[] = []
  if (probe.hwH264) hw.push('h264')
  if (probe.hwHevc) hw.push('hevc')
  const codecs: LiveClientCodec[] = Array.from(new Set<LiveClientCodec>(['h264', ...hw]))
  return {
    runtime: probe.runtime,
    codecs,
    hardwareDecodedCodecs: hw,
    transports: probe.transports,
    maxHardwareDecoders: probe.maxHardwareDecoders,
    cameraId: scope?.cameraId,
    viewId: scope?.viewId,
  }
}
