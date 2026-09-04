// apps/api/src/services/onvif/discovery-message.test.ts
//
// Mensaje Probe de WS-Discovery (puro, determinista con messageId inyectado).

import { describe, it, expect } from 'vitest'
import { buildProbeMessage, PROBE_ACTION, WS_DISCOVERY_ADDR, WS_DISCOVERY_PORT } from './discovery-message'

describe('buildProbeMessage', () => {
  it('construye un Probe con Action, MessageID y tipo por defecto', () => {
    const msg = buildProbeMessage({ messageId: 'urn:uuid:fixed-1' })
    expect(msg).toContain(`<a:Action s:mustUnderstand="1">${PROBE_ACTION}</a:Action>`)
    expect(msg).toContain('<a:MessageID>urn:uuid:fixed-1</a:MessageID>')
    expect(msg).toContain('<d:Types>dn:NetworkVideoTransmitter</d:Types>')
    expect(msg).toContain('<d:Probe>')
  })
  it('respeta un tipo custom', () => {
    const msg = buildProbeMessage({ messageId: 'urn:uuid:x', type: 'dn:Device' })
    expect(msg).toContain('<d:Types>dn:Device</d:Types>')
  })
  it('genera un MessageID único cuando no se pasa', () => {
    const a = buildProbeMessage()
    const b = buildProbeMessage()
    const idA = a.match(/<a:MessageID>(.*?)<\/a:MessageID>/)?.[1]
    const idB = b.match(/<a:MessageID>(.*?)<\/a:MessageID>/)?.[1]
    expect(idA).toMatch(/^urn:uuid:/)
    expect(idA).not.toBe(idB)
  })
  it('expone el grupo multicast estándar', () => {
    expect(WS_DISCOVERY_ADDR).toBe('239.255.255.250')
    expect(WS_DISCOVERY_PORT).toBe(3702)
  })
})
