// apps/api/src/services/media/contracts.ts
//
// Contratos PUROS del plano de autorización de medios y de la decisión de
// reproducción nativa (C22). Sin lógica, sin estado, sin secretos. Se comparten
// entre servicios, rutas y (conceptualmente) el cliente nativo/shared-core.
//
// Regla de oro: NINGÚN tipo aquí transporta contraseñas de NVR, URIs RTSP ni
// secretos del servidor. El "secreto" del grant es un opaco de un solo envío en
// la emisión; el servidor guarda únicamente su hash.

export const MEDIA_GRANT_CONTRACT_VERSION = 1 as const

export type MediaTransport = 'hls' | 'whep' | 'rtsps'
export type MediaCodec = 'h264' | 'hevc'
/** El cliente sólo puede consumir (read). Nunca publish/api. */
export type MediaAction = 'read'

/** Decisión explícita del servidor sobre cómo reproducir una cámara. */
export type LivePlaybackDecision =
  | 'native_hevc'   // el dispositivo decodifica HEVC localmente (requiere relay seguro)
  | 'native_h264'   // el dispositivo decodifica H.264 localmente
  | 'server_h264'   // fallback: transcode H.264 en el servidor (consume 1 de 2 cupos)
  | 'substream'     // se conserva el substream (esperando capacidad o sin transcode)
  | 'unavailable'   // no hay ruta de reproducción viable

/** Razón estructurada y auditable de la decisión. */
export type LivePlaybackReason =
  | 'NATIVE_HEVC_LOCAL_DECODE'
  | 'NATIVE_H264_LOCAL_DECODE'
  | 'SERVER_H264_DIRECT'
  | 'SERVER_TRANSCODE_FALLBACK'
  | 'SUBSTREAM_WHILE_WAITING_CAPACITY'
  | 'SUBSTREAM_TRANSCODE_UNAVAILABLE'
  | 'SECURE_RELAY_NOT_IMPLEMENTED'
  | 'NATIVE_PLAYBACK_FLAG_DISABLED'
  | 'CLIENT_CAPABILITY_MISSING'
  | 'CAMERA_ACCESS_DENIED'
  | 'HD_PERMISSION_MISSING'
  | 'RELAY_BACKEND_NOT_READY'
  | 'NO_TRANSCODE_CAPACITY'

/**
 * Grant tal como lo recibe el cliente en la emisión. `secret` viaja UNA sola vez;
 * el servidor no lo persiste en claro. No contiene credenciales ni URIs RTSP.
 */
export interface IssuedMediaGrant {
  grantId: string
  secret: string
  transport: MediaTransport
  codec: MediaCodec
  /** Identidad del stream (p.ej. nvr_<id>_ch09_sub) — independiente del path reutilizable. */
  streamPath: string
  action: MediaAction
  expiresAt: number
  contractVersion: typeof MEDIA_GRANT_CONTRACT_VERSION
}

/**
 * Registro server-side del grant. NUNCA contiene credenciales NVR ni URIs RTSP.
 * `secretHash` es sha256(secret); el secreto no se guarda.
 */
export interface StoredMediaGrant {
  grantId: string
  secretHash: string
  userId: string
  viewId: string
  cameraId: string
  streamPath: string
  codec: MediaCodec
  transport: MediaTransport
  action: MediaAction
  /** Tipo de stream efectivo resuelto por el servidor (no por el cliente). */
  effectiveType: 'sub' | 'main'
  /** Etiqueta acotada del dispositivo/runtime declarada por el cliente (no autoriza por sí sola). */
  device: string
  /**
   * Identidad opaca de instancia derivada SERVER-SIDE al emitir (de la instancia
   * de proceso real cuando existe, o del registro de instancias por path). El
   * validador la EXIGE: si el path fue recreado (instancia rotada), el grant
   * viejo deja de validar. El cliente nunca la ve ni la controla.
   */
  mediaInstanceId: string
  /**
   * Epoch de autorización del usuario capturado al emitir (C22.2, P0-2). Logout y
   * cambio de permisos incrementan el epoch de forma durable; `validateAndClaim`
   * exige que el epoch del grant siga siendo el vigente. Un grant emitido con una
   * autorización leída antes del cambio NO puede aparecer válido después, aunque
   * su índice se haya escrito con retraso.
   */
  authorizationEpoch: number
  issuedAt: number
  expiresAt: number
  /** Grant de uso único (handshake). El consumo atómico lo hace `validateAndClaim`. */
  revokedAt: number | null
}

/**
 * Ámbito que se exige coincida al validar/usar un grant. El servidor deriva la
 * identidad de instancia por sí mismo (no se pasa aquí ni se confía al cliente).
 */
export interface GrantScopeQuery {
  userId: string
  cameraId: string
  streamPath: string
  transport: MediaTransport
  action: MediaAction
}

export type GrantRejectReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'REVOKED'
  | 'SECRET_MISMATCH'
  | 'SCOPE_MISMATCH'
  | 'INSTANCE_REQUIRED'
  | 'INSTANCE_MISMATCH'
  | 'EPOCH_MISMATCH'
  | 'REPLAYED'
  | 'BACKEND_UNAVAILABLE'

export interface GrantValidation {
  ok: boolean
  reason?: GrantRejectReason
  grant?: StoredMediaGrant
}

/** Eventos de auditoría del plano de grants (nunca incluyen el secreto completo). */
export type GrantAuditEvent =
  | 'grant_issued'
  | 'grant_used'
  | 'grant_revoked'
  | 'grant_expired'
  | 'grant_rejected'

export interface GrantAuditRecord {
  event: GrantAuditEvent
  grantId: string
  userId: string
  cameraId: string
  transport: MediaTransport
  reason?: GrantRejectReason
  at: number
}
