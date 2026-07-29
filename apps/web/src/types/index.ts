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

export interface UserFeaturePermissions {
  canViewDashboard:      boolean
  canViewLive:           boolean
  canViewRecordings:     boolean
  canViewAlerts:         boolean
  canViewDiagnostics:    boolean
  canManageNVRs:         boolean
  canManageCameras:      boolean
  canManageUsers:        boolean
  canManageAppearance:   boolean
  canResolveAlerts:      boolean
  canRestartStreams:      boolean
  canTranscode:          boolean
  canDownloadRecordings: boolean
  canManageViews:        boolean
  canManageSettings:     boolean
}

export interface NvrPermission {
  id?:              string
  nvrId:            string
  canView:          boolean
  canViewCameras:   boolean
  canViewRecordings: boolean
  canManage:        boolean
  canEditVideoAudio: boolean
  canSync:          boolean
  canRevalidate:    boolean
  canRestart:       boolean
  nvr?: { id: string; name: string; model: string }
}

export interface CameraPermission {
  id?:             string
  cameraId:        string
  canView:         boolean
  canViewLive:     boolean
  canPlayback:     boolean
  canDownload:     boolean
  canHighQuality:  boolean
  canUseMainStream: boolean
  canUseTranscode:  boolean
  canAddToViews:    boolean
  canReceiveAlerts: boolean
  camera?: { id: string; name: string; channel: number; nvrId: string }
}

export interface UserPermissionData {
  featurePermissions: UserFeaturePermissions | null
  nvrPermissions:     NvrPermission[]
  cameraPermissions:  CameraPermission[]
}

export interface UserSession {
  id:          string
  userAgent?:  string | null
  ipAddress?:  string | null
  deviceName?: string | null
  createdAt:   string
  expiresAt:   string
  lastUsedAt?: string | null
  current?:    boolean
}

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
  twoFactorEnabled?:   boolean
  forcePasswordChange?: boolean
  lockedUntil?:        string | null
  failedLoginAttempts?: number
  passwordChangedAt?:  string | null
  permissions?:         UserPermission[]
  featurePermissions?:  UserFeaturePermissions
  sessions?:            UserSession[]
  _count?: { permissions: number; sessions: number }
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
  id:              string
  userId:          string
  nvrId?:          string
  cameraId?:       string
  canView:         boolean
  canPlayback:     boolean
  canPtz:          boolean
  canHighQuality:  boolean
  // Granular NVR
  canViewCameras?:   boolean
  canViewRecordings?: boolean
  canManage?:       boolean
  canEditVideoAudio?: boolean
  canSync?:         boolean
  canRevalidate?:   boolean
  canRestart?:      boolean
  // Granular camera
  canViewLive?:     boolean
  canDownload?:     boolean
  canUseMainStream?: boolean
  canUseTranscode?:  boolean
  canAddToViews?:    boolean
  canReceiveAlerts?: boolean
  nvr?:    { id: string; name: string }
  camera?: { id: string; name: string; channel: number }
}

export type RecordingProviderType =
  | 'ISAPI'
  | 'HIKVISION_SDK'
  | 'MEDIAMTX_LOCAL'
  | 'MANUAL_NVR'
  | 'UNSUPPORTED'

export interface RecordingCapabilities {
  nvrId:                        string
  recordingProvider:            RecordingProviderType
  supportsIsapiRecording:       boolean | null
  supportsSdkRecording:         boolean
  recordingCapabilityAt:        string | null
  recordingCapabilityError:     string | null
  recordingCapabilityErrorCode: 'AUTH_FAILED' | 'UNSUPPORTED_MODEL' | 'INVALID_REQUEST' | 'NETWORK_TIMEOUT' | 'NETWORK_ERROR' | 'PARSE_ERROR' | null
  playbackWebUrl:               string | null
  sdkEnabled:                   boolean
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
  // Recording provider fields
  recordingProvider?:        RecordingProviderType
  supportsIsapiRecording?:   boolean | null
  supportsSdkRecording?:     boolean
  recordingCapabilityAt?:    string | null
  recordingCapabilityError?: string | null
  playbackWebUrl?:           string | null
  sdkEnabled?:               boolean
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
  onlineInNvrAt?: string
  // Estado efectivo resuelto server-side (fuente de verdad única, P0). Cuando viene,
  // la tabla lo usa en vez de re-derivar desde flags históricos.
  effectiveStatus?: 'AUTH_FAILED' | 'OFFLINE' | 'STREAM_DEGRADED' | 'HEALTHY' | 'UNKNOWN'
  effectiveOnline?: boolean
  statusStale?: boolean
  statusReason?: string
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
  playbackURI?: string
}

// Resumen ÚNICO de contadores (server-side). Fuente de verdad de campana/menú
// (unread), Dashboard (pending) y AlertsPage.
export interface AlertSummary {
  unread: number
  acknowledged: number
  pending: number
  resolved: number
  total: number
  criticalPending: number
}

export interface DashboardOverview {
  cameras: { total: number; online: number }
  nvrs: { total: number; online: number }
  alerts: AlertSummary
  activity: { hourStart: string; alerts: number }[]
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
  cameraName?: string
}

export type AlertType =
  | 'CAMERA_OFFLINE'
  | 'CAMERA_RECOVERED'
  | 'CAMERA_STREAM_ERROR'
  | 'CAMERA_STREAM_RECOVERED'
  | 'STREAM_DEGRADED'
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

// ─── NVR Video/Audio Config ───────────────────────────────────────────────────

export interface VideoStreamConfig {
  streamType:      'main' | 'sub'
  videoCodecType:  string
  videoScanType:   string
  width:           number
  height:          number
  fps:             number
  bitrateType:     string  // CBR | VBR
  bitrateMax:      number  // kbps
  qualityLevel:    string
  h265Plus:        boolean
  audioEnabled:    boolean
  audioCodecType:  string
  audioInputType:  string
  audioBitrate:    number
}

export interface ChannelStreamConfig {
  codec:      string
  resolution: string
  fps:        number
  bitrate:    number
}

export interface ChannelVideoConfig {
  nvrId:       string
  channel:     number
  channelCode?: string
  cameraName:  string
  main:        ChannelStreamConfig | null
  sub:         ChannelStreamConfig | null
  fetchedAt:   string
  error?:      string
}

export interface VideoStreamUpdate {
  videoCodecType?: string
  width?:          number
  height?:         number
  fps?:            number
  bitrateType?:    string
  bitrateMax?:     number
  qualityLevel?:   string
  audioEnabled?:   boolean
  audioCodecType?: string
  audioBitrate?:   number
}

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
  logoUrl?: string
  sidebarLogoUrl?: string
  faviconUrl?: string
  updatedAt: string
}

