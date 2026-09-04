import { describe, expect, it } from 'vitest'
import { codecIsHevc, hdStartupMessage } from './hdStartupMessage'

describe('hdStartupMessage', () => {
  it.each(['HEVC', 'h265', 'H.265', 'hvc1'])(
    'explica la preparación del transcode para %s',
    (codec) => {
      expect(codecIsHevc(codec)).toBe(true)
      expect(hdStartupMessage({ mainCodec: codec, transcodingAvailable: true }))
        .toContain('5–7 s')
    },
  )

  it('no promete transcodificación para H.264 ni cuando está deshabilitada', () => {
    expect(hdStartupMessage({ mainCodec: 'H264', transcodingAvailable: true }))
      .toBe('Cambiando a video HD…')
    expect(hdStartupMessage({ mainCodec: 'HEVC', transcodingAvailable: false }))
      .toBe('Cambiando a video HD…')
  })

  it('explica la espera si se pidió main_h264 explícitamente', () => {
    expect(hdStartupMessage({
      mainCodec: 'H264',
      transcodingAvailable: true,
      requestedType: 'main_h264',
    })).toContain('5–7 s')
  })
})
