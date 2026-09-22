export const DEFAULT_PREVIEW_ANALYZE_DURATION_US = 1_000_000
export const DEFAULT_PREVIEW_PROBE_SIZE_BYTES = 1_000_000

const MIN_ANALYZE_DURATION_US = 100_000
const MAX_ANALYZE_DURATION_US = 5_000_000
const MIN_PROBE_SIZE_BYTES = 32_768
const MAX_PROBE_SIZE_BYTES = 5_000_000

export interface PreviewInputOptions {
  transport: 'tcp' | 'udp'
  inputUrl: string
  rtspTimeoutOption?: string | null
  rtspTimeoutUs?: number
  analyzeDurationUs?: number
  probeSizeBytes?: number
}

function boundedInteger(
  raw: string | number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
}

/**
 * Resolve the preview-only probe window. FFmpeg defaults both stream analysis
 * and probe size to values that can add about five seconds before the first
 * fragmented-MP4 byte. Recordings come from known RTSP camera tracks, so the
 * preview path uses a bounded one-second/one-megabyte window by default while
 * keeping an environment override for unusual NVRs.
 */
export function resolvePreviewProbeOptions(env: NodeJS.ProcessEnv = process.env): {
  analyzeDurationUs: number
  probeSizeBytes: number
} {
  return {
    analyzeDurationUs: boundedInteger(
      env.RECORDINGS_PREVIEW_ANALYZE_DURATION_US,
      DEFAULT_PREVIEW_ANALYZE_DURATION_US,
      MIN_ANALYZE_DURATION_US,
      MAX_ANALYZE_DURATION_US,
    ),
    probeSizeBytes: boundedInteger(
      env.RECORDINGS_PREVIEW_PROBE_SIZE_BYTES,
      DEFAULT_PREVIEW_PROBE_SIZE_BYTES,
      MIN_PROBE_SIZE_BYTES,
      MAX_PROBE_SIZE_BYTES,
    ),
  }
}

/** Build only the FFmpeg input side, so option ordering before `-i` is tested. */
export function buildPreviewInputArgs(options: PreviewInputOptions): string[] {
  const analyzeDurationUs = boundedInteger(
    options.analyzeDurationUs,
    DEFAULT_PREVIEW_ANALYZE_DURATION_US,
    MIN_ANALYZE_DURATION_US,
    MAX_ANALYZE_DURATION_US,
  )
  const probeSizeBytes = boundedInteger(
    options.probeSizeBytes,
    DEFAULT_PREVIEW_PROBE_SIZE_BYTES,
    MIN_PROBE_SIZE_BYTES,
    MAX_PROBE_SIZE_BYTES,
  )

  return [
    '-rtsp_transport', options.transport,
    '-fflags', '+genpts+discardcorrupt+nobuffer',
    ...(options.rtspTimeoutOption
      ? [options.rtspTimeoutOption, String(options.rtspTimeoutUs ?? 60_000_000)]
      : []),
    '-analyzeduration', String(analyzeDurationUs),
    '-probesize', String(probeSizeBytes),
    '-reorder_queue_size', '0',
    '-i', options.inputUrl,
  ]
}
