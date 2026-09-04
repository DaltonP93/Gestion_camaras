import { describe, it, expect } from 'vitest'
import { redactUrlSecrets, redactUrlUserinfo, maskIp, redactIps } from './log-redact'

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

describe('maskIp (invariante #6)', () => {
  it('enmascara los dos últimos octetos de una IPv4', () => {
    expect(maskIp('192.168.1.50')).toBe('192.168.x.x')
    expect(maskIp('10.0.0.5')).toBe('10.0.x.x')
    expect(maskIp('  172.16.30.200  ')).toBe('172.16.x.x')
  })
  it('nunca devuelve la IP completa real', () => {
    expect(maskIp('192.168.1.50')).not.toContain('1.50')
  })
  it('vacío → cadena vacía; no-IPv4 → ***', () => {
    expect(maskIp('')).toBe('')
    expect(maskIp(null)).toBe('')
    expect(maskIp(undefined)).toBe('')
    expect(maskIp('nvr-host.local')).toBe('***')
    expect(maskIp('fe80::1')).toBe('***')
  })
})

describe('redactIps', () => {
  it('enmascara todas las IPv4 embebidas en un texto/XML', () => {
    expect(redactIps('<ipAddress>192.168.1.10</ipAddress> port 172.16.0.3'))
      .toBe('<ipAddress>192.168.x.x</ipAddress> port 172.16.x.x')
  })
  it('no toca texto sin IPs y respeta vacío', () => {
    expect(redactIps('sin ips aqui')).toBe('sin ips aqui')
    expect(redactIps('')).toBe('')
  })
})
