// Perfiles de transcodificación (PR B). Extrae la construcción de argumentos FFmpeg a
// una función PURA y añade un perfil exclusivo de FOCO (1×1) de mayor calidad, separado
// del perfil de grilla. El perfil 'grid' reproduce EXACTAMENTE la configuración previa
// (TRANSCODE_*), de modo que la grilla 3×3/4×4 no cambia; sólo el foco puede pedir 1080p.

export interface TranscodeProfileConfig {
  width: string       // '1280' | '1920' | 'source' (sin escalado)
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

// Perfil de FOCO (1×1) — usa LIVE_FOCUS_TRANSCODE_* con defaults de mayor calidad. NO se
// aplica a las grillas. Encoder/preset/gop se heredan de la grilla salvo override.
export function resolveFocusProfile(env: Env = process.env): TranscodeProfileConfig {
  const grid = resolveGridProfile(env)
  const bitrate = env.LIVE_FOCUS_TRANSCODE_BITRATE || '3500k'
  return {
    width:      env.LIVE_FOCUS_TRANSCODE_WIDTH || '1920',
    fps:        env.LIVE_FOCUS_TRANSCODE_FPS || '20',
    bitrate,
    maxrate:    env.LIVE_FOCUS_TRANSCODE_MAXRATE || bitrate,
    bufsize:    env.LIVE_FOCUS_TRANSCODE_BUFSIZE || '',
    preset:     env.LIVE_FOCUS_TRANSCODE_PRESET || grid.preset,
    encoder:    grid.encoder,
    gopSeconds: grid.gopSeconds,
  }
}

export function resolveTranscodeProfile(profile: 'grid' | 'focus', env: Env = process.env): TranscodeProfileConfig {
  return profile === 'focus' ? resolveFocusProfile(env) : resolveGridProfile(env)
}

// Límite de transcodificaciones simultáneas de foco (separado del límite general).
export function focusMaxTranscodes(env: Env = process.env): number | null {
  const raw = env.LIVE_FOCUS_MAX_TRANSCODES
  if (raw === undefined || raw === '') return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export interface TranscodeIo {
  rtspInput: string
  rtspOutput: string
  rtspTimeoutOpt: string | null   // p.ej. '-timeout' o '-rw_timeout', o null si no soportado
}

// Construcción PURA de los argumentos de FFmpeg. Idéntica a la previa para el perfil de
// grilla; parametriza width/fps/bitrate/maxrate/bufsize/preset/encoder/gop por perfil.
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

  // Escalado — se omite si width='source' (usa la resolución nativa del main). Nunca se
  // hace upscale del sub: el foco parte SIEMPRE del main (canal 01).
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
