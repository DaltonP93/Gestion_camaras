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
