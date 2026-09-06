// apps/api/src/services/live-playback-decision.ts
//
// Decisión EXPLÍCITA y COHERENTE de reproducción (C22, endurecida C22.2/P0-5).
//
//  - Nativo SÓLO si el relay está REALMENTE listo (NativeRelayReadiness) y el
//    usuario puede obtener el grant elegido (RBAC compartido con la emisión):
//    HEVC nativo consume el main ⇒ exige acceso HD (canHighQuality).
//  - Nunca inicia un tercer transcode: sin cupo, conserva substream y espera.
//  - Razones estructuradas, incluidas falta de permiso HD y backend no listo.

import type {
  LiveClientCapabilitiesInput,
  LivePlaybackServerCapabilities,
  LiveClientTransport,
} from './live-playback-capabilities'
import type { LivePlaybackDecision, LivePlaybackReason } from './media/contracts'

export interface LivePlaybackDecisionInput {
  client: LiveClientCapabilitiesInput
  server: LivePlaybackServerCapabilities
  /** Readiness UNIFICADA del relay (no `!!redis`). */
  relayReady: boolean
  nativePlaybackEnabled: boolean
  camera: { mainCodec: 'h264' | 'hevc' | 'unknown' }
  capacity: { availableTranscodeSlots: number }
  /** RBAC del usuario para esta cámara (mismo predicado que la emisión). */
  access: { live: boolean; hd: boolean }
}

export interface LivePlaybackDecisionResult {
  decision: LivePlaybackDecision
  reason: LivePlaybackReason
  transport: LiveClientTransport | null
  consumesServerTranscodeSlot: boolean
  waiting: boolean
  nativeBlockedReason?: LivePlaybackReason
}

function pickNativeTransport(client: LiveClientCapabilitiesInput): LiveClientTransport | null {
  if (client.transports.includes('rtsps')) return 'rtsps'
  if (client.transports.includes('whep')) return 'whep'
  return null
}

/** El tipo/codec efectivo del NATIVO según la cámara (HEVC ⇒ main; si no, sub). */
function nativeEffective(input: LivePlaybackDecisionInput): { codec: 'h264' | 'hevc'; type: 'sub' | 'main' } {
  return input.camera.mainCodec === 'hevc' ? { codec: 'hevc', type: 'main' } : { codec: 'h264', type: 'sub' }
}

function deviceNativeCapable(input: LivePlaybackDecisionInput, codec: 'h264' | 'hevc'): boolean {
  if (input.client.runtime === 'web') return false
  if (!input.client.hardwareDecodedCodecs.includes(codec)) return false
  if ((input.client.maxHardwareDecoders ?? 1) < 1) return false
  return pickNativeTransport(input.client) !== null
}

function nativeBlockedReason(input: LivePlaybackDecisionInput): LivePlaybackReason {
  if (!input.nativePlaybackEnabled) return 'NATIVE_PLAYBACK_FLAG_DISABLED'
  const eff = nativeEffective(input)
  if (!deviceNativeCapable(input, eff.codec)) return 'CLIENT_CAPABILITY_MISSING'
  if (!input.relayReady) return 'RELAY_BACKEND_NOT_READY'
  if (eff.type === 'main' && !input.access.hd) return 'HD_PERMISSION_MISSING'
  return 'CLIENT_CAPABILITY_MISSING'
}

/** ¿Es elegible el nativo directo? (readiness + dispositivo + RBAC del tipo efectivo). */
function nativeTransportIfEligible(input: LivePlaybackDecisionInput): LiveClientTransport | null {
  if (!input.nativePlaybackEnabled || !input.relayReady) return null
  const eff = nativeEffective(input)
  if (!deviceNativeCapable(input, eff.codec)) return null
  // RBAC: el usuario debe poder obtener el grant del tipo efectivo.
  if (eff.type === 'main' ? !input.access.hd : !input.access.live) return null
  return pickNativeTransport(input.client)
}

function serverFallback(input: LivePlaybackDecisionInput): LivePlaybackDecisionResult {
  const serverTranscodeAvailable = input.server.ffmpegAvailable && input.server.transcodingEnabled
  if (!serverTranscodeAvailable) {
    return { decision: 'substream', reason: 'SUBSTREAM_TRANSCODE_UNAVAILABLE', transport: 'hls', consumesServerTranscodeSlot: false, waiting: false }
  }
  if (input.capacity.availableTranscodeSlots <= 0) {
    return { decision: 'substream', reason: 'SUBSTREAM_WHILE_WAITING_CAPACITY', transport: 'hls', consumesServerTranscodeSlot: false, waiting: true }
  }
  return { decision: 'server_h264', reason: 'SERVER_TRANSCODE_FALLBACK', transport: 'hls', consumesServerTranscodeSlot: true, waiting: false }
}

export function decideLivePlayback(input: LivePlaybackDecisionInput): LivePlaybackDecisionResult {
  // Sin acceso de visualización en vivo ⇒ nada es reproducible.
  if (!input.access.live) {
    return { decision: 'unavailable', reason: 'CAMERA_ACCESS_DENIED', transport: null, consumesServerTranscodeSlot: false, waiting: false }
  }

  const t = nativeTransportIfEligible(input)
  if (t) {
    const eff = nativeEffective(input)
    return {
      decision: eff.codec === 'hevc' ? 'native_hevc' : 'native_h264',
      reason: eff.codec === 'hevc' ? 'NATIVE_HEVC_LOCAL_DECODE' : 'NATIVE_H264_LOCAL_DECODE',
      transport: t, consumesServerTranscodeSlot: false, waiting: false,
    }
  }

  const blocked = input.nativePlaybackEnabled ? nativeBlockedReason(input) : undefined

  // Cámara H.264: sin transcode (directo). Cámara HEVC/desconocida: fallback servidor.
  if (input.camera.mainCodec === 'h264') {
    return { decision: 'server_h264', reason: 'SERVER_H264_DIRECT', transport: 'hls', consumesServerTranscodeSlot: false, waiting: false, nativeBlockedReason: blocked }
  }
  return { ...serverFallback(input), nativeBlockedReason: blocked }
}
