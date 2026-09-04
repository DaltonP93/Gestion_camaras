// apps/api/src/services/onvif/discovery.ts
//
// I/O INYECTABLE (delgado) — WS-Discovery por UDP multicast (SOAP-over-UDP).
//
// El socket es INYECTABLE (`UdpSocket` + `SocketFactory`): en producción usa
// `dgram` de Node; en tests se inyecta un doble que no toca la red. Aquí sólo se
// orquesta: enviar el Probe al grupo multicast 239.255.255.250:3702 y juntar los
// ProbeMatch recibidos durante una ventana de tiempo. El armado del Probe y el
// parseo son núcleo puro (discovery-message.ts / parse.ts).
//
// La descoberta es multicast LOCAL: no alcanza destinos arbitrarios. No hay
// credenciales en juego (el Probe no las lleva).

import { buildProbeMessage, parseProbeMatches, WS_DISCOVERY_ADDR, WS_DISCOVERY_PORT, type ProbeMatch } from './discovery-message'

/** Subconjunto mínimo de un socket UDP (dgram) que necesitamos. Inyectable. */
export interface UdpSocket {
  on(event: 'message', cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  bind(cb?: () => void): void
  send(msg: Buffer, port: number, address: string, cb?: (err: Error | null) => void): void
  close(cb?: () => void): void
}

export type SocketFactory = () => UdpSocket

export interface DiscoverOptions {
  /** Ventana de escucha en ms antes de cerrar y resolver. */
  timeoutMs?: number
  /** MessageID del Probe (para tests deterministas). */
  messageId?: string
  socketFactory?: SocketFactory
  /** Reloj/temporizador inyectable (para tests). Default setTimeout. */
  setTimer?: (cb: () => void, ms: number) => { clear: () => void }
}

export interface DiscoveredDevice extends ProbeMatch {
  /** Dirección de origen del datagrama (IP del dispositivo en la LAN). */
  remoteAddress: string
}

const DEFAULT_TIMEOUT_MS = 4000

function defaultSocketFactory(): UdpSocket {
  // Import perezoso de dgram: sólo cuando realmente se descubre (nunca en import).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dgram = require('dgram') as typeof import('dgram')
  return dgram.createSocket({ type: 'udp4', reuseAddr: true }) as unknown as UdpSocket
}

const defaultSetTimer = (cb: () => void, ms: number): { clear: () => void } => {
  const t = setTimeout(cb, ms)
  if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref()
  return { clear: () => clearTimeout(t) }
}

/**
 * Envía un Probe multicast y junta los ProbeMatch durante `timeoutMs`. Deduplica
 * por endpoint (o por remoteAddress si el endpoint es nulo). Siempre cierra el
 * socket. Nunca rechaza por respuestas malformadas: las ignora.
 */
export function discover(opts: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const makeSocket = opts.socketFactory ?? defaultSocketFactory
  const setTimer = opts.setTimer ?? defaultSetTimer
  const probe = Buffer.from(buildProbeMessage({ messageId: opts.messageId }), 'utf8')

  return new Promise<DiscoveredDevice[]>((resolve) => {
    const found = new Map<string, DiscoveredDevice>()
    let socket: UdpSocket
    let settled = false
    let timer: { clear: () => void } | null = null

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) timer.clear()
      try { socket.close() } catch { /* ya cerrado */ }
      resolve([...found.values()])
    }

    try {
      socket = makeSocket()
    } catch {
      resolve([])
      return
    }

    socket.on('error', () => finish())
    socket.on('message', (msg, rinfo) => {
      try {
        const matches = parseProbeMatches(msg.toString('utf8'))
        for (const m of matches) {
          const key = m.endpoint ?? `addr:${rinfo.address}`
          if (!found.has(key)) found.set(key, { ...m, remoteAddress: rinfo.address })
        }
      } catch { /* respuesta malformada: ignorar */ }
    })

    socket.bind(() => {
      socket.send(probe, WS_DISCOVERY_PORT, WS_DISCOVERY_ADDR, () => { /* errores → timeout cierra igual */ })
      timer = setTimer(finish, timeoutMs)
    })
  })
}
