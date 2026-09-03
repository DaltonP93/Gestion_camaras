// Contrato de negociación para clientes de LiveView.
//
// C21 NO habilita todavía acceso nativo directo: MediaMTX no posee hoy una
// credencial efímera por sesión y nunca debemos entregar las credenciales del
// NVR al dispositivo. Este contrato permite que Windows/Android/iOS anuncien
// su decodificación local sin fingir que el relay seguro ya existe.

export const LIVE_PLAYBACK_CONTRACT_VERSION = 1 as const

export type LiveClientRuntime = 'web' | 'windows' | 'android' | 'ios'
export type LiveClientCodec = 'h264' | 'hevc'
export type LiveClientTransport = 'hls' | 'whep' | 'rtsps'

export interface LiveClientCapabilitiesInput {
  runtime: LiveClientRuntime
  codecs: LiveClientCodec[]
  hardwareDecodedCodecs: LiveClientCodec[]
  transports: LiveClientTransport[]
  maxHardwareDecoders?: number
}

export interface LivePlaybackServerCapabilities {
  ffmpegAvailable: boolean
  transcodingEnabled: boolean
  maxTranscodeSessions: number
}

export function negotiateLivePlaybackCapabilities(
  input: LiveClientCapabilitiesInput,
  server: LivePlaybackServerCapabilities,
) {
  const nativeRuntime = input.runtime !== 'web'
  const hardwareHevc = nativeRuntime && input.hardwareDecodedCodecs.includes('hevc')
  const nativeTransport = input.transports.includes('rtsps') || input.transports.includes('whep')
  const localDecoderCandidate = hardwareHevc && nativeTransport
  const serverTranscodeAvailable = server.ffmpegAvailable && server.transcodingEnabled

  return {
    contractVersion: LIVE_PLAYBACK_CONTRACT_VERSION,
    runtime: input.runtime,
    // Refleja capacidad declarada del dispositivo; no promete que tantas
    // cámaras funcionarán, porque también limitan red, GPU, NVR y MediaMTX.
    client: {
      hardwareHevc,
      maxHardwareDecoders: Math.max(1, Math.min(64, input.maxHardwareDecoders ?? 1)),
      localDecoderCandidate,
    },
    browserFallback: {
      mode: serverTranscodeAvailable ? 'server_hls_transcode' : 'h264_direct_only',
      h264DirectAvailable: true,
      hevcServerTranscodeAvailable: serverTranscodeAvailable,
      maxConcurrentServerTranscodes: Math.max(0, server.maxTranscodeSessions),
    },
    nativeDirect: {
      // Se mantiene falso hasta que exista relay autenticado con token efímero.
      // Tener decoder HEVC local no autoriza a saltarse el control de acceso.
      available: false,
      candidate: localDecoderCandidate,
      blockingReason: localDecoderCandidate
        ? 'SECURE_RELAY_NOT_IMPLEMENTED'
        : 'CLIENT_CAPABILITY_MISSING',
      requiredTransport: 'rtsps_or_authenticated_whep',
      consumesServerTranscodeSlot: false,
    },
    security: {
      rawNvrCredentialsExposed: false,
      shortLivedRelayCredentialRequired: true,
    },
  }
}
