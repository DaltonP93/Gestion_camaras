// Stream Validator — valida la salud RTSP de una cámara y actualiza su streamHealthStatus en DB
import type { PrismaClient } from '@prisma/client'
import type { NVR, Camera } from '@prisma/client'
import { probeBothStreams } from './rtsp-probe'
import CryptoJS from 'crypto-js'

const ENCRYPTION_KEY = process.env.NVR_CREDENTIAL_KEY || process.env.JWT_SECRET || 'visioncore_key'
const decryptPass = (p: string) => CryptoJS.AES.decrypt(p, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8)

// Posibles valores de streamHealthStatus
export type StreamHealthStatus =
  | 'HEALTHY'
  | 'RTSP_SUB_NOT_FOUND'
  | 'CODEC_UNSUPPORTED_HEVC'
  | 'STREAM_UNSTABLE'
  | 'AUTH_FAILED'
  | 'OFFLINE'
  | 'UNKNOWN'

/**
 * Prueba RTSP de una cámara y actualiza su streamHealthStatus en la base de datos.
 * Devuelve el nuevo streamHealthStatus.
 */
export async function validateAndUpdateCameraHealth(
  prisma: PrismaClient,
  nvr: NVR,
  camera: Camera,
): Promise<StreamHealthStatus> {
  const plainPassword = decryptPass(nvr.password)
  const nvrDecrypted = { ...nvr, password: plainPassword }

  let healthStatus: StreamHealthStatus = 'UNKNOWN'
  let rtspSubOk = false
  let subCodec: string | null = null
  let subResolution: string | null = null
  let lastRtspError: string | null = null

  try {
    const result = await probeBothStreams(nvrDecrypted, camera.channel)
    const sub = result.sub

    if (sub.ok) {
      rtspSubOk = true
      subCodec = sub.codec || null
      subResolution = sub.width ? `${sub.width}x${sub.height}` : null

      const codec = (sub.codec || '').toLowerCase()

      if (codec.includes('hevc') || codec.includes('h265')) {
        healthStatus = 'CODEC_UNSUPPORTED_HEVC'
      } else if (codec === 'h264' || codec === 'avc') {
        // Check for SPS/PPS warnings in ffprobe error output (not available here,
        // but treat as HEALTHY if codec ok and no error)
        healthStatus = 'HEALTHY'
      } else if (codec) {
        // Other codec that is not hevc — treat as stable
        healthStatus = 'HEALTHY'
      } else {
        // No codec info — stream_unstable
        healthStatus = 'STREAM_UNSTABLE'
      }
    } else {
      rtspSubOk = false
      const error = sub.error || ''
      lastRtspError = error

      if (error.includes('404') || error.includes('Not Found') || error.includes('no encontrado')) {
        healthStatus = 'RTSP_SUB_NOT_FOUND'
      } else if (error.includes('401') || error.includes('Unauthorized') || error.includes('Credenciales')) {
        healthStatus = 'AUTH_FAILED'
      } else if (
        error.includes('Timeout') || error.includes('timeout') ||
        error.includes('Connection refused') || error.includes('ECONNREFUSED') ||
        error.includes('ETIMEDOUT') || error.includes('EHOSTUNREACH') ||
        error.includes('Host no encontrado')
      ) {
        healthStatus = 'OFFLINE'
      } else {
        healthStatus = 'UNKNOWN'
      }
    }
  } catch (err: any) {
    lastRtspError = err?.message || 'Error inesperado en probe'
    healthStatus = 'UNKNOWN'
  }

  // Actualizar la cámara en DB
  await prisma.camera.update({
    where: { id: camera.id },
    data: {
      streamHealthStatus: healthStatus,
      rtspSubOk,
      subCodec,
      ...(subResolution ? { subResolution } : {}),
      lastRtspCheckAt: new Date(),
      lastRtspError,
    } as any,
  })

  return healthStatus
}
