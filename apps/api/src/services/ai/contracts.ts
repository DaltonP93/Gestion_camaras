// apps/api/src/services/ai/contracts.ts
//
// Contratos PUROS de la base de IA (C22). Definen la forma de eventos,
// detecciones, tracks, alertas y del proveedor de inferencia SIN implementar un
// sistema de inferencia productivo. La base es desacoplada y verificable; el
// pipeline real de detección se agrega en fases posteriores con un modelo
// validado. Todo queda detrás de `AI_EVENTS_ENABLED` (apagado por defecto).
//
// El pipeline consume el restream COMPARTIDO de MediaMTX (una sola sesión RTSP
// contra el NVR, vía StreamConsumerRegistry). No abre una segunda conexión al
// NVR por consumidor de IA.

export const AI_CONTRACT_VERSION = 1 as const

export type AiObjectClass =
  | 'person' | 'car' | 'truck' | 'bus' | 'motorcycle' | 'bicycle' | 'unknown'

export interface BoundingBox {
  /** Coordenadas normalizadas [0..1] relativas al frame. */
  x: number
  y: number
  w: number
  h: number
}

export interface Detection {
  className: AiObjectClass
  confidence: number      // [0..1]
  bbox: BoundingBox
}

export interface Track {
  trackId: number
  className: AiObjectClass
  confidence: number
  bbox: BoundingBox
  /** ms que el track lleva vivo (para loitering, etc.). */
  ageMs: number
}

export type AiEventType =
  | 'person' | 'vehicle' | 'zone_intrusion' | 'line_crossing'
  | 'loitering' | 'occupancy_limit'

/**
 * Evento de analítica normalizado que produce un InferenceProvider. Es la unidad
 * que la cola transporta hacia el API. NO contiene URIs RTSP ni credenciales.
 */
export interface AnalyticsEvent {
  contractVersion: typeof AI_CONTRACT_VERSION
  eventId: string
  cameraId: string
  type: AiEventType
  className: AiObjectClass
  confidence: number
  trackId?: number
  zoneName?: string
  direction?: 'in' | 'out'
  /** Correlaciona entrada/permanencia/salida de un mismo incidente. */
  incidentId?: string
  occurredAt: number      // epoch ms
  detections?: Detection[]
  modelId: string
  modelVersion: string
}

export type AlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

/** Alerta derivada de un evento (forma de dominio, desacoplada del provider). */
export interface Alert {
  alertId: string
  cameraId: string
  eventId: string
  type: AiEventType
  severity: AlertSeverity
  createdAt: number
}

export type ModelState = 'unloaded' | 'loading' | 'ready' | 'error'

export interface InferenceProviderStatus {
  providerId: string
  modelId: string
  modelVersion: string
  state: ModelState
  lastError?: string
  updatedAt: number
}

/**
 * Interfaz de proveedor de inferencia. La base incluye un proveedor MOCK para
 * pruebas; un proveedor real (p.ej. el servicio Python existente) la implementa
 * sin acoplar el resto del pipeline a YOLOX ni a ningún runtime concreto.
 */
export interface InferenceProvider {
  readonly providerId: string
  status(): InferenceProviderStatus
  /**
   * Procesa un frame/entrada y devuelve tracks. DEBE ser cancelable: el pipeline
   * pasa un AbortSignal y aborta al vencer el timeout; el proveedor debe dejar de
   * trabajar cuando `signal.aborted` (P0-5).
   */
  infer(input: InferenceInput, signal?: AbortSignal): Promise<Track[]>
}

/** Entrada abstracta de inferencia. Referencia al restream compartido, nunca al NVR. */
export interface InferenceInput {
  cameraId: string
  /** streamPath del restream compartido de MediaMTX (identidad, no URI con secreto). */
  streamPath: string
  frameId: number
  capturedAt: number
  /** Bytes del frame ya obtenidos del restream compartido (opcional para mocks). */
  frameJpeg?: Uint8Array
}

/** Política de deduplicación/retención declarativa (implementada en el pipeline). */
export interface AiRetentionPolicy {
  /** Ventana de deduplicación por (cameraId,type,trackId) en ms. */
  dedupeWindowMs: number
  /** Máximo de eventos retenidos en memoria por cámara antes de aplicar backpressure. */
  maxQueuedPerCamera: number
}
