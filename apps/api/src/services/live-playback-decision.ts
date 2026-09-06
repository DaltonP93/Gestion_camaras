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
  /**
   * C23·H2·P3 — ¿El path EXACTO tiene una mediaInstanceId vigente? (misma
   * verificación que exige la emisión). `false` ⇒ la emisión respondería
   * NO_MEDIA_INSTANCE, así que NO se elige nativo. Opcional: `undefined` ≡ listo,
   * para no romper llamadores/tests previos que no conocen esta señal.
   */
  mediaInstanceReady?: boolean
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
  // El path exacto sin instancia ⇒ la emisión daría NO_MEDIA_INSTANCE.
  if (input.mediaInstanceReady === false) return 'NO_MEDIA_INSTANCE'
  if (eff.type === 'main' && !input.access.hd) return 'HD_PERMISSION_MISSING'
  return 'CLIENT_CAPABILITY_MISSING'
}

/** ¿Es elegible el nativo directo? (readiness + dispositivo + RBAC del tipo efectivo + instancia por path). */
function nativeTransportIfEligible(input: LivePlaybackDecisionInput): LiveClientTransport | null {
  if (!input.nativePlaybackEnabled || !input.relayReady) return null
  // Sin instancia vigente para el path EXACTO no puede haber nativo (la emisión se
  // negaría con NO_MEDIA_INSTANCE). `undefined` ≡ listo (compatibilidad).
  if (input.mediaInstanceReady === false) return null
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

// ─── admisión / espera de cupo (helper PURO, no cableado al flujo real) ──
export interface AdmissionInput { maxSlots: number; activeSlots: number; cancelRequested: boolean }
export interface AdmissionResult { action: 'start' | 'wait' | 'cancelled'; retriable: boolean }

/**
 * NOTA (honestidad): predicado PURO probado. La aplicación real del límite de 2
 * transcodes sigue en el lifecycle de stream-manager (invariante C1–C21); esto
 * NO es un flujo nuevo cableado.
 */
export function decideAdmissionOrWait(i: AdmissionInput): AdmissionResult {
  if (i.cancelRequested) return { action: 'cancelled', retriable: false }
  if (i.activeSlots < i.maxSlots) return { action: 'start', retriable: false }
  return { action: 'wait', retriable: true }
}
