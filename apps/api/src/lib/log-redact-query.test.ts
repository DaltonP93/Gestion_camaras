// El serializer `req` de server.ts registra req.url pasado por redactUrlSecrets:
// ningún token de medios de grabación ni capability de cierre debe quedar en el log
// de peticiones (revisión conjunta, C22).
import { describe, it, expect } from 'vitest'
import { redactUrlSecrets } from './log-redact'

describe('redactUrlSecrets — tokens de grabaciones y de retención (C22)', () => {
  it('enmascara el token de descarga ?t= (24 h) y retentionToken por query', () => {
    const t = 'ab12'.repeat(12)
    const out = redactUrlSecrets(`/api/recordings/download?t=${t}`)
    expect(out).toBe('/api/recordings/download?t=***')
    expect(out).not.toContain(t)
    expect(redactUrlSecrets('/api/cameras/c1/stop-stream?viewId=v1&retentionToken=rt-ficticio-123&reason=unmount'))
      .toBe('/api/cameras/c1/stop-stream?viewId=v1&retentionToken=***&reason=unmount')
  })
  it('no toca parámetros que sólo empiezan con "t"', () => {
    expect(redactUrlSecrets('/api/x?type=sub&ts=1&tab=2')).toBe('/api/x?type=sub&ts=1&tab=2')
  })
})
