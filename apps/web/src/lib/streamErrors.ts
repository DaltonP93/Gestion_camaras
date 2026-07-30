// Contrato de errores de start-stream — lógica PURA y unificada (P1).
//
// EL BUG: el backend responde SIEMPRE `{ code, message }` (y en los límites, 429 con
// `Retry-After` + contadores). Varias rutas del frontend leían `body.error` (que no
// existe), de modo que un 429 de "límite de transcodificaciones alcanzado" terminaba
// mostrándose como "Error desconocido". Además el mapa código→UI estaba duplicado en
// cuatro sitios. Aquí se centraliza para que todos los caminos (grid, foco, cambio de
// calidad, heartbeat) usen el mismo contrato.

import type { CameraPlaybackErrorCode } from '@/components/cameras/VideoPlayer'

/** Cuerpo de error tal como lo envía el backend de start-stream. */
export interface RawStreamErrorBody {
  code?: string
  error?: string           // legado — algunas respuestas antiguas; se tolera vía ??
  message?: string
  details?: string
  // Límite de streams
  current?: number
  max?: number
  // Límite de transcodificaciones (nuevo contrato)
  activeCount?: number
  startingCount?: number
  maxTranscodes?: number
}

/** Códigos del backend que representan un límite alcanzado (respuesta 429). */
export const STREAM_LIMIT_CODES = new Set([
  'STREAM_LIMIT_REACHED',
  'STREAM_LIMIT_GLOBAL',
  'TRANSCODE_LIMIT_REACHED',
])

/** Mapa único backend-code → código de error de la UI del reproductor. */
export const STREAM_ERROR_CODE_MAP: Record<string, CameraPlaybackErrorCode> = {
  RTSP_SUB_NOT_FOUND:       'RTSP_CHANNEL_NOT_FOUND',
  RTSP_MAIN_NOT_FOUND:      'RTSP_CHANNEL_NOT_FOUND',
  CODEC_UNSUPPORTED_HEVC:   'CODEC_UNSUPPORTED',
  TRANSCODING_DISABLED:     'CODEC_UNSUPPORTED',
  AUTH_FAILED:              'AUTH_FAILED',
  OFFLINE:                  'CAMERA_OFFLINE',
  CAMERA_OFFLINE:           'CAMERA_OFFLINE',
  MEDIA_SERVER_ERROR:       'MEDIAMTX_NOT_READY',
  CAMERA_NOT_FOUND:         'UNKNOWN',
  CAMERA_DISABLED:          'UNKNOWN',
  TRANSCODE_LIMIT_REACHED:  'TRANSCODE_LIMIT_REACHED',
  TRANSCODE_NOT_READY:      'TRANSCODE_NOT_READY',
  TRANSCODE_PROCESS_EXITED: 'TRANSCODE_PROCESS_EXITED',
  STREAM_LIMIT_GLOBAL:      'STREAM_LIMIT_REACHED',
  STREAM_LIMIT_REACHED:     'STREAM_LIMIT_REACHED',
  NO_PERMISSION:            'NO_PERMISSION',
}

/**
 * Código crudo del backend. Usa `body.code ?? body.error` (contrato nuevo con caída al
 * legado) y, para 403 sin cuerpo, asume NO_PERMISSION.
 */
export function readBackendCode(body: RawStreamErrorBody, status?: number): string {
  const backendCode = body.code ?? body.error
  if (backendCode) return backendCode
  if (status === 403) return 'NO_PERMISSION'
  return ''
}

/** ¿Es este un error de límite (429)? */
export function isLimitCode(backendCode: string): boolean {
  return STREAM_LIMIT_CODES.has(backendCode)
}

/**
 * Convierte el header `Retry-After` (segundos) en ms. Devuelve `fallbackMs` si el header
 * no es un número válido. Acepta el header como string o number.
 */
export function parseRetryAfterMs(
  retryAfter: string | number | undefined | null,
  fallbackMs = 15_000,
): number {
  if (retryAfter == null) return fallbackMs
  const secs = typeof retryAfter === 'number' ? retryAfter : parseInt(retryAfter, 10)
  if (!Number.isFinite(secs) || secs < 0) return fallbackMs
  return secs * 1000
}

/** Mensaje legible para un error de límite, con contadores reales si el backend los da. */
export function describeLimit(backendCode: string, body: RawStreamErrorBody): string {
  if (backendCode === 'TRANSCODE_LIMIT_REACHED') {
    const active = body.activeCount ?? body.current
    const max = body.maxTranscodes ?? body.max
    const starting = body.startingCount
    if (active !== undefined && max !== undefined) {
      const startingTxt = starting ? `, ${starting} iniciando` : ''
      return `Límite de transcodificaciones alcanzado (${active}/${max} activas${startingTxt})`
    }
    return body.message || 'Límite de transcodificaciones alcanzado'
  }
  // STREAM_LIMIT_REACHED / STREAM_LIMIT_GLOBAL
  const cur = body.current
  const max = body.max
  if (cur !== undefined && max !== undefined) {
    return `Límite de streams alcanzado (${cur}/${max} activos)`
  }
  return body.message || 'Límite de streams alcanzado'
}

export interface ParsedStreamError {
  /** Código crudo del backend (p.ej. TRANSCODE_LIMIT_REACHED). */
  backendCode: string
  /** Código traducido a la UI del reproductor. Nunca 'UNKNOWN' para un límite conocido. */
  code: CameraPlaybackErrorCode
  /** Mensaje ya listo para mostrar (con contadores reales cuando existan). */
  message: string
  technicalDetail?: string
  isLimit: boolean
  current?: number
  max?: number
}

/**
 * Punto único de traducción de un error de start-stream a la forma que consume la UI.
 * Garantiza que un 429 (límite) jamás caiga en 'UNKNOWN'/"Error desconocido".
 */
export function parseStreamError(
  body: RawStreamErrorBody,
  status?: number,
  fallbackMessage = 'No se pudo obtener el stream',
): ParsedStreamError {
  const backendCode = readBackendCode(body, status)
  const limit = isLimitCode(backendCode)
  const code = (STREAM_ERROR_CODE_MAP[backendCode] || 'UNKNOWN') as CameraPlaybackErrorCode
  const message = limit
    ? describeLimit(backendCode, body)
    : (body.message || body.code || fallbackMessage)
  return {
    backendCode,
    code,
    message,
    technicalDetail: body.details,
    isLimit: limit,
    current: body.activeCount ?? body.current,
    max: body.maxTranscodes ?? body.max,
  }
}
