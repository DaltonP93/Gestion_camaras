// Prueba transversal de seguridad (C22, Hito 6 · T14/T18): ninguna de las
// estructuras que el plano de medios / negociación / IA devuelve o registra debe
// contener una URI RTSP (esquema rtsp://) ni credenciales embebidas (user:pass@).
import { describe, expect, it } from 'vitest'
import { buildGrant, systemClock, systemRandom } from './media-grants'
import { decideLivePlayback } from '../live-playback-decision'
import { AiEventPipeline } from '../ai/pipeline'
import { BoundedQueue } from '../ai/queue'
import { CircuitBreaker } from '../ai/circuit-breaker'
import { MockInferenceProvider } from '../ai/mock-provider'
import type { AnalyticsEvent, InferenceInput } from '../ai/contracts'

function assertNoSecrets(label: string, value: unknown) {
  const s = JSON.stringify(value).toLowerCase()
  expect(s, `${label} no debe contener rtsp://`).not.toContain('rtsp://')
  expect(s, `${label} no debe contener rtsps://`).not.toContain('rtsps://')
  expect(s, `${label} no debe contener userinfo user:pass@`).not.toContain('@')
  expect(s, `${label} no debe contener 'password'`).not.toContain('password')
}

describe('no fuga de secretos/URIs en estructuras de C22', () => {
  it('grant emitido y registro server-side', () => {
    const { issued, stored } = buildGrant(
      { userId: 'u', viewId: 'v', cameraId: 'c', streamPath: 'nvr_c_sub', effectiveType: 'sub', codec: 'hevc', transport: 'rtsps', device: 'win', mediaInstanceId: 'mi-1', authorizationEpoch: 0, ttlMs: 30000 },
      systemClock, systemRandom,
    )
    assertNoSecrets('stored grant', stored)
    // El secreto emitido es opaco (hex), no una URI/credencial.
    expect(issued.secret).toMatch(/^[0-9a-f]+$/)
    assertNoSecrets('issued (sin secret)', { ...issued, secret: 'REDACTED' })
  })

  it('decisión de reproducción', () => {
    const d = decideLivePlayback({
      client: { runtime: 'android', codecs: ['hevc'], hardwareDecodedCodecs: ['hevc'], transports: ['rtsps'] },
      server: { ffmpegAvailable: true, transcodingEnabled: true, maxTranscodeSessions: 2 },
      relayReady: true,
      nativePlaybackEnabled: true,
      camera: { mainCodec: 'hevc' },
      capacity: { availableTranscodeSlots: 2 },
      access: { live: true, hd: true },
    })
    assertNoSecrets('decision', d)
  })

  it('evento de analítica emitido por el pipeline', async () => {
    const events: AnalyticsEvent[] = []
    const provider = new MockInferenceProvider({ tracks: () => [{ trackId: 1, className: 'person', confidence: 0.9, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, ageMs: 0 }] })
    const p = new AiEventPipeline(
      provider,
      new BoundedQueue<InferenceInput>({ maxPerKey: 10, maxTotal: 10 }),
      new CircuitBreaker({ failureThreshold: 3, openMs: 1000 }, () => 0),
      { enabled: true, inferTimeoutMs: 1000, dedupeWindowMs: 5000, clock: () => 0, onEvent: (e) => events.push(e) },
    )
    p.submit({ cameraId: 'c', streamPath: 'nvr_c_sub', frameId: 1, capturedAt: 0 })
    await p.drainOne()
    expect(events).toHaveLength(1)
    assertNoSecrets('analytics event', events[0])
  })
})
