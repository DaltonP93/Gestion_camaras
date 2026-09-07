// Invariante #6: sanitizeRtsp NO debe dejar en claro ni el usuario/clave (userinfo)
// ni la IP interna del NVR/cámara en URLs rtsp:// que van a logs o diagnóstico.
import { describe, it, expect } from 'vitest'
import { sanitizeRtsp } from './stream'

describe('sanitizeRtsp — enmascara userinfo Y host (invariante #6)', () => {
  it('URL con credenciales + IPv4: oculta usuario, clave e IP; conserva puerto y path', () => {
    const out = sanitizeRtsp('rtsp://admin:s3cr3t@192.168.1.103:554/Streaming/Channels/4402')
    expect(out).not.toContain('admin')
    expect(out).not.toContain('s3cr3t')
    expect(out).not.toContain('192.168.1.103')
    expect(out).toContain('***@')
    expect(out).toContain('192.168.x.x')
    expect(out).toContain(':554')
    expect(out).toContain('/Streaming/Channels/4402')
  })

  it('URL sin credenciales: sigue ocultando la IP y NO inventa userinfo', () => {
    const out = sanitizeRtsp('rtsp://10.20.30.40:554/live')
    expect(out).toBe('rtsp://10.20.x.x:554/live')
    expect(out).not.toContain('30.40')
    expect(out).not.toContain('***@')
  })

  it('host que es hostname (no IPv4) se colapsa a ***', () => {
    const out = sanitizeRtsp('rtsp://user:pass@nvr.interno.lan:554/x')
    expect(out).not.toContain('nvr.interno.lan')
    expect(out).not.toContain('pass')
    expect(out).toContain('rtsp://***@***:554/x')
  })

  it('enmascara múltiples URLs embebidas en un texto de log', () => {
    const out = sanitizeRtsp('src=rtsp://a:b@192.168.1.5:554/1 dst=rtsp://c:d@192.168.1.6:554/2')
    expect(out).not.toMatch(/192\.168\.1\.[56]/)
    expect(out).not.toContain(':b@')
    expect(out).toContain('192.168.x.x')
  })

  it('texto sin rtsp:// queda intacto', () => {
    expect(sanitizeRtsp('nada que enmascarar aquí')).toBe('nada que enmascarar aquí')
  })
})
