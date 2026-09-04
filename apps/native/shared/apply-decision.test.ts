// apps/native/shared/apply-decision.test.ts
//
// N2c — puente decisión→lifecycle. Verifica que native_* abre el coordinador con
// transporte+codec correctos, que server/substream invalidan cualquier nativo y
// delegan a HLS, que unavailable invalida y no reproduce, y que una decisión
// nativa sin transporte nativo se reporta (no se adivina).

import { describe, it, expect, beforeEach } from 'vitest'
import { applyPlaybackDecision, type PlaybackCoordinatorLike } from './apply-decision'
import type { GrantRequest } from './grant-client'
import type { CoordinatorOpenResult } from './coordinator'

class FakeCoordinator implements PlaybackCoordinatorLike {
  calls: string[] = []
  lastReq: GrantRequest | null = null
  result: CoordinatorOpenResult = { published: true }
  async open(req: GrantRequest): Promise<CoordinatorOpenResult> {
    this.calls.push('open'); this.lastReq = req; return this.result
  }
  async invalidate(): Promise<void> { this.calls.push('invalidate') }
}

const ctx = { viewId: 'v1', cameraId: 'cam1', device: 'win', callbacks: {} }

describe('applyPlaybackDecision', () => {
  let coord: FakeCoordinator
  beforeEach(() => { coord = new FakeCoordinator() })

  it('native_hevc abre con rtsps + codec hevc', async () => {
    const out = await applyPlaybackDecision({ decision: 'native_hevc', transport: 'rtsps' }, coord, ctx)
    expect(coord.calls).toEqual(['open'])
    expect(coord.lastReq).toMatchObject({ transport: 'rtsps', codec: 'hevc', cameraId: 'cam1', viewId: 'v1' })
    expect(out).toEqual({ mode: 'native', transport: 'rtsps', result: { published: true } })
  })

  it('native_h264 abre con whep + codec h264', async () => {
    const out = await applyPlaybackDecision({ decision: 'native_h264', transport: 'whep' }, coord, ctx)
    expect(coord.lastReq).toMatchObject({ transport: 'whep', codec: 'h264' })
    expect(out.mode).toBe('native')
  })

  it('server_h264 invalida cualquier nativo y delega a HLS', async () => {
    const out = await applyPlaybackDecision({ decision: 'server_h264', transport: 'hls' }, coord, ctx)
    expect(coord.calls).toEqual(['invalidate'])
    expect(out).toEqual({ mode: 'server', transport: 'hls' })
  })

  it('substream invalida y delega a HLS', async () => {
    const out = await applyPlaybackDecision({ decision: 'substream', transport: 'hls' }, coord, ctx)
    expect(coord.calls).toEqual(['invalidate'])
    expect(out).toEqual({ mode: 'server', transport: 'hls' })
  })

  it('unavailable invalida y no reproduce', async () => {
    const out = await applyPlaybackDecision({ decision: 'unavailable', transport: null }, coord, ctx)
    expect(coord.calls).toEqual(['invalidate'])
    expect(out).toEqual({ mode: 'none', reason: 'unavailable' })
  })

  it('decisión nativa SIN transporte nativo se reporta (no adivina), soltando el nativo', async () => {
    const out = await applyPlaybackDecision({ decision: 'native_hevc', transport: 'hls' }, coord, ctx)
    expect(coord.calls).toEqual(['invalidate'])
    expect(out).toEqual({ mode: 'none', reason: 'invalid_native_transport' })
  })
})
