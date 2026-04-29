// src/types/index.ts

export type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

export interface User {
  id: string
  username: string
  email: string
  fullName: string
  role: Role
  active: boolean
  createdAt: string
  permissions?: UserPermission[]
}

export interface UserPermission {
  id: string
  userId: string
  nvrId?: string
  cameraId?: string
  canView: boolean
  canPlayback: boolean
  canPtz: boolean
  nvr?: { id: string; name: string }
  camera?: { id: string; name: string; channel: number }
}

export interface NVR {
  id: string
  name: string
  model: string
  ipAddress: string
  port: number
  rtspPort: number
  channels: number
  hddCount: number
  firmware?: string
  location?: string
  active: boolean
  lastSeen?: string
  createdAt: string
  cameras?: Camera[]
}

export interface NVRStatus {
  online: boolean
  firmware: string
  diskUsage: number
  cpuUsage: number
  temperature?: number
}

export interface Camera {
  id: string
  nvrId: string
  channel: number
  name: string
  location?: string
  rtspUrl?: string
  hlsPath?: string
  ptzEnabled: boolean
  active: boolean
  online: boolean
  lastCheck?: string
  nvr?: { id: string; name: string; ipAddress: string }
}

export interface StreamInfo {
  cameraId: string
  streamPath: string
  hls: string
  webrtc: string
  channel: number
  nvrName: string
}

export interface Recording {
  id: string
  channel: number
  startTime: string
  endTime: string
  size: number
  type: string
}

export interface Alert {
  id: string
  nvrId?: string
  cameraId?: string
  type: AlertType
  severity: AlertSeverity
  message: string
  detail?: Record<string, unknown>
  resolved: boolean
  resolvedAt?: string
  createdAt: string
  nvrName?: string
}

export type AlertType =
  | 'CAMERA_OFFLINE'
  | 'NVR_OFFLINE'
  | 'HDD_FULL'
  | 'HDD_ERROR'
  | 'MOTION_DETECTED'
  | 'RECORDING_ERROR'
  | 'AUTH_FAILED'

export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface AuditLog {
  id: string
  userId?: string
  action: string
  resource?: string
  detail?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
  createdAt: string
  user?: { username: string; fullName: string; role: Role }
}

export interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: User
}

export interface ApiError {
  statusCode: number
  error: string
  message: string
}

// Layouts de grilla de cámaras disponibles
export type GridLayout = 1 | 4 | 9 | 16 | 25
