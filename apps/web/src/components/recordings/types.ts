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

// loading = pidiendo sesión al API; buffering = tiene URL, esperando datos de
// FFmpeg; playing = reproduciendo (currentTime avanza); ready = media lista pero
// pausada; stalled = con URL pero sin avance tras el timeout → probable fallo.
// waiting_next_recording = terminó el bloque y hay un hueco hasta el siguiente;
// en multicámara el slot ESPERA a que el reloj global llegue al siguiente bloque
// (sin adelantar el reloj) y arranca solo — una única transición, sin clic manual.
export type SlotStatus =
  | 'empty' | 'idle' | 'loading' | 'buffering' | 'playing'
  | 'ready' | 'stalled' | 'error' | 'no_recording'
  | 'waiting_next_recording'

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
  sessionType: 'preview' | 'mp4' | null
  downloadUrl: string | null
  errorMsg: string | null
  vodProgress: { outTimeSec: number; expectedDurationSec: number } | null
  mimeType: string | null
  // El preview se está reproduciendo sin audio (fallback video-only del backend):
  // badge discreto "Sin audio". No es un error.
  noAudio?: boolean
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
    sessionType: null,
    downloadUrl: null,
    errorMsg: null,
    vodProgress: null,
    mimeType: null,
  }
}
