// Shared types for the Recordings / Remote Playback module
import type { Recording } from '@/types'

export interface RecordingWithCamera extends Recording {
  cameraId: string
  cameraName: string
  nvrName: string
}

export interface NvrSearchError {
  nvrId: string
  nvrName: string
  cameraIds: string[]
  code: 'ISAPI_UNSUPPORTED' | 'AUTH_FAILED' | 'NVR_OFFLINE' | 'UNKNOWN'
  message: string
  playbackWebUrl?: string | null
}

export type PlaybackLayout = '1x1' | '2x2' | '3x3' | '4x4'

export type SlotStatus = 'empty' | 'idle' | 'loading' | 'ready' | 'error' | 'no_recording'

export interface PlaybackSlot {
  slotIndex: number
  cameraId: string | null
  cameraName: string | null
  nvrId: string | null
  nvrName: string | null
  recording: RecordingWithCamera | null
  status: SlotStatus
  playbackUrl: string | null
  sessionId: string | null
  downloadUrl: string | null
  errorMsg: string | null
  vodProgress: { outTimeSec: number; expectedDurationSec: number } | null
  mimeType: string | null
}

export function emptySlot(slotIndex: number): PlaybackSlot {
  return {
    slotIndex,
    cameraId: null,
    cameraName: null,
    nvrId: null,
    nvrName: null,
    recording: null,
    status: 'empty',
    playbackUrl: null,
    sessionId: null,
    downloadUrl: null,
    errorMsg: null,
    vodProgress: null,
    mimeType: null,
  }
}
