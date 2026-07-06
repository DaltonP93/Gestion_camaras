// apps/api/src/services/rtsp-probe.ts
// Valida streams RTSP usando ffprobe
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface RtspProbeResult {
  ok: boolean
  codec?: string
  width?: number
  height?: number
  fps?: number
  bitrate?: number
  latencyMs?: number
  error?: string
}

const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe'
const PROBE_TIMEOUT_MS = 12000

// Masks passwords in RTSP URLs: rtsp://user:pass@host → rtsp://user:***@host
function sanitizeRtsp(s: string): string {
  return s.replace(/rtsp:\/\/([^:@]+):([^@]+)@/gi, 'rtsp://$1:***@')
}

export async function probeRtspStream(rtspUrl: string): Promise<RtspProbeResult> {
  const start = Date.now()

  // Enmascarar password en logs
  const masked = rtspUrl.replace(/:([^@]+)@/, ':***@')

  try {
    const { stdout } = await execFileAsync(
      FFPROBE_PATH,
      [
        '-v', 'quiet',
        '-rtsp_transport', 'tcp',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,r_frame_rate,bit_rate',
        '-of', 'json',
        rtspUrl,
      ],
      { timeout: PROBE_TIMEOUT_MS }
    )

    const latencyMs = Date.now() - start
    const data = JSON.parse(stdout)
    const stream = data?.streams?.[0]

    if (!stream) {
      return { ok: false, error: 'No video stream found', latencyMs }
    }

    // r_frame_rate viene como "30/1" o "15/1"
    let fps = 0
    if (stream.r_frame_rate) {
      const [num, den] = stream.r_frame_rate.split('/').map(Number)
      fps = den > 0 ? Math.round((num / den) * 10) / 10 : 0
    }

    return {
      ok:        true,
      codec:     stream.codec_name || '',
      width:     stream.width || 0,
      height:    stream.height || 0,
      fps,
      bitrate:   parseInt(stream.bit_rate || '0'),
      latencyMs,
    }
  } catch (err: any) {
    const latencyMs = Date.now() - start
    let error = sanitizeRtsp(err.message || 'ffprobe error')

    if (err.code === 'ETIMEDOUT' || latencyMs >= PROBE_TIMEOUT_MS) {
      error = `Timeout después de ${PROBE_TIMEOUT_MS}ms`
    } else if (error.includes('453') || /not enough bandwidth/i.test(error)) {
      error = 'NVR sin ancho de banda / sesiones libres (453)'
    } else if (error.includes('401') || error.includes('Unauthorized')) {
      error = 'Credenciales RTSP incorrectas (401)'
    } else if (error.includes('Connection refused') || error.includes('ECONNREFUSED')) {
      error = 'Conexión rechazada — NVR no responde en RTSP'
    } else if (error.includes('No such host') || error.includes('ENOTFOUND')) {
      error = 'Host no encontrado'
    } else if (error.includes('404') || error.includes('Not Found')) {
      error = 'Canal/stream no encontrado (404)'
    }

    return { ok: false, error: `${masked}: ${error}`, latencyMs }
  }
}

// Probe ambos streams (main y sub) de un canal
export async function probeBothStreams(
  nvr: { ipAddress: string; rtspPort: number; username: string; password: string },
  channel: number
): Promise<{ main: RtspProbeResult; sub: RtspProbeResult }> {
  const { ipAddress, rtspPort, username, password } = nvr
  const enc = encodeURIComponent(password)

  const mainUrl = `rtsp://${username}:${enc}@${ipAddress}:${rtspPort}/Streaming/Channels/${channel}01`
  const subUrl  = `rtsp://${username}:${enc}@${ipAddress}:${rtspPort}/Streaming/Channels/${channel}02`

  const [main, sub] = await Promise.all([
    probeRtspStream(mainUrl),
    probeRtspStream(subUrl),
  ])

  return { main, sub }
}
