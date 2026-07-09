// Stream Validator — valida la salud RTSP de una cámara y actualiza su streamHealthStatus en DB
import type { PrismaClient } from '@prisma/client'
import type { NVR, Camera } from '@prisma/client'
import { probeBothStreams } from './rtsp-probe'
import { decryptNvrPassword as decryptPass } from './credentials'

// Posibles valores de streamHealthStatus
export type StreamHealthStatus =
  | 'HEALTHY'
  | 'USING_MAIN_STREAM'
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
  let rtspMainOk = false
  let subCodec: string | null = null
  let mainCodec: string | null = null
  let subResolution: string | null = null
  let mainResolution: string | null = null
  let lastRtspError: string | null = null
  let preferredStream: 'sub' | 'main' = 'sub'

  try {
    const result = await probeBothStreams(nvrDecrypted, camera.channel)
    const sub = result.sub
    const main = result.main

    // Capture main stream results unconditionally for DB persistence
    rtspMainOk = main.ok
    mainCodec = main.codec || null
    mainResolution = main.ok && main.width ? `${main.width}x${main.height}` : null

    const subCodecLower = (sub.codec || '').toLowerCase()
    const mainCodecLower = (main.codec || '').toLowerCase()
    const subIsHevc = subCodecLower.includes('hevc') || subCodecLower.includes('h265') || subCodecLower.includes('h.265')
    const mainIsHevc = mainCodecLower.includes('hevc') || mainCodecLower.includes('h265') || mainCodecLower.includes('h.265')
    const mainIsH264 = mainCodecLower === 'h264' || mainCodecLower === 'avc' || (main.ok && !mainIsHevc && mainCodecLower !== '')

    if (sub.ok && !subIsHevc) {
      // Substream OK and H264-compatible → use substream
      healthStatus = 'HEALTHY'
      rtspSubOk = true
      subCodec = sub.codec || null
      subResolution = sub.width ? `${sub.width}x${sub.height}` : null
      preferredStream = 'sub'
      console.info(`[validator] ch${camera.channel} → HEALTHY sub=${sub.codec} ${subResolution || ''}`)
    } else if (sub.ok && subIsHevc) {
      // Substream is HEVC → check if main is H264
      rtspSubOk = true
      subCodec = sub.codec || null
      if (main.ok && mainIsH264) {
        healthStatus = 'USING_MAIN_STREAM'
        preferredStream = 'main'
        console.info(`[validator] ch${camera.channel} → USING_MAIN_STREAM (sub=HEVC, main=${main.codec})`)
      } else {
        // main is also HEVC or failed — can't play in browser
        healthStatus = 'CODEC_UNSUPPORTED_HEVC'
        preferredStream = 'sub'
        console.info(`[validator] ch${camera.channel} → CODEC_UNSUPPORTED_HEVC (sub=${sub.codec}, main=${main.codec || 'failed'})`)
      }
    } else {
      // Substream failed → try main as fallback
      rtspSubOk = false
      lastRtspError = sub.error || null
      if (main.ok && mainIsH264) {
        healthStatus = 'USING_MAIN_STREAM'
        preferredStream = 'main'
        console.info(`[validator] ch${camera.channel} → USING_MAIN_STREAM (sub failed, main=${main.codec})`)
      } else if (main.ok && mainIsHevc) {
        // Main is HEVC — cannot play in browser without transcoding
        healthStatus = 'CODEC_UNSUPPORTED_HEVC'
        preferredStream = 'sub'
        console.info(`[validator] ch${camera.channel} → CODEC_UNSUPPORTED_HEVC (sub failed, main=HEVC ${main.codec})`)
      } else {
        // Both failed — determine error type from sub error
        const error = sub.error || ''
        if (error.includes('404') || error.includes('Not Found') || error.includes('no encontrado')) {
          healthStatus = 'RTSP_SUB_NOT_FOUND'
        } else if (error.includes('401') || error.includes('Unauthorized') || error.includes('Credenciales')) {
          healthStatus = 'AUTH_FAILED'
        } else if (error.includes('Timeout') || error.includes('timeout') || error.includes('Connection refused') ||
                   error.includes('ECONNREFUSED') || error.includes('ETIMEDOUT') || error.includes('EHOSTUNREACH') ||
                   error.includes('Host no encontrado')) {
          healthStatus = 'OFFLINE'
        } else {
          healthStatus = 'UNKNOWN'
        }
        console.info(`[validator] ch${camera.channel} → ${healthStatus} (sub err: ${error.slice(0, 80)})`)
      }
    }
  } catch (err: any) {
    lastRtspError = err?.message || 'Error inesperado en probe'
    healthStatus = 'UNKNOWN'
  }

  // Camera is reachable if any RTSP stream responded — regardless of codec/browser-compatibility
  const rtspReachable = rtspSubOk || rtspMainOk
  const hardOffline = healthStatus === 'OFFLINE' || healthStatus === 'AUTH_FAILED'

  // Actualizar la cámara en DB
  await prisma.camera.update({
    where: { id: camera.id },
    data: {
      streamHealthStatus: healthStatus,
      rtspSubOk,
      rtspMainOk,
      subCodec,
      mainCodec,
      ...(subResolution ? { subResolution } : {}),
      ...(mainResolution ? { mainResolution } : {}),
      lastRtspCheckAt: new Date(),
      lastRtspError,
      preferredStream,
      // online is RTSP-truth: true when any stream responds, false only when confirmed unreachable
      ...(rtspReachable ? { online: true } : hardOffline ? { online: false } : {}),
    } as any,
  })

  return healthStatus
}
