import { describe, it, expect } from 'vitest'
import { redactLog, redactError, maskIp, maskUser } from './log-redact'

describe('redactLog — invariante #6: ni host ni credenciales en el log', () => {
  it('colapsa IPv4, IPv6, userinfo y Authorization', () => {
    const raw =
      'connect ECONNREFUSED http://admin:s3cr3t@10.20.30.40:80/ISAPI ' +
      'ipv6 [fd12:3456:789a:1::abcd]:554 ' +
      'headers Authorization: Bearer eyJhbGciOiJIUzI1.abc.def Basic YWRtaW46czNjcjN0'
    const out = redactLog(raw)
    // No debe quedar NINGÚN octeto/credencial sensible.
    expect(out).not.toContain('30.40')
    expect(out).not.toContain('s3cr3t')
    expect(out).not.toContain('admin')        // el USUARIO del userinfo tampoco queda
    expect(out).not.toContain('fd12:3456:789a')
    expect(out).not.toContain('eyJhbGciOiJIUzI1.abc.def')
    expect(out).not.toContain('YWRtaW46czNjcjN0')
    expect(out).toContain('10.20.x.x')
    expect(out).toContain('[ipv6]')
    // Ningún token vivo tras Bearer/Basic/Authorization (todo colapsado a ***).
    expect(out).not.toMatch(/Bearer\s+[A-Za-z0-9]/)
    expect(out).not.toMatch(/Basic\s+[A-Za-z0-9]/)
  })

  it('redacta el userinfo completo, incluso sin contraseña (user@host)', () => {
    const out = redactLog('GET http://operador@10.0.0.5:8000/ISAPI/System/deviceInfo')
    expect(out).not.toContain('operador')     // usuario redactado aun sin ":pass"
    expect(out).toContain('***@')
    expect(out).toContain('10.0.x.x')
  })

  it('redactError nunca expone host/credencial del AxiosError', () => {
    const axiosLike = {
      code: 'ERR_BAD_REQUEST',
      message: 'Request failed https://user:pw@192.168.9.9:8000/ISAPI/System',
      config: { url: 'https://user:pw@192.168.9.9:8000/ISAPI', headers: { Authorization: 'Bearer TOKEN123' } },
    }
    const out = redactError(axiosLike)
    expect(out).toContain('ERR_BAD_REQUEST')
    expect(out).not.toContain('192.168.9.9')
    expect(out).not.toContain('pw@')
    expect(out).not.toContain('TOKEN123') // el objeto config NO se serializa
    expect(out).toContain('192.168.x.x')
  })

  it('maskIp / maskUser no filtran el valor', () => {
    expect(maskIp('10.20.30.40')).toBe('10.20.x.x')
    expect(maskIp('fd12::1')).toBe('***')
    expect(maskUser('admin')).toBe('set')
    expect(maskUser('')).toBe('unset')
  })
})
