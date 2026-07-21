// Parsers PUROS y testeables de la salida de FFmpeg — para instrumentar por
// ETAPAS dónde se detiene cada estrategia de reproducción (RTSP abierto, paquetes
// recibidos, frame decodificado, frame codificado, primer byte muxeado). No
// spawnean nada: sólo interpretan texto que el caller ya capturó. Nunca deben
// recibir (ni por tanto exponer) credenciales — operan sobre stderr/-progress.

export interface FfmpegProgressSnapshot {
  frame: number | null
  fps: number | null
  outTimeMs: number | null      // milisegundos de media producidos
  totalSize: number | null      // bytes escritos al muxer/salida
  speed: string | null
  progress: 'continue' | 'end' | null
}

// FFmpeg `-progress` emite bloques de líneas key=value terminados por
// `progress=continue|end`. Devuelve el ÚLTIMO snapshot completo visto (el estado
// más reciente) — suficiente para saber si avanzó (frame>0, out_time>0, size>0).
export function parseFfmpegProgress(text: string): FfmpegProgressSnapshot {
  const snap: FfmpegProgressSnapshot = {
    frame: null, fps: null, outTimeMs: null, totalSize: null, speed: null, progress: null,
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    switch (key) {
      case 'frame':      { const n = parseInt(val, 10); if (!Number.isNaN(n)) snap.frame = n; break }
      case 'fps':        { const n = parseFloat(val);   if (!Number.isNaN(n)) snap.fps = n; break }
      case 'out_time_us':{ const n = parseInt(val, 10); if (!Number.isNaN(n)) snap.outTimeMs = Math.floor(n / 1000); break }
      case 'out_time_ms':{ // FFmpeg confusamente emite out_time_ms en MICROsegundos en
                           // algunas builds; sólo se usa si out_time_us no vino.
                           if (snap.outTimeMs == null) { const n = parseInt(val, 10); if (!Number.isNaN(n)) snap.outTimeMs = Math.floor(n / 1000) } break }
      case 'total_size': { const n = parseInt(val, 10); if (!Number.isNaN(n)) snap.totalSize = n; break }
      case 'speed':      { snap.speed = val || null; break }
      case 'progress':   { snap.progress = (val === 'end' ? 'end' : 'continue'); break }
    }
  }
  return snap
}

export interface FfmpegStreamInfo {
  inputOpened: boolean       // se vio "Input #0"
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
  fps: number | null
}

// Extrae info de streams del stderr de FFmpeg/ffprobe (líneas "Input #0" y
// "Stream #0:N: Video/Audio: ..."). Sirve para saber si el RTSP abrió y qué
// descubrió, sin depender de que salga un solo byte muxeado.
export function parseStreamInfoFromStderr(stderr: string): FfmpegStreamInfo {
  const info: FfmpegStreamInfo = {
    inputOpened: false, videoCodec: null, audioCodec: null, width: null, height: null, fps: null,
  }
  if (/^\s*Input #\d+/m.test(stderr) || /\bInput #\d+,/.test(stderr)) info.inputOpened = true
  for (const raw of stderr.split('\n')) {
    const line = raw.trim()
    const v = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Video:\s*([a-z0-9_]+)/i)
    if (v && !info.videoCodec) {
      info.videoCodec = v[1].toLowerCase()
      const dim = line.match(/(\d{2,5})x(\d{2,5})/)
      if (dim) { info.width = parseInt(dim[1], 10); info.height = parseInt(dim[2], 10) }
      const f = line.match(/(\d+(?:\.\d+)?)\s*fps/)
      if (f) info.fps = parseFloat(f[1])
      // Si abrió streams de video, evidentemente el input abrió.
      info.inputOpened = true
    }
    const a = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Audio:\s*([a-z0-9_]+)/i)
    if (a && !info.audioCodec) { info.audioCodec = a[1].toLowerCase(); info.inputOpened = true }
  }
  return info
}

// Parsea la salida JSON de `ffprobe -show_streams -show_format -of json`. Devuelve
// null si no es JSON válido. Tolerante: sólo lee lo que necesita.
export function parseFfprobeJson(jsonText: string): {
  streamsDetected: number; videoCodec: string | null; audioCodec: string | null
  width: number | null; height: number | null; fps: number | null
} | null {
  let data: any
  try { data = JSON.parse(jsonText) } catch { return null }
  const streams: any[] = Array.isArray(data?.streams) ? data.streams : []
  const video = streams.find(s => s?.codec_type === 'video')
  const audio = streams.find(s => s?.codec_type === 'audio')
  let fps: number | null = null
  if (video?.avg_frame_rate && typeof video.avg_frame_rate === 'string') {
    const [n, d] = video.avg_frame_rate.split('/').map((x: string) => parseInt(x, 10))
    if (n > 0 && d > 0) fps = Math.round((n / d) * 100) / 100
  }
  return {
    streamsDetected: streams.length,
    videoCodec: video?.codec_name ? String(video.codec_name).toLowerCase() : null,
    audioCodec: audio?.codec_name ? String(audio.codec_name).toLowerCase() : null,
    width: typeof video?.width === 'number' ? video.width : null,
    height: typeof video?.height === 'number' ? video.height : null,
    fps,
  }
}
