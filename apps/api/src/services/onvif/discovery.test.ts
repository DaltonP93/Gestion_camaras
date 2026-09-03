// apps/api/src/services/onvif/discovery.test.ts
//
// WS-Discovery I/O con socket UDP INYECTADO (sin red real). Verifica que se envía
// el Probe al grupo multicast, que se juntan/deduplican ProbeMatches y que el
// socket siempre se cierra.

import { describe, it, expect } from 'vitest'
import { discover, type UdpSocket } from './discovery'
import { WS_DISCOVERY_ADDR, WS_DISCOVERY_PORT } from './discovery-message'

interface Sent { port: number; address: string }

class FakeSocket implements UdpSocket {
  msgCb?: (msg: Buffer, rinfo: { address: string; port: number }) => void
  errCb?: (err: Error) => void
  sent: Sent[] = []
  closed = false
  on(event: 'message' | 'error', cb: any): void {
    if (event === 'message') this.msgCb = cb
    else this.errCb = cb
  }
  bind(cb?: () => void): void { cb?.() }
  send(_msg: Buffer, port: number, address: string, cb?: (err: Error | null) => void): void {
    this.sent.push({ port, address })
    cb?.(null)
  }
  close(cb?: () => void): void { this.closed = true; cb?.() }
}

const PROBE_MATCH = (uuid: string, ip: string) =>
  `<s:Envelope><s:Body><d:ProbeMatches><d:ProbeMatch>` +
  `<a:EndpointReference><a:Address>${uuid}</a:Address></a:EndpointReference>` +
  `<d:XAddrs>http://${ip}/onvif/device_service</d:XAddrs>` +
  `</d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`

/** Reloj/timer manual: captura el callback finish para dispararlo desde el test. */
function manualTimer() {
  let fire: (() => void) | null = null
  const setTimer = (cb: () => void) => {
    fire = cb
    return { clear: () => { fire = null } }
  }
  return { setTimer, fireNow: () => fire?.() }
}

describe('discover', () => {
  it('envía el Probe al grupo multicast y junta ProbeMatches', async () => {
    const socket = new FakeSocket()
    const { setTimer, fireNow } = manualTimer()
    const p = discover({ messageId: 'urn:uuid:test', socketFactory: () => socket, setTimer })

    // Simula dos dispositivos respondiendo.
    socket.msgCb!(Buffer.from(PROBE_MATCH('urn:uuid:AAA', '192.168.1.50')), { address: '192.168.1.50', port: 3702 })
    socket.msgCb!(Buffer.from(PROBE_MATCH('urn:uuid:BBB', '192.168.1.51')), { address: '192.168.1.51', port: 3702 })
    fireNow() // cierra la ventana

    const devices = await p
    expect(socket.sent).toEqual([{ port: WS_DISCOVERY_PORT, address: WS_DISCOVERY_ADDR }])
    expect(devices).toHaveLength(2)
    expect(devices.map((d) => d.endpoint).sort()).toEqual(['urn:uuid:AAA', 'urn:uuid:BBB'])
    expect(devices[0].remoteAddress).toBe('192.168.1.50')
    expect(socket.closed).toBe(true)
  })

  it('deduplica por endpoint (mismo dispositivo responde dos veces)', async () => {
    const socket = new FakeSocket()
    const { setTimer, fireNow } = manualTimer()
    const p = discover({ messageId: 'urn:uuid:test', socketFactory: () => socket, setTimer })
    socket.msgCb!(Buffer.from(PROBE_MATCH('urn:uuid:SAME', '192.168.1.50')), { address: '192.168.1.50', port: 3702 })
    socket.msgCb!(Buffer.from(PROBE_MATCH('urn:uuid:SAME', '192.168.1.50')), { address: '192.168.1.50', port: 3702 })
    fireNow()
    const devices = await p
    expect(devices).toHaveLength(1)
  })

  it('ignora respuestas malformadas sin romper', async () => {
    const socket = new FakeSocket()
    const { setTimer, fireNow } = manualTimer()
    const p = discover({ messageId: 'urn:uuid:test', socketFactory: () => socket, setTimer })
    socket.msgCb!(Buffer.from('esto no es SOAP'), { address: '10.0.0.9', port: 3702 })
    fireNow()
    expect(await p).toEqual([])
    expect(socket.closed).toBe(true)
  })

  it('resuelve vacío si el socket no se puede crear', async () => {
    const devices = await discover({
      socketFactory: () => { throw new Error('no socket') },
    })
    expect(devices).toEqual([])
  })

  it('un error del socket cierra y resuelve lo acumulado', async () => {
    const socket = new FakeSocket()
    const { setTimer } = manualTimer()
    const p = discover({ messageId: 'urn:uuid:test', socketFactory: () => socket, setTimer })
    socket.msgCb!(Buffer.from(PROBE_MATCH('urn:uuid:AAA', '192.168.1.50')), { address: '192.168.1.50', port: 3702 })
    socket.errCb!(new Error('ENETUNREACH'))
    const devices = await p
    expect(devices).toHaveLength(1)
    expect(socket.closed).toBe(true)
  })
})
