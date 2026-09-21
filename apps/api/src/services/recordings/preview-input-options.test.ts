import { describe, expect, it } from 'vitest'
import {
  buildPreviewInputArgs,
  DEFAULT_PREVIEW_ANALYZE_DURATION_US,
  DEFAULT_PREVIEW_PROBE_SIZE_BYTES,
  resolvePreviewProbeOptions,
} from './preview-input-options'

describe('resolvePreviewProbeOptions', () => {
  it('usa el perfil rápido y conservador por defecto', () => {
    expect(resolvePreviewProbeOptions({})).toEqual({
      analyzeDurationUs: DEFAULT_PREVIEW_ANALYZE_DURATION_US,
      probeSizeBytes: DEFAULT_PREVIEW_PROBE_SIZE_BYTES,
    })
  })

  it('acepta overrides válidos', () => {
    expect(resolvePreviewProbeOptions({
      RECORDINGS_PREVIEW_ANALYZE_DURATION_US: '750000',
      RECORDINGS_PREVIEW_PROBE_SIZE_BYTES: '524288',
    })).toEqual({ analyzeDurationUs: 750_000, probeSizeBytes: 524_288 })
  })

  it('usa defaults ante valores no numéricos', () => {
    expect(resolvePreviewProbeOptions({
      RECORDINGS_PREVIEW_ANALYZE_DURATION_US: 'nope',
      RECORDINGS_PREVIEW_PROBE_SIZE_BYTES: '',
    })).toEqual({
      analyzeDurationUs: DEFAULT_PREVIEW_ANALYZE_DURATION_US,
      probeSizeBytes: DEFAULT_PREVIEW_PROBE_SIZE_BYTES,
    })
  })

  it('limita extremos para no desactivar el análisis ni reintroducir más de 5 s', () => {
    expect(resolvePreviewProbeOptions({
      RECORDINGS_PREVIEW_ANALYZE_DURATION_US: '0',
      RECORDINGS_PREVIEW_PROBE_SIZE_BYTES: '999999999',
    })).toEqual({ analyzeDurationUs: 100_000, probeSizeBytes: 5_000_000 })
  })
})

describe('buildPreviewInputArgs', () => {
  it('coloca análisis, probe y nobuffer antes de -i', () => {
    const args = buildPreviewInputArgs({
      transport: 'tcp', inputUrl: 'rtsp://example/Streaming/tracks/101',
      rtspTimeoutOption: '-timeout', rtspTimeoutUs: 60_000_000,
      analyzeDurationUs: 750_000, probeSizeBytes: 524_288,
    })
    const inputIndex = args.indexOf('-i')
    expect(args.slice(0, inputIndex)).toEqual([
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts+discardcorrupt+nobuffer',
      '-timeout', '60000000',
      '-analyzeduration', '750000',
      '-probesize', '524288',
      '-reorder_queue_size', '0',
    ])
    expect(args[inputIndex + 1]).toBe('rtsp://example/Streaming/tracks/101')
  })

  it('omite la opción de timeout cuando FFmpeg no la soporta', () => {
    const args = buildPreviewInputArgs({ transport: 'udp', inputUrl: 'rtsp://example/playback' })
    expect(args).not.toContain('-timeout')
    expect(args).not.toContain('-stimeout')
    expect(args.slice(-2)).toEqual(['-i', 'rtsp://example/playback'])
  })
})
