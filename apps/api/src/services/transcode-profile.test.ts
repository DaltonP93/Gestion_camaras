import { describe, it, expect } from 'vitest'
import {
  resolveGridProfile, resolveFocusProfile, buildTranscodeArgs, focusMaxTranscodes,
} from './transcode-profile'

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

describe('resolveFocusProfile (foco 1×1, mayor calidad)', () => {
  it('defaults de foco: 1920 / 20fps / 3500k', () => {
    const p = resolveFocusProfile({})
    expect(p).toMatchObject({ width: '1920', fps: '20', bitrate: '3500k', maxrate: '3500k' })
  })
  it('LIVE_FOCUS_TRANSCODE_* override', () => {
    const p = resolveFocusProfile({
      LIVE_FOCUS_TRANSCODE_WIDTH: 'source',
      LIVE_FOCUS_TRANSCODE_FPS: '25',
      LIVE_FOCUS_TRANSCODE_BITRATE: '6000k',
      LIVE_FOCUS_TRANSCODE_MAXRATE: '8000k',
    })
    expect(p).toMatchObject({ width: 'source', fps: '25', bitrate: '6000k', maxrate: '8000k' })
  })
  it('hereda encoder/preset/gop de la grilla', () => {
    const p = resolveFocusProfile({ TRANSCODE_ENCODER: 'h264_nvenc', TRANSCODE_GOP_SECONDS: '4' })
    expect(p.encoder).toBe('h264_nvenc')
    expect(p.gopSeconds).toBe(4)
  })
})

describe('buildTranscodeArgs (puro)', () => {
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
  it('foco: escala a 1920, bufsize 7000k, gop 40 (20fps×2s)', () => {
    const args = buildTranscodeArgs(resolveFocusProfile({}), IO)
    expect(pair(args, '-vf')).toBe('scale=1920:-2')
    expect(pair(args, '-b:v')).toBe('3500k')
    expect(pair(args, '-bufsize')).toBe('7000k')
    expect(pair(args, '-g')).toBe('40')
  })
  it('width=source: NO agrega -vf (sin escalado, resolución nativa del main)', () => {
    const args = buildTranscodeArgs(resolveFocusProfile({ LIVE_FOCUS_TRANSCODE_WIDTH: 'source' }), IO)
    expect(args).not.toContain('-vf')
  })
  it('sin rtspTimeoutOpt no agrega la opción de timeout', () => {
    const args = buildTranscodeArgs(resolveGridProfile({}), { ...IO, rtspTimeoutOpt: null })
    expect(args).not.toContain('-timeout')
  })
})

describe('focusMaxTranscodes', () => {
  it('null si no está configurado', () => {
    expect(focusMaxTranscodes({})).toBeNull()
  })
  it('parsea el límite configurado', () => {
    expect(focusMaxTranscodes({ LIVE_FOCUS_MAX_TRANSCODES: '2' })).toBe(2)
    expect(focusMaxTranscodes({ LIVE_FOCUS_MAX_TRANSCODES: '0' })).toBe(0)
    expect(focusMaxTranscodes({ LIVE_FOCUS_MAX_TRANSCODES: 'x' })).toBeNull()
  })
})
