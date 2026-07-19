import { describe, it, expect } from 'vitest'
import { redactUrlSecrets, redactUrlUserinfo } from './log-redact'

describe('redactUrlSecrets', () => {
  it('enmascara el token del WS y de streams', () => {
    expect(redactUrlSecrets('/ws/alerts?token=eyJhbGciOiJIUzI1NiJ9.abc.def'))
      .toBe('/ws/alerts?token=***')
    expect(redactUrlSecrets('/api/recordings/preview/s1/stream?token=SECRET&x=1'))
      .toBe('/api/recordings/preview/s1/stream?token=***&x=1')
  })

  it('enmascara varios parámetros sensibles y respeta el resto', () => {
    expect(redactUrlSecrets('/x?a=1&accessToken=zzz&b=2&password=p'))
      .toBe('/x?a=1&accessToken=***&b=2&password=***')
  })

  it('no toca URLs sin secretos', () => {
    expect(redactUrlSecrets('/api/cameras?nvrId=abc')).toBe('/api/cameras?nvrId=abc')
    expect(redactUrlSecrets('')).toBe('')
  })
})

describe('redactUrlUserinfo', () => {
  it('enmascara la contraseña en URLs RTSP', () => {
    expect(redactUrlUserinfo('rtsp://admin:s3cr3t@10.0.0.5:554/Streaming/tracks/101'))
      .toBe('rtsp://admin:***@10.0.0.5:554/Streaming/tracks/101')
  })
  it('deja intactas URLs sin userinfo', () => {
    expect(redactUrlUserinfo('rtsp://10.0.0.5:554/x')).toBe('rtsp://10.0.0.5:554/x')
  })
})
