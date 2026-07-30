import { describe, it, expect } from 'vitest'
import { shouldShowCodecUnsupported } from './codecSupport'

describe('shouldShowCodecUnsupported — no falsos CODEC_UNSUPPORTED (P1)', () => {
  it('main HEVC + primer HLS 500 (MediaMTX no listo) → NO incompatible', () => {
    // El stream es HEVC pero el fallo es un 500 temporal; reintentar debe permitirse.
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      errorCode: 'MEDIAMTX_NOT_READY',
      hlsErrorDetail: 'fragLoadError',
    })).toBe(false)
  })

  it('main HEVC + segundo intento exitoso (sin error) → NO incompatible', () => {
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      errorCode: null,
      hlsErrorDetail: null,
    })).toBe(false)
  })

  it('main HEVC + timeout temporal → NO incompatible', () => {
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      errorCode: 'PLAYER_TIMEOUT',
    })).toBe(false)
  })

  it('main HEVC + 404 (manifest temporal) → NO incompatible', () => {
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      errorCode: 'HLS_MANIFEST_NOT_FOUND',
    })).toBe(false)
  })

  it('error real manifestIncompatibleCodecsError → SÍ incompatible', () => {
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      hlsErrorDetail: 'manifestIncompatibleCodecsError',
    })).toBe(true)
  })

  it('error real bufferIncompatibleCodecsError → SÍ incompatible', () => {
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      hlsErrorDetail: 'bufferIncompatibleCodecsError',
    })).toBe(true)
  })

  it('error clasificado CODEC_UNSUPPORTED → SÍ incompatible', () => {
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      errorCode: 'CODEC_UNSUPPORTED',
    })).toBe(true)
  })

  it('comprobación explícita del navegador (MediaSource) = incompatible → SÍ', () => {
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      explicitIncompatible: true,
    })).toBe(true)
  })

  it('REGRESIÓN: streamType main pero SIN señal de error real → NO (aunque sea HEVC)', () => {
    // Antes bastaba con que el códec fuese HEVC para rotular incompatible: el bug.
    expect(shouldShowCodecUnsupported({
      streamType: 'main',
      errorCode: 'MEDIAMTX_NOT_READY',
      explicitIncompatible: null,
    })).toBe(false)
  })

  it('sub / main_h264 nunca muestran la rama HEVC', () => {
    expect(shouldShowCodecUnsupported({ streamType: 'sub', errorCode: 'CODEC_UNSUPPORTED' })).toBe(false)
    expect(shouldShowCodecUnsupported({ streamType: 'main_h264', hlsErrorDetail: 'manifestIncompatibleCodecsError' })).toBe(false)
  })
})
