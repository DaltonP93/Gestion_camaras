// Construcción de argumentos de FFmpeg para live (PR B). Extrae a una función PURA la
// creación de args del transcode de grilla — misma configuración que antes (TRANSCODE_*),
// de modo que el comportamiento de la grilla NO cambia; sólo queda testeable.
//
// NOTA: el perfil de transcode de FOCO (1080p, LIVE_FOCUS_*) se DIFIERE a un PR aparte:
// requiere aislar la identidad del path/proceso main_h264 por perfil (hoy foco y fallback
// de grilla comparten getTranscodedStreamPath) y validación de CPU/memoria en un NVR real.

export interface TranscodeProfileConfig {
  width: string       // '1280' | 'source' (sin escalado)
  fps: string         // '15'
  bitrate: string     // '1500k'
  maxrate: string
  bufsize: string     // '' → auto (2× bitrate)
  preset: string
  encoder: string
  gopSeconds: number
}

type Env = Record<string, string | undefined>

// Perfil de GRILLA — precedencia idéntica a la del código previo (no cambia la grilla).
export function resolveGridProfile(env: Env = process.env): TranscodeProfileConfig {
  const bitrate = env.TRANSCODE_BITRATE || env.HEVC_TRANSCODE_BITRATE || '1500k'
  return {
    width:      env.TRANSCODE_WIDTH || env.HEVC_TRANSCODE_WIDTH || '1280',
    fps:        env.TRANSCODE_FPS || env.HEVC_TRANSCODE_FPS || '15',
    bitrate,
    maxrate:    env.TRANSCODE_MAXRATE || bitrate,
    bufsize:    env.TRANSCODE_BUFSIZE || '',
    preset:     env.HEVC_TRANSCODE_PRESET || 'ultrafast',
    encoder:    env.TRANSCODE_ENCODER || 'libx264',
    gopSeconds: Number(env.TRANSCODE_GOP_SECONDS || '2'),
  }
}

// Deriva la resolución de SALIDA real del transcode a partir del perfil aplicado y la
// resolución de la FUENTE (p.ej. "1920x1080"). El transcode escala a `width` preservando
// el aspecto (scale=width:-2 → alto par). Devuelve "WxH", o null si no se puede derivar.
// Con width='source' (sin escalado) devuelve la resolución de la fuente tal cual.
export function deriveOutputResolution(
  sourceResolution: string | null | undefined,
  cfg: TranscodeProfileConfig,
): string | null {
  if (!sourceResolution) return null
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(sourceResolution.trim())
  if (!m) return null
  const srcW = Number(m[1])
  const srcH = Number(m[2])
  if (!srcW || !srcH) return null
  if (cfg.width === 'source') return `${srcW}x${srcH}`
  const outW = Number(cfg.width)
  if (!outW) return null
  // scale=outW:-2 → alto proporcional redondeado al múltiplo de 2 más cercano.
  const outH = Math.round((srcH * outW) / srcW / 2) * 2
  return `${outW}x${outH}`
}

export interface TranscodeIo {
  rtspInput: string
  rtspOutput: string
  rtspTimeoutOpt: string | null   // p.ej. '-timeout' o '-rw_timeout', o null si no soportado
}

// Construcción PURA de los argumentos de FFmpeg. Idéntica a la previa.
export function buildTranscodeArgs(cfg: TranscodeProfileConfig, io: TranscodeIo): string[] {
  const fps = Number(cfg.fps) || 15
  const gopFrames = Math.max(1, Math.round(fps * cfg.gopSeconds))

  const bitrateNum = parseInt(cfg.bitrate) || 1500
  const bitrateUnit = cfg.bitrate.replace(/^\d+/, '') || 'k'
  const bufsize = cfg.bufsize || `${bitrateNum * 2}${bitrateUnit}`

  const args: string[] = [
    '-rtsp_transport', 'tcp',
    '-fflags', '+genpts+discardcorrupt',
    '-use_wallclock_as_timestamps', '1',
    ...(io.rtspTimeoutOpt ? [io.rtspTimeoutOpt, '15000000'] : []),
    '-reorder_queue_size', '0',
    '-i', io.rtspInput,
    '-an',
  ]

  if (cfg.width !== 'source') {
    args.push('-vf', `scale=${cfg.width}:-2`)
  }

  args.push('-r', cfg.fps, '-c:v', cfg.encoder, '-preset', cfg.preset)

  if (cfg.encoder === 'libx264' || cfg.encoder === 'libx265') {
    args.push('-tune', 'zerolatency')
  }

  args.push(
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-level', '4.1',
    '-bf', '0',
    '-sc_threshold', '0',
    '-g', String(gopFrames),
    '-keyint_min', String(gopFrames),
    '-force_key_frames', `expr:gte(t,n_forced*${cfg.gopSeconds})`,
  )

  args.push(
    '-b:v', cfg.bitrate,
    '-maxrate', cfg.maxrate,
    '-bufsize', bufsize,
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    io.rtspOutput,
  )

  return args
}
