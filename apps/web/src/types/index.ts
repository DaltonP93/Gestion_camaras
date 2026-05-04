// src/types/index.ts

export type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

export interface User {
  id: string
  username: string
  email: string
  fullName: string
  role: Role
  active: boolean
  avatarUrl?: string | null
  phone?: string | null
  createdAt: string
  permissions?: UserPermission[]
}

export interface AlertSettings {
  id: string
  emailEnabled: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPassword: string
  smtpFromEmail: string
  smtpFromName: string
  recipientEmails: string
  alertTypes: Record<string, boolean>
  minSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  updatedAt: string
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
  username: string
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
  user: User
}

export interface ApiError {
  statusCode: number
  error: string
  message: string
}

// Layouts de grilla de cámaras disponibles
export type GridLayout = 1 | 4 | 9 | 16 | 25

export type ViewLayout = '1x1' | '2x2' | '3x3' | '4x4' | 'featured' | 'custom'

export interface CameraSlot {
  slotIndex: number
  cameraId: string | null
  size: 'normal' | 'large'
}

export interface CameraView {
  id: string
  name: string
  description?: string
  layout: ViewLayout
  cameraSlots: CameraSlot[]
  slideshowEnabled: boolean
  slideshowInterval: number
  isPublic: boolean
  createdById: string
  createdAt: string
  updatedAt: string
  access?: { userId: string; user?: { fullName: string; username: string } }[]
}

export interface AppearanceSettings {
  id: string
  siteName: string
  logoText: string
  primaryColor: string
  accentColor: string
  theme: 'dark' | 'darker' | 'midnight'
  sidebarWidth: 'compact' | 'normal'
  showNVRsInSidebar: boolean
  customCss?: string
  updatedAt: string
}
