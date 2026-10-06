import { apiDelete, apiGet, apiPost } from '@/lib/api'
import type { Recording, RecordingCapabilities } from '@/types'

/** NVR wall-clock values are already prepared by the caller. Never rezone them here. */
export interface RecordingWindow {
  cameraId: string
  startTime: string
  endTime: string
}

export interface PlaybackRequest extends RecordingWindow {
  playbackURI?: string
  canPlayHevcMp4: boolean
  forceTranscode: boolean
}

export interface PreviewRequest extends PlaybackRequest {
  slotIndex: number
  continuityOfSessionId?: string
  browserLocal?: string
  browserTimezoneOffset?: number
}

export interface PlaybackStatusResponse {
  status: 'starting' | 'ready' | 'error'
  url?: string
  mimeType?: string
  transcoded?: boolean
  errorCode?: string
  error?: string
  downloadUrl?: string
  outTimeSec?: number
  expectedDurationSec?: number
  progressPercent?: number
}

export interface PlaybackStartResponse extends PlaybackStatusResponse {
  sessionId: string
}

export interface PreviewStatusResponse {
  status: 'ready' | 'queued' | 'active' | 'error'
  streamUrl?: string
  queuePosition?: number | null
  queueClass?: 'continuity' | 'normal' | null
  capacity?: { nvrName?: string | null; activeCount: number; effectiveLimit: number }
  category?: string | null
  detail?: string | null
  errorCategory?: string | null
  errorDetail?: string | null
  videoOnly?: boolean | null
  // Arrival at the server is not evidence of a decoded frame in the browser.
  hadFirstByte?: boolean | null
}

export interface PreviewStartResponse extends Omit<PreviewStatusResponse, 'status'> {
  sessionId: string
  status: 'ready' | 'queued'
}

export type RecordingSession = { type: 'preview' | 'mp4'; id: string }

/** Boundary for current and future recording UIs. All I/O goes through VisionCore. */
export interface NvrRecordingProvider {
  readonly archiveSource: 'nvr'
  search(window: RecordingWindow): Promise<{ recordings: Recording[] }>
  checkCapabilities(nvrId: string): Promise<RecordingCapabilities>
  startPreview(request: PreviewRequest): Promise<PreviewStartResponse>
  previewStatus(sessionId: string): Promise<PreviewStatusResponse>
  startPlayback(request: PlaybackRequest): Promise<PlaybackStartResponse>
  playbackStatus(sessionId: string): Promise<PlaybackStatusResponse>
  close(session: RecordingSession): Promise<void>
}

function resourceId(id: string): string {
  if (!id || id === '.' || id === '..') throw new Error('Identificador de recurso inválido')
  return encodeURIComponent(id)
}

// No polling/retry, media attachment, storage or generation state belongs here.
// The controller owns those decisions; the backend owns authorization/admission
// and releases a lease only after FFmpeg exits. In particular, ready is a URL,
// not "playing", and POST acceptance must precede closing a continuity parent.
export const nvrRecordingProvider: NvrRecordingProvider = {
  archiveSource: 'nvr',
  search: window => apiGet('/recordings/search', window),
  checkCapabilities: async nvrId => apiPost(`/nvrs/${resourceId(nvrId)}/recording-capabilities/check`, {}),
  startPreview: request => apiPost('/recordings/preview/start', request),
  previewStatus: async sessionId => apiGet(`/recordings/preview/${resourceId(sessionId)}/status`, {}),
  startPlayback: request => apiPost('/recordings/playback', request),
  playbackStatus: async sessionId => apiGet(`/recordings/playback/${resourceId(sessionId)}/status`, {}),
  close: async session => {
    const kind = session.type === 'preview' ? 'preview' : 'playback'
    await apiDelete(`/recordings/${kind}/${resourceId(session.id)}`)
  },
}
