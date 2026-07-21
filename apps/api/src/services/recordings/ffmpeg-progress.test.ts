import { describe, it, expect } from 'vitest'
import { parseFfmpegProgress, parseStreamInfoFromStderr, parseFfprobeJson } from './ffmpeg-progress'

describe('parseFfmpegProgress', () => {
  it('lee el último snapshot de bloques -progress', () => {
    const text = [
      'frame=1', 'fps=0.00', 'total_size=48', 'out_time_us=0', 'speed=0x', 'progress=continue',
      'frame=25', 'fps=24.90', 'total_size=131072', 'out_time_us=1000000', 'speed=1.01x', 'progress=continue',
    ].join('\n')
    const s = parseFfmpegProgress(text)
    expect(s.frame).toBe(25)
    expect(s.fps).toBeCloseTo(24.9)
    expect(s.totalSize).toBe(131072)
    expect(s.outTimeMs).toBe(1000)   // 1_000_000 us → 1000 ms
    expect(s.progress).toBe('continue')
  })
  it('marca progress=end', () => {
    expect(parseFfmpegProgress('frame=100\nprogress=end').progress).toBe('end')
  })
  it('tolera texto vacío', () => {
    const s = parseFfmpegProgress('')
    expect(s.frame).toBeNull(); expect(s.totalSize).toBeNull()
  })
})

describe('parseStreamInfoFromStderr', () => {
  it('detecta input abierto, video y audio con dimensiones y fps', () => {
    const stderr = [
      "Input #0, rtsp, from 'rtsp://x':",
      '  Duration: N/A, start: 0.000000, bitrate: N/A',
      '  Stream #0:0: Video: hevc (Main), yuvj420p(pc), 2560x1440, 20 fps, 20 tbr, 90k tbn',
      '  Stream #0:1: Audio: aac (LC), 8000 Hz, mono, fltp',
    ].join('\n')
    const info = parseStreamInfoFromStderr(stderr)
    expect(info.inputOpened).toBe(true)
    expect(info.videoCodec).toBe('hevc')
    expect(info.audioCodec).toBe('aac')
    expect(info.width).toBe(2560)
    expect(info.height).toBe(1440)
    expect(info.fps).toBe(20)
  })
  it('reproduce el caso real: sólo se ve Audio AAC 8000 Hz (video aún no)', () => {
    const info = parseStreamInfoFromStderr('  Stream #0:1: Audio: aac (LC), 8000 Hz, mono, fltp')
    expect(info.audioCodec).toBe('aac')
    expect(info.videoCodec).toBeNull()
    expect(info.inputOpened).toBe(true)
  })
  it('sin streams → input no abierto', () => {
    const info = parseStreamInfoFromStderr('ffmpeg version 6.0\nbuilt with gcc')
    expect(info.inputOpened).toBe(false)
    expect(info.videoCodec).toBeNull()
  })
})

describe('parseFfprobeJson', () => {
  it('extrae streams, codecs y fps', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '25/1' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    })
    const r = parseFfprobeJson(json)!
    expect(r.streamsDetected).toBe(2)
    expect(r.videoCodec).toBe('h264')
    expect(r.audioCodec).toBe('aac')
    expect(r.width).toBe(1920)
    expect(r.fps).toBe(25)
  })
  it('devuelve null para JSON inválido', () => {
    expect(parseFfprobeJson('not json')).toBeNull()
  })
})
