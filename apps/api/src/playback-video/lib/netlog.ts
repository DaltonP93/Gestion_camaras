// apps/api/src/playback-video/lib/netlog.ts
//
// Lectura del netlog del navegador (`--log-net-log`): lo escribe el servicio de red
// de Chromium/Chrome con TODOS sus sockets (páginas, DoH, servicios de fondo), cosa
// que ni los eventos de Playwright ni el centinela de Node (que sólo ve sockets del
// proceso de la suite) pueden ver. Sirve para afirmar el aislamiento del navegador.
//
// Formato: línea 1 = {"constants":{...}, línea 2 = "events": [, después UN evento
// por línea terminado en coma. Se lee línea por línea (tolera un archivo truncado).

import fs from 'node:fs'

export interface BrowserNet {
  /** Se pudo leer el netlog (constantes y eventos). */
  ok: boolean
  error?: string
  bytes: number
  events: number
  /** Destinos de sockets (TCP/UDP) en loopback, distintos. Debe ser > 0: prueba que el netlog vio tráfico. */
  loopbackSockets: number
  /**
   * Destinos fuera de loopback CON tráfico ("TIPO ip:puerto"). Debe ser []. Cuenta
   * todo intento TCP (el connect ya emite un SYN) y los sockets UDP que enviaron o
   * intentaron enviar datos (UDP_BYTES_SENT / UDP_SEND_ERROR en el mismo socket).
   */
  nonLoopback: string[]
  /**
   * Sockets UDP fuera de loopback que sólo hicieron connect(), sin enviar nada: un
   * connect UDP fija el destino y consulta la tabla de rutas, pero no emite ningún
   * paquete. Chromium lo usa, p. ej., para sondear si hay IPv6 global
   * ([2001:4860:4860::8888]:443). Se informa, no es tráfico.
   */
  udpConnectOnly: string[]
  /** Pedidos de URL fuera de loopback que el navegador INTENTÓ (origen; bloqueados por el resolvedor). */
  attemptedOrigins: string[]
  /**
   * Consultas DNS-over-HTTPS (DOH_URL_REQUEST). Debe ser 0: el DoH se conecta al
   * servidor por IP literal (p. ej. 2001:4860:4860::8888:443), que la regla del
   * resolvedor NO cubre. Se cuenta aparte porque, sin ruta a esa IP (este
   * contenedor), el intento no llega a abrir un socket y I-NET-4 no lo vería.
   */
  dohRequests: number
}

const isLoopbackAddr = (a: string) => /^(127\.\d+\.\d+\.\d+(:\d+)?|\[::1\](:\d+)?|::1)$/.test(a)

function originOf(u: string): string | null {
  try {
    const x = new URL(u)
    if (!/^(https?|wss?):$/.test(x.protocol)) return null
    return /^(127\.\d+\.\d+\.\d+|\[::1\])$/.test(x.hostname) ? null : `${x.protocol}//${x.host}`
  } catch { return null }
}

/** Análisis PURO del texto de un netlog (se prueba en metrics.test.ts). */
export function analyzeNetlog(text: string): BrowserNet {
  const res: BrowserNet = { ok: false, bytes: text.length, events: 0, loopbackSockets: 0, nonLoopback: [], udpConnectOnly: [], attemptedOrigins: [], dohRequests: 0 }
  const lines = text.split('\n')
  let types: Record<string, number>
  let sourceTypes: Record<string, number> = {}
  try {
    const constants = JSON.parse(lines[0].replace(/,\s*$/, '') + '}').constants
    types = constants.logEventTypes
    if (!types || typeof types !== 'object') throw new Error('sin constants.logEventTypes')
    if (constants.logSourceType && typeof constants.logSourceType === 'object') sourceTypes = constants.logSourceType
  } catch (e) {
    res.error = `netlog ilegible: ${(e as Error).message}`
    return res
  }
  const names = new Map<number, string>(Object.entries(types).map(([k, v]) => [Number(v), k]))
  const srcNames = new Map<number, string>(Object.entries(sourceTypes).map(([k, v]) => [Number(v), k]))
  const loop = new Set<string>()
  const outside = new Set<string>()
  // UDP: destino por socket (source.id) y sockets que enviaron algo.
  const udpDest = new Map<number, Set<string>>()
  const udpSent = new Set<number>()
  const origins = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    let ev: { type?: number; params?: Record<string, unknown>; source?: { id?: number; type?: number } }
    try { ev = JSON.parse(line.replace(/,$/, '')) } catch { continue }
    if (typeof ev.type !== 'number') continue
    res.events++
    const name = names.get(ev.type) ?? ''
    const p = ev.params ?? {}
    if (name === 'DOH_URL_REQUEST') res.dohRequests++
    const src = typeof ev.source?.id === 'number' ? ev.source.id : -1
    if (name === 'UDP_BYTES_SENT' || name === 'UDP_SEND_ERROR') {
      udpSent.add(src)
      // SendTo sin connect: el destino viene en el propio evento.
      if (typeof p.address === 'string' && p.address && !isLoopbackAddr(p.address)) outside.add(`${name} ${p.address}`)
    }
    if (/CONNECT/.test(name)) {
      // SOCKET_CONNECT de un UDP_CLIENT_SOCKET repite el UDP_CONNECT de su socket interno.
      const srcType = typeof ev.source?.type === 'number' ? srcNames.get(ev.source.type) : undefined
      const udp = name === 'UDP_CONNECT' || (name === 'SOCKET_CONNECT' && srcType === 'UDP_CLIENT_SOCKET')
      const addrs = [p.address, ...(Array.isArray(p.address_list) ? p.address_list : []), p.remote_address]
      for (const a of addrs) {
        if (typeof a !== 'string' || !a) continue
        if (isLoopbackAddr(a)) loop.add(a)
        else if (udp) { if (!udpDest.has(src)) udpDest.set(src, new Set()); udpDest.get(src)!.add(a) }
        else outside.add(`${name} ${a}`)
      }
    }
    if (typeof p.url === 'string') {
      const o = originOf(p.url)
      if (o) origins.add(o)
    }
  }
  res.ok = res.events > 0
  if (!res.ok) res.error = 'netlog sin eventos'
  res.loopbackSockets = loop.size
  const connectOnly = new Set<string>()
  const sentTo = new Set<string>()
  for (const [id, dests] of udpDest) for (const a of dests) (udpSent.has(id) ? sentTo : connectOnly).add(a)
  for (const a of sentTo) { outside.add(`UDP_SEND ${a}`); connectOnly.delete(a) }
  res.nonLoopback = [...outside].sort()
  res.udpConnectOnly = [...connectOnly].sort()
  res.attemptedOrigins = [...origins].sort()
  return res
}

export function readNetlog(file: string): BrowserNet {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    return { ok: false, error: `no se pudo leer el netlog: ${(e as Error).message}`, bytes: 0, events: 0, loopbackSockets: 0, nonLoopback: [], udpConnectOnly: [], attemptedOrigins: [], dohRequests: 0 }
  }
  return analyzeNetlog(text)
}
