// apps/native/shared/playback.ts
//
// Núcleo compartido del cliente nativo (C22, Hito 3). Define la interfaz de
// reproducción común a Windows/Android/iOS y la máquina de estados. Es TS puro,
// sin DOM ni Node, para poder compartirse y probarse. El decoder real por
// plataforma implementa `NativeVideoAdapter` en el backend nativo (Rust/Tauri).

export type PlaybackState =
  | 'idle' | 'opening' | 'playing' | 'paused' | 'stopped' | 'error' | 'disposed'

export type MediaCodec = 'h264' | 'hevc'
export type NativeTransport = 'rtsps' | 'whep'

/**
 * Grant efímero tal como lo recibe el cliente del API. NO contiene credenciales
 * de NVR ni URIs RTSP: sólo la identidad del stream y el secreto opaco.
 */
export interface EphemeralMediaGrant {
  grantId: string
  secret: string
  transport: NativeTransport
  streamPath: string
  codec: MediaCodec
  expiresAt: number
}

export interface NetworkStats {
  bitrateKbps: number
  rttMs: number
  droppedFrames: number
}

export interface PlaybackCallbacks {
  onFirstFrame?: (info: { atMs: number }) => void
  onError?: (err: { code: string; message: string }) => void
  onCodec?: (codec: MediaCodec) => void
  onHardwareDecoder?: (hardware: boolean) => void
  onNetworkStats?: (stats: NetworkStats) => void
}

export interface NativePlayerHandle {
  readonly id: string
}

export interface AdapterCapabilities {
  codecs: MediaCodec[]
  hardwareDecodedCodecs: MediaCodec[]
  transports: NativeTransport[]
  maxHardwareDecoders: number
}

/**
 * Frontera estable que cada plataforma implementa con su decoder de hardware
 * (Media Foundation / MediaCodec / VideoToolbox). Sólo lectura: nunca publica ni
 * administra; recibe un grant y reproduce el restream autenticado.
 */
export interface NativeVideoAdapter {
  readonly platform: string
  capabilities(): Promise<AdapterCapabilities>
  open(grant: EphemeralMediaGrant, cb: PlaybackCallbacks): Promise<NativePlayerHandle>
  play(handle: NativePlayerHandle): Promise<void>
  pause(handle: NativePlayerHandle): Promise<void>
  stop(handle: NativePlayerHandle): Promise<void>
  dispose(handle: NativePlayerHandle): Promise<void>
}

// Transiciones válidas de la máquina de estados de reproducción.
export const PLAYBACK_TRANSITIONS: Record<PlaybackState, PlaybackState[]> = {
  idle:     ['opening', 'disposed'],
  opening:  ['playing', 'error', 'stopped', 'disposed'],
  playing:  ['paused', 'stopped', 'error', 'disposed'],
  paused:   ['playing', 'stopped', 'error', 'disposed'],
  stopped:  ['opening', 'disposed'],
  error:    ['opening', 'stopped', 'disposed'],
  disposed: [],
}

export function canTransition(from: PlaybackState, to: PlaybackState): boolean {
  return PLAYBACK_TRANSITIONS[from].includes(to)
}
