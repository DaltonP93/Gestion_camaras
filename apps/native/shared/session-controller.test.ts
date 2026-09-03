import { describe, expect, it } from 'vitest'
import { LivePlaybackSession } from './session-controller'
import { MockAdapter } from './mock-adapter'
import { canTransition } from './playback'
import type { EphemeralMediaGrant, PlaybackState } from './playback'

const grant: EphemeralMediaGrant = {
  grantId: 'g1', secret: 's1', transport: 'rtsps', streamPath: 'nvr_cam1_sub', codec: 'hevc', expiresAt: 9e15,
}

describe('máquina de estados', () => {
  it('permite transiciones válidas y rechaza inválidas', () => {
    expect(canTransition('idle', 'opening')).toBe(true)
    expect(canTransition('opening', 'playing')).toBe(true)
    expect(canTransition('disposed', 'playing')).toBe(false)
    expect(canTransition('idle', 'playing')).toBe(false)
  })
})

describe('LivePlaybackSession', () => {
  it('open ⇒ playing; pause/resume; stop', async () => {
    const a = new MockAdapter()
    const states: PlaybackState[] = []
    const s = new LivePlaybackSession(a, (x) => states.push(x))
    expect((await s.open(grant, {})).published).toBe(true)
    expect(s.state).toBe('playing')
    await s.pause(); expect(s.state).toBe('paused')
    await s.resume(); expect(s.state).toBe('playing')
    await s.stop(); expect(s.state).toBe('stopped')
    expect(a.calls).toEqual(['open', 'pause', 'play', 'stop'])
    expect(states).toEqual(['opening', 'playing', 'paused', 'playing', 'stopped'])
  })

  it('callback de la generación vigente se aplica; el de una vieja se descarta', async () => {
    const a = new MockAdapter()
    const s = new LivePlaybackSession(a)
    let frames = 0
    await s.open(grant, { onFirstFrame: () => { frames++ } })
    a.lastCallbacks?.onFirstFrame?.({ atMs: 1 })
    expect(frames).toBe(1)
    // Cambio de viewport: la generación avanza; el callback viejo ya no aplica.
    await s.invalidate()
    a.lastCallbacks?.onFirstFrame?.({ atMs: 2 })
    expect(frames).toBe(1)
  })

  it('CARRERA · viewport invalidado durante el open ⇒ apertura obsoleta se libera, no se publica', async () => {
    const a = new MockAdapter()
    a.gateOpen = true
    const s = new LivePlaybackSession(a)
    const openPromise = s.open(grant, {})   // queda esperando en la compuerta
    expect(s.state).toBe('opening')
    await s.invalidate()                     // el usuario cambió de cámara/vista
    a.releaseOpen()                          // recién ahora resuelve el open viejo
    const result = await openPromise
    expect(result).toEqual({ published: false, reason: 'STALE' })
    expect(s.state).toBe('stopped')          // no quedó en 'playing'
    // El handle recién abierto se liberó (dispose), no quedó huérfano.
    expect(a.calls.filter((c) => c === 'dispose').length).toBeGreaterThanOrEqual(1)
  })

  it('invalidate libera el handle activo (dispose) al cambiar de viewport', async () => {
    const a = new MockAdapter()
    const s = new LivePlaybackSession(a)
    await s.open(grant, {})
    expect(s.state).toBe('playing')
    await s.invalidate()
    expect(s.state).toBe('stopped')
    expect(a.calls.filter((c) => c === 'dispose').length).toBe(1)
  })

  it('P0-4 · open(A) luego open(B) libera el handle A antes de publicar B', async () => {
    const a = new MockAdapter()
    const s = new LivePlaybackSession(a)
    await s.open(grant, {})
    await s.open(grant, {})   // segunda apertura: debe disponer la anterior
    expect(a.calls.filter((c) => c === 'dispose').length).toBe(1)
    expect(s.state).toBe('playing')
  })

  // Flush de microtasks (sin timers): deja que B alcance la compuerta de dispose.
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

  it('P0-6 · A publicada, B espera dispose(A), C publica ⇒ B termina STALE sin sobrescribir C', async () => {
    const a = new MockAdapter()
    const s = new LivePlaybackSession(a)
    await s.open(grant, {})                 // A publicada
    a.gateDispose = true
    const pB = s.open(grant, {})            // B: abre hB, luego espera dispose(A) en la compuerta
    await tick(); await tick()
    const pC = s.open(grant, {})            // C: abre hC y publica (this.handle está null)
    expect(await pC).toEqual({ published: true })
    a.gateDispose = false
    a.releaseDispose()                       // libera dispose(A) ⇒ B re-comprueba generación
    expect((await pB).reason).toBe('STALE')
    expect(s.state).toBe('playing')          // C sigue publicada
    // Se dispusieron A y el handle de B (obsoleto); C no se tocó.
    expect(a.calls.filter((c) => c === 'dispose').length).toBeGreaterThanOrEqual(2)
  })

  it('P0-6/T12 · invalidate mientras B espera dispose(A) ⇒ B termina STALE', async () => {
    const a = new MockAdapter()
    const s = new LivePlaybackSession(a)
    await s.open(grant, {})
    a.gateDispose = true
    const pB = s.open(grant, {})
    await tick(); await tick()
    const inv = s.invalidate()               // cambia el viewport durante la espera
    a.gateDispose = false
    a.releaseDispose()
    await inv
    expect((await pB).reason).toBe('STALE')
    expect(s.state).toBe('stopped')
  })

  it('dispose es idempotente y libera el handle', async () => {
    const a = new MockAdapter()
    const s = new LivePlaybackSession(a)
    await s.open(grant, {})
    await s.dispose()
    expect(s.state).toBe('disposed')
    await s.dispose() // idempotente, sin lanzar
    expect(s.state).toBe('disposed')
    expect(a.calls.filter((c) => c === 'dispose').length).toBe(1)
  })

  it('open tras dispose no reproduce', async () => {
    const a = new MockAdapter()
    const s = new LivePlaybackSession(a)
    await s.dispose()
    const r = await s.open(grant, {})
    expect(r.published).toBe(false)
    expect(s.state).toBe('disposed')
  })
})
