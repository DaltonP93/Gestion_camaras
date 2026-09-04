// apps/api/src/services/onvif/soap-client.test.ts
//
// I/O SOAP con transporte INYECTADO (sin red real). Verifica SSRF previa, mapeo
// de errores tipados, detección de Fault (incl. HTTP 500) y headers SOAP 1.2.

import { describe, it, expect } from 'vitest'
import { postSoap, type SoapTransport } from './soap-client'
import { OnvifError } from './errors'

function transportReturning(status: number, body: string, capture?: { headers?: Record<string, string> }): SoapTransport {
  return {
    async post(_url, _b, o) {
      if (capture) capture.headers = o.headers
      return { status, body }
    },
  }
}

const OK_BODY = '<s:Envelope><s:Body><trt:GetProfilesResponse/></s:Body></s:Envelope>'
const FAULT_BODY =
  '<s:Envelope><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value>' +
  '<s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code>' +
  '<s:Reason><s:Text>no auth</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>'

const URL = 'http://192.168.1.50/onvif/device_service'

describe('postSoap', () => {
  it('devuelve el body crudo en 200', async () => {
    const body = await postSoap(URL, '<env/>', { transport: transportReturning(200, OK_BODY), action: 'A' })
    expect(body).toBe(OK_BODY)
  })

  it('pone el action en el Content-Type SOAP 1.2', async () => {
    const cap: { headers?: Record<string, string> } = {}
    await postSoap(URL, '<env/>', { transport: transportReturning(200, OK_BODY, cap), action: 'urn:X' })
    expect(cap.headers!['Content-Type']).toContain('application/soap+xml')
    expect(cap.headers!['Content-Type']).toContain('action="urn:X"')
  })

  it('lanza SSRF_BLOCKED antes de tocar el transporte', async () => {
    let called = false
    const t: SoapTransport = { async post() { called = true; return { status: 200, body: '' } } }
    await expect(postSoap('http://169.254.169.254/', '<env/>', { transport: t, action: 'A' })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    })
    expect(called).toBe(false)
  })

  it('detecta Fault aunque venga con HTTP 500', async () => {
    await expect(
      postSoap(URL, '<env/>', { transport: transportReturning(500, FAULT_BODY), action: 'A' }),
    ).rejects.toMatchObject({ code: 'SOAP_FAULT' })
  })

  it('status no-2xx sin Fault → TRANSPORT_ERROR', async () => {
    await expect(
      postSoap(URL, '<env/>', { transport: transportReturning(404, '<nope/>'), action: 'A' }),
    ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' })
  })

  it('timeout del transporte → OnvifError TIMEOUT', async () => {
    const t: SoapTransport = { async post() { throw Object.assign(new Error('to'), { code: 'ECONNABORTED' }) } }
    await expect(postSoap(URL, '<env/>', { transport: t, action: 'A' })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('error de red genérico → TRANSPORT_ERROR', async () => {
    const t: SoapTransport = { async post() { throw new Error('boom') } }
    const err = await postSoap(URL, '<env/>', { transport: t, action: 'A' }).catch((e) => e)
    expect(err).toBeInstanceOf(OnvifError)
    expect(err.code).toBe('TRANSPORT_ERROR')
  })
})
