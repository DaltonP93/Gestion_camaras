// apps/native/shared/apply-decision.ts
//
// N2c — Puente entre la decisión SERVER-SIDE (decideLivePlayback) y el lifecycle
// nativo real. Cierra el hueco honesto de C22.2: `decideLivePlayback` devolvía la
// decisión pero nada la APLICABA al coordinador. Este helper la aplica de forma
// coherente, sin decidir por su cuenta (la autoridad de la decisión es el server):
//
//   - native_hevc/native_h264: abre el coordinador con transporte + codec resueltos.
//   - server_h264/substream: invalida cualquier sesión nativa activa (no dejar un
//     stream autenticado vivo al caer al fallback HLS) y delega a HLS.
//   - unavailable: invalida y no reproduce.

import type { CoordinatorOpenResult } from './coordinator'
import type { GrantRequest } from './grant-client'
import type { PlaybackCallbacks } from './playback'

export type PlaybackDecisionKind =
  | 'native_hevc' | 'native_h264' | 'server_h264' | 'substream' | 'unavailable'
export type PlaybackTransport = 'rtsps' | 'whep' | 'hls' | null

export interface AppliedDecision {
  decision: PlaybackDecisionKind
  transport: PlaybackTransport
}

/** Superficie mínima del coordinador que este puente necesita. */
export interface PlaybackCoordinatorLike {
  open(req: GrantRequest, cb: PlaybackCallbacks): Promise<CoordinatorOpenResult>
  invalidate(): Promise<void>
}

export interface ApplyContext {
  viewId: string
  cameraId: string
  device: string
  callbacks: PlaybackCallbacks
}

export type ApplyOutcome =
  | { mode: 'native'; transport: 'rtsps' | 'whep'; result: CoordinatorOpenResult }
  | { mode: 'server'; transport: 'hls' }
  | { mode: 'none'; reason: 'unavailable' | 'invalid_native_transport' }

const NATIVE = new Set<PlaybackDecisionKind>(['native_hevc', 'native_h264'])

export async function applyPlaybackDecision(
  d: AppliedDecision,
  coordinator: PlaybackCoordinatorLike,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  if (NATIVE.has(d.decision)) {
    // Coherencia: una decisión nativa DEBE traer transporte nativo. Si no, se
    // suelta cualquier nativo activo y se reporta el desajuste (no se adivina).
    if (d.transport !== 'rtsps' && d.transport !== 'whep') {
      await coordinator.invalidate()
      return { mode: 'none', reason: 'invalid_native_transport' }
    }
    const codec = d.decision === 'native_hevc' ? 'hevc' : 'h264'
    const req: GrantRequest = {
      viewId: ctx.viewId, cameraId: ctx.cameraId,
      transport: d.transport, codec, device: ctx.device,
    }
    const result = await coordinator.open(req, ctx.callbacks)
    return { mode: 'native', transport: d.transport, result }
  }
  // Fallback servidor/substream o inviable ⇒ soltar cualquier nativo activo.
  await coordinator.invalidate()
  if (d.decision === 'unavailable') return { mode: 'none', reason: 'unavailable' }
  return { mode: 'server', transport: 'hls' }
}
