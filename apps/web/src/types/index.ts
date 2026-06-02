// src/types/index.ts

export type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'AUDITOR'

export type StreamHealthStatus =
  | 'HEALTHY'
  | 'USING_MAIN_STREAM'   // Sub failed/HEVC, using main stream (H264)
  | 'RTSP_SUB_NOT_FOUND'
  | 'RTSP_MAIN_NOT_FOUND'
  | 'CODEC_UNSUPPORTED_HEVC'
  | 'STREAM_UNSTABLE'
  | 'MEDIA_SERVER_ERROR'
  | 'AUTH_FAILED'
  | 'OFFLINE'
  | 'UNKNOWN'

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
  serialNumber?: string
  ipAddress: string
  port: number
  rtspPort: number
  sdkPort?: number
  username: string
  channels: number
  hddCount: number
  firmware?: string
  encodingVersion?: string
  webVersion?: string
  location?: string
  active: boolean
  online: boolean
  lastSeen?: string
  lastSyncAt?: string
  lastRtspOkAt?: string
  isapIStatus?: 'available' | 'no_permission' | 'unsupported' | 'error' | 'unknown'
  createdAt: string
  cameras?: Camera[]
  hdds?: NvrHdd[]
}

export interface NvrHdd {
  id: string
  nvrId: string
  diskNumber: number
  capacityGb?: number
  freeGb?: number
  usedPercent?: number
  status?: string
  type?: string
  property?: string
  process?: string
  lastSyncAt?: string
}

export interface NVRStatus {
  online: boolean
  firmware: string
  diskUsage: number
  cpuUsage: number
  temperature?: number
  errorReason?: 'network' | 'auth' | 'unknown'
}

export interface Camera {
  id: string
  nvrId: string
  channel: number
  channelCode?: string
  name: string
  location?: string
  ipAddress?: string
  protocol?: string
  managementPort?: number
  securityStatus?: string
  preferredStream?: 'main' | 'sub'
  mainRtspPath?: string
  subRtspPath?: string
  mainCodec?: string
  subCodec?: string
  mainResolution?: string
  subResolution?: string
  mainFps?: number
  subFps?: number
  mainBitrate?: number
  subBitrate?: number
  rtspMainOk?: boolean
  rtspSubOk?: boolean
  lastRtspCheckAt?: string
  lastRtspError?: string
  consecutiveFailures?: number
  streamHealthStatus?: StreamHealthStatus
  onlineInNvr?: boolean
  rtspUrl?: string
  hlsPath?: string
  ptzEnabled: boolean
  active: boolean
  online: boolean
  lastCheck?: string
  lastSyncAt?: string
  nvr?: { id: string; name: string; ipAddress: string }
}

export interface IpCamera {
  channel: number
  channelCode: string
  name: string
  ipAddress: string
  protocol: string
  managementPort: number
  securityStatus: string
  status: string
}

export interface StreamInfo {
  cameraId: string
  streamPath: string
  hls: string
  webrtc: string
  channel: number
  nvrName: string
  warning?: { code: string; message: string }
}

export interface HeartbeatResponse {
  streams: Record<string, { hls: string; webrtc: string; streamPath: string; channel?: number; nvrName?: string; warning?: { code: string; message: string } }>
  errors: Record<string, { code: string; message: string; details?: string }>
  startedIds: string[]   // cámaras iniciadas en este heartbeat (necesitan nuevo player key)
  stoppedIds: string[]   // cámaras detenidas (ya no visibles en el view)
}

export interface CameraDiagnostics {
  cameraId: string
  cameraName: string
  channelCode: string
  nvr: {
    id: string
    name: string
    onlineHttp: boolean
    lastSeen?: string
  }
  camera: {
    channelNumber: number
    name: string
    ipAddress?: string
    protocol?: string
    onlineInNvr: boolean
    preferredStream: string
  }
  rtsp: {
    mainUrlMasked: string
    subUrlMasked: string
    mainOk: boolean
    subOk: boolean
    mainError?: string
    subError?: string
    preferred: string
    mainCodec?: string
    subCodec?: string
    mainResolution?: string
    subResolution?: string
    mainFps?: number
    subFps?: number
    mainLatencyMs?: number
    subLatencyMs?: number
  }
  mediaServer: {
    provider: string
    route: string
    routeExists: boolean
    ready: boolean
    readers: number
    sourceType?: string
    sourceMasked?: string
  }
  frontend: {
    hlsUrl: string
    webrtcUrl: string
  }
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
  resolvedAt?: string | null
  readAt?: string | null
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
  customCss: string
  logoUrl: string
  sidebarLogoUrl: string
  faviconUrl: string
  updatedAt: string
}
