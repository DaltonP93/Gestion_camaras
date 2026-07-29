import { describe, it, expect } from 'vitest'
import { decideStreamRequest, wantsMainQuality } from './live-quality'

const base = { mainCodecIsHevc: false, transcodeEnabled: true }

describe('decideStreamRequest (política adaptativa)', () => {
  it('focus=1 solicita main', () => {
    expect(decideStreamRequest({ ...base, layout: 9, focus: true })).toMatchObject({ streamType: 'main', profile: 'focus' })
  })
  it('layout 1 solicita main (perfil de foco)', () => {
    expect(decideStreamRequest({ ...base, layout: 1, focus: false })).toMatchObject({ streamType: 'main', profile: 'focus' })
  })
  it('3×3 (layout 9) usa sub', () => {
    expect(decideStreamRequest({ ...base, layout: 9, focus: false })).toEqual({ streamType: 'sub', profile: 'grid', fallbackToSub: false })
  })
  it('4×4 (layout 16) usa sub', () => {
    expect(decideStreamRequest({ ...base, layout: 16, focus: false })).toMatchObject({ streamType: 'sub' })
  })
  it('2×2 (layout 4) usa sub por defecto', () => {
    expect(decideStreamRequest({ ...base, layout: 4, focus: false })).toMatchObject({ streamType: 'sub' })
  })
  it('H.264 main: pide main sin transcode', () => {
    const d = decideStreamRequest({ layout: 1, focus: true, mainCodecIsHevc: false, transcodeEnabled: false })
    expect(d).toMatchObject({ streamType: 'main', fallbackToSub: false })
  })
  it('HEVC main + transcode: pide main (el backend redirige a main_h264)', () => {
    const d = decideStreamRequest({ layout: 1, focus: true, mainCodecIsHevc: true, transcodeEnabled: true })
    expect(d).toMatchObject({ streamType: 'main', profile: 'focus', fallbackToSub: false })
  })
  it('HEVC main sin transcode: fallback a sub con aviso', () => {
    const d = decideStreamRequest({ layout: 1, focus: true, mainCodecIsHevc: true, transcodeEnabled: false })
    expect(d).toEqual({ streamType: 'sub', profile: 'grid', fallbackToSub: true })
  })
})

describe('wantsMainQuality', () => {
  it('true en 1×1 o foco; false en grillas', () => {
    expect(wantsMainQuality(1, false)).toBe(true)
    expect(wantsMainQuality(9, true)).toBe(true)
    expect(wantsMainQuality(9, false)).toBe(false)
    expect(wantsMainQuality(4, false)).toBe(false)
  })
})
