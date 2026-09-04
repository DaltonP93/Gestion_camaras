// Builder de live/address/get (clamp de TTL ≤600) y parser de la URL HLS.

import { describe, it, expect } from 'vitest'
import { buildHlsAddressRequest, parseHlsAddress, clampHlsTtl, MAX_HLS_TTL_SEC, HLS_ADDRESS_PATH } from './hls'
import { HikConnectError } from './errors'

function code(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e instanceof HikConnectError ? e.code : 'OTHER'
  }
}

describe('clampHlsTtl — clamp ≤ 600', () => {
  it('recorta valores > 600 a 600', () => {
    expect(clampHlsTtl(3600)).toBe(MAX_HLS_TTL_SEC)
    expect(clampHlsTtl(601)).toBe(600)
  })
  it('mantiene valores en rango', () => {
    expect(clampHlsTtl(300)).toBe(300)
    expect(clampHlsTtl(1)).toBe(1)
  })
  it('valores < 1 → 1; undefined/NaN → 600', () => {
    expect(clampHlsTtl(0)).toBe(1)
    expect(clampHlsTtl(-5)).toBe(1)
    expect(clampHlsTtl(undefined)).toBe(600)
    expect(clampHlsTtl(NaN)).toBe(600)
  })
})

describe('buildHlsAddressRequest', () => {
  it('produce POST form con protocol HLS y expireTime clampeado', () => {
    const spec = buildHlsAddressRequest({ accessToken: 'at', deviceSerial: 'DS1', channelNo: 2, expireSec: 9999 })
    expect(spec.method).toBe('POST')
    expect(spec.path).toBe(HLS_ADDRESS_PATH)
    expect(spec.body).toContain('deviceSerial=DS1')
    expect(spec.body).toContain('channelNo=2')
    expect(spec.body).toContain('protocol=1')
    expect(spec.body).toContain(`expireTime=${MAX_HLS_TTL_SEC}`)
  })

  it('channelNo por defecto = 1', () => {
    const spec = buildHlsAddressRequest({ accessToken: 'at', deviceSerial: 'DS1' })
    expect(spec.body).toContain('channelNo=1')
  })

  it('valida args', () => {
    expect(code(() => buildHlsAddressRequest({ accessToken: '', deviceSerial: 'DS' }))).toBe('INVALID_ARG')
    expect(code(() => buildHlsAddressRequest({ accessToken: 'at', deviceSerial: '' }))).toBe('INVALID_ARG')
    expect(code(() => buildHlsAddressRequest({ accessToken: 'at', deviceSerial: 'DS', channelNo: 0 }))).toBe(
      'INVALID_ARG',
    )
  })
})

describe('parseHlsAddress', () => {
  it('parsea url', () => {
    const r = parseHlsAddress({ code: '200', data: { url: 'https://x.ys7.com/live/abc.m3u8' } }, 300)
    expect(r).toEqual({ url: 'https://x.ys7.com/live/abc.m3u8', ttlSec: 300 })
  })
  it('acepta hlsAddress como nombre alternativo', () => {
    const r = parseHlsAddress({ code: '200', data: { hlsAddress: 'https://x.ys7.com/live/y.m3u8' } }, 120)
    expect(r.url).toBe('https://x.ys7.com/live/y.m3u8')
  })
  it('code de error → API_ERROR', () => {
    expect(code(() => parseHlsAddress({ code: '20007', msg: 'offline' }, 300))).toBe('API_ERROR')
  })
  it('sin url → PARSE_ERROR', () => {
    expect(code(() => parseHlsAddress({ code: '200', data: {} }, 300))).toBe('PARSE_ERROR')
  })
})
