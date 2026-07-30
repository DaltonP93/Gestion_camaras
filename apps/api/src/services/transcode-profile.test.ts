import { describe, it, expect } from 'vitest'
import { resolveGridProfile, buildTranscodeArgs } from './transcode-profile'

const IO = { rtspInput: 'rtsp://in/101', rtspOutput: 'rtsp://out/path', rtspTimeoutOpt: '-timeout' }
const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('resolveGridProfile (grilla, sin cambios)', () => {
  it('defaults previos: 1280 / 15fps / 1500k / libx264', () => {
    const p = resolveGridProfile({})
    expect(p).toMatchObject({ width: '1280', fps: '15', bitrate: '1500k', maxrate: '1500k', encoder: 'libx264', gopSeconds: 2 })
  })
  it('respeta TRANSCODE_* y alias HEVC_*', () => {
    expect(resolveGridProfile({ TRANSCODE_WIDTH: '960' }).width).toBe('960')
    expect(resolveGridProfile({ HEVC_TRANSCODE_WIDTH: '854' }).width).toBe('854')
    expect(resolveGridProfile({ TRANSCODE_WIDTH: 'x', HEVC_TRANSCODE_WIDTH: 'y' }).width).toBe('x')
  })
})

describe('buildTranscodeArgs (puro, idéntico al comportamiento previo)', () => {
  it('grilla: escala a 1280, bitrate/bufsize correctos, keyframes por GOP', () => {
    const args = buildTranscodeArgs(resolveGridProfile({}), IO)
    expect(args).toContain('-i'); expect(pair(args, '-i')).toBe('rtsp://in/101')
    expect(pair(args, '-vf')).toBe('scale=1280:-2')
    expect(pair(args, '-b:v')).toBe('1500k')
    expect(pair(args, '-bufsize')).toBe('3000k')          // auto = 2× bitrate
    expect(pair(args, '-g')).toBe('30')                   // 15fps × 2s
    expect(args[args.length - 1]).toBe('rtsp://out/path')
    expect(pair(args, '-timeout')).toBe('15000000')
  })
  it('width=source: NO agrega -vf (sin escalado, resolución nativa)', () => {
    const args = buildTranscodeArgs(resolveGridProfile({ TRANSCODE_WIDTH: 'source' }), IO)
    expect(args).not.toContain('-vf')
  })
  it('sin rtspTimeoutOpt no agrega la opción de timeout', () => {
    const args = buildTranscodeArgs(resolveGridProfile({}), { ...IO, rtspTimeoutOpt: null })
    expect(args).not.toContain('-timeout')
  })
})
