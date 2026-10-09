import { describe, it, expect } from 'vitest'
import { buildStreamPayload } from './streamConfigPayload'

const video = { videoCodecType: 'H.264', width: 1920, height: 1080, fps: 15, bitrateMax: 4096, bitrateType: 'CBR' }

describe('buildStreamPayload — el audio sólo viaja si el usuario lo eligió', () => {
  it('sin elección (o "keep") ⇒ ningún campo de audio', () => {
    for (const form of [video, { ...video, audio: 'keep' as const }]) {
      const p = buildStreamPayload('main', form)
      expect(p).toEqual({ streamType: 'main', ...video })
      expect(Object.keys(p).some((k) => k.startsWith('audio'))).toBe(false)
    }
  })

  it('"on"/"off" ⇒ sólo audioEnabled (nunca codec vacío ni bitrate inventado)', () => {
    expect(buildStreamPayload('sub', { ...video, audio: 'off' })).toEqual({ streamType: 'sub', ...video, audioEnabled: false })
    expect(buildStreamPayload('main', { ...video, audio: 'on' })).toEqual({ streamType: 'main', ...video, audioEnabled: true })
  })
})
