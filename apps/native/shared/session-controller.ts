// apps/native/shared/session-controller.ts
//
// Controlador de una sesión de reproducción nativa sobre un NativeVideoAdapter.
// Comparte los INVARIANTES del lifecycle web (C1-C21) sin duplicar su código:
//
//  - Generación monótona: cada open captura una generación; si el viewport se
//    invalida durante un open en vuelo, esa apertura queda obsoleta y se libera
//    su handle en vez de publicarlo (una respuesta vieja no reactiva un stream).
//  - Callbacks de una generación vieja se descartan (no aplican video/estado).
//  - invalidate()/dispose() liberan el handle de forma idempotente.

import type {
  NativeVideoAdapter,
  NativePlayerHandle,
  EphemeralMediaGrant,
  PlaybackCallbacks,
  PlaybackState,
} from './playback'

export interface OpenResult {
  published: boolean
  reason?: 'STALE' | 'ERROR'
}

export class LivePlaybackSession {
  private _state: PlaybackState = 'idle'
  private handle: NativePlayerHandle | null = null
  private generation = 0
  private disposed = false

  constructor(
    private readonly adapter: NativeVideoAdapter,
    private readonly onState?: (s: PlaybackState) => void,
  ) {}

  get state(): PlaybackState { return this._state }
  get currentGeneration(): number { return this.generation }

  private set(s: PlaybackState): void {
    if (this._state !== s) {
      this._state = s
      this.onState?.(s)
    }
  }

  async open(grant: EphemeralMediaGrant, cb: PlaybackCallbacks): Promise<OpenResult> {
    if (this.disposed) return { published: false, reason: 'ERROR' }
    const gen = ++this.generation
    this.set('opening')

    // Callbacks protegidos por generación: una generación vieja no aplica nada.
    const guarded: PlaybackCallbacks = {
      onFirstFrame: (i) => { if (gen === this.generation) cb.onFirstFrame?.(i) },
      onError: (e) => { if (gen === this.generation) { this.set('error'); cb.onError?.(e) } },
      onCodec: (c) => { if (gen === this.generation) cb.onCodec?.(c) },
      onHardwareDecoder: (h) => { if (gen === this.generation) cb.onHardwareDecoder?.(h) },
      onNetworkStats: (s) => { if (gen === this.generation) cb.onNetworkStats?.(s) },
    }

    let h: NativePlayerHandle
    try {
      h = await this.adapter.open(grant, guarded)
    } catch {
      if (gen === this.generation) this.set('error')
      return { published: false, reason: 'ERROR' }
    }

    // Si el viewport cambió (o se dispuso) durante el open, esta apertura es
    // obsoleta: se libera sin publicar, sin tocar lo que otro ya haya montado.
    if (gen !== this.generation || this.disposed) {
      await this.adapter.dispose(h)
      return { published: false, reason: 'STALE' }
    }

    // P0-4: nunca sobrescribir un handle sin liberarlo. Si había uno previo
    // (open(A) → open(B)), se detiene y dispone A antes de publicar B.
    const prev = this.handle
    this.handle = null
    if (prev) await this.adapter.dispose(prev)

    // P0-6: re-comprobar generación DESPUÉS del await de dispose(prev). Si mientras
    // se esperaba, otra apertura C se publicó (o hubo invalidate/dispose), esta B
    // quedó obsoleta: se dispone su propio handle y se devuelve STALE, SIN
    // sobrescribir lo que C dejó montado.
    if (gen !== this.generation || this.disposed) {
      await this.adapter.dispose(h)
      return { published: false, reason: 'STALE' }
    }

    this.handle = h
    this.set('playing')
    return { published: true }
  }

  async pause(): Promise<void> {
    if (this.handle && this._state === 'playing') {
      await this.adapter.pause(this.handle)
      this.set('paused')
    }
  }

  async resume(): Promise<void> {
    if (this.handle && this._state === 'paused') {
      await this.adapter.play(this.handle)
      this.set('playing')
    }
  }

  async stop(): Promise<void> {
    this.generation++
    const h = this.handle
    this.handle = null
    if (h) await this.adapter.stop(h)
    this.set('stopped')
  }

  /** Cambio de viewport/cámara: invalida trabajo en vuelo y libera el handle. */
  async invalidate(): Promise<void> {
    this.generation++
    const h = this.handle
    this.handle = null
    if (h) await this.adapter.dispose(h)
    this.set('stopped')
  }

  /** Desmontaje definitivo (idempotente). */
  async dispose(): Promise<void> {
    this.disposed = true
    this.generation++
    const h = this.handle
    this.handle = null
    if (h) await this.adapter.dispose(h)
    this.set('disposed')
  }
}
