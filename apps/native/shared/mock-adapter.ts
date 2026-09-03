// apps/native/shared/mock-adapter.ts
//
// Adaptador en memoria para pruebas del shared-core. Permite compuertar el
// `open` (deferred) para reproducir carreras controladas (cambio de viewport
// mientras un open está en vuelo) sin depender de promesas ya resueltas.

import type {
  NativeVideoAdapter,
  NativePlayerHandle,
  EphemeralMediaGrant,
  PlaybackCallbacks,
  AdapterCapabilities,
} from './playback'

export function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

export class MockAdapter implements NativeVideoAdapter {
  readonly platform = 'mock'
  readonly calls: string[] = []
  lastCallbacks: PlaybackCallbacks | null = null
  /** Si es true, `open` espera a `releaseOpen()` (para carreras controladas). */
  gateOpen = false
  private openGate: { promise: Promise<void>; resolve: (v: void) => void } | null = null

  async capabilities(): Promise<AdapterCapabilities> {
    return { codecs: ['h264', 'hevc'], hardwareDecodedCodecs: ['h264', 'hevc'], transports: ['rtsps'], maxHardwareDecoders: 8 }
  }

  async open(grant: EphemeralMediaGrant, cb: PlaybackCallbacks): Promise<NativePlayerHandle> {
    this.calls.push('open')
    this.lastCallbacks = cb
    if (this.gateOpen) {
      this.openGate = createDeferred<void>()
      await this.openGate.promise
    }
    return { id: `h_${grant.grantId}` }
  }

  releaseOpen(): void { this.openGate?.resolve() }

  /** Si es true, `dispose` espera a `releaseDispose()` (para probar carreras P0-6). */
  gateDispose = false
  private disposeGate: { promise: Promise<void>; resolve: (v: void) => void } | null = null
  releaseDispose(): void { this.disposeGate?.resolve() }

  async play(): Promise<void> { this.calls.push('play') }
  async pause(): Promise<void> { this.calls.push('pause') }
  async stop(): Promise<void> { this.calls.push('stop') }
  async dispose(): Promise<void> {
    this.calls.push('dispose')
    if (this.gateDispose) { this.disposeGate = createDeferred<void>(); await this.disposeGate.promise }
  }
}
